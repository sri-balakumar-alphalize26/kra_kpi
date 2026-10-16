import { Suspense } from "react";
import C from "@/components/admin/ActionLog";

export const metadata = { title: "Action log" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
