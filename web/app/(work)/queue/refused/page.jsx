import { Suspense } from "react";
import C from "@/components/admin/RefusedQueue";

export const metadata = { title: "Refused requests" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
