import { Suspense } from "react";
import C from "@/components/reports/UnitReport";

export const metadata = { title: "Unit report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
