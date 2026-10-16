import { Suspense } from "react";
import C from "@/components/settings/WorkdaySessions";

export const metadata = { title: "Workday sessions" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
