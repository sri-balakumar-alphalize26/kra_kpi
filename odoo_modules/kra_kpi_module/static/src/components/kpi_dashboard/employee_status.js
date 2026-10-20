/** @odoo-module **/
/* How the Dashboard describes a person right now, from a live-tracking row
   (merged with the overview's numbers). Shared by the employee card
   (kpi_dashboard.js) and the employee popup (kpi_dashboard_popups.js), so both
   say the same thing. Copy of web/components/admin/employeeStatus.js — change
   both together, or the web and Odoo dashboards will tell different stories. */
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

/* "Reason: emergency outing · at 7:29 PM" for a paused task (the same reason
   the task card in the app shows). */
export const pauseWhy = (t) => [t && t.reason ? `Reason: ${t.reason}` : "", t && t.at ? `at ${clock(t.at)}` : ""].filter(Boolean).join(" · ");

/* [headline, detail] for the coloured strip. */
export function cardText(p, s = statusOf(p)) {
    const t = p.active_tasks && p.active_tasks[0];
    if (s === "working") {
        if (t) return [`Working on ${t.ref || t.name} · ${hm(t.elapsed_seconds)}`, t.start ? `Started ${clock(t.start)}` : t.name];
        if (p.activity_kind === "meeting") return [`In a meeting · ${mins(p.elapsed_seconds)}`, p.activity_note || ""];
        if (p.activity_kind === "no_tasks") return ["No task to work on", p.activity_note || ""];
        const pt = p.paused_task;
        if (pt) return [`Idle · paused ${pt.ref || pt.name}`, pauseWhy(pt) || (p.active ? "At the desk" : "Away from the desk")];
        return ["Idle · no task running", p.active ? "At the desk" : "Away from the desk"];
    }
    if (s === "break" || s === "lunch") {
        const head = `${s === "lunch" ? "At lunch" : "On break"} · ${mins(p.elapsed_seconds)}`;
        const pt = p.paused_task;
        const at = p.break_start || (pt && pt.at);
        return [head, pt ? `Paused ${pt.ref || pt.name}${at ? ` at ${clock(at)}` : ""}${pt.reason ? ` — ${pt.reason}` : ""}` : p.activity_note || ""];
    }
    if (p.day_done) return ["Workday ended", p.arrival ? `Was in from ${clock(p.arrival)}` : ""];
    return ["Absent", p.attendance === "pending" ? "Not checked in yet" : "No workday started today"];
}

/* Order on the dashboard: who is working first, then breaks, lunch, absent. */
export const STATUS_ORDER = { working: 0, break: 1, lunch: 2, absent: 3 };

/* Live timers: the row's elapsed seconds were true when the poll arrived;
   add the time since then so break / lunch / task durations count up between
   polls (the dashboard re-renders every minute). */
export function liveRow(p, sinceMs) {
    const extra = Math.max(0, Math.floor(sinceMs / 1000));
    if (!extra) return p;
    return {
        ...p,
        elapsed_seconds: (p.elapsed_seconds || 0) + (p.started ? extra : 0),
        active_tasks: (p.active_tasks || []).map((t) => ({ ...t, elapsed_seconds: (t.elapsed_seconds || 0) + extra })),
    };
}

/* Amber past 15 min break / 45 min lunch, red past 30 / 60. */
const LIMITS = { break: [15, 30], lunch: [45, 60] };
export function timerLevel(p, s = statusOf(p)) {
    const lim = LIMITS[s];
    if (!lim) return "";
    const m = (p.elapsed_seconds || 0) / 60;
    return m >= lim[1] ? "late" : m >= lim[0] ? "warn" : "";
}

export const since = (p) => (p.arrival ? `${p.attendance === "late" ? "late, " : ""}in ${clock(p.arrival)}` : "not checked in");

/* Shared bits for the Odoo port. */
export const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
export const hue = (id) => (Number(id || 0) * 47) % 360;
export const avatarUrl = (uid) => `/web/image/res.users/${uid}/avatar_128`;
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dmy = (s, o = { day: "numeric", month: "short" }) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", o) : "");
export const loadLs = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; } };
export const saveLs = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
/* Where each web route lives in Odoo (the popup buttons). */
export const ACT = {
    queue: "kra_kpi_module.action_kpi_pending_queue",
    board: "kra_kpi_module.action_kpi_action_screen",
    live: "kra_kpi_module.action_kpi_live_tracking",
    cert: "kra_kpi_module.action_kpi_completion_certificate",
    appr: "kra_kpi_module.action_kpi_approval",
    bill: "kra_kpi_module.action_kpi_owner_dashboard",
    work: "kra_kpi_module.action_kpi_period_report",
    inv: "kra_kpi_module.action_kpi_client_invoice_admin",
    snap: "kra_kpi_module.action_kpi_workday_snapshot",
};
