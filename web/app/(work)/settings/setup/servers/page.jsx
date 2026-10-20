import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Servers" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="servers" /></Suspense>;
}
