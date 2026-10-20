import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Databases" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="databases" /></Suspense>;
}
