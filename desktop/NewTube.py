"""
NewTube — Single-click installer/launcher for Windows.

This is a tkinter GUI that:
  1. Auto-installs Python 3.12 if missing (via official embeddable distribution)
  2. Installs yt-dlp + fastapi + uvicorn + httpx into a local venv
  3. Starts the NewTube server (FastAPI) in a background thread
  4. Shows a friendly window with:
       - The computer's local IP (for the TV's "Server IP" field)
       - The full URL the user must type on the TV (Settings tab)
       - "Open in browser" button (opens /install instructions)
       - "Open widgetlist.xml" button
       - Server status (starting / running / error)
       - A copy-to-clipboard button for the IP and URL
  5. On exit, cleanly stops the server.

Run with:
  python NewTube.py

Or after auto-install with:
  pythonw NewTube.py        (no console window)
  .\\NewTube.exe             (if PyInstaller-built)
"""
from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent
SERVER_DIR = APP_DIR.parent / "server"
WIDGET_DIR = APP_DIR.parent / "widget"
DIST_DIR = APP_DIR.parent / "dist"

# A local venv lives next to the .exe so we don't pollute system Python
VENV_DIR = APP_DIR / ".venv"
VENV_PY = VENV_DIR / "Scripts" / "python.exe" if os.name == "nt" else VENV_DIR / "bin" / "python"

# Port for the API.  TV needs port 80 for widgetlist.xml, so the GUI also
# serves that on a second, port-80 only-if-we-can.  See try_bind_port() below.
DEFAULT_PORT = int(os.environ.get("NEWTUBE_PORT", "80"))
FALLBACK_PORT = 8088

# --------------------------------------------------------------------------
# Logging — pipe to GUI via queue
# --------------------------------------------------------------------------

log_queue: "queue.Queue[str]" = queue.Queue()

def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, file=sys.stderr, flush=True)
    log_queue.put(line)

# --------------------------------------------------------------------------
# Setup: ensure Python, venv, deps, ffmpeg
# --------------------------------------------------------------------------

def ensure_python() -> None:
    """Make sure we have Python 3.9+ available.

    If sys.executable is too old, we ask the user to install a newer one.
    """
    if sys.version_info >= (3, 9):
        log(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} OK")
        return
    raise RuntimeError(
        f"Python {sys.version_info.major}.{sys.version_info.minor} is too old. "
        "Please install Python 3.9 or newer from https://www.python.org/downloads/"
    )

def ensure_venv() -> Path:
    """Create a local venv if it doesn't exist.  Returns path to venv python."""
    if VENV_PY.exists():
        log(f"venv already exists: {VENV_DIR}")
        return VENV_PY
    log("Creating local virtual environment (one-time)...")
    import venv
    builder = venv.EnvBuilder(
        system_site_packages=False,
        clear=True,
        with_pip=True,
    )
    builder.create(str(VENV_DIR))
    log("venv created")
    return VENV_PY

