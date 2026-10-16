"use client";
import SubNav from "./SubNav";
import { INTAKE_NAV } from "@/lib/nav";

/* Upload requirements · Client files · Completion certificates · Project completion */
export default function IntakeNav() {
  return <SubNav items={INTAKE_NAV} label="Intake" />;
}
