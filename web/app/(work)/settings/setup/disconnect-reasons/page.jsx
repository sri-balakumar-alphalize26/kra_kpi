import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Disconnect reasons" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="disconnect-reasons" /></Suspense>;
}
