// Turns a stream of upload-progress callbacks into a readable speed and ETA.
//
// Both upload transports in this app already hand over (sent, total) — axios
// onUploadProgress in api/odooApi.js does it for the JSON and the multipart
// path alike — and both callers were throwing those numbers away and keeping
// only the ratio. So a 20 MB upload showed a bar creeping along with no way to
// tell whether it was moving at 5 MB/s or had stalled completely, which is the
// only question anyone actually has while waiting.
//
// The rate is smoothed over a short window rather than measured between the last
// two events: raw deltas swing hard enough that the number flickers between
// 200 KB/s and 8 MB/s, and a figure that jumps like that is worse than none.

const WINDOW_MS = 3000;

/**
 * Create a tracker for ONE upload. Feed it every progress callback; it returns
 * { percent, speed, eta, loaded, total } — speed in bytes/sec, eta in seconds.
 *
 * Note for the manual upload specifically: its route is base64-in-JSON, so the
 * `total` reported here is the ENCODED body, about a third larger than the file
 * on disk. Always render from these numbers rather than from file.size, or the
 * speed reads ~33% low and the bytes-sent line never reaches the file's size.
 */
export function makeRateTracker() {
  const samples = [];
  const startedAt = Date.now();

  return (sent, total) => {
    const now = Date.now();
    samples.push({ t: now, loaded: sent });
    // Keep at least two samples so there is always something to measure across.
    while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();

    const first = samples[0];
    const dt = (now - first.t) / 1000;
    const db = sent - first.loaded;
    // Until the window has filled, fall back to the whole-upload average so the
    // first couple of events still show a sensible figure instead of Infinity.
    const speed = dt > 0.25 ? db / dt : sent / Math.max(0.25, (now - startedAt) / 1000);
    const remaining = Math.max(0, (total || 0) - sent);

    return {
      loaded: sent,
      total: total || 0,
      percent: total ? Math.min(100, Math.round((sent / total) * 100)) : 0,
      speed,
      eta: speed > 0 ? remaining / speed : Infinity,
    };
  };
}

/** Bytes/sec → "1.4 MB/s". */
export function fmtSpeed(bytesPerSec) {
  if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Seconds → "45s" / "2m 05s". Rounded — an ETA that claims precision it does
 *  not have just reads as broken when it jumps around. */
export function fmtEta(secs) {
  if (!isFinite(secs) || secs < 0) return '';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
