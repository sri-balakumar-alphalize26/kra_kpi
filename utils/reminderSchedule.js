// The two decisions behind arming a reminder: when the server means, and which
// reminders deserve an alarm at all.
//
// Kept PURE, with zero React Native / Expo imports, for the same reason
// workdayState.js is: these are the parts that can be silently wrong, and this
// way they unit-test under plain `jest` without a device. CommonJS so jest reads
// them without the RN preset. services/reminderAlarm.js does the scheduling; it
// makes no judgements of its own.

// Odoo hands back a NAIVE-UTC datetime: 'YYYY-MM-DD HH:MM:SS', no T, no Z.
//
// `new Date('2026-09-12 19:30:00')` is read by JS as LOCAL time. At +05:30 that
// is 5 hours 30 minutes adrift — every evening reminder would fire in the
// afternoon, and the bug would look like a server problem. The T and the Z are
// what make the string mean what the server meant.
//
// Returns epoch ms, or null for anything unparseable.
function parseServerUtc(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}

// Which rows should have an alarm scheduled, given the time now.
//
// Two rules that are easy to get wrong:
//
//  * `enabled` MUST be checked here. kpi_reminder.py's _compute_next_trigger
//    does not depend on it, so a reminder switched off still carries a perfectly
//    good future next_trigger. Arm on that alone and disabled reminders ring.
//
//  * Past-due is NOT armed. A repeating reminder whose owner never pressed Done
//    keeps its old next_trigger — scheduling that would fire the moment the app
//    opens, for something that was due yesterday. The list already shows it as
//    due, which is the right place to notice.
//
// `skewMs` is a small guard so a reminder due this very second is not armed for
// an instant that passes while we are still scheduling it.
function armableReminders(rows, nowMs, skewMs = 1000) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    if (r.enabled === false) continue;
    const at = parseServerUtc(r.next_trigger);
    if (at == null || at <= nowMs + skewMs) continue;
    out.push({ id: String(r.id), at, name: r.name || 'Reminder' });
  }
  return out;
}

module.exports = { parseServerUtc, armableReminders };
