import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Database terms" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="db-terms" /></Suspense>;
}
