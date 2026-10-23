import { Suspense } from "react";
import C from "@/components/talks/Questions";

export const metadata = { title: "Questions" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
