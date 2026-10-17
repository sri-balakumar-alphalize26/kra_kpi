/* Upload progress arithmetic shared by every upload readout: the task panel's
   bar (components/task/TaskExtras.jsx) and the app-wide upload card
   (components/ui/UploadMonitor.jsx). Odoo's _fmtBytes / _fmtEta / _makeRateTracker. */

export const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

export const pctOf = (l, t) => (t ? Math.min(100, Math.round((l / t) * 100)) : 0);

/* "45s" / "2m 05s". */
export const fmtEta = (s) => {
  if (!Number.isFinite(s) || s < 0) return "";
  const n = Math.max(1, Math.round(s));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
};

/* Speed from the progress events, averaged over the last 3 s so one slow packet
   doesn't swing the time left about, and over the whole upload for its first
   quarter-second, when 3 s of samples don't exist yet. */
export function rateTracker() {
  const t0 = Date.now();
  const samples = [];
  return (loaded, total) => {
    const now = Date.now();
    samples.push([now, loaded]);
    while (samples.length > 2 && now - samples[0][0] > 3000) samples.shift();
    const [ts, ls] = samples[0];
    const speed = now - ts >= 250 ? ((loaded - ls) * 1000) / (now - ts)
      : now - t0 > 0 ? (loaded * 1000) / (now - t0) : 0;
    return { loaded, total, pct: pctOf(loaded, total), speed, eta: speed > 0 ? (total - loaded) / speed : Infinity };
  };
}

/* "12.4 MB of 38.0 MB · 2.1 MB/s · 13s left". */
export const progressLine = ({ loaded, total, speed, eta }) =>
  `${fmtBytes(loaded)} of ${fmtBytes(total)}${speed > 0 ? ` · ${fmtBytes(speed)}/s` : ""}${fmtEta(eta) ? ` · ${fmtEta(eta)} left` : ""}`;
