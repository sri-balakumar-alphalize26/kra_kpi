/* My Work › Meetings — Odoo's kpi.meeting (views/kpi_meeting_views.xml).
   No custom routes: plain ORM calls (call_kw), like the Odoo form, so Odoo's
   ACLs decide who may do what (admins / owners / System: everything;
   developers: read and edit, never create or delete). Each lifecycle button
   is the model's own action_* method — the WhatsApp posts happen there. */
import { rpc } from "@/lib/api";

const kw = (model, method, args = [], kwargs = {}) => rpc("/web/dataset/call_kw", { model, method, args, kwargs }, { timeout: 45000 });

export const STATES = {
  requested: ["paused", "Waiting to confirm"],
  confirmed: ["review", "Confirmed"],
  live: ["progress", "Open now"],
  done: ["done", "Finished"],
  cancelled: ["neutral", "Cancelled"],
};

/* The Odoo search filters, in the same order. */
export const FILTERS = [
  { key: "requested", label: "Waiting", domain: [["state", "=", "requested"]] },
  { key: "confirmed", label: "Confirmed", domain: [["state", "=", "confirmed"]] },
  { key: "live", label: "Open now", domain: [["state", "=", "live"]] },
  { key: "done", label: "Finished", domain: [["state", "=", "done"]] },
  { key: "all", label: "All", domain: [] },
];

const LIST_FIELDS = ["name", "kpi_id", "client_kra_id", "scheduled_start", "duration_minutes", "local_when", "requested_text",
  "organizer_id", "requested_by_name", "state", "actual_minutes", "participant_summary", "is_internal"];
const FORM_FIELDS = [...LIST_FIELDS, "client_db_id", "attendee_user_ids", "requested_by_number", "provider", "join_url", "room_name",
  "confirmed_by_id", "confirmed_at", "reminder_sent_at", "link_posted_at", "opened_at", "ended_at", "cancel_reason",
  "summary", "action_items", "summary_posted", "notes"];

export const listMeetings = (domain, limit = 200) =>
  kw("kpi.meeting", "search_read", [domain], { fields: LIST_FIELDS, limit, order: "scheduled_start desc, id desc" });
export const countMeetings = (domain) => kw("kpi.meeting", "search_count", [domain]);
export const readMeeting = async (id) => (await kw("kpi.meeting", "read", [[id], FORM_FIELDS]))?.[0] || null;
export const writeMeeting = (id, vals) => kw("kpi.meeting", "write", [[id], vals]);
export const listParticipants = (meetingId) =>
  kw("kpi.meeting.participant", "search_read", [[["meeting_id", "=", meetingId]]], { fields: ["person_name", "joined_at", "left_at", "minutes"], order: "joined_at" });

/* The link the client is sent: Odoo's own /kpi/meet/<token> page, which embeds
   the room and records who joined. Only asked for once a meeting is confirmed
   (the first call mints the token). */
export const clientLink = (id) => kw("kpi.meeting", "page_url", [[id]]);

export const confirmMeeting = (id) => kw("kpi.meeting", "action_confirm", [[id]]);
export const openNow = (id) => kw("kpi.meeting", "action_open_now", [[id]]);
export const markDone = (id) => kw("kpi.meeting", "action_mark_done", [[id]]);
export const postSummary = (id) => kw("kpi.meeting", "action_post_summary", [[id]]);
export const cancelMeeting = (id, reason) => kw("kpi.meeting", "action_cancel", [[id]], { reason: reason || "" });

/* Odoo datetimes are UTC "YYYY-MM-DD HH:MM:SS"; <input type="datetime-local">
   is the browser's local time "YYYY-MM-DDTHH:MM". */
export function toLocalInput(ts) {
  if (!ts) return "";
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  if (!v) return false;
  const d = new Date(v);
  return isNaN(d) ? false : d.toISOString().slice(0, 19).replace("T", " ");
}
