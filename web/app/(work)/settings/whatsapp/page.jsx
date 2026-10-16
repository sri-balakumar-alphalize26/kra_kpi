import { Suspense } from "react";
import C from "@/components/settings/WhatsAppConnect";

export const metadata = { title: "WhatsApp connect" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
