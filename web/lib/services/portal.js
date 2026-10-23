/* Client portal services (port of services/clientPortal.js, preApproval.js
   and the client side of clientInvoices.js). */
import { rpc, read, href, assertOk, upload } from "@/lib/api";

export const DASH_PATH = "/kpi_client_portal/dashboard";
/* state: 'all' | a task_state. Answers { authorized, message, kpis, totals, by_type, pending_approvals, clients }. */
export const fetchClientDashboard = (state = "all") => read(DASH_PATH, { state }, { ttl: 10000 });
export const fetchClientProjects = () => read("/kpi_client_portal/get_projects", {}, { ttl: 60000 }).then((r) => r?.projects || []);

/* NB: the dashboard's pending_approvals are SIGN-OFF items (awaiting_client, or
   legacy partially_completed + admin_approved). Tasks waiting for the client's
   go-ahead on the developer/estimate come from /kpi_pre_approval/list instead:
   {kpis:[{id,name,kind,external_ref,description,project_name,priority,task_state,
   developer,deadline_at,server_now,auto_releases,auto_released,released_at,held}]}. */
export const PRE_LIST_PATH = "/kpi_pre_approval/list";

/* The client's WhatsApp-only pages, from here (controllers/kpi_client_links.py).
   info → { has_group, declined:[{id, ref, name, reason, declined_at, declined_by, url}],
   live_dbs:[{id, name, label, server, created, expires}], can_destroy }.
   dbFormLink / chatLink → { url } (a fresh link to the same page WhatsApp sends). */
export const LINKS_PATH = "/kpi_client_portal/links/info";
export const dbFormLink = (kind) => rpc("/kpi_client_portal/links/db_form", { kind }).then(assertOk);
export const chatLink = (kpiId) => rpc("/kpi_client_portal/links/chat", kpiId ? { kpi_id: kpiId } : {}).then(assertOk);

/* Sign-off on a finished task (client_approval), and the developer/estimate
   pre-approval (pre_approval/decide: approve | reject | hold | resume). */
export const signOff = (kpiId, { signatureText, notes } = {}) =>
  rpc("/kpi_client_approval/approve", { kpi_id: kpiId, signature_text: (signatureText || "").trim(), chk_delivered: true, chk_works: true, chk_authorized: true, notes: notes || "" });
/* ↩ Send back. With proof (photos / videos / voice notes) it is one multipart
   post, the files as repeated `files`; without, the plain JSON route. */
export const sendBack = (kpiId, reason, files = []) => (files.length
  ? upload("/kpi_client_approval/reject_files", (() => {
    const fd = new FormData();
    fd.append("kpi_id", String(kpiId)); fd.append("reason", (reason || "").trim()); fd.append("source", "web");
    for (const f of files) fd.append("files", f, f.name);
    return fd;
  })(), { timeout: 300000 })
  : rpc("/kpi_client_approval/reject", { kpi_id: kpiId, reason: (reason || "").trim(), source: "web" }));
/* approve/reject go through record_client_pre_decision, whose status is a
   STRING (ok | already_decided | expired | invalid) spread over the route's
   boolean — so "already_decided" would read as success. Only true/"ok" pass. */
const DECIDE_FAIL = { already_decided: "This was already decided — refresh to see where it stands.", expired: "This approval has expired.", invalid: "That decision was not accepted." };
export async function decidePreApproval(kpiId, action, feedback) {
  const res = await rpc("/kpi_pre_approval/decide", { kpi_id: kpiId, action, feedback: feedback || "" });
  const st = res?.status;
  if (st === true || st === "ok") return { ...res, status: true };
  return { ...(res || {}), status: false, message: res?.message || DECIDE_FAIL[st] || "Could not save your decision." };
}
/* Several finished tasks signed off at once. Answers {approved:[id], skipped:[{id,name,reason}], message};
   partial success is normal. */
export const signOffBulk = (kpiIds, { signatureText, notes } = {}) =>
  rpc("/kpi_client_approval/approve_bulk", { kpi_ids: kpiIds.map(Number), signature_text: (signatureText || "").trim(), chk_delivered: true, chk_works: true, chk_authorized: true, notes: notes || "" }, { timeout: 120000 });
