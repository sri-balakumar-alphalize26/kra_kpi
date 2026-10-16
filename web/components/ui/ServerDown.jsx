"use client";
/* "Server not reachable": a little server box runs along and hops an
   unplugged cable under a no-signal badge. Full size on the sign-in gate;
   `compact` inside a page (ErrorState uses it when the error is "offline").
   Styles: serverdown.css (theme tokens; LEDs/box keep illustration colours).
   Plain .btn buttons, not <Button>, so this file needn't import the UI index
   (which imports it). */
export default function ServerDown({ message = "Can't reach the server. Try again in a moment.", onRetry, onSignOut, compact = false }) {
  return (
    <div className={`sd-card ${compact ? "compact" : ""}`} role="alert">
      <svg className="sd-scene" viewBox="0 0 340 120" aria-hidden="true">
        <path className="sd-cloud" d="M250 30h34a8 8 0 0 0 0-16 11 11 0 0 0-21-3 8 8 0 0 0-13 19z" />
        <path className="sd-cloud c2" d="M330 46h26a6 6 0 0 0 0-12 9 9 0 0 0-17-2 6 6 0 0 0-9 14z" />
        <g transform="translate(300 16)" fill="none" strokeWidth="2.4" strokeLinecap="round" className="sd-badge">
          <g className="sd-signal"><path d="M2 14a14 14 0 0 1 20 0" /><path d="M6 18a8 8 0 0 1 12 0" /><path d="M11 22.5h2" /></g>
          <path className="sd-slash" d="M2 4l20 20" stroke="#ef4444" />
        </g>
        <line className="sd-ground" x1="0" y1="100" x2="340" y2="100" />
        <g className="sd-pebble"><circle cx="90" cy="107" r="1.6" /><circle cx="210" cy="109" r="1.2" /><circle cx="300" cy="106" r="1.4" /><circle cx="470" cy="107" r="1.6" /><circle cx="590" cy="109" r="1.2" /><circle cx="680" cy="106" r="1.4" /></g>
        <g className="sd-plug">
          <g transform="translate(345 0)" fill="none" stroke="#64748b" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 100v-8c0-5 4-7 4-12" />
            <rect x="5" y="70" width="16" height="11" rx="3" fill="#e2e8f0" />
            <path d="M9 70v-6M17 70v-6" />
          </g>
        </g>
        <g className="sd-runner"><g transform="translate(46 0)">
          <g fill="none" stroke="#475569" strokeWidth="2.6" strokeLinecap="round">
            <path className="sd-leg" d="M10 90v10" /><path className="sd-leg l2" d="M22 90v10" />
          </g>
          <g className="sd-bob">
            <rect x="2" y="56" width="28" height="35" rx="6" fill="#f1f5f9" stroke="#475569" strokeWidth="2.6" />
            <path d="M2 73h28" stroke="#475569" strokeWidth="2" />
            <g className="sd-eyes" fill="#334155"><circle cx="11" cy="65" r="2.1" /><circle cx="21" cy="65" r="2.1" /></g>
            <rect x="7" y="79" width="11" height="3" rx="1.5" fill="#94a3b8" />
            <circle className="sd-led" cx="23" cy="80.5" r="2" fill="#ef4444" />
            <circle className="sd-led b" cx="23" cy="86" r="2" fill="#f59e0b" />
            <path className="sd-sweat" d="M33 60c2 3 2 5 0 6-2-1-2-3 0-6z" fill="#60a5fa" />
          </g>
        </g></g>
      </svg>
      <h2>Server not reachable</h2>
      <p>{message}</p>
      {(onRetry || onSignOut) && (
        <div className="sd-btns">
          {onRetry && <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>}
          {onSignOut && <button type="button" className="btn btn-ghost" onClick={onSignOut}>Sign out</button>}
        </div>
      )}
    </div>
  );
}
