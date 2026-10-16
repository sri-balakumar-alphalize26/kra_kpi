import { Suspense } from "react";
import Intake from "@/components/admin/Intake";

export const metadata = { title: "Upload a list" };

export default function Page() {
  return <Suspense fallback={null}><Intake docType="requirement" portal /></Suspense>;
}
