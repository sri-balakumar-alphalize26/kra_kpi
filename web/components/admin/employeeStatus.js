/* How the Dashboard describes a person right now, from a live-tracking row
   (merged with the overview's numbers). Shared by the employee card
   (DashboardTop.jsx) and the employee popup (EmployeePopup.jsx), so both say
   the same thing. */
export const pad = (n) => String(n).padStart(2, "0");
export const hm = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
export const mins = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m} min` : hm(secs); };
/* "14:10" → "2:10 PM" */
export const clock = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "AM" : "PM"}`; };

export const ST = { working: "Working", break: "On break", lunch: "Lunch", absent: "Absent" };
export const TS = { running: "Running", paused: "Paused", todo: "To do", done: "Done", approval: "Approval", hold: "On hold" };

export function statusOf(p) {
  if (p.activity_kind === "break") return "break";
  if (p.activity_kind === "lunch") return "lunch";
  if (p.started) return "working";
  return "absent";
}

/* [headline, detail] for the coloured strip. */
export function cardText(p, s = statusOf(p)) {
  const t = p.active_tasks?.[0];
  if (s === "working") {
    if (t) return [`Working on ${t.ref || t.name} · ${hm(t.elapsed_seconds)}`, t.start ? `Started ${clock(t.start)}` : t.name];
    if (p.activity_kind === "meeting") return [`In a meeting · ${mins(p.elapsed_seconds)}`, p.activity_note || ""];
    if (p.activity_kind === "no_tasks") return ["No task to work on", p.activity_note || ""];
    return ["Idle · no task running", p.active ? "At the desk" : "Away from the desk"];
  }
  if (s === "break" || s === "lunch") {
    const head = `${s === "lunch" ? "At lunch" : "On break"} · ${mins(p.elapsed_seconds)}`;
    const pt = p.paused_task;
    return [head, pt ? `Paused ${pt.ref || pt.name}${p.break_start ? ` at ${clock(p.break_start)}` : ""}` : p.activity_note || ""];
  }
  if (p.day_done) return ["Workday ended", p.arrival ? `Was in from ${clock(p.arrival)}` : ""];
  return ["Absent", p.attendance === "pending" ? "Not checked in yet" : "No workday started today"];
}

export const since = (p) => (p.arrival ? `${p.attendance === "late" ? "late, " : ""}in ${clock(p.arrival)}` : "not checked in");
