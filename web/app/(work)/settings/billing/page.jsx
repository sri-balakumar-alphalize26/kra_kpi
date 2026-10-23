import { Suspense } from "react";
import B from "@/components/settings/Billing";

export const metadata = { title: "Billing" };

export default function Page() {
  return <Suspense fallback={null}><B /></Suspense>;
}
