import { Suspense } from "react";
import C from "@/components/work/Meetings";

export const metadata = { title: "Meetings" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
