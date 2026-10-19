import Gate from "@/components/shell/Gate";

/* /dashboards is the Owner Dashboard, open to every admin on the web: its
   routes (/kpi_owner/certified_by_client, /kpi_client_invoice/create) accept
   the admin, owner and system groups (_is_owner_admin), so an admin without
   the owner group still gets its data. The work layout's Gate has already
   loaded the person; this one reuses it and sends anyone else (a developer)
   to /your-work. middleware.js turns developers away from the role cookie first. */
export default function AdminOnlyLayout({ children }) {
  return <Gate allow={["admin"]} redirect>{children}</Gate>;
}
