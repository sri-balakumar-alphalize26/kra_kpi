import { Suspense } from "react";
import C from "@/components/settings/KpiConfig";

export const metadata = { title: "KPI configuration" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
