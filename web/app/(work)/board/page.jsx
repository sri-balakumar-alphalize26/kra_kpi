import { Suspense } from "react";
import Board from "@/components/board/Board";

export const metadata = { title: "Board" };

export default function BoardPage() {
  return <Suspense fallback={null}><Board /></Suspense>;
}
