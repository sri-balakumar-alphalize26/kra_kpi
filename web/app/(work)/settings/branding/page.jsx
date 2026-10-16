import { Suspense } from "react";
import C from "@/components/settings/Branding";

export const metadata = { title: "Company branding" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
