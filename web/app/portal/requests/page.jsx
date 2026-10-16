import { Suspense } from "react";
import PortalRequests from "@/components/portal/PortalRequests";

export const metadata = { title: "My requests" };

export default function Page() {
  return <Suspense fallback={null}><PortalRequests /></Suspense>;
}
