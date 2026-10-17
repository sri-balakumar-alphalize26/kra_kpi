/* The site map, in one place. Each item: { key, label, icon, href, roles }.
   `roles` lists who sees it; absent = everyone signed in. The shell filters by
   the role /api/auth/me returned (see allowed() below). `match` (optional)
   lists extra path prefixes that also light the item up.
   Flags on top of the role:
     system: true    Odoo System administrators only
     owner: true     Owners (and System) only: Odoo's Owner Dashboard menu is
                     group_kra_owner + base.group_system
     notOwner: true  only for people WITHOUT the owner view (its stand-in) */

export const TOP_NAV = [
  { key: "yourwork", label: "Your work", href: "/your-work", roles: ["developer", "admin"] },
  { key: "projects", label: "Projects", href: "/projects", roles: ["developer", "admin"] },
  { key: "filters", label: "Filters", href: "/list", roles: ["developer", "admin"] },
  { key: "dashboards", label: "Dashboards", href: "/dashboards", roles: ["admin"], owner: true },
  { key: "people", label: "People", href: "/people", roles: ["admin"] },
];

/* Left sidebar for developers and admins: the Odoo "KRA / KPI" menu, same
   groups, same sub-options, same order (views/menu.xml and the menu records
   in the other views). Each group opens and closes; its items are the
   sub-options. A group's `roles`/flags hide the whole group; an item's hide
   just that item. Items marked "web only" have no Odoo menu but live here so
   they stay reachable. */
const ADMIN = ["admin"];
export const WORK_MENU = [
  { key: "mywork", group: "My Work", icon: "board", roles: ["developer", "admin"], items: [
    { key: "board", label: "KPI Actions", href: "/board", match: ["/browse"] },
    { key: "workday", label: "My Workday", href: "/your-work/timeline" },
    { key: "reminders", label: "Reminders", href: "/reminders" },
    { key: "snapshots", label: "My Workday Snapshots", href: "/your-work/snapshots" },
    { key: "meetings", label: "Meetings", href: "/meetings" },
    { key: "documents", label: "Task Related Documents", href: "/documents" },
    { key: "notifications", label: "Notifications", href: "/notifications" }, /* web only */
    { key: "manual", label: "User Manual", href: "/manual" }, /* web only */
  ] },
  { key: "tracking", group: "Tracking", icon: "live", roles: ADMIN, items: [
    { key: "live", label: "Live Tracking", href: "/people" },
    { key: "owner", label: "Owner Dashboard", href: "/dashboards", owner: true },
    { key: "attendance", label: "Attendance", href: "/people/attendance" }, /* web only */
  ] },
  { key: "clients", group: "Clients", icon: "inbox", roles: ADMIN, items: [
    /* badge: the Sidebar shows the number waiting on a manager (Shell.jsx). */
    { key: "approvals", label: "Approvals", href: "/approvals", badge: "approvals" },
    { key: "queue", label: "Client Task Queue", href: "/queue" },
    { key: "files", label: "Generate Client Files", href: "/intake/files" },
  ] },
  { key: "uploads", group: "Uploads", icon: "upload", roles: ADMIN, items: [
    { key: "up-req", label: "Upload Requirements", href: "/intake/requirement" },
    { key: "up-upd", label: "Upload Updates", href: "/intake/update" },
    { key: "up-bug", label: "Upload Bug Reports", href: "/intake/bug" },
  ] },
  { key: "setup", group: "Setup", icon: "list", roles: ADMIN, items: [
    { key: "kra-master", label: "KRA / KPI Master", href: "/settings/kra-tree" },
    /* kpi.config.screen is System/Manager-only in Odoo's access rules. */
    { key: "kpi-config", label: "KPI Configuration", href: "/settings/kpi-config", system: true },
    { key: "whatsapp", label: "WhatsApp Connect", href: "/settings/whatsapp" },
  ] },
  { key: "reports", group: "KPI Reports", icon: "chart", roles: ADMIN, items: [
    { key: "salary", label: "Employee Salary Master", href: "/reports/performance?tab=salary" },
    { key: "unit", label: "KPI Unit Report", href: "/reports/unit" },
    { key: "performance", label: "KPI Performance Report", href: "/reports/performance" },
    { key: "kra", label: "KRA Report", href: "/reports/kra" },
    { key: "attention", label: "KPI Attention Report", href: "/reports/attention" },
    { key: "employee", label: "KRA Employee Report", href: "/reports/employee" },
    { key: "invoices", label: "Client Invoices", href: "/reports/invoices" },
    { key: "tracker", label: "Employee Tracker", href: "/people/tracker" },
    { key: "work", label: "Work Report", href: "/reports/work" },
    { key: "certs", label: "Completion Certificates", href: "/intake/certificates" },
    { key: "project-status", label: "Project Completion Check", href: "/intake/project-status" },
    { key: "daily", label: "Daily Task Reports", href: "/reports/daily" },
    { key: "paid", label: "Paid Work", href: "/reports/paid-work" }, /* web only */
  ] },
  { key: "settings", group: "Settings", icon: "gear", roles: ADMIN, items: [
    { key: "configuration", label: "Configuration", href: "/settings/configuration" },
    { key: "branding", label: "Company Branding", href: "/settings/branding" },
    /* Multi-task settings live inside the Configuration page on the web. */
    { key: "multitask", label: "Multi-task Settings", href: "/settings/configuration?section=multitask" },
    { key: "sessions", label: "Workday Sessions", href: "/settings/workday-sessions", system: true },
    { key: "action-log", label: "Action Log", href: "/people/action-log" },
    { key: "backup", label: "Backup & Restore", href: "/settings/backup", system: true },
    { key: "wd-snapshots", label: "Workday Snapshots", href: "/reports/snapshots" },
    { key: "login", label: "Login Management", href: "/settings/login" },
    { key: "users", label: "Users", href: "/settings/users" }, /* web only */
    { key: "cleanup", label: "Data Cleanup", href: "/settings/cleanup", system: true },
    { key: "reassignments", label: "Reassignment History", href: "/reports/reassignments" },
    { key: "pre-approvals", label: "Client Pre-Approvals", href: "/settings/pre-approvals" },
  ] },
];

