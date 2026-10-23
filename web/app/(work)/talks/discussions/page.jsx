import { Suspense } from "react";
import C from "@/components/talks/Discussions";

export const metadata = { title: "Discussions" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
