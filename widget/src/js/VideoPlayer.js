import React from 'react';
import RemoteControlListener from './RemoteControlListener';
import config from './config';
import { errorToString } from './util';

import 'core-js/features/set';
import 'core-js/features/map';
import 'regenerator-runtime/runtime';

/**
 * NewTube VideoPlayer.
 *
 * The original OldTube tried to use ytdl-core in the TV's browser, which broke
 * the moment YouTube changed the n/sig challenge.  NewTube instead asks the
 * NewTube server (a small Python daemon running on the user's home network)
 * for a directly-playable URL.  The server uses yt-dlp to handle all the
 * deciphering and (if needed) transcodes the result to H.264 MP4 that the
 * Orsay TV can play natively.
 *
 * Flow:
 *   1. User picks a video in Search/Channel/Playlist
 *   2. <VideoPlayer> mounts, we call {serverBase}/api/resolve/{videoId}
 *   3. Server replies with { streamUrl: "/stream/{videoId}", ... }
 *   4. We set the <video> tag's src to that absolute URL
 *   5. The TV's native media engine plays it
 */
export default class VideoPlayer extends React.PureComponent {

	constructor(props) {
		super(props);

		this.state = {
			currentVideo: 0,
			currentTime: 0,
			duration: 0,
			progressBarVisible: true,
			videoUrl: null,
			loadingVideoUrl: false,
			needsTranscode: false,
			error: null,
		}
	}

	componentWillReceiveProps(nextProps) {
		this.setState({
			currentVideo: 0,
			currentTime: 0,
			duration: 0,
			progressBarVisible: true,
			videoUrl: null,
			loadingVideoUrl: false,
			needsTranscode: false,
			error: null
		})
	}

	onPlayerReady = (event) => {
		console.log("player ready");
		this.showAndUpdateProgress();
	};

	showAndUpdateProgress(fadeOutAfter) {
		if (this.videoRef) {
			this.setState({
				currentTime: this.videoRef.currentTime,
				duration: this.videoRef.duration,
				progressBarVisible: true
			});
			if (fadeOutAfter) {
				setTimeout(() => {
					this.setState({
						progressBarVisible: false
					})
				}, 2000)
			}
		}
	}

	onTimeUpdate = () => {
		this.setState({
			currentTime: this.videoRef.currentTime,
			duration: this.videoRef.duration
		});
	};

	onPlayerEnded = (event) => {
		console.log("player state change: ended");
		this.toggleScreenSaver(true);
		if (this.hasMoreVideosInPlaylist()) {
			this.onKeyFastForward();
			this.onKeyPlay();
		} else {
			this.props.onReturn(null);
		}
	};

	onPlayerPlaying = (event) => {
		console.log("player state change: playing");
		this.toggleScreenSaver(false);
		this.showAndUpdateProgress(true);
	};

	onPlayerPaused = (event) => {
		console.log("player state change: paused");
		this.toggleScreenSaver(true);
		this.showAndUpdateProgress(false);
	};

	onError = (event) => {
		console.log("video error:", event);
		this.setState({
			error: (event && event.target && event.target.error
				? `Media error code ${event.target.error.code}`
				: "Unknown media error")
		});
	};

	componentDidMount() {
		this.loadVideoUrl();
	}

	componentDidUpdate() {
		this.remoteControlListener.focus();
		this.loadVideoUrl();
	}

	onKeyPlay = () => {
		this.videoRef && this.videoRef.play();
	};

	onKeyPause = () => {
		if (this.videoRef) {
			if (!this.videoRef.paused) {
				this.videoRef.pause();
			} else {
				this.videoRef.play();
			}
		}
	};

	onKeyStop = () => {
		if (this.videoRef) {
			this.videoRef.pause();
			this.videoRef.currentTime = 0;
			this.showAndUpdateProgress(false);
		}
	};

	onKeyRw = () => {
		if (this.videoRef) {
			this.videoRef.currentTime = Math.max(0, this.videoRef.currentTime - 10);
			this.showAndUpdateProgress(!this.videoRef.paused);
		}
	};

	onKeyFF = () => {
		if (this.videoRef) {
			this.videoRef.currentTime = Math.min(this.videoRef.duration, this.videoRef.currentTime + 10);
			this.showAndUpdateProgress(!this.videoRef.paused);
		}
	};

	onKeyRewind = () => {
		if (this.state.currentVideo > 0) {
			this.setState({
				currentVideo: this.state.currentVideo - 1,
				currentTime: 0,
				duration: 0,
				videoUrl: null,
				loadingVideoUrl: false
			}, this.loadVideoUrl)
		}
	};

	onKeyFastForward = () => {
		if (this.hasMoreVideosInPlaylist()) {
			this.setState({
				currentVideo: this.state.currentVideo + 1,
				currentTime: 0,
				duration: 0,
				videoUrl: null,
				loadingVideoUrl: false
			}, this.loadVideoUrl)
		}
	};

	hasMoreVideosInPlaylist() {
		return this.state.currentVideo <= this.props.playlistVideoIds.length;
	}

	onKeyVolUp = () => {
		deviceapis.audiocontrol.setVolumeUp();
	};

	onKeyVolDown = () => {
		deviceapis.audiocontrol.setVolumeDown();
	};

	onKeyReturn = (event) => {
		this.toggleScreenSaver(true);
		this.props.onReturn(event);
	};

	getCurrentVideoObject() {
		return (this.state.currentVideo === 0) ?
			this.props.youtubeId :
			this.props.playlistVideoIds[this.state.currentVideo - 1];
	}

	loadVideoUrl = async () => {
		const videoId = this.getCurrentVideoObject().videoId;
		if (!videoId || this.state.videoUrl || this.state.loadingVideoUrl || this.state.error) {
			return;
		}

		console.log("NewTube resolve " + videoId);
		this.setState({ loadingVideoUrl: true });

		try {
			const base = config.serverBase;
			const url = base + "/api/resolve/" + encodeURIComponent(videoId);
			const json = await new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open("GET", url, true);
				xhr.timeout = 30000;
				xhr.onload = () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						try { resolve(JSON.parse(xhr.responseText)); }
						catch (e) { reject(new Error("bad JSON: " + e.message)); }
					} else {
						reject(new Error("HTTP " + xhr.status + ": " + (xhr.responseText || "").slice(0, 200)));
					}
				};
				xhr.onerror = () => reject(new Error("network error"));
				xhr.ontimeout = () => reject(new Error("timeout"));
				xhr.send();
			});

			// Server returns a relative streamUrl; make it absolute
			let streamUrl = json.streamUrl;
			if (streamUrl && streamUrl.indexOf("http") !== 0) {
				streamUrl = base + streamUrl;
			}
			console.log("NewTube stream " + streamUrl + " (transcode=" + !!json.needsTranscode + ")");
			this.setState({
				videoUrl: streamUrl,
				needsTranscode: !!json.needsTranscode,
				loadingVideoUrl: false
			});
		} catch (err) {
			console.log(errorToString(err));
			this.setState({
				error: "NewTube: " + errorToString(err),
				loadingVideoUrl: false
			});
		}
	};

	toggleScreenSaver(enabled) {
		webapis && webapis.appcommon && webapis.appcommon.setScreenSaver && webapis.appcommon.setScreenSaver(
			enabled ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON :
				webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
			function (result) {
				console.log(result);
			}, function (error) {
				console.log(JSON.stringify(error));
			}
		);
	}

	render() {
		const v = this.getCurrentVideoObject();
		return (<div className="section">
			<RemoteControlListener
				ref={ref => this.remoteControlListener = ref}
				onKeyPlay={this.onKeyPlay}
				onKeyPause={this.onKeyPause}
				onKeyStop={this.onKeyStop}
				onKeyRw={this.onKeyRw}
				onKeyFF={this.onKeyFF}
				onKeyRewind={this.onKeyRewind}
				onKeyFastForward={this.onKeyFastForward}
				onKeyVolUp={this.onKeyVolUp}
				onKeyVolDown={this.onKeyVolDown}
				onKeyReturn={this.onKeyReturn}
			/>
			{this.state.videoUrl ? (
				<video ref={videoRef => this.videoRef = videoRef}
					   style={{position: "absolute", top: 0, left: 0, width: "1920px", height: "1080px"}}
					   src={this.state.videoUrl}
					   autoPlay={true}
					   onLoadedData={this.onPlayerReady}
					   onPlaying={this.onPlayerPlaying}
					   onPause={this.onPlayerPaused}
					   onEnded={this.onPlayerEnded}
					   onError={this.onError}
					   onTimeUpdate={this.onTimeUpdate}>
				</video>
			) : null}
			{this.state.loadingVideoUrl ? (
				<div className="loading-overlay">
					<div>Resolving via NewTube server...</div>
				</div>
			) : null}
			<h1 className={"video-title " + (!this.state.progressBarVisible ? "fade-out" : "")}>
				{v ? (v.name || v.title || "") : ""}
			</h1>
			{this.state.needsTranscode ? (
				<small className={"transcode-hint " + (!this.state.progressBarVisible ? "fade-out" : "")}>
					Server-side transcoding (slight delay on start)
				</small>
			) : null}
			{this.state.error ? <pre className="error">Error: {this.state.error}</pre> : null}
			<div className={"progress-bar " + (!this.state.progressBarVisible ? "fade-out" : "")}>
				<progress max={this.state.duration} value={this.state.currentTime}/>
			</div>
		</div>)
	}

}
