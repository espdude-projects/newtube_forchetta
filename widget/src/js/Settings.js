import List from './List';
import React from 'react';
import config from './config';

const SERVER_OPTION = 'server';
const ABOUT_OPTION = 'about';
const CLEAR_CACHE_OPTION = 'clearCache';

export default class Settings extends React.Component {

    constructor(props) {
        super(props);
        this.state = {
            editingServer: false,
            serverDraft: config.serverBase,
            status: null,
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

    _promptForServer() {
        // Use a simple inline prompt.  The Orsay TV's native input dialog
        // would be nicer but it's an undocumented private API; a custom
        // modal keeps this portable.
        const current = config.serverBase;
        const v = window.prompt(
            "NewTube server URL (e.g. http://192.168.1.50:8088):",
            current
        );
        if (v && v.trim()) {
            config.serverBase = v.trim();
            this.setState({ status: "Saved. Server: " + config.serverBase });
            setTimeout(() => this.setState({ status: null }), 3500);
        }
    }

    _testServer() {
        const base = config.serverBase;
        this.setState({ status: "Testing " + base + "..." });
        const xhr = new XMLHttpRequest();
        xhr.open("GET", base + "/api/version", true);
        xhr.timeout = 5000;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    this.setState({ status: "OK — server " + (body.server || "?") + " v" + (body.version || "?") });
                } catch (e) {
                    this.setState({ status: "Reachable but bad response" });
                }
            } else {
                this.setState({ status: "HTTP " + xhr.status });
            }
            setTimeout(() => this.setState({ status: null }), 5000);
        };
        xhr.onerror = () => {
            this.setState({ status: "Network error — is the server running on " + base + "?" });
            setTimeout(() => this.setState({ status: null }), 5000);
        };
        xhr.ontimeout = () => {
            this.setState({ status: "Timeout — check the server URL and that TV and server are on the same network" });
            setTimeout(() => this.setState({ status: null }), 5000);
        };
        xhr.send();
    }

    _clearCache() {
        try {
            localStorage.clear();
        } catch (e) {}
        this.setState({ status: "Local cache cleared" });
        setTimeout(() => this.setState({ status: null }), 3000);
    }

    onItemSelected = (item) => {
        if (item.key === SERVER_OPTION) {
            this._promptForServer();
        } else if (item.key === 'testServer') {
            this._testServer();
        } else if (item.key === CLEAR_CACHE_OPTION) {
            this._clearCache();
        } else if (item.key === ABOUT_OPTION) {
            this.setState({ status: "NewTube 1.0.0 — YouTube for legacy Samsung Smart TVs" });
            setTimeout(() => this.setState({ status: null }), 5000);
        }
    };

    render() {
        return <div className="tab-section settings" style={this.props.style}>
            <div className="server-info">
                <small>NewTube server</small>
                <h2>{config.serverBase}</h2>
            </div>
            {this.state.status ? <p className="status">{this.state.status}</p> : null}
            <List ref={ref => this.listRef = ref}
                  items={[
                      {key: SERVER_OPTION, name: 'Set NewTube server URL'},
                      {key: 'testServer', name: 'Test connection to server'},
                      {key: CLEAR_CACHE_OPTION, name: 'Clear local cache'},
                      {key: ABOUT_OPTION, name: 'About NewTube'},
                  ]}
                  onReturn={this.onReturn}
                  onSelectBeforeFirst={this.props.onTabsFocus}
                  onItemSelected={this.onItemSelected}
            />
        </div>
    }

}
