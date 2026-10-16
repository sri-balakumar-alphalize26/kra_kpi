import { Suspense } from "react";
import PortalRequests from "@/components/portal/PortalRequests";

export const metadata = { title: "Completions" };

/* Odoo's client portal Completions: finished work waiting for the client's sign-off. */
export default function Page() {
  return <Suspense fallback={null}><PortalRequests initialTab="approval" title="Completions" signatureCard /></Suspense>;
}
