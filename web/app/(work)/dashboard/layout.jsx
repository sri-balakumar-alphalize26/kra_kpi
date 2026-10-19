import Gate from "@/components/shell/Gate";

/* /dashboard is the CEO's Dashboard: its routes (/kra_kpi/dashboard/overview,
   /kpi_owner/live_tracking, /kpi_owner/certified_by_client) accept the admin,
   owner and system groups (_is_owner_admin). Same guard as /dashboards. */
export default function AdminOnlyLayout({ children }) {
  return <Gate allow={["admin"]} redirect>{children}</Gate>;
}
