import { Suspense } from "react";
import TaskList from "@/components/board/TaskList";

export const metadata = { title: "List" };

export default function ListPage() {
  return <Suspense fallback={null}><TaskList /></Suspense>;
}
