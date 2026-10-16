import { Suspense } from "react";
import C from "@/components/reports/WorkReport";

export const metadata = { title: "Work report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
