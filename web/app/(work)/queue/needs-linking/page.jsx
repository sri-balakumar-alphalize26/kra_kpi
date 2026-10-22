import { Suspense } from "react";
import C from "@/components/admin/NeedsLinking";

export const metadata = { title: "Needs linking" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
