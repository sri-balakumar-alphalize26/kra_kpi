import { Suspense } from "react";
import C from "@/components/settings/PreApprovals";

export const metadata = { title: "Client pre-approvals" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
