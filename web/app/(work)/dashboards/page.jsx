import { Suspense } from "react";
import C from "@/components/admin/OwnerDashboard";

export const metadata = { title: "Owner dashboard" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
