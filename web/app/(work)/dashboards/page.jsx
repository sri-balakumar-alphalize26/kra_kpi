import { Suspense } from "react";
import C from "@/components/admin/OwnerDashboard";

export const metadata = { title: "Client billing" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
