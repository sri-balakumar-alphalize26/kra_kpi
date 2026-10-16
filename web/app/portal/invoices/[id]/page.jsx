import { Suspense } from "react";
import PortalInvoices from "@/components/portal/PortalInvoices";

export const metadata = { title: "Invoice" };

export default async function Page({ params }) {
  const { id } = await params;
  return <Suspense fallback={null}><PortalInvoices id={id} /></Suspense>;
}
