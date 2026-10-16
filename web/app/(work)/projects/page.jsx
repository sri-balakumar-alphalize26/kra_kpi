import { Suspense } from "react";
import C from "@/components/work/Projects";

export const metadata = { title: "Projects" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
