import { Suspense } from "react";
import C from "@/components/admin/ProjectCompletion";

export const metadata = { title: "Project completion" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
