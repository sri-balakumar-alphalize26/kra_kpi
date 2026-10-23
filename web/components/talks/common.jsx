"use client";
/* Pieces the three Client Talks screens share (Odoo kpi_client_talks.js). */
import { useEffect, useState } from "react";
import { Input, Tabs } from "@/components/ui";

/* 📌 Task-oriented / 🌐 General, with their counts. */
export function TalkTabs({ tab, counts = {}, onChange }) {
  return (
    <Tabs value={tab} onChange={onChange} items={[
      { key: "task", label: "📌 Task-oriented", count: counts.task || null },
      { key: "general", label: "🌐 General", count: counts.general || null },
    ]} />
  );
}

/* Searches when the box is left or Enter is pressed, like Odoo's t-on-change. */
export function SearchBox({ value, onChange, placeholder, width = 240 }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <Input type="search" value={v} placeholder={placeholder} style={{ width }} aria-label="Search"
      onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onChange(v); } }} />
  );
}

export function FilterButton({ on, onClick, children }) {
  return <button type="button" className={`btn ${on ? "btn-primary" : "btn-ghost"}`} style={{ height: 28, fontSize: 12.5 }} onClick={onClick}>{children}</button>;
}
