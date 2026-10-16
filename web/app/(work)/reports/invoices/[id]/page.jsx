import { Suspense } from "react";
import InvoiceDetail from "@/components/reports/InvoiceDetail";

export const metadata = { title: "Invoice" };

export default async function Page({ params }) {
  const { id } = await params;
  return <Suspense fallback={null}><InvoiceDetail id={id} /></Suspense>;
}
