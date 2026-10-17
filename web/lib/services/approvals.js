/* The manager-approval layer of kra_kpi_module 19.0.6.2: everything waiting on a
   manager (kpi.approval), developers' questions to the manager (kpi.doubt), and
   who manages each client (kra.master.manager_user_id).

   The rule all of it serves: no developer talks to a client and no client talks
   to a developer; the manager is the only bridge. The module has no HTTP routes
   for these, so they are plain ORM calls (call_kw) and Odoo's ACLs decide; the
   decision logic itself lives in the module (kpi.approval.decide), never here.

   Each decision may finish by posting to WhatsApp. That post can fail (no
   reachable WhatsApp server) without the decision failing, so the screens never
   present "sent on WhatsApp" as the outcome. */
import { rpc } from "@/lib/api";

const kw = (model, method, args = [], kwargs = {}) => rpc("/web/dataset/call_kw", { model, method, args, kwargs }, { timeout: 45000 });

/* kpi.approval.kind, in the Odoo menu's order. `label` is the column text;
   `tab` the short tab name. */
export const KINDS = [
  { key: "new_request", label: "Client raised something", tab: "Client requests" },
  { key: "new_database", label: "New database asked for", tab: "New databases" },
  { key: "disconnect", label: "Asked to be switched off", tab: "Switch-offs" },
  { key: "db_live", label: "Database waiting to go live", tab: "Go-live" },
  { key: "meeting", label: "Meeting asked for", tab: "Meetings" },
  { key: "qa", label: "Work finished, needs checking", tab: "QA checks" },
];
export const kindLabel = (k) => KINDS.find((x) => x.key === k)?.label || k;

/* ---- the approvals desk ---- */
const APPROVAL_FIELDS = ["kind", "res_model", "res_id", "reference", "name", "detail", "client_kra_id", "requested_on",
  "requested_by", "approve_label", "reject_label", "waiting_days"];
export const waitingCounts = () => kw("kpi.approval", "waiting_counts", []);
export const listApprovals = () => kw("kpi.approval", "search_read", [[]], { fields: APPROVAL_FIELDS, limit: 500, order: "requested_on desc, id desc" });

/* Approve / Refuse. A decision that needs nothing more (approve QA, approve
   go-live) is done here and answers a notification; anything else answers an
   act_window for the decide dialog, whose context carries the prefills. */
function outcome(res, decision) {
  if (res && res.type === "ir.actions.client") return { done: true, message: (res.params && res.params.message) || "Done." };
  if (res && res.type === "ir.actions.act_window") return { done: false, decision, context: res.context || {}, title: res.name || "" };
  return { done: true, message: "Done." };
}
export const approve = async (row) => outcome(await kw("kpi.approval", "action_approve", [[row.id]]), "approve");
export const reject = async (row) => outcome(await kw("kpi.approval", "action_reject", [[row.id]]), "reject");

/* The decide dialog's record: created with the context action_approve/reject
   handed back (so the module's own defaults apply), then applied. */
export async function decide(vals, context = {}) {
  const id = await kw("kpi.approval.decide", "create", [vals], { context });
  const res = await kw("kpi.approval.decide", "action_apply", [[id]], { context });
  return (res && res.params && res.params.message) || "Done.";
}
export const declineReasons = () =>
  kw("kpi.decline.reason", "search_read", [[["mode", "in", ["decline", "both"]]]], { fields: ["name"], order: "sequence, name" })
    .catch(() => kw("kpi.decline.reason", "search_read", [[["mode", "in", ["decline", "both"]]]], { fields: ["name"], order: "name" }));

/* Who can manage a client: Odoo only accepts a coordinator (admin), owner or
   System user. Owner and System imply admin, so all_group_ids covers all three. */
let adminGroupId = null;
async function kraAdminGroup() {
  if (adminGroupId) return adminGroupId;
  const r = await kw("ir.model.data", "search_read", [[["module", "=", "kra_kpi_module"], ["name", "=", "group_kra_admin"]]], { fields: ["res_id"], limit: 1 });
  adminGroupId = r?.[0]?.res_id || null;
  return adminGroupId;
}
export async function coordinators() {
  const gid = await kraAdminGroup();
  if (!gid) return [];
  return kw("res.users", "search_read", [[["share", "=", false], ["all_group_ids", "in", [gid]]]], { fields: ["name", "login"], order: "name" });
}

/* ---- who manages each client ---- */
export const coverage = () => kw("kra.master", "manager_coverage", []);
export const clientManagers = () =>
  kw("kra.master", "search_read", [[["parent_id", "=", false]]], { fields: ["name", "manager_user_id", "manager_ready"] });
export const setManager = (kraId, userId) => kw("kra.master", "write", [[kraId], { manager_user_id: userId || false }]);

/* ---- developers' questions to the manager (kpi.doubt) ---- */
export const DOUBT_KINDS = [
  { key: "question", label: "A question" },
  { key: "meet_admin", label: "Meet the manager" },
  { key: "meet_client", label: "Need a client meeting" },
];
export const doubtKindLabel = (k) => ({ question: "Question", meet_admin: "Meet the manager", meet_client: "Client meeting", escalation: "Escalation" })[k] || k;
export const DOUBT_STATES = {
  open: ["paused", "Waiting for the manager"],
  answered: ["done", "Answered"],
  released: ["review", "Sent to the client"],
  client_replied: ["review", "Client replied"],
  rejected: ["neutral", "Not now"],
  closed: ["neutral", "Closed"],
};
const DOUBT_FIELDS = ["display_ref", "kpi_id", "task_ref", "client_kra_id", "kind", "question", "raised_by_id", "manager_user_id",
  "state", "answer", "answered_by_id", "answered_at", "client_posted_at", "client_answer", "meeting_id", "create_date"];
export const listDoubts = (states) =>
  kw("kpi.doubt", "search_read", [states && states.length ? [["state", "in", states]] : []], { fields: DOUBT_FIELDS, limit: 300, order: "create_date desc" });
export const taskDoubts = (kpiId) =>
  kw("kpi.doubt", "search_read", [[["kpi_id", "=", Number(kpiId)]]], { fields: DOUBT_FIELDS, order: "create_date desc" });
export const countOpenDoubts = () => kw("kpi.doubt", "search_count", [[["state", "=", "open"]]]);
/* The asker is the signed-in person (the model's default); the module works out
   the manager and asks them. */
export const createDoubt = ({ kpiId, kind, question }) =>
  kw("kpi.doubt", "create", [{ kpi_id: Number(kpiId), kind, question }]);
/* Manager-only. The module does not check the caller on these, so the web only
   ever shows them to admins. */
export const answerDoubt = (id, text) => kw("kpi.doubt", "action_answer", [[id], text]);
export const releaseDoubt = (id, text) => kw("kpi.doubt", "action_release_to_client", [[id], text || false]);
export const meetingFromDoubt = (id) => kw("kpi.doubt", "action_make_meeting", [[id]]);
export const rejectDoubt = (id, note) => kw("kpi.doubt", "action_reject", [[id], note || ""]);

/* ---- a task's correction history (the client's first wording) ---- */
export const taskCorrection = async (kpiId) =>
  (await kw("kra.kpi", "read", [[Number(kpiId)], ["original_client_text", "correction_round", "last_correction_text"]]))?.[0] || null;
