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
  "summary", "action_items", "summary_posted", "notes", "recording_ids", "active_minutes", "log_ids"];
/* The Recording block of the Odoo form. record_meeting carries
   groups="group_kra_admin", so a developer's read must leave these out. */
const RECORDING_FIELDS = ["record_meeting", "recording_state", "recording_detail"];

export const RECORDING_STATES = {
  off: "Not recording", starting: "Starting", running: "Recording",
  no_audio: "Joined but heard nothing", failed: "Could not record", stopped: "Stopped",
};
export const LOG_SOURCES = { web: "Web Dashboard", whatsapp: "WhatsApp", system: "System / ORM" };

export const listMeetings = (domain, limit = 200) =>
  kw("kpi.meeting", "search_read", [domain], { fields: LIST_FIELDS, limit, order: "scheduled_start desc, id desc" });
export const countMeetings = (domain) => kw("kpi.meeting", "search_count", [domain]);
export const readMeeting = async (id, admin = false) =>
  (await kw("kpi.meeting", "read", [[id], admin ? [...FORM_FIELDS, ...RECORDING_FIELDS] : FORM_FIELDS]))?.[0] || null;
export const writeMeeting = (id, vals) => kw("kpi.meeting", "write", [[id], vals]);
export const listParticipants = (meetingId) =>
  kw("kpi.meeting.participant", "search_read", [[["meeting_id", "=", meetingId]]], { fields: ["person_name", "user_id", "joined_at", "left_at", "minutes", "removed_no_reply"], order: "joined_at" });

/* Recordings (many2many_binary on the form): the audio segments the recorder
   bot writes, or a file uploaded by hand. */
export const listRecordings = (ids) => (ids?.length
  ? kw("ir.attachment", "read", [ids, ["name", "mimetype", "file_size", "create_date"]])
  : Promise.resolve([]));
export const recordingUrl = (a) => `/web/content/${a.id}?download=true`;
export async function uploadRecording(meetingId, name, b64, mimetype) {
  const attId = await kw("ir.attachment", "create", [{ name, datas: b64, mimetype: mimetype || undefined, res_model: "kpi.meeting", res_id: meetingId }]);
  await writeMeeting(meetingId, { recording_ids: [[4, attId]] });
  return attId;
}
export const removeRecording = (meetingId, attId) => writeMeeting(meetingId, { recording_ids: [[3, attId]] });

/* The Log page: this meeting's own events from kpi.action.log, newest first
   (the server already orders log_ids). Coordinators and up may read the log. */
export const readLog = (ids) => (ids?.length
  ? kw("kpi.action.log", "read", [ids, ["create_date", "event", "actor_user_id", "source", "payload_json"]])
  : Promise.resolve([]));

/* The link the client is sent: Odoo's own /kpi/meet/<token> page, which embeds
   the room and records who joined. Only asked for once a meeting is confirmed
   (the first call mints the token). */
export const clientLink = (id) => kw("kpi.meeting", "page_url", [[id]]);
/* Attendance: [{name, user, minutes, removed, absent}]. Invited staff who never joined are absent. */
export const attendance = (id) => kw("kpi.meeting", "attendance_sheet", [[id]]);
/* The room for ME: the server names me from my Odoo user, no name screen. → url. */
export const myLink = async (id) => {
  const r = await rpc("/kpi_meeting/my_link", { meeting_id: id });
  if (!r?.status) throw new Error(r?.message || "Could not open the meeting.");
  return r.url;
};

export const confirmMeeting = (id) => kw("kpi.meeting", "action_confirm", [[id]]);
export const openNow = (id) => kw("kpi.meeting", "action_open_now", [[id]]);
export const markDone = (id) => kw("kpi.meeting", "action_mark_done", [[id]]);
export const postSummary = (id) => kw("kpi.meeting", "action_post_summary", [[id]]);
/* "Draft with AI". The Odoo button (action_draft_summary) reports by raising,
   which would roll the written summary back, so call draft_summary itself:
   → [ok, message]. Transcribing the audio can take a while. */
export async function draftSummary(id) {
  const r = await rpc("/web/dataset/call_kw", { model: "kpi.meeting", method: "draft_summary", args: [[id]], kwargs: {} }, { timeout: 300000 });
  return { ok: !!r?.[0], message: r?.[1] || "" };
}
export const cancelMeeting =(id, reason) => kw("kpi.meeting", "action_cancel", [[id]], { reason: reason || "" });

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
