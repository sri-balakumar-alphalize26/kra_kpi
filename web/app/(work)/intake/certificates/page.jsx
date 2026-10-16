import { Suspense } from "react";
import C from "@/components/admin/Certificates";

export const metadata = { title: "Completion certificates" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
