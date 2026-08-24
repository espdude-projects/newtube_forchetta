import css from '../css/main.css';
import React from 'react';
import Search from './Search';
import Settings from './Settings';
import Tabs from './Tabs';
import VideoPlayer from './VideoPlayer';
import Popup from "./Popup";
import config from './config';

const widgetAPI = new Common.API.Widget();

/**
 * NewTube top-level app.
 *
 *   - Search   -> typed search via the NewTube server
 *   - Settings -> server URL, connection test, cache, about
 *   - PhoneCast-> the TV periodically polls the server for videos that
 *                 the phone's web app has pushed.  When one arrives,
 *                 the TV plays it automatically.
 */
export default class App extends React.Component {

	constructor(props) {
		super(props);
		this.state = {
			showServerWarning: !this._looksLikeValidServer(config.serverBase),
			castToast: null,        // {videoId, title}
		};
		this._castPollTimer = null;
		this._castPollInFlight = false;
		this._lastCastId = null;
	}

	_looksLikeValidServer(url) {
		return typeof url === "string"
			&& /^https?:\/\/[\w.-]+(:\d+)?$/.test(url)
			&& url.indexOf("newtube.local") === -1;  // default placeholder
	}

	componentDidMount() {
		widgetAPI.sendReadyEvent();
		this._startCastPolling();
	}

	componentWillUnmount() {
		if (this._castPollTimer) clearInterval(this._castPollTimer);
	}

	_startCastPolling() {
		// Every 3 seconds, ask the server if the phone has pushed any videos.
		// If we get a fresh one (different videoId from last time), play it.
		const tick = async () => {
			if (this._castPollInFlight) return;
			if (this.state.youtubeId) return;  // already playing
			if (!this._looksLikeValidServer(config.serverBase)) return;
			this._castPollInFlight = true;
			try {
				const r = await new Promise((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					xhr.open("GET", config.serverBase + "/api/cast_queue", true);
					xhr.timeout = 4000;
					xhr.onload = () => xhr.status >= 200 && xhr.status < 300
						? resolve(JSON.parse(xhr.responseText))
						: reject(new Error("HTTP " + xhr.status));
					xhr.onerror = () => reject(new Error("network"));
					xhr.ontimeout = () => reject(new Error("timeout"));
					xhr.send();
				});
				const items = (r && r.items) || [];
				if (items.length === 0) return;
				const next = items[0];
				if (next.videoId === this._lastCastId) return;  // already handled
				this._lastCastId = next.videoId;
				// Build a fake youtubeId object the VideoPlayer expects
				const fakeId = {
					videoId: next.videoId,
					name: next.title || "Telefondan",
				};
				this.setState({
					youtubeId: fakeId,
					playlistVideoIds: [],
					castToast: { title: next.title || next.videoId, ts: Date.now() },
				});
			} catch (e) {
				// Silent — keep polling
			} finally {
				this._castPollInFlight = false;
			}
		};
		this._castPollTimer = setInterval(tick, 3000);
		// First check immediately
		setTimeout(tick, 1000);
	}

	focusAfterState = () => {
		if (this.tabs) this.tabs.focusOnSelectedTab();
	};

	onVideoSelected = (youtubeId, playlistVideoIds) => {
		this.setState({
			youtubeId: youtubeId,
			playlistVideoIds: playlistVideoIds
		});
	};

	videoReturn = (event) => {
		widgetAPI.blockNavigation(event);
		this.setState({ youtubeId: null }, this.focusAfterState);
		// Allow the same video to be cast again immediately
		setTimeout(() => { this._lastCastId = null; }, 1500);
	};

	exit = () => {
		widgetAPI.sendReturnEvent();
	};

	render() {
		const player = !this.state.youtubeId ? null :
			<VideoPlayer
				youtubeId={this.state.youtubeId}
				playlistVideoIds={this.state.playlistVideoIds}
				onReturn={this.videoReturn}
			/>;

		return (<div>
			{player}
			{this.state.castToast && !player ? (
				<Popup onClose={() => this.setState({ castToast: null })}>
					<p>Telefondan gelen video bitti.</p>
				</Popup>
			) : null}
			{!player && this.state.showServerWarning ? (
				<Popup onClose={() => this.setState({ showServerWarning: false })}>
					<h2>NewTube'a hoş geldin</h2>
					<p>Aramadan önce lütfen <b>Ayarlar</b> sekmesine git ve
						NewTube sunucu URL'ni ayarla.</p>
					<p>Varsayılan: <code>http://newtube.local:8088</code> (mDNS kuruluysa çalışır).</p>
					<p>Yoksa bilgisayarının yerel IP'sini yaz, örn.
						<code>http://192.168.1.50:8088</code>.</p>
				</Popup>
			) : null}
			<Tabs
				ref={ref => this.tabs = ref}
				className="section"
				style={{display: player ? "none" : null}}
				onKeyReturn={this.exit}
			>
				<Search name="Ara" onVideoSelected={this.onVideoSelected} language={undefined}/>
				<Settings name="Ayarlar"/>
			</Tabs>
		</div>);
	}
}
