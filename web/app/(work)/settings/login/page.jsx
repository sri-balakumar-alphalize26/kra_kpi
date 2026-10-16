import { Suspense } from "react";
import C from "@/components/settings/LoginManagement";

export const metadata = { title: "Login management" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
