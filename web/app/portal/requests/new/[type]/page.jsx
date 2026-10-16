import { Suspense } from "react";
import PortalNewRequest from "@/components/portal/PortalNewRequest";

export const metadata = { title: "New request" };

export default async function Page({ params }) {
  const { type } = await params;
  return <Suspense fallback={null}><PortalNewRequest type={["requirement", "update", "bug"].includes(type) ? type : "requirement"} /></Suspense>;
}
