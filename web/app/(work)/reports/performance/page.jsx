import { Suspense } from "react";
import C from "@/components/reports/PerformanceReport";

export const metadata = { title: "Performance report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
