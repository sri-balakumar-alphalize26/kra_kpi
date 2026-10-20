import { Suspense } from "react";
import SetupScreen from "@/components/settings/SetupScreen";

export const metadata = { title: "AI Assistant chats" };

export default function Page() {
  return <Suspense fallback={null}><SetupScreen name="ai-chats" /></Suspense>;
}
