import Gate from "@/components/shell/Gate";

/* /dashboards is the Owner Dashboard: Odoo shows it to Owners and System
   administrators only (group_kra_owner, base.group_system), and its route
   (/kpi_owner/certified_by_client) refuses everyone else. The work layout's
   Gate has already loaded the person; this one reuses it and sends anyone
   else (a developer, or a coordinator without the owner group) to
   /your-work. middleware.js turns developers away from the role cookie first. */
export default function OwnerOnlyLayout({ children }) {
  return <Gate allow={["admin"]} need="owner" redirect>{children}</Gate>;
}
