"use client";
/* Wraps a settings page that only Odoo System administrators may use
   (Workday sessions, Backup & restore, Data cleanup). The Settings tabs already
   hide these from coordinators/owners; this covers someone typing the URL.
   Odoo's ACLs (and, for cleanup, the proxy) still decide every call. */
import { useMe } from "@/lib/me";
import { PageHeader } from "@/components/ui";
import SettingsNav from "./SettingsNav";

export default function SystemOnly({ title, children }) {
  const { me } = useMe();
  if (me?.flags?.isSystem) return children;
  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: title }]} title={title} />
      <SettingsNav />
      <div className="cardbox" style={{ maxWidth: 560 }}>
        <b style={{ color: "var(--navy)", fontSize: 16 }}>System administrators only</b>
        <p className="note" style={{ margin: 0 }}>This screen is for Odoo System administrators. Ask one if you need something changed here.</p>
      </div>
    </>
  );
}
