import { Suspense } from "react";
import C from "@/components/settings/Configuration";

export const metadata = { title: "Configuration" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
