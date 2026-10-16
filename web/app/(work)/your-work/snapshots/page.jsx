import { Suspense } from "react";
import C from "@/components/work/Snapshots";

export const metadata = { title: "My snapshots" };

export default function Page() {
  return <Suspense fallback={null}><C mine /></Suspense>;
}
