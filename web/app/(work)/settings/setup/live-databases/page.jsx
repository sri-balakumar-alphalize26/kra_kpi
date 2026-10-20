import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Live databases" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="live-databases" /></Suspense>;
}
