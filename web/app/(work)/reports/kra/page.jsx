import { Suspense } from "react";
import C from "@/components/reports/KraReport";

export const metadata = { title: "KRA report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
