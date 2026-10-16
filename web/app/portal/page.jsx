import { Suspense } from "react";
import PortalHome from "@/components/portal/PortalHome";

export const metadata = { title: "Home" };

export default function Page() {
  return <Suspense fallback={null}><PortalHome /></Suspense>;
}
