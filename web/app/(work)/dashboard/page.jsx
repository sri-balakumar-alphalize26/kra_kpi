import { Suspense } from "react";
import C from "@/components/admin/Dashboard";

export const metadata = { title: "Dashboard" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
