import { Suspense } from "react";
import C from "@/components/reports/AttentionReport";

export const metadata = { title: "Attention report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
