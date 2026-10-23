// What the Live Tracking widget should say, given the route's payload.
//
// Kept PURE, with zero React Native / Expo imports, for the same reason
// reminderSchedule.js is: a widget has no error state a person can read. If this
// picks the wrong people or drops the counts, the result is a blank-looking card
// on somebody's home screen and nothing anywhere says why. So the decisions live
// here and unit-test without a device; utils/liveTrackingWidget.js only writes the
// file. CommonJS so jest reads it without the RN preset.

// Everyone, not a top three: on Android 12+ the widget is a list that scrolls
// inside the card (plugins/withLiveTrackingWidget.js), and older phones show the
// first three of these with "+N more". The cap only guards the size of the
// RemoteViews payload the launcher has to take — far above any real team.
const MAX_ROWS = 100;

// "A timer is running" is activity_kind === 'task' (or the older on_task flag).
// NOT `active`: on this route `active` means "heartbeat is fresh" — at the desk —
// and someone whose laptop slept through a meeting is still on their task.
function onTask(r) {
  return r.activity_kind === 'task' || !!r.on_task;
}

// Away from the desk but working today: a declared break, lunch or meeting.
function away(r) {
  return r.activity_kind === 'break' || r.activity_kind === 'meeting' || r.activity_kind === 'lunch';
}

// Who an admin most wants to see first. Someone actively on a task is the point
// of the screen; someone absent is the least urgent thing to spend a row on.
// Ranked rather than filtered, so a quiet day still fills the widget instead of
// showing an empty card that reads as broken.
function rank(r) {
  if (onTask(r)) return 0;                       // a timer is running
  if (away(r)) return 1;                         // away, but working today
  if (r.day_done) return 2;                      // finished
  if (r.started) return 3;                       // present, nothing running
  return 4;                                      // absent / offline
}

// The header's "as of" clock, as HH:MM in the device's time zone.
//
// The route sends this as a bare UTC datetime ("2026-09-27 05:10:00"): shown as
// it arrives, an IST admin read "as of 05:10" at 10:40, and the widget header had
// a full date and time pushing the title out. Accepts the fixed server (HH:MM)
// and the old one alike, so the widget is right whichever the phone talks to.
function asOfClock(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(Z)?$/.exec(s);
  if (!m) return s;
  const t = Date.parse(`${m[1]}T${m[2]}:00Z`);   // bare = UTC, exactly as Odoo stores it
  if (Number.isNaN(t)) return s;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The names of everything this person has running, oldest first — the order the
// server sends active_tasks in.
function taskNames(r) {
  const tasks = Array.isArray(r.active_tasks) ? r.active_tasks : [];
  return tasks.map((t) => t && t.name).filter(Boolean);
}

// One line of "what are they doing". activity_label is the server's own wording
// and is preferred wherever it exists; the fallbacks only cover the rows where it
// is deliberately blank (idle, offline), which would otherwise render as a gap.
//
// Someone multi-tasking gets EVERY task, not just the first: activity_label names
// only the oldest timer, and the point of this widget is seeing what the whole
// team is on.
function whatFor(r) {
  if (r.day_done) return 'Day ended';
  if (onTask(r)) {
    const names = taskNames(r);
    if (names.length > 1) return names.join(' · ');
  }
  if (r.activity_label) return r.activity_label;
  if (r.activity_kind === 'offline' || r.attendance === 'absent') return 'Absent';
  if (r.started) return 'Idle';
  return 'Not started';
}

/**
 * @param {object} res   the /kpi_owner/live_tracking payload
 * @returns {object} the widget's state file:
 *   { ok, as_of, summary, rows: [{ user_id, name, what, task_count, time }], more, message }
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
    return { ok: false, message: 'Nobody on the team yet', as_of: asOfClock(res.as_of), rows: [], more: 0 };
  }

  // Stable within a rank: the server's order is already meaningful, and
  // re-sorting equal ranks would make the widget reshuffle between refreshes for
  // no reason anybody could see.
  const ordered = all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r) - rank(b.r)) || (a.i - b.i))
    .map((x) => x.r);

  const rows = ordered.slice(0, MAX_ROWS).map((r) => ({
    // So a tap on the row can open that person (plugins/withLiveTrackingWidget.js
    // → krakpi://widget/livetracking?user=<id>). 0 when the server sent none.
    user_id: Number(r.user_id) || 0,
    name: r.name || '—',
    what: whatFor(r),
    task_count: onTask(r) ? Math.max(1, taskNames(r).length) : 0,
    // Blank rather than '0s' when nothing is running: a time next to "Absent"
    // invites the reader to believe it means something.
    time: onTask(r) || away(r) ? (r.elapsed_display || '') : '',
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
    as_of: asOfClock(res.as_of),
    summary: bits.join(' · ') || `${total} on the team`,
    rows,
    more: Math.max(0, ordered.length - rows.length),
  };
}

/** What the widget shows when nobody is signed in on this device. */
function signedOutState() {
  return { ok: false, message: 'Sign in to see Live Tracking', as_of: '', rows: [], more: 0 };
}

/**
 * What the widget shows to someone who is not an admin.
 *
 * The widget is in everybody's picker — the picker cannot filter by role, and
 * hiding it per role left admins without it on several launchers — while the
 * route behind it is admin-only. Saying so beats an empty card.
 */
function adminOnlyState() {
  return { ok: false, message: 'Live Tracking is for admins', as_of: '', rows: [], more: 0 };
}

module.exports = { shapeLiveTracking, signedOutState, adminOnlyState, asOfClock, MAX_ROWS };
