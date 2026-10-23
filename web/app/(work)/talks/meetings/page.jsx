import { Suspense } from "react";
import C from "@/components/talks/TalksMeetings";

export const metadata = { title: "Meetings" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
