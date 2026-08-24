import config from './config';
import React from 'react';
import VideoList from './VideoList';

const tvKey = new Common.API.TVKeyValue();

export default class Search extends React.Component {

    constructor(props) {
        super(props);
        this.searching = null;
        this.state = {
            displayEnterHint: false,
            items: [],
            loading: false,
            error: null
        };
    }

    onChange = () => {
        const value = this.ime.getInputObj().value;

        this.setState({
            searchText: value,
            displayEnterHint: value && value.trim().length && (!this.searching || this.searching.q !== value)
        });

    }

    search = () => {
        const value = this.ime.getInputObj().value;

        if (!value || !value.trim().length) {
            return
        }

        if (this.searching) {
            if (this.searching.q === value) {
                // keep searching
                return;
            } else {
                if (this.searching.abort) {
                    try { this.searching.abort(); } catch (e) {}
                }
            }
        }

        this.setState({
            loading: true,
            searchText: value,
            displayEnterHint: false
        });

        // Use XMLHttpRequest directly because it's more reliable on the
        // Orsay TV browser than third-party HTTP libraries.
        const xhr = new XMLHttpRequest();
        const base = config.serverBase;
        xhr.open("GET", base + "/api/search?q=" + encodeURIComponent(value) + "&maxResults=25", true);
        xhr.timeout = 20000;
        xhr.onload = () => {
            let items = [];
            let err = null;
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    items = (body.items || []).map(it => ({
                        id: { videoId: it.videoId },
                        snippet: {
                            title: it.title,
                            channelTitle: it.channelTitle,
                            channelId: it.channelId,
                            thumbnails: it.thumbnail ? { high: { url: it.thumbnail } } : undefined,
                        },
                        // The OldTube VideoList expects these fields:
                        videoId: it.videoId,
                        name: it.title,
                        channelTitle: it.channelTitle,
                        duration: it.duration,
                        thumbnail: it.thumbnail,
                        key: it.videoId,
                    }));
                } catch (e) {
                    err = "bad JSON: " + e.message;
                }
            } else {
                err = "HTTP " + xhr.status + ": " + (xhr.responseText || "").slice(0, 200);
            }
            this.setState({
                error: err,
                items: items,
                loading: false
            });
            this.searching = null;
        };
        xhr.onerror = () => {
            this.setState({ error: "network error (check NewTube server is running)", loading: false });
            this.searching = null;
        };
        xhr.ontimeout = () => {
            this.setState({ error: "timeout talking to NewTube server", loading: false });
            this.searching = null;
        };
        xhr.send();
        this.searching = { q: value, abort: () => xhr.abort() };
    };

    componentDidMount() {
        this.focus();
    }

    canFocus() {
        return true;
    }

    focus() {
        console.log("search focus");
        if (!this.listRef.isSelected()) {
            this.setupKeyboard();
        } else {
            this.listRef.focus();
        }
    }

    setupKeyboard() {
        let imeShell = new IMEShell("searchText", this.onIMEInit.bind(this), this);
        if (!imeShell) {
            console.log("object for IMEShell create failed");
        }
    }

    onIMEInit(ime) {
        this.ime = ime;
        ime.setOnCompleteFunc(this.onChange);
        ime.getInputObj().focus();
        ime.setEnterFunc(this.onImeEnter);
        ime.setKeyFunc(tvKey.KEY_UP, this.onImeKeyUp);
        ime.setKeyFunc(tvKey.KEY_DOWN, this.onImeKeyDown);
        ime.setKeyFunc(tvKey.KEY_RETURN, this.onImeKeyReturn);
    }

    onImeEnter = () => {
        console.log("enter");
        this.search();
        this.listRef.focus();
        this.listRef.select(0);
    };

    onImeKeyUp = () => {
        console.log("key up");
        this.props.onTabsFocus();
    };

    onImeKeyDown = () => {
        console.log("key down");
        this.search();
        this.listRef.focus();
        this.listRef.select(0);
    };

    onImeKeyReturn = () => {
        console.log("key return");
        this.search();
        this.props.onTabsFocus();
    };

    focusSearch = () => {
        this.setupKeyboard();
        this.listRef.select(-1);
    };

    render() {
        return (
            <div className="tab-section search" style={this.props.style}>
                <div className="search-bar">
                    <label>Ara:</label>
                        <input id="searchText" type="text" placeholder="YouTube'da ara..." value={this.state.searchText}
                               onChange={() => {/* ignored, just to avoid a react warning, goes thru ime */}}/>
                        {this.state.displayEnterHint ? <small>Ara için OK/enter'a bas</small> : null}

                </div>
                <VideoList
                    listRef={ref => this.listRef = ref}
                    loading={this.state.loading}
                    error={this.state.error}
                    items={this.state.items}
                    onVideoSelected={this.props.onVideoSelected}
                    onReturn={this.focusSearch}
                    onSearch={this.focusSearch}
                    onSelectBeforeFirst={this.focusSearch}
                />
            </div>
        );
    }

}