/**
 * NewTube widget config.
 *
 * The NewTube server URL is the only thing the user needs to configure.
 * It is stored in localStorage on the TV and editable from the Settings screen.
 *
 * DO NOT include a trailing slash.
 */
const STORAGE_KEY = "newtubeServerBase";

function readStored() {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v) return v.replace(/\/+$/, "");
    } catch (e) {}
    return null;
}

function writeStored(v) {
    try {
        localStorage.setItem(STORAGE_KEY, v.replace(/\/+$/, ""));
    } catch (e) {}
}

export default {
    STORAGE_KEY,

    /**
     * The base URL of the NewTube server.  The widget calls:
     *   {serverBase}/api/search?q=...
     *   {serverBase}/api/resolve/{videoId}
     *   {serverBase}/stream/{videoId}
     */
    get serverBase() {
        return readStored() || "http://newtube.local:8088";
    },
    set serverBase(v) {
        writeStored(v);
    },
};
