/* KRA / KPI › Client Talks: 💬 Discussions · 📅 Meetings · ❓ Questions, and
   📅 Meetings in a task's details. Odoo's routes (controllers/kpi_talks_api.py),
   which group a chat by date and into talks (a new talk after 60 minutes of
   quiet) and lay each meeting out as one card. Each list already holds only
   what the caller may see: admins everything, developers their own. */
import { rpc } from "@/lib/api";

const ok = (r, what) => {
  if (!r || r.status === false) throw new Error(r?.message || `Could not load the ${what}.`);
  return r;
};

/* tab: task | general · filter: waiting | all → { rows, counts:{task, general, waiting_task, waiting_general} } */
export const fetchDiscussions = (tab, filter, search) =>
  rpc("/kpi_action/talks/discussions", { tab, filter, search: search || "" }).then((r) => ok(r, "discussions"));
/* One chat → { kpi_id, is_general, ref, title, client, count, days:[{date, label, sessions:[{n, start, end, count, status, by, gap_min, messages}]}] } */
export const fetchThread = (kpiId) => rpc("/kpi_action/talks/thread", { kpi_id: kpiId }).then((r) => ok(r, "chat"));
/* tab: task | general · filter: upcoming | past | all → { days:[{date, label, upcoming, meetings:[card]}], counts } */
export const fetchTalkMeetings = (tab, filter, search) =>
  rpc("/kpi_action/talks/meetings", { tab, filter, search: search || "" }).then((r) => ok(r, "meetings"));
/* The meetings on one task → { count, days } */
export const fetchTaskMeetings = (kpiId) => rpc("/kpi_action/meetings", { kpi_id: kpiId }).then((r) => ok(r, "meetings"));
/* filter: open | answered | all → { rows, counts:{open, answered} } */
export const fetchQuestions = (filter, search) =>
  rpc("/kpi_action/talks/questions", { filter, search: search || "" }).then((r) => ok(r, "questions"));

/* One colour per talk in a day, in turn: blue, amber, green, violet (Odoo TALK_COLOURS). */
export const TALK_COLOURS = [
  { bar: "#2F6FDB", band: "#EAF1FD", text: "#1D4FA8" },
  { bar: "#B45309", band: "#FDF3E4", text: "#8A4108" },
  { bar: "#15803D", band: "#E8F6EE", text: "#0F5E2D" },
  { bar: "#7C3AED", band: "#F1EBFD", text: "#5B21B6" },
];
export const colour = (i) => TALK_COLOURS[i % TALK_COLOURS.length];

export const gapLabel = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`);
export const ageLabel = (min) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`);
export const kindIcon = (k) => ({ client_msg: "💬", client_meet: "📅", meet_admin: "📅", meet_client: "📅", escalation: "⬆️" }[k] || "🙋");
