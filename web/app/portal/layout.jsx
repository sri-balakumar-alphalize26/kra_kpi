import Gate from "@/components/shell/Gate";
import Shell from "@/components/shell/Shell";

/* The client portal: header tabs, no sidebar. Admins may look. */
export default function PortalLayout({ children }) {
  return (
    <Gate allow={["client", "admin"]}>
      <Shell variant="portal">{children}</Shell>
    </Gate>
  );
}
