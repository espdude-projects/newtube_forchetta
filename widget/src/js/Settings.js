import List from './List';
import React from 'react';
import config from './config';
import RemoteControlListener from './RemoteControlListener';

const SERVER_OPTION = 'server';
const TEST_OPTION = 'testServer';
const CLEAR_CACHE_OPTION = 'clearCache';
const ABOUT_OPTION = 'about';

const tvKey = (typeof Common !== "undefined" && Common.API && Common.API.TVKeyValue)
    ? new Common.API.TVKeyValue()
    : null;

export default class Settings extends React.Component {

    constructor(props) {
        super(props);
        this.state = {
            editingServer: false,
            serverDraft: config.serverBase,
            testStatus: null,
            testStatusKind: null,  // 'ok' | 'err' | null
        };
    }

    canFocus() {
        return !!this.listRef;
    }

    focus() {
        this.listRef.select(0);
        this.listRef.focus();
    }

    onReturn = () => {
        this.listRef && this.listRef.select(-1);
        this.props.onTabsFocus();
    };

    /**
     * Open a full-screen text-editor overlay that uses the Samsung TV's
     * built-in XT9 IME (the same keyboard the Search box uses) so the
     * user can type the server URL with the remote.  We do this by
     * programmatically focusing an <input> that has the Samsung IME
     * attached, instead of using window.prompt() (which the Orsay
     * browser doesn't support).
     */
    _openServerEditor = () => {
        // Create / reuse a hidden input wired to the Samsung IME
        let input = document.getElementById("newtube-server-input");
        if (!input) {
            input = document.createElement("input");
            input.id = "newtube-server-input";
            input.type = "text";
            input.autocomplete = "off";
            input.style.position = "absolute";
            input.style.left = "-9999px";
            input.style.opacity = "0";
            input.style.width = "1px";
            input.style.height = "1px";
            document.body.appendChild(input);
        }
        input.value = config.serverBase;
        // Attach the Samsung XT9 IME (same approach as Search.js)
        try {
            if (typeof IMEShell !== "undefined") {
                const ime = new IMEShell("newtube-server-input", () => {}, this);
                this._ime = ime;
                this.setState({ editingServer: true, serverDraft: input.value });
            } else {
                // Fallback: just focus the input. The browser may or may
                // not pop a soft keyboard depending on the firmware.
                input.focus();
                this.setState({ editingServer: true, serverDraft: input.value });
            }
        } catch (e) {
            input.focus();
            this.setState({ editingServer: true, serverDraft: input.value });
        }
    };

    _finishEditing = () => {
        try {
            const v = (this.state.serverDraft || "").trim();
            if (v) {
                config.serverBase = v;
                this.setState({ testStatus: "Kaydedildi: " + v, testStatusKind: "ok" });
                setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 3500);
            }
        } finally {
            this.setState({ editingServer: false });
        }
    };

    _cancelEditing = () => {
        this.setState({ editingServer: false });
    };

    _testServer = () => {
        const base = config.serverBase;
        if (!base) {
            this.setState({ testStatus: "Önce bir URL gir", testStatusKind: "err" });
            return;
        }
        this.setState({ testStatus: "Test ediliyor " + base + "...", testStatusKind: null });
        const xhr = new XMLHttpRequest();
        xhr.open("GET", base.replace(/\/+$/, "") + "/api/version", true);
        xhr.timeout = 5000;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    this.setState({
                        testStatus: "✓ Bağlantı başarılı — sunucu " + (body.server || "?") + " v" + (body.version || "?"),
                        testStatusKind: "ok",
                    });
                } catch (e) {
                    this.setState({ testStatus: "Erişilebilir ama cevap okunamadı", testStatusKind: "ok" });
                }
            } else {
                this.setState({ testStatus: "✗ HTTP " + xhr.status, testStatusKind: "err" });
            }
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 6000);
        };
        xhr.onerror = () => {
            this.setState({ testStatus: "Ağ hatası — sunucu " + base + " üzerinde mi?", testStatusKind: "err" });
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 6000);
        };
        xhr.ontimeout = () => {
            this.setState({ testStatus: "Zaman aşımı — TV ve sunucu aynı ağda mı?", testStatusKind: "err" });
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 6000);
        };
        xhr.send();
    };

    _clearCache = () => {
        try { localStorage.clear(); } catch (e) {}
        this.setState({ testStatus: "Yerel önbellek temizlendi", testStatusKind: "ok" });
        setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 3000);
    };

    onItemSelected = (item) => {
        if (item.key === SERVER_OPTION) {
            this._openServerEditor();
        } else if (item.key === TEST_OPTION) {
            this._testServer();
        } else if (item.key === CLEAR_CACHE_OPTION) {
            this._clearCache();
        } else if (item.key === ABOUT_OPTION) {
            this.setState({
                testStatus: "NewTube 1.0.0 — YouTube for legacy Samsung Smart TVs",
                testStatusKind: "ok",
            });
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 5000);
        }
    };

    render() {
        return (
            <div className="tab-section settings" style={this.props.style}>
                <RemoteControlListener
                    onKeyReturn={() => this.state.editingServer ? this._cancelEditing() : this.onReturn()}
                    onKeyEnter={() => this.state.editingServer ? this._finishEditing() : null}
                />
                <div className="server-info">
                    <small>NewTube sunucu</small>
                    <h2>{config.serverBase}</h2>
                </div>
                {this.state.testStatus ? (
                    <p className={"status " + (this.state.testStatusKind || "")}>{this.state.testStatus}</p>
                ) : null}
                {this.state.editingServer ? (
                    <p className="editing-hint">
                        Klavyeyle yazın, <b>Tamam</b>'a basınca kaydeder.
                        <br/><small>{this.state.serverDraft}</small>
                    </p>
                ) : null}
                <List
                    ref={ref => this.listRef = ref}
                    items={[
                        { key: SERVER_OPTION, name: 'NewTube sunucu URL\'sini ayarla' },
                        { key: TEST_OPTION, name: 'Sunucuya bağlantıyı test et' },
                        { key: CLEAR_CACHE_OPTION, name: 'Yerel önbelleği temizle' },
                        { key: ABOUT_OPTION, name: 'Hakkında' },
                    ]}
                    onReturn={this.onReturn}
                    onSelectBeforeFirst={this.props.onTabsFocus}
                    onItemSelected={this.onItemSelected}
                />
            </div>
        );
    }
}
