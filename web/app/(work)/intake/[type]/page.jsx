import { Suspense } from "react";
import Intake from "@/components/admin/Intake";

export const metadata = { title: "Upload requirements" };

export default async function Page({ params }) {
  const { type } = await params;
  return <Suspense fallback={null}><Intake docType={["requirement", "update", "bug"].includes(type) ? type : "requirement"} /></Suspense>;
}
