import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "Install packages" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="install-packages" /></Suspense>;
}
