import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "WhatsApp database" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="wa-database" /></Suspense>;
}
