import { Suspense } from "react";
import C from "@/components/settings/Backups";

export const metadata = { title: "Backup & restore" };

export default function Page() {
  return <Suspense fallback={null}><C /></Suspense>;
}
