"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeKey } from "@/lib/nav";

/* A section's tab row under the page header (People, Intake, Settings).
   Items come from lib/nav.js; the label sits in a <span> so the .tabs styles
   (made for spans) apply to links too. */
export default function SubNav({ items, label }) {
  const pathname = usePathname() || "";
  const on = activeKey(items, pathname);
  return (
    <nav className="tabs" aria-label={label} style={{ alignSelf: "flex-start", flexWrap: "wrap", maxWidth: "100%", marginBottom: 14 }}>
      {items.map((it) => (
        <Link key={it.key} href={it.href} aria-current={on === it.key ? "page" : undefined} style={{ textDecoration: "none" }}>
          <span className={on === it.key ? "on" : ""}>{it.label}</span>
        </Link>
      ))}
    </nav>
  );
}
