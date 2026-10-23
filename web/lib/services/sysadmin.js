/* Odoo's Setup / Settings admin screens that have no custom routes: plain ORM
   calls (call_kw) on kpi.config.screen, kpi.work.session, kpi.backup and the
   cleanup models, plus the /kpi_cleanup/* routes (proxied for System admins
   only — see app/api/kpi/[...path]/route.js). Odoo's ACLs re-check every call. */
import { rpc, href } from "@/lib/api";

const kw = (model, method, args = [], kwargs = {}, timeout) => rpc("/web/dataset/call_kw", { model, method, args, kwargs }, { timeout });
const LONG = 10 * 60 * 1000; /* backups and cleanups run synchronously in Odoo */

/* Model methods answer {status:false,message} (work sessions, routes) or raise
   a UserError (backup, cleanup) — the latter arrives as a thrown ApiError. */
export function ok(res, fallback = "Request failed.") {
  if (res && res.status === false) throw new Error(res.message || res.error || fallback);
  return res;
}
/* An ir.actions.client display_notification's text, if a method returned one. */
export const notice = (res) => (res && res.params && (res.params.message || res.params.title)) || "";

/* Odoo datetimes are UTC "YYYY-MM-DD HH:MM:SS". */
export function local(ts, { date = false } = {}) {
  if (!ts) return "—";
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  if (isNaN(d)) return ts;
  return date ? d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export const m2o = (v) => (Array.isArray(v) ? v[1] : "");
export const hm = (sec) => { const s = Math.max(0, Math.round(sec || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/* ---- Setup › KPI configuration (kpi.config.screen: the "Actions" catalogue) ---- */
export const listConfigScreens = () => kw("kpi.config.screen", "search_read", [[]], { fields: ["name", "url", "active"], order: "name", context: { active_test: false } });
export const createConfigScreen = (vals) => kw("kpi.config.screen", "create", [[vals]]);
export const writeConfigScreen = (id, vals) => kw("kpi.config.screen", "write", [[id], vals]);
export const deleteConfigScreen = (id) => kw("kpi.config.screen", "unlink", [[id]]);

/* ---- Settings › Workday sessions (kpi.work.session) ---- */
export const SESSION_FIELDS = ["user_id", "session_date", "login_at", "logout_at", "state", "auto_closed", "reverted", "reverted_by_id", "revert_reason", "is_paused", "paused_seconds", "productive_seconds", "presence_seconds", "task_count", "note"];
export const listSessions = (domain, limit, offset = 0) => kw("kpi.work.session", "search_read", [domain], { fields: SESSION_FIELDS, limit, offset, order: "session_date desc, login_at desc" });
export const countSessions = (domain) => kw("kpi.work.session", "search_count", [domain]);
export const revertWorkday = (userId, reason) => rpc("/kpi_workday/revert", { user_id: userId, reason }, { timeout: 45000 });

/* ---- Settings › Backup & restore (kpi.backup) — never read backup_file in lists ---- */
export const INCLUDES = [["include_kra", "KRAs"], ["include_kpi", "KPIs / tasks"], ["include_progress", "Progress"], ["include_manuals", "User manuals"], ["include_github", "GitHub links"], ["include_reassignments", "Reassignments"], ["include_reports", "Reports"], ["include_attachments", "Attachments"]];
export const BACKUP_FIELDS = ["name", "backup_date", "backup_type", "backup_size", "backup_filename", "kra_count", "kpi_count", "attachment_count", "links_count", "state", "is_restored", "restored_date", "restored_by", "error_log", "notes",
  "reference_date", "last_full_backup_id", "last_full_backup_date"];
export const listBackups = () => kw("kpi.backup", "search_read", [[]], { fields: BACKUP_FIELDS, limit: 100, order: "create_date desc" });
export const createBackupRecord = (vals) => kw("kpi.backup", "create", [[vals]]);
export const runBackup = (id) => kw("kpi.backup", "action_create_backup", [[id]], {}, LONG);
export const restoreBackup = (id) => kw("kpi.backup", "action_restore_backup", [[id]], {}, LONG);
export const deleteBackup = (id) => kw("kpi.backup", "unlink", [[id]]);
export const readBackup = (id) => kw("kpi.backup", "read", [[id], BACKUP_FIELDS]);
export const backupDownloadUrl = (b) => `/web/content/kpi.backup/${b.id}/backup_file/${encodeURIComponent(b.backup_filename || `backup_${b.id}.zip`)}?download=true`;

/* ---- Settings › Data cleanup (kpi.data.cleanup + password models + /kpi_cleanup/*) ---- */
export const CLEAN = [["clean_kras", "KRAs", "kras"], ["clean_kpis", "KPIs / tasks", "kpis"], ["clean_progress", "Progress updates", "progress"], ["clean_manuals", "User manuals", "manuals"], ["clean_github", "GitHub links", "github"], ["clean_reassignments", "Reassignment history", "reassignments"], ["clean_reports", "Reports", "reports"]];
export const OLD_DATA_KEYS = ["clean_kpis", "clean_progress", "clean_reassignments"];
/* The password is Odoo's menu gate (kpi.cleanup.auth). A wrong one raises. */
export async function verifyCleanupPassword(password) {
  const id = await kw("kpi.cleanup.auth", "create", [[{ password }]]);
  await kw("kpi.cleanup.auth", "action_authenticate", [[Array.isArray(id) ? id[0] : id]]);
  return true;
}
export async function changeCleanupPassword(current, next, confirm) {
  const id = await kw("kpi.cleanup.change.password", "create", [[{ current_password: current, new_password: next, confirm_password: confirm }]]);
  return kw("kpi.cleanup.change.password", "action_change_password", [[Array.isArray(id) ? id[0] : id]]);
}
export async function cleanupPasswordInfo() {
  const r = await kw("kpi.cleanup.password.config", "get_or_create_config", [], {});
  const id = Array.isArray(r) ? r[0] : typeof r === "object" && r ? r.id : r;
  if (!id) return null;
  const rows = await kw("kpi.cleanup.password.config", "read", [[id], ["last_changed_date", "last_changed_by"]]);
  return rows?.[0] || null;
}
export const cleanupStats = () => rpc("/kpi_cleanup/statistics", {});
export const cleanupBackupStatus = () => rpc("/kpi_cleanup/backup_status", {});
export const createCleanup = (vals) => kw("kpi.data.cleanup", "create", [[vals]]);
export const deleteCleanupDraft = (id) => kw("kpi.data.cleanup", "unlink", [[id]]);
export const previewCleanup = (id) => rpc("/kpi_cleanup/preview", { cleanup_id: id });
export const executeCleanup = (id) => rpc("/kpi_cleanup/execute", { cleanup_id: id, confirmed: true }, { timeout: LONG });
export const listCleanups = () => kw("kpi.data.cleanup", "search_read", [[["state", "!=", "draft"]]], { fields: ["name", "cleanup_date", "cleanup_type", "executed_by", "state", "kras_deleted", "kpis_deleted", "progress_deleted", "manuals_deleted", "github_deleted", "reassignments_deleted", "reports_deleted", "backup_created_id"], limit: 30, order: "id desc" });
export { href };
