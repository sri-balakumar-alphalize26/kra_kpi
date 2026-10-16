"use client";
import { Empty, PageHeader } from "@/components/ui";

/* A section that is designed (see the canvas) but not yet built. Replaced
   screen by screen as the phases land. */
export default function ComingSoon({ title, crumbs = [], phase = "the next step" }) {
  return (
    <>
      <PageHeader crumbs={crumbs} title={title} />
      <div className="page">
        <div className="cardbox">
          <Empty icon="board" title={`${title} arrives in ${phase}`} text="The design is final; the data wiring is being built in order of daily use." />
        </div>
      </div>
    </>
  );
}
