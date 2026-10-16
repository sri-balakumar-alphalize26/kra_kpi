/* Cookie names shared by middleware.js (edge) and the route handlers (node).
   Kept in a file with no other imports so the edge bundle stays tiny. */
export const SESSION_COOKIE = "kpi_session";  /* Odoo's session_id, httpOnly */
export const ROLE_COOKIE = "kpi_role";        /* admin | developer | client — a hint for middleware only */

/* Where each role lands after sign-in or when it opens "/". */
export function roleHome(role) {
  return role === "client" ? "/portal" : "/your-work";
}
