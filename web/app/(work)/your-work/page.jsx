import { Suspense } from "react";
import YourWork from "@/components/work/YourWork";

export const metadata = { title: "Your work" };

export default function YourWorkPage() {
  return <Suspense fallback={null}><YourWork /></Suspense>;
}
