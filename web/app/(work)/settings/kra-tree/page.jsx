import { Suspense } from "react";
import C from "@/components/settings/KraTree";

export const metadata = { title: "KRA / KPI master" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
