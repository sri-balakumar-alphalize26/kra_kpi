import { Suspense } from "react";
import C from "@/components/work/Manual";

export const metadata = { title: "User manual" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
