import { Suspense } from "react";
import C from "@/components/admin/Approvals";

export const metadata = { title: "Approvals" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
