import { Suspense } from "react";
import C from "@/components/work/Manual";

export const metadata = { title: "Help" };

export default function Page() {
  return <Suspense fallback={null}><C portal /></Suspense>;
}
