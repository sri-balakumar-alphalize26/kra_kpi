import { Suspense } from "react";
import C from "@/components/work/Documents";

export const metadata = { title: "Documents" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
