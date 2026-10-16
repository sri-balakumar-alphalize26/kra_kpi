import { Suspense } from "react";
import C from "@/components/admin/EmployeeTracker";

export const metadata = { title: "Employee Tracker" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
