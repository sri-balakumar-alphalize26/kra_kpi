import { Suspense } from "react";
import C from "@/components/reports/PaidWork";

export const metadata = { title: "Paid work" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
