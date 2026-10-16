import { Suspense } from "react";
import C from "@/components/admin/ClientFiles";

export const metadata = { title: "Client files" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
