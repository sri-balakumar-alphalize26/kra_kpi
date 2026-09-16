// What the Live Tracking widget should say, given the route's payload.
//
// Kept PURE, with zero React Native / Expo imports, for the same reason
// reminderSchedule.js is: a widget has no error state a person can read. If this
// picks the wrong people or drops the counts, the result is a blank-looking card
// on somebody's home screen and nothing anywhere says why. So the decisions live
// here and unit-test without a device; utils/liveTrackingWidget.js only writes the
// file. CommonJS so jest reads it without the RN preset.

const MAX_ROWS = 3;

// Who an admin most wants to see first. Someone actively on a task is the point
// of the screen; someone absent is the least urgent thing to spend a row on.
// Ranked rather than filtered, so a quiet day still fills the widget instead of
// showing an empty card that reads as broken.
function rank(r) {
  if (r.active) return 0;                        // a timer is running
  if (r.activity_kind === 'break'
      || r.activity_kind === 'meeting'
      || r.activity_kind === 'lunch') return 1;  // away, but working today
  if (r.day_done) return 2;                      // finished
  if (r.started) return 3;                       // present, nothing running
  return 4;                                      // absent / offline
}

// One line of "what are they doing". activity_label is the server's own wording
// and is preferred wherever it exists; the fallbacks only cover the rows where it
// is deliberately blank (idle, offline), which would otherwise render as a gap.
function whatFor(r) {
  if (r.day_done) return 'Day ended';
  if (r.activity_label) return r.activity_label;
  if (r.activity_kind === 'offline' || r.attendance === 'absent') return 'Absent';
  if (r.started) return 'Idle';
  return 'Not started';
}

/**
 * @param {object} res   the /kpi_owner/live_tracking payload
 * @returns {object} the widget's state file:
 *   { ok, as_of, summary, rows: [{ name, what, time }], more, message }
 *
 * `ok: false` carries a `message` the widget prints instead of the counts. A
 * deliberate sentence beats an empty card — "no data yet", "not signed in" and
 * "everyone is off today" look identical otherwise, and all three read as a bug.
 */
function shapeLiveTracking(res) {
  if (!res || res.status === false) {
    return { ok: false, message: 'Could not load Live Tracking', as_of: '', rows: [], more: 0 };
  }

  const all = Array.isArray(res.rows) ? res.rows.filter(Boolean) : [];
  const total = Number.isFinite(res.total) ? res.total : all.length;

  if (!all.length) {
    return { ok: false, message: 'Nobody on the team yet', as_of: res.as_of || '', rows: [], more: 0 };
  }

  // Stable within a rank: the server's order is already meaningful, and
  // re-sorting equal ranks would make the widget reshuffle between refreshes for
  // no reason anybody could see.
  const ordered = all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r) - rank(b.r)) || (a.i - b.i))
    .map((x) => x.r);

  const rows = ordered.slice(0, MAX_ROWS).map((r) => ({
    name: r.name || '—',
    what: whatFor(r),
    // Blank rather than '0s' when nothing is running: a time next to "Absent"
    // invites the reader to believe it means something.
    time: r.active || r.activity_kind === 'break' || r.activity_kind === 'meeting'
      ? (r.elapsed_display || '')
      : '',
  }));

  const present = Number.isFinite(res.present_count) ? res.present_count : null;
  const active = Number.isFinite(res.active_count) ? res.active_count : null;

  // "3/4 present · 2 active". The active half is dropped rather than shown as
  // "0 active", which reads as a failure on a day when nobody has started yet.
  const bits = [];
  if (present != null) bits.push(`${present}/${total} present`);
  if (active) bits.push(`${active} active`);

  return {
    ok: true,
    as_of: res.as_of || '',
    summary: bits.join(' · ') || `${total} on the team`,
    rows,
    more: Math.max(0, ordered.length - rows.length),
  };
}

/** What the widget shows when nobody is signed in on this device. */
function signedOutState() {
  return { ok: false, message: 'Sign in to see Live Tracking', as_of: '', rows: [], more: 0 };
}

module.exports = { shapeLiveTracking, signedOutState, MAX_ROWS };
