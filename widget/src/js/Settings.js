import List from './List';
import React from 'react';
import config from './config';
import RemoteControlListener from './RemoteControlListener';
import { discoverServer } from './ServerDiscovery';

const SERVER_OPTION = 'server';
const TEST_OPTION = 'testServer';
const CLEAR_CACHE_OPTION = 'clearCache';
const ABOUT_OPTION = 'about';
const SCAN_OPTION = 'scanNetwork';

const tvKey = (typeof Common !== "undefined" && Common.API && Common.API.TVKeyValue)
    ? new Common.API.TVKeyValue()
    : null;

export default class Settings extends React.Component {

    constructor(props) {
        super(props);
        this.state = {
            testStatus: null,
            testStatusKind: null,
            // Discovery
            scanning: false,
            scanProgress: 0,
            found: [],
            // Manual edit
            editing: false,
            editDraft: config.serverBase,
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
     * Scan the local network for any NewTube server and show the
     * results as a pickable list.  The user just clicks the one
     * matching their PC and the URL is set automatically.
     */
    _scanNetwork = async () => {
        if (this.state.scanning) return;
        this.setState({ scanning: true, scanProgress: 0, found: [], testStatus: null, testStatusKind: null });
        try {
            const found = await discoverServer({
                timeoutMs: 25000,
                onProgress: (p) => this.setState({ scanProgress: p }),
            });
            if (found.length === 0) {
                this.setState({
                    scanning: false,
                    testStatus: "Hiç sunucu bulunamadı. PC'nin açık ve NewTube'ın çalışıyor olduğundan emin ol.",
                    testStatusKind: "err",
                });
            } else {
                this.setState({ scanning: false, found });
            }
        } catch (e) {
            this.setState({
                scanning: false,
                testStatus: "Tarama hatası: " + e.message,
                testStatusKind: "err",
            });
        }
    };

    _pickFound = (item) => {
        const url = `http://${item.ip}:${item.port}`;
        config.serverBase = url;
        localStorage.setItem(config.STORAGE_KEY, url);
        this.setState({
            found: [],
            testStatus: "Seçildi: " + url,
            testStatusKind: "ok",
        });
        setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 3500);
    };

    /**
     * Open the manual server-URL editor.  We render an <input> in the
     * DOM and use Samsung's IMEShell to attach the TV's on-screen
     * keyboard.  Crucially, the input is VISIBLE (in a modal) so
     * the keyboard actually appears.
     */
    _openEditor = () => {
        this.setState({ editing: true, editDraft: config.serverBase });
        // Attach IME on next tick so the input is in the DOM
        setTimeout(() => this._attachIME(), 50);
    };

    _attachIME = () => {
        try {
            if (typeof IMEShell === "undefined") return;
            // Tear down any old shell
            if (this._ime) {
                try { this._ime.destroy && this._ime.destroy(); } catch (e) {}
            }
            this._ime = new IMEShell("newtube-server-input", () => {
                // IME init callback
                if (this._ime && this._ime.getInputObj) {
                    this._ime.setOnCompleteFunc(() => this._onEditChange());
                    this._ime.getInputObj().focus();
                }
            }, this);
        } catch (e) {
            // Even without IME, the input is focusable; user can use
            // the remote's character-entry mode on some models.
            try {
                const el = document.getElementById("newtube-server-input");
                if (el) el.focus();
            } catch (_) {}
        }
    };

    _onEditChange = () => {
        const el = document.getElementById("newtube-server-input");
        if (el) this.setState({ editDraft: el.value });
    };

    _saveEdit = () => {
        const v = (this.state.editDraft || "").trim();
        if (v) {
            config.serverBase = v;
            localStorage.setItem(config.STORAGE_KEY, v);
            this.setState({ editing: false, testStatus: "Kaydedildi: " + v, testStatusKind: "ok" });
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 3000);
        } else {
            this.setState({ editing: false });
        }
    };

    _cancelEdit = () => {
        this.setState({ editing: false });
    };

    _testServer = () => {
        const base = config.serverBase;
        if (!base) {
            this.setState({ testStatus: "Önce bir URL ayarla", testStatusKind: "err" });
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
        if (item.key === SCAN_OPTION) {
            this._scanNetwork();
        } else if (item.key === SERVER_OPTION) {
            this._openEditor();
        } else if (item.key === TEST_OPTION) {
            this._testServer();
        } else if (item.key === CLEAR_CACHE_OPTION) {
            this._clearCache();
        } else if (item.key === ABOUT_OPTION) {
            this.setState({
                testStatus: "NewTube 1.0.1 — YouTube for legacy Samsung Smart TVs",
                testStatusKind: "ok",
            });
            setTimeout(() => this.setState({ testStatus: null, testStatusKind: null }), 5000);
        }
    };

    render() {
        return (
            <div className="tab-section settings" style={this.props.style}>
                <RemoteControlListener
                    onKeyReturn={() => this.state.editing ? this._cancelEdit() : this.onReturn()}
                    onKeyEnter={() => this.state.editing ? this._saveEdit() : null}
                />
                <div className="server-info">
                    <small>NewTube sunucu</small>
                    <h2>{config.serverBase}</h2>
                </div>

                {this.state.testStatus ? (
                    <p className={"status " + (this.state.testStatusKind || "")}>{this.state.testStatus}</p>
                ) : null}

                {this.state.scanning ? (
                    <p className="scanning">Ağ taranıyor... {this.state.scanProgress}%</p>
                ) : null}

                {this.state.found && this.state.found.length > 0 ? (
                    <div className="found-servers">
                        <p><b>Bulunan sunucular — TV kumandasıyla seç:</b></p>
                        <List
                            ref={ref => this.foundRef = ref}
                            items={this.state.found.map(f => ({
                                key: `${f.ip}:${f.port}`,
                                name: `${f.ip}:${f.port}  (${f.rttMs}ms)`,
                            }))}
                            onReturn={() => { this.setState({ found: [] }); this.focus(); }}
                            onSelectBeforeFirst={() => { this.setState({ found: [] }); this.focus(); }}
                            onItemSelected={this._pickFound}
                        />
                    </div>
                ) : null}

                {this.state.editing ? (
                    <div className="server-editor">
                        <p>Sunucu URL'sini yaz. Samsung TV kumandasının klavyesi açılacak.</p>
                        <input
                            id="newtube-server-input"
                            type="text"
                            defaultValue={this.state.editDraft}
                            onChange={this._onEditChange}
                            autoFocus
                        />
                        <div className="editor-buttons">
                            <a className="button" href="javascript:void(0);" onClick={this._saveEdit}>Kaydet</a>
                            <a className="button secondary" href="javascript:void(0);" onClick={this._cancelEdit}>İptal</a>
                        </div>
                    </div>
                ) : null}

                <List
                    ref={ref => this.listRef = ref}
                    items={[
                        { key: SCAN_OPTION, name: '🔍 Ağda NewTube sunucu ara (otomatik)' },
                        { key: SERVER_OPTION, name: '⌨️  Sunucu URL\'sini elle yaz' },
                        { key: TEST_OPTION, name: '✓  Sunucuya bağlantıyı test et' },
                        { key: CLEAR_CACHE_OPTION, name: '🗑️  Yerel önbelleği temizle' },
                        { key: ABOUT_OPTION, name: 'ℹ️  Hakkında' },
                    ]}
                    onReturn={this.onReturn}
                    onSelectBeforeFirst={this.props.onTabsFocus}
                    onItemSelected={this.onItemSelected}
                />
            </div>
        );
    }
}
