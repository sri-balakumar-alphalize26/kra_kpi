import { Suspense } from "react";
import C from "@/components/reports/EmployeeReport";

export const metadata = { title: "Employee report" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