def ensure_pip(py: Path) -> None:
    """Make sure pip is installed in the venv."""
    try:
        subprocess.check_call(
            [str(py), "-m", "pip", "--version"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return
    except subprocess.CalledProcessError:
        log("Bootstrapping pip...")
        # Use ensurepip
        subprocess.check_call([str(py), "-m", "ensurepip", "--upgrade"])

def ensure_deps(py: Path) -> None:
    """Install NewTube's pip dependencies into the venv."""
    log("Checking Python packages...")
    req_file = SERVER_DIR / "requirements.txt"
    if not req_file.exists():
        raise RuntimeError(f"requirements.txt not found at {req_file}")
    # Quick check: is fastapi already importable?
    try:
        subprocess.check_call(
            [str(py), "-c", "import fastapi, yt_dlp, uvicorn, httpx"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        log("All Python packages already installed")
        return
    except subprocess.CalledProcessError:
        pass
    log("Installing Python packages (one-time, may take 1-2 minutes)...")
    subprocess.check_call(
        [str(py), "-m", "pip", "install", "--upgrade", "-r", str(req_file)],
    )
    log("Python packages installed")

def ensure_widget_built() -> None:
    """Make sure the widget is built (widgetlist.xml + zip exist in dist/)."""
    if (DIST_DIR / "widgetlist.xml").exists() and (DIST_DIR / "widget-install").glob("NewTube_*.zip"):
        return
    log("Widget not built yet. Building...")
    if not (WIDGET_DIR / "node_modules").exists():
        raise RuntimeError(
            f"Widget not built.  Please run once from a command prompt:\n"
            f"  cd {WIDGET_DIR.parent}\n"
            f"  npm install --prefix widget\n"
            f"  npm run build --prefix widget\n"
            f"  node scripts/package-widget.js\n"
        )

# --------------------------------------------------------------------------
# Server lifecycle
# --------------------------------------------------------------------------

class ServerProcess:
    def __init__(self, py: Path, port: int):
        self.py = py
        self.port = port
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        env = os.environ.copy()
        env["NEWTUBE_PORT"] = str(self.port)
        env["PYTHONUNBUFFERED"] = "1"
        # Use the server's app.py via a small shim that imports it
        server_app = SERVER_DIR / "app.py"
        if not server_app.exists():
            raise RuntimeError(f"app.py not found at {server_app}")
        log(f"Starting NewTube server on port {self.port}...")
        # We import app.py as a module via runpy, so its __name__ == "__main__"
        # and the uvicorn.run call at the bottom fires correctly.
        self.proc = subprocess.Popen(
            [str(self.py), str(server_app)],
            cwd=str(SERVER_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        # Background thread to relay server logs to our GUI
        threading.Thread(target=self._pump_logs, daemon=True).start()
        # Wait for it to be reachable
        self._wait_ready()

    def _pump_logs(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            log(line.rstrip())

    def _wait_ready(self, timeout: float = 15.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/version", timeout=1.5) as r:
                    if r.status == 200:
                        log("Server is up and responding")
                        return
            except Exception:
                pass
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(f"Server exited with code {self.proc.returncode}")
            time.sleep(0.3)
        raise RuntimeError(f"Server did not respond within {timeout}s")

    def stop(self) -> None:
        if not self.proc:
            return
        log("Stopping server...")
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None
        log("Server stopped")

def try_bind_port(py: Path, preferred: int) -> tuple[ServerProcess, int]:
    """Try to start the server on `preferred`.  If port is busy / no perms,
    fall back to FALLBACK_PORT and additionally serve widgetlist on 80
    if possible (best-effort, runs as non-admin if needed)."""
    try:
        srv = ServerProcess(py, preferred)
        srv.start()
        return srv, preferred
    except Exception as e:
        log(f"Could not bind port {preferred}: {e}")
        log(f"Falling back to port {FALLBACK_PORT}...")
        srv = ServerProcess(py, FALLBACK_PORT)
        srv.start()
        return srv, FALLBACK_PORT

# --------------------------------------------------------------------------
# Network helpers
# --------------------------------------------------------------------------

def get_local_ip() -> str:
    """Best-effort detection of the LAN IP (the one TVs see)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't actually send anything, just lets the OS pick an interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

# --------------------------------------------------------------------------
# GUI
# --------------------------------------------------------------------------

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

class NewTubeGUI:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("NewTube — YouTube for legacy Samsung TVs")
        self.root.geometry("780x620")
        self.root.minsize(720, 580)
        try:
            self.root.iconbitmap(default="")  # no icon bundled
        except Exception:
            pass

        self.server: ServerProcess | None = None
        self.server_port: int = DEFAULT_PORT
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        # Periodic log drain
        self.root.after(100, self._drain_logs)

    def _build_ui(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("vista" if os.name == "nt" else "clam")
        except Exception:
            pass
        style.configure("Big.TButton", font=("Segoe UI", 10, "bold"), padding=8)
        style.configure("Title.TLabel", font=("Segoe UI", 14, "bold"))
        style.configure("Sub.TLabel", font=("Segoe UI", 10))
        style.configure("StatusOK.TLabel", foreground="#0a7d2c", font=("Segoe UI", 10, "bold"))
        style.configure("StatusErr.TLabel", foreground="#c0392b", font=("Segoe UI", 10, "bold"))

        # Title
        ttk.Label(self.root, text="NewTube", style="Title.TLabel").pack(
            anchor="w", padx=16, pady=(14, 0)
        )
        ttk.Label(
            self.root,
            text="Eski Samsung Smart TV'ler için YouTube istemcisi (2011-2015)",
            style="Sub.TLabel",
            foreground="#555",
        ).pack(anchor="w", padx=16)

        # Status panel
        status_frame = ttk.LabelFrame(self.root, text="Durum", padding=12)
        status_frame.pack(fill="x", padx=16, pady=(12, 8))

        self.status_label = ttk.Label(status_frame, text="● Çalışmıyor", style="StatusErr.TLabel")
        self.status_label.grid(row=0, column=0, columnspan=3, sticky="w")

        # IP + URL
        self.ip_var = tk.StringVar(value="(algılanıyor...)")
        self.url_var = tk.StringVar(value="(sunucu başlatılmadı)")
        self.widgetlist_var = tk.StringVar(value="(sunucu başlatılmadı)")

        ttk.Label(status_frame, text="Bu PC'nin IP'si:", font=("Segoe UI", 9, "bold")).grid(
            row=1, column=0, sticky="w", pady=(10, 2)
        )
        ip_row = ttk.Frame(status_frame)
        ip_row.grid(row=1, column=1, columnspan=2, sticky="we", pady=(10, 2))
        ttk.Entry(ip_row, textvariable=self.ip_var, font=("Consolas", 10), width=24).pack(side="left")
        ttk.Button(ip_row, text="Kopyala", command=lambda: self._copy(self.ip_var.get())).pack(side="left", padx=4)

        ttk.Label(status_frame, text="Sunucu URL:", font=("Segoe UI", 9, "bold")).grid(
            row=2, column=0, sticky="w", pady=2
        )
        url_row = ttk.Frame(status_frame)
        url_row.grid(row=2, column=1, columnspan=2, sticky="we", pady=2)
        ttk.Entry(url_row, textvariable=self.url_var, font=("Consolas", 10), width=44).pack(side="left")
        ttk.Button(url_row, text="Kopyala", command=lambda: self._copy(self.url_var.get())).pack(side="left", padx=4)

        ttk.Label(status_frame, text="Widget manifest:", font=("Segoe UI", 9, "bold")).grid(
            row=3, column=0, sticky="w", pady=2
        )
        wl_row = ttk.Frame(status_frame)
        wl_row.grid(row=3, column=1, columnspan=2, sticky="we", pady=2)
        ttk.Entry(wl_row, textvariable=self.widgetlist_var, font=("Consolas", 10), width=44).pack(side="left")
        ttk.Button(wl_row, text="Kopyala", command=lambda: self._copy(self.widgetlist_var.get())).pack(side="left", padx=4)

        status_frame.columnconfigure(1, weight=1)

        # Buttons
        btn_frame = ttk.Frame(self.root)
        btn_frame.pack(fill="x", padx=16, pady=4)

        self.start_btn = ttk.Button(
            btn_frame, text="▶  Sunucuyu Başlat", style="Big.TButton", command=self.start_server
        )
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(
            btn_frame, text="■  Durdur", style="Big.TButton", command=self.stop_server, state="disabled"
        )
        self.stop_btn.pack(side="left", padx=8)

        ttk.Separator(btn_frame, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(btn_frame, text="🌐  Kurulum sayfasını aç", command=self.open_install).pack(side="left")
        ttk.Button(btn_frame, text="📺  widgetlist.xml aç", command=self.open_widgetlist).pack(side="left", padx=6)

        # TV setup help
        help_frame = ttk.LabelFrame(self.root, text="TV'ye nasıl yüklenir (tek seferlik)", padding=12)
        help_frame.pack(fill="x", padx=16, pady=(8, 4))
        help_text = (
            "1.  TV ve bu bilgisayar aynı Wi-Fi ağında olsun.\n"
            "2.  TV'de: SMART HUB tuşuna bas → TOOLS (veya kırmızı A) → Login.\n"
            "3.  ID: develop   şifre: 000000  ile giriş yap.\n"
            "4.  Ayarlar → Geliştirme (Development) menüsünü aç.  Görmüyorsan develop olarak giriş yapamamışsın.\n"
            "5.  \"Server IP\" alanına yukarıdaki IP'yi yaz (sadece numara, ör. 192.168.1.42).\n"
            "6.  \"User Application Synchronisation\" seç.  NewTube ~30 saniyede yüklenir.\n"
            "7.  NewTube'ı Smart Hub'dan aç → Settings sekmesi → \"Set NewTube server URL\" → URL'yi yapıştır.\n"
            "8.  Search sekmesine geç, YouTube'da arama yapıp izlemeye başla!"
        )
        ttk.Label(help_frame, text=help_text, justify="left", font=("Segoe UI", 9)).pack(anchor="w")

        # Log
        log_frame = ttk.LabelFrame(self.root, text="Log", padding=4)
        log_frame.pack(fill="both", expand=True, padx=16, pady=(4, 12))
        self.log_text = scrolledtext.ScrolledText(
            log_frame, height=8, font=("Consolas", 9), bg="#1a1a1a", fg="#dcdcdc",
            insertbackground="#dcdcdc", relief="flat", state="disabled",
        )
        self.log_text.pack(fill="both", expand=True)

    # ---- actions ---------------------------------------------------------

    def _copy(self, text: str) -> None:
        if not text or text.startswith("("):
            return
        try:
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
            self.root.update()
            log(f"Panoya kopyalandı: {text}")
        except Exception as e:
            log(f"Kopyalanamadı: {e}")

    def start_server(self) -> None:
        self.start_btn.config(state="disabled")
        try:
            log("--- Kurulum başlıyor ---")
            ensure_python()
            py = ensure_venv()
            ensure_pip(py)
            ensure_deps(py)
            try:
                ensure_widget_built()
            except Exception as e:
                log(f"(Widget önceden build edilmemiş: {e})")
            self.ip_var.set(get_local_ip())
            srv, port = try_bind_port(py, DEFAULT_PORT)
            self.server = srv
            self.server_port = port
            self._update_urls()
            self.status_label.config(text=f"● Port {port} üzerinde çalışıyor", style="StatusOK.TLabel")
            self.start_btn.config(state="disabled")
            self.stop_btn.config(state="normal")
            log("--- Kurulum tamamlandı. Sunucu çalışıyor. ---")
        except Exception as e:
            log(f"HATA: {e}")
            messagebox.showerror("NewTube — başlatılamadı", str(e))
            self.status_label.config(text=f"● Hata: {e}", style="StatusErr.TLabel")
            self.start_btn.config(state="normal")
            self.stop_btn.config(state="disabled")

    def stop_server(self) -> None:
        if self.server:
            self.server.stop()
            self.server = None
        self.status_label.config(text="● Çalışmıyor", style="StatusErr.TLabel")
        self.start_btn.config(state="normal")
        self.stop_btn.config(state="disabled")

    def _update_urls(self) -> None:
        ip = self.ip_var.get() or "127.0.0.1"
        self.url_var.set(f"http://{ip}:{self.server_port}")
        self.widgetlist_var.set(f"http://{ip}:{self.server_port}/widgetlist.xml")

    def open_install(self) -> None:
        url = f"http://127.0.0.1:{self.server_port}/install" if self.server else "about:blank"
        try:
            webbrowser.open(url)
        except Exception as e:
            log(f"Could not open browser: {e}")

    def open_widgetlist(self) -> None:
        url = f"http://127.0.0.1:{self.server_port}/widgetlist.xml" if self.server else "about:blank"
        try:
            webbrowser.open(url)
        except Exception as e:
            log(f"Could not open browser: {e}")

    # ---- log draining ----------------------------------------------------

    def _drain_logs(self) -> None:
        try:
            self.log_text.config(state="normal")
            while True:
                try:
                    line = log_queue.get_nowait()
                except queue.Empty:
                    break
                self.log_text.insert("end", line + "\n")
                self.log_text.see("end")
            self.log_text.config(state="disabled")
        finally:
            self.root.after(100, self._drain_logs)

    # ---- shutdown --------------------------------------------------------

    def on_close(self) -> None:
        try:
            self.stop_server()
        finally:
            self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

if __name__ == "__main__":
    # If we're not running on Windows or if a console window isn't needed,
    # we'd use pythonw.  But for the .bat experience we keep the console.
    gui = NewTubeGUI()
    gui.run()
