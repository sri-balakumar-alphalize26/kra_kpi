import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "WhatsApp groups" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="wa-groups" /></Suspense>;
}
