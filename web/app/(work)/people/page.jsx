import { Suspense } from "react";
import C from "@/components/admin/LiveTracking";

export const metadata = { title: "Live Tracking" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
