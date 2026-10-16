import { Suspense } from "react";
import Gate from "@/components/shell/Gate";
import Shell from "@/components/shell/Shell";

/* The internal workspace: developers and admins share one shell; admin-only
   sections appear for admins (lib/nav.js). Clients are sent to /portal by
   middleware.js and, if they get here anyway, by the Gate. The task-actions
   provider (workday, task dialogs) lives inside Shell so the top bar can use it. */
export default function WorkLayout({ children }) {
  return (
    <Gate allow={["developer", "admin"]}>
      <Shell variant="work">
        <Suspense fallback={null}>{children}</Suspense>
      </Shell>
    </Gate>
  );
}