/* The same items as one flat list (page titles, active-item lookup). */
export const WORK_SIDE = WORK_MENU.flatMap((g) => g.items.map((it) => ({ ...it, roles: it.roles || g.roles, system: it.system || g.system, owner: it.owner || g.owner })));

/* WORK_MENU cut down to what this person may see; empty groups drop out. */
export function allowedMenu(me) {
  return allowed(WORK_MENU, me)
    .map((g) => ({ ...g, items: allowed(g.items, me) }))
    .filter((g) => g.items.length);
}

/* The client portal has no sidebar: tabs in the header. */
export const PORTAL_TABS = [
  { key: "home", label: "Home", href: "/portal" },
  { key: "requests", label: "My requests", href: "/portal/requests" },
  { key: "completions", label: "Completions", href: "/portal/completions" },
  { key: "new", label: "New request", href: "/portal/requests/new/requirement" },
  { key: "invoices", label: "Invoices", href: "/portal/invoices" },
  { key: "help", label: "Help", href: "/portal/manual" },
];

/* Sub-navigation of the admin areas, drawn as a tab row under the page header
   (components/settings/SettingsNav, components/admin/PeopleNav, IntakeNav).
   Every page listed is admin-only, like its sidebar entry. */
export const SETTINGS_NAV = [
  { key: "kra-tree", label: "KRA / KPI master", href: "/settings/kra-tree" },
  { key: "configuration", label: "Configuration", href: "/settings/configuration" },
  { key: "pre-approvals", label: "Pre-approvals", href: "/settings/pre-approvals" },
  { key: "users", label: "Users", href: "/settings/users" },
  { key: "login", label: "Login management", href: "/settings/login" },
  { key: "whatsapp", label: "WhatsApp connect", href: "/settings/whatsapp" },
  { key: "branding", label: "Branding", href: "/settings/branding" },
  /* System administrators only (not every coordinator / owner). */
  { key: "kpi-config", label: "KPI configuration", href: "/settings/kpi-config", system: true },
  { key: "workday-sessions", label: "Workday sessions", href: "/settings/workday-sessions", system: true },
  { key: "backup", label: "Backup & restore", href: "/settings/backup", system: true },
  { key: "cleanup", label: "Data cleanup", href: "/settings/cleanup", system: true },
];
export const PEOPLE_NAV = [
  { key: "live", label: "Live tracking", href: "/people" },
  { key: "tracker", label: "Tracker", href: "/people/tracker" },
  { key: "attendance", label: "Attendance", href: "/people/attendance" },
  { key: "action-log", label: "Action log", href: "/people/action-log" },
];
export const INTAKE_NAV = [
  { key: "upload", label: "Upload requirements", href: "/intake/requirement", match: ["/intake/update", "/intake/bug"] },
  { key: "files", label: "Client files", href: "/intake/files" },
  { key: "certificates", label: "Completion certificates", href: "/intake/certificates" },
  { key: "project-status", label: "Project completion", href: "/intake/project-status" },
];

export function visible(items, role) {
  return items.filter((it) => !it.roles || it.roles.includes(role));
}

/* Does this person have the owner view (Owner Dashboard)? */
export const hasOwnerView = (me) => !!(me?.flags?.isOwner || me?.flags?.isSystem);

/* visible() plus the system / owner / notOwner flags, for the person from useMe(). */
export function allowed(items, me) {
  const sys = !!me?.flags?.isSystem, owner = hasOwnerView(me);
  return visible(items, me?.role).filter((it) => (!it.system || sys) && (!it.owner || owner) && (!it.notOwner || !owner));
}

/* Which nav item a pathname belongs to: the longest matching prefix wins.
   An item matches its own href and every prefix in its `match`. */
export function activeKey(items, pathname) {
  let best = null, bestLen = -1;
  for (const it of items) {
    if (!it.href) continue;
    for (const p of [it.href, ...(it.match || [])]) {
      if ((pathname === p || pathname.startsWith(p + "/")) && p.length > bestLen) { best = it; bestLen = p.length; }
    }
  }
  return best?.key || null;
}
