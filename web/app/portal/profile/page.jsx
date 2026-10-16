import { Suspense } from "react";
import C from "@/components/work/Profile";

export const metadata = { title: "Profile" };

export default function Page() {
  return <Suspense fallback={null}><C portal /></Suspense>;
}
