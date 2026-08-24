#!/usr/bin/env node
/*
 * Package the NewTube widget for installation on Orsay Smart TVs.
 *
 * Orsay user widgets are installed via the "User Application Synchronisation"
 * feature: the TV downloads a zip from your server, unpacks it, and installs
 * each *.zip inside that bundle as a separate widget.
 *
 * Output structure (in /workspace/newtube/dist/):
 *   widgetlist.xml           <- the manifest the TV reads
 *   NewTube_1.0.0.zip         <- the widget itself, ready to be installed
 *
 * Host the dist/ directory with any HTTP server (IIS, Python, nginx, etc.)
 * and point the TV's "Setting Server IP" at its URL.  See README.md.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WIDGET_DIR = path.join(ROOT, "widget");
const DIST_DIR = path.join(ROOT, "dist");

// Read the version from the widget's package.json
const pkg = JSON.parse(fs.readFileSync(path.join(WIDGET_DIR, "package.json"), "utf8"));
const version = pkg.version;
const widgetName = "NewTube";
const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

function die(msg) {
    console.error("\n  ✗ " + msg + "\n");
    process.exit(1);
}

function step(msg) {
    console.log("\n→ " + msg);
}

function ok(msg) {
    console.log("  ✓ " + msg);
}

function run(cmd, cwd) {
    try {
        execSync(cmd, { stdio: "inherit", cwd: cwd || ROOT });
    } catch (e) {
        die("Command failed: " + cmd);
    }
}

if (!fs.existsSync(path.join(WIDGET_DIR, "src"))) {
    die("Widget source not found at " + WIDGET_DIR);
}

step("1. Build the widget bundle (webpack production mode)");
run("npm run build", WIDGET_DIR);
ok("webpack build complete");

step("2. Collect widget files for the installable zip");
const stagedDir = path.join(DIST_DIR, "_stage");
fs.rmSync(stagedDir, { recursive: true, force: true });
fs.mkdirSync(stagedDir, { recursive: true });

const FILES_TO_PACK = [
    "config.xml",
    "index.html",
    "widget.info",
];
for (const f of FILES_TO_PACK) {
    const src = path.join(WIDGET_DIR, f);
    if (!fs.existsSync(src)) {
        die("missing widget file: " + f);
    }
    fs.copyFileSync(src, path.join(stagedDir, f));
}

// dist/ (webpack output)
const widgetDist = path.join(WIDGET_DIR, "dist");
if (!fs.existsSync(widgetDist)) {
    die("webpack did not produce widget/dist/");
}
copyDirRecursive(widgetDist, path.join(stagedDir, "dist"));

// img/
copyDirRecursive(path.join(WIDGET_DIR, "img"), path.join(stagedDir, "img"));
ok("files copied to staging dir");

step("3. Create the installable widget zip");
// Try zip first, fall back to a Python helper
let zipPath = path.join(DIST_DIR, `${widgetName}_${version}_${date}.zip`);
try {
    execSync(`cd "${stagedDir}" && zip -r "${zipPath}" .`, { stdio: "inherit" });
} catch (e) {
    try {
        execSync(
            `python3 -c "import shutil; shutil.make_archive('${zipPath.replace(/\.zip$/, "")}', 'zip', '${stagedDir}')"`,
            { stdio: "inherit" }
        );
    } catch (e2) {
        die("Could not create zip.  Install the `zip` utility or use Python 3.");
    }
}
ok("created " + path.basename(zipPath));

// Compute uncompressed size for the manifest (best effort)
let size = 0;
try {
    const out = execSync(`stat -c %s "${zipPath}" 2>/dev/null || stat -f %z "${zipPath}"`).toString();
    size = parseInt(out.trim(), 10);
} catch (e) {}

// Step 4: write widgetlist.xml
step("4. Write widgetlist.xml manifest");
const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<rsp stat="ok">
<list>
<widget id="${widgetName}">
<title>${widgetName}</title>
<compression type="zip" size="${size}"/>
<description>NewTube — YouTube client for legacy Samsung Smart TVs</description>
<download>http://YOUR_SERVER_IP:8088/widget-install/${path.basename(zipPath)}</download>
</widget>
</list>
</rsp>
`;
fs.writeFileSync(path.join(DIST_DIR, "widgetlist.xml"), manifest);
ok("wrote widgetlist.xml");

// Step 5: copy zip to widget-install subfolder
const installDir = path.join(DIST_DIR, "widget-install");
fs.mkdirSync(installDir, { recursive: true });
fs.copyFileSync(zipPath, path.join(installDir, path.basename(zipPath)));
ok("copied to " + path.join("dist", "widget-install", path.basename(zipPath)));

// Step 6: clean up staging
fs.rmSync(stagedDir, { recursive: true, force: true });

console.log("\n✓ Done!\n");
console.log("  To install on your TV:");
console.log("    1. Start the NewTube server:    python server/app.py");
console.log("    2. Open the dist/ directory:    cd dist && python -m http.server 8089");
console.log("    3. On the TV, log in as 'develop' and set Server IP to your computer's:8089");
console.log("    4. Run 'User Application Synchronisation' on the TV");
console.log("    5. NewTube appears in your Smart Hub\n");
console.log("  Generated files:");
console.log("    " + path.join(DIST_DIR, "widgetlist.xml"));
console.log("    " + path.join(DIST_DIR, "widget-install", path.basename(zipPath)));
console.log();

function copyDirRecursive(src, dst) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}
