import { Suspense } from "react";
import C from "@/components/admin/ClientQueue";

export const metadata = { title: "Client task queue" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
