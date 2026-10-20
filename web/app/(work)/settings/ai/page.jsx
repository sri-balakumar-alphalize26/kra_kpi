import { Suspense } from "react";
import AiConfig from "@/components/settings/AiConfig";

export const metadata = { title: "AI & Transcription" };

export default function Page() {
  return <Suspense fallback={null}><AiConfig /></Suspense>;
}
