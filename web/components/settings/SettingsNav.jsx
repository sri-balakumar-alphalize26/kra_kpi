"use client";
import SubNav from "@/components/admin/SubNav";
import { SETTINGS_NAV, allowed } from "@/lib/nav";
import { useMe } from "@/lib/me";

/* Shown on every settings page. Items marked system: true only for System administrators. */
export default function SettingsNav() {
  const { me } = useMe();
  return <SubNav items={allowed(SETTINGS_NAV, me)} label="Settings" />;
}
