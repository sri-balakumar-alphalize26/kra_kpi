import { Suspense } from "react";
import C from "@/components/work/MyWorkday";

export const metadata = { title: "My workday" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
