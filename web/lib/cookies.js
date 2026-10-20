/* Cookie names shared by middleware.js (edge) and the route handlers (node).
   Kept in a file with no other imports so the edge bundle stays tiny. */
export const SESSION_COOKIE = "kpi_session";  /* Odoo's session_id, httpOnly */
export const ROLE_COOKIE = "kpi_role";        /* admin | developer | client — a hint for middleware only */
/* The Odoo account this browser was set up with (/api/auth/setup) — the web's
   version of the phone's device setup. Decides the country code on the
   number login and locks it to that person's number, as the phone does.
   Outlives sign-out on purpose. */
export const SETUP_UID_COOKIE = "kpi_setup_uid";
export const SETUP_NAME_COOKIE = "kpi_setup_name";
export const ODOO_URL_COOKIE = "kpi_odoo_url";  /* the server this browser was set up with */
export const ODOO_DB_COOKIE = "kpi_odoo_db";    /* and its database */

/* Where each role lands after sign-in or when it opens "/". */
export function roleHome(role) {
  return role === "client" ? "/portal" : "/your-work";
}
