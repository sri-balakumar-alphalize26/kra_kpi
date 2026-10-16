import Gate from "@/components/shell/Gate";

/* /people is admin-only (lib/nav.js shows it to admins alone). The work layout's
   Gate has already loaded the person; this one reuses it and sends anyone
   else (a developer) to their home, /your-work. middleware.js does the same
   from the role cookie before the page loads. */
export default function AdminOnlyLayout({ children }) {
  return <Gate allow={["admin"]} redirect>{children}</Gate>;
}
