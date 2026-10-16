"use client";
import SubNav from "./SubNav";
import { PEOPLE_NAV } from "@/lib/nav";

/* Live tracking · Tracker · Attendance · Action log */
export default function PeopleNav() {
  return <SubNav items={PEOPLE_NAV} label="People" />;
}
