import { Suspense } from "react";
import C from "@/components/reports/Invoices";

export const metadata = { title: "Client invoices" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
