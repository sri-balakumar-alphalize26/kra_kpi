import { Suspense } from "react";
import C from "@/components/reports/DailyReports";

export const metadata = { title: "Daily reports" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
