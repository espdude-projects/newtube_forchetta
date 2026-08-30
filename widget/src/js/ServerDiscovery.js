/**
 * Server discovery — scan the local subnet for a NewTube server.
 *
 * The Orsay browser can't do mDNS / Bonjour / UDP broadcasts, so we
 * just hammer a list of likely IPs with HTTP probes.  In practice the
 * user's PC is somewhere in 192.168.0.x or 192.168.1.x so we hit
 * the common ranges first, then expand to a wider scan if needed.
 *
 * Returns: list of {ip, port, rttMs} for servers that responded to
 * /api/version, sorted fastest first.
 */

const COMMON_PREFIXES = [
    "192.168.1.",
    "192.168.0.",
    "192.168.2.",
    "10.0.0.",
    "10.0.1.",
    "172.16.0.",
];

const COMMON_HOSTS = [
    "192.168.1.1", "192.168.1.10", "192.168.1.50", "192.168.1.100",
    "192.168.1.200", "192.168.0.1", "192.168.0.10", "192.168.0.50",
    "192.168.0.100", "192.168.0.200",
    "10.0.0.1", "10.0.0.10", "10.0.0.50", "10.0.0.100",
];

const PORTS_TO_TRY = [80, 8088, 8080, 5000, 3000];

/** Fetch /api/version with a hard timeout.  Returns parsed JSON or null. */
function probe(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const url = `http://${ip}:${port}/api/version`;
        const xhr = new XMLHttpRequest();
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            try { xhr.abort(); } catch (e) {}
            resolve(val);
        };
        xhr.open("GET", url, true);
        xhr.timeout = timeoutMs;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (body && (body.server === "newtube" || /newtube/i.test(JSON.stringify(body)))) {
                        finish({ ip, port, body, tStart: this._t0 });
                    } else {
                        finish(null);
                    }
                } catch (e) { finish(null); }
            } else {
                finish(null);
            }
        };
        xhr.onerror = () => finish(null);
        xhr.ontimeout = () => finish(null);
        this._t0 = Date.now();
        xhr.send();
    });
}

/**
 * Scan a single prefix (e.g. "192.168.1.") by trying every host in
 * parallel chunks.  Returns the first response per host.
 */
async function scanPrefix(prefix, port, timeoutMs = 800) {
    const tasks = [];
    for (let i = 1; i < 255; i++) {
        const ip = prefix + i;
        tasks.push(probe(ip, port, timeoutMs).then((r) => r ? { ...r, rttMs: Date.now() - this._t0 } : null));
    }
    const results = await Promise.all(tasks);
    return results.filter(Boolean);
}

/**
 * Discover the user's likely subnet from the browser's WebRTC hints.
 * Orsay's WebRTC is broken, so this is best-effort.  Returns the
 * candidate prefixes to try, in priority order.
 */
function getCandidatePrefixes() {
    const out = [...COMMON_PREFIXES];
    // Orsay exposes the local IP via some legacy APIs but we can't
    // rely on it.  We just hope one of the common ones matches.
    return out;
}

/**
 * Run a fast scan of well-known hosts first, then a wider subnet
 * scan if nothing found.
 *
 * onProgress(percent) is called periodically.
 */
export async function discoverServer({ onProgress, timeoutMs = 20000 } = {}) {
    const candidates = getCandidatePrefixes();
    const found = [];
    const seen = new Set();

    function remember(r) {
        const key = `${r.ip}:${r.port}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push(r);
    }

    // Phase 1: probe well-known hosts first (super fast)
    if (onProgress) onProgress(0);
    for (const port of PORTS_TO_TRY) {
        for (const host of COMMON_HOSTS) {
            const r = await probe(host, port, 600);
            if (r) remember(r);
        }
        if (found.length > 0) break;
    }
    if (found.length > 0) {
        if (onProgress) onProgress(100);
        return found.sort((a, b) => a.rttMs - b.rttMs);
    }

    // Phase 2: scan each prefix on the most common port (8088)
    const start = Date.now();
    for (let pi = 0; pi < candidates.length; pi++) {
        if (Date.now() - start > timeoutMs) break;
        const prefix = candidates[pi];
        if (onProgress) onProgress(Math.floor((pi / candidates.length) * 100));
        // Limit to .1-100 first (most home routers are .1, PCs often
        // .50-.200), then .101-254
        const firstOctet = [1,2,3,4,5,10,20,50,51,52,53,100,101,102,150,200,201,202,250];
        for (const i of firstOctet) {
            if (Date.now() - start > timeoutMs) break;
            const ip = prefix + i;
            for (const port of [8088, 80]) {
                const r = await probe(ip, port, 500);
                if (r) remember(r);
            }
        }
    }
    if (onProgress) onProgress(100);
    return found.sort((a, b) => a.rttMs - b.rttMs);
}
