import { Suspense } from "react";
import C from "@/components/settings/DataCleanup";

export const metadata = { title: "Data cleanup" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
