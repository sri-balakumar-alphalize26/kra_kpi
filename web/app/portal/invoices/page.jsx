import { Suspense } from "react";
import PortalInvoices from "@/components/portal/PortalInvoices";

export const metadata = { title: "Invoices" };

export default function Page() {
  return <Suspense fallback={null}><PortalInvoices /></Suspense>;
}
