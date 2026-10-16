import { Suspense } from "react";
import C from "@/components/work/Notifications";

export const metadata = { title: "Notifications" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
