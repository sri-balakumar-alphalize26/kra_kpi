"use client";
/* 📅 Meetings on this task, in its details: all their details, by date
   (Odoo kpi_action.js › KPI details, /kpi_action/meetings). Hidden when the
   task has none. */
import { useEffect, useState } from "react";
import { Lozenge } from "@/components/ui";
import { fetchTaskMeetings } from "@/lib/services/talks";
import { MeetingDays } from "./MeetingCards";

export default function TaskMeetings({ kpiId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    fetchTaskMeetings(kpiId).then((r) => { if (live) setData(r); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [kpiId]);
  if (!data?.count) return null;
  return (
    <div className="sec">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>📅 Meetings <Lozenge tone="neutral">{data.count}</Lozenge>
        <span className="mini" style={{ marginLeft: "auto", fontWeight: 400 }}>Attendance, summary, action items, recording and transcript are kept on each meeting.</span>
      </h3>
      <MeetingDays days={data.days} />
    </div>
  );
}
