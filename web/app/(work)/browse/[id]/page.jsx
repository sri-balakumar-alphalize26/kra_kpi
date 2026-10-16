import { redirect } from "next/navigation";

/* /browse/<id> — a link to one task. Opens the board with its panel. */
export default async function Browse({ params }) {
  const { id } = await params;
  redirect(`/board?task=${encodeURIComponent(id)}`);
}
