import { Suspense } from "react";
import C from "@/components/reports/Reassignments";

export const metadata = { title: "Reassignment history" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
