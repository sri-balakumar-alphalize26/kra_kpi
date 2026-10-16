"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/* The sub-navigation shared by every report page. */
const ITEMS = [
  ["/reports/kra", "KRA report"], ["/reports/employee", "Employee report"], ["/reports/unit", "Unit report"], ["/reports/performance", "Performance"],
  ["/reports/attention", "Attention"], ["/reports/work", "Work report"], ["/reports/daily", "Daily reports"], ["/reports/snapshots", "Snapshots"],
  ["/reports/paid-work", "Paid work"], ["/reports/reassignments", "Reassignments"], ["/reports/invoices", "Invoices"],
];
export default function ReportsNav() {
  const p = usePathname();
  return (
    <div className="tabs" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
      {ITEMS.map(([h, l]) => <Link key={h} href={h} className={p === h || p.startsWith(h + "/") ? "on" : ""} style={{ textDecoration: "none" }}>{l}</Link>)}
    </div>
  );
}