/* Certificate data for one task under review: {company_name, client_name, project_name, kpi:{…}, contributors, …}. */
export const fetchApprovalDetail = (kpiId) => rpc("/kpi_client_approval/get", { kpi_id: Number(kpiId) });
/* Tasks waiting on this client's sign-off. */
export const APPROVAL_LIST_PATH = "/kpi_client_approval/list";
export const REJECT_REASONS = [
  { code: "different_dev", label: "Want a different developer", emoji: "🔁" },
  { code: "wrong_details", label: "Task details are wrong", emoji: "📝" },
  { code: "not_needed", label: "Not needed anymore", emoji: "🚫" },
  { code: "other", label: "Other", emoji: "✍" },
];

/* Signature image used on certificates. */
export const fetchSignature = () => rpc("/kpi_client_portal/get_signature_info", {}).then((r) => ({ hasSignature: !!r?.has_signature, imageB64: r?.image_b64 || "" })).catch(() => ({ hasSignature: false, imageB64: "" }));
export const uploadSignature = (fileData, fileName) => rpc("/kpi_client_portal/upload_signature", { file_data: fileData || "", file_name: fileName || "" });
/* No separate delete route: an empty file_data clears the saved image (Odoo's Remove). */
export const removeSignature = () => rpc("/kpi_client_portal/upload_signature", { file_data: "", file_name: "" });
export const certificateHref =(kpiId) => href(`/kpi_client_portal/download_cert?kpi_id=${kpiId}`);

/* One request from the portal. needed_by / attachments are new on 19.0.5.7.
   legacy*: a Bug / Update about an old-DB requirement (no parent to pick);
   the server checks it says enough (lib/services/legacy legacyProblem). */
export const addClientTask = ({ subKraId, kind, name, description, priority, deliverableType, deliverableOther, neededBy, attachments, parentId, legacyOn, legacyRef, legacyName, legacyNote }) =>
  rpc("/kpi_client_portal/add_task", {
    sub_kra_id: subKraId, kind: kind || "requirement", name: name || "", description: description || "", priority: priority || "regular", parent_id: parentId || 0,
    deliverable_type: deliverableType || "", deliverable_other: deliverableOther || "", needed_by: neededBy || "", attachments: attachments || [],
    legacy_on: !!legacyOn, legacy_ref: legacyOn ? legacyRef || "" : "", legacy_name: legacyOn ? legacyName || "" : "", legacy_note: legacyOn ? legacyNote || "" : "",
  }, { timeout: 120000 });

/* The requirements a Bug / Update can be about, newest first: [{id, ref, name, date, db, old}]
   (old: an old-DB requirement already added here). */
/* Bugs / updates already raised under a requirement, and the next ref:
   {items: [{ref, name, status, date}], next_ref, parent}. */
export const fetchChildren = (parentId, kind) => rpc("/kpi_client_portal/children", { parent_id: Number(parentId), kind }).then((r) => (r?.status ? r : null));
export const fetchParentTasks =(subKraId) => rpc("/kpi_client_portal/parent_tasks", { sub_kra_id: subKraId ? Number(subKraId) : 0 }).then((r) => (r?.status ? r.tasks || [] : []));

/* Invoices (client view). */
export const INVOICES_PATH = "/kpi_client_invoice/list";
export const fetchInvoices = (statusFilter = "all") => read(INVOICES_PATH, { status_filter: statusFilter }, { ttl: 15000 });
export const fetchInvoice = (id) => rpc("/kpi_client_invoice/get", { invoice_id: Number(id) }).then((r) => (r?.status ? r.data : null));
export const PAYMENT_METHODS = [
  { code: "bank_transfer", label: "Bank transfer" }, { code: "cash", label: "Cash" }, { code: "cheque", label: "Cheque" },
  { code: "card", label: "Card" }, { code: "other", label: "Other" },
];
/* The branded invoice PDF; the route is record-rule scoped, so clients may call it. */
export const invoicePdf = (id) => rpc("/kpi_client_invoice/pdf", { invoice_id: Number(id) }, { timeout: 90000 });
export const clientMarkPaid = (invoiceId, method, note) => rpc("/kpi_client_invoice/client_mark_paid", { invoice_id: Number(invoiceId), method: method || "", note: note || "" });
export const invoiceTone = (inv) => (inv.payment_status === "paid" ? "done" : inv.client_paid_claim ? "review" : inv.state === "sent" ? "progress" : inv.state === "finalized" ? "progress" : "todo");
export const invoiceLabel = (inv) => (inv.payment_status === "paid" ? "Paid" : inv.client_paid_claim ? "Payment claimed" : inv.state === "sent" ? "Sent" : inv.state === "finalized" ? "Finalized" : inv.state === "draft" ? "Draft" : inv.state);
export const money = (n, cur = "₹") => `${cur} ${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export { assertOk };
