import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Decline reasons" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="decline-reasons" /></Suspense>;
}
