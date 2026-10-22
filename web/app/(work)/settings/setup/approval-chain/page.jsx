import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Approval Chain" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="approval-chain" /></Suspense>;
}
