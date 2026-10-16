import { Suspense } from "react";
import C from "@/components/settings/Users";

export const metadata = { title: "Users" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
