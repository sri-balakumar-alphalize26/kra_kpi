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

/* Left sidebar for developers and admins (one workspace; admin items appear
   for admins, as Jira does with permissions). `group` starts a new section. */
export const WORK_SIDE = [
  { key: "dash", label: "Dashboard", icon: "dash", href: "/dashboards", roles: ["admin"], owner: true },
  { key: "dash-me", label: "Dashboard", icon: "dash", href: "/your-work", roles: ["developer", "admin"], notOwner: true },
  { key: "board", label: "Board", icon: "board", href: "/board" },
  { key: "list", label: "List", icon: "list", href: "/list" },
  /* Admins keep a workday too, so they see their own day and snapshots. */
  { key: "workday", label: "My workday", icon: "timeline", href: "/your-work/timeline", roles: ["developer", "admin"] },
  { key: "snapshots", label: "My snapshots", icon: "camera", href: "/your-work/snapshots", roles: ["developer", "admin"] },
  { key: "documents", label: "Documents", icon: "doc", href: "/documents" },
  { key: "reminders", label: "Reminders", icon: "alarm", href: "/reminders" },
  { key: "notifications", label: "Notifications", icon: "bell", href: "/notifications" },
  { key: "manual", label: "User manual", icon: "book", href: "/manual" },
  { group: "Admin", roles: ["admin"] },
  { key: "live", label: "Live Tracking", icon: "live", href: "/people", roles: ["admin"] },
  { key: "queue", label: "Client queue", icon: "inbox", href: "/queue", roles: ["admin"] },
  { key: "intake", label: "Intake / uploads", icon: "upload", href: "/intake/requirement", match: ["/intake"], roles: ["admin"] },
  { key: "certs", label: "Certificates", icon: "doc", href: "/intake/certificates", roles: ["admin"] },
  { key: "tracker", label: "People", icon: "people", href: "/people/tracker", match: ["/people/attendance", "/people/action-log"], roles: ["admin"] },
  { key: "reports", label: "Reports", icon: "chart", href: "/reports/kra", match: ["/reports"], roles: ["admin"] },
  { key: "settings", label: "Settings", icon: "gear", href: "/settings/kra-tree", match: ["/settings"], roles: ["admin"] },
  /* Odoo System administrators only (also hidden from coordinators / owners).
     KPI configuration (kpi.config.screen) stays here until Odoo's ACL lets
     group_kra_admin use that model too. */
  { group: "System", roles: ["admin"], system: true },
  { key: "kpi-config", label: "KPI configuration", icon: "list", href: "/settings/kpi-config", roles: ["admin"], system: true },
  { key: "sessions", label: "Workday sessions", icon: "timeline", href: "/settings/workday-sessions", roles: ["admin"], system: true },
  { key: "backup", label: "Backup & restore", icon: "download", href: "/settings/backup", roles: ["admin"], system: true },
  { key: "cleanup", label: "Data cleanup", icon: "trash", href: "/settings/cleanup", roles: ["admin"], system: true },
];

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
