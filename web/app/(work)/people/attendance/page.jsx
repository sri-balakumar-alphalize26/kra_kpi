import { Suspense } from "react";
import C from "@/components/admin/Attendance";

export const metadata = { title: "Attendance" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
