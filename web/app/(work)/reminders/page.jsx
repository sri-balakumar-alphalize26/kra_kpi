import { Suspense } from "react";
import C from "@/components/work/Reminders";

export const metadata = { title: "Reminders" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
