"use client";
import { Button, Icon, Select } from "@/components/ui";
import * as R from "@/lib/services/reports";

/* The filter row the Unit / Performance / Attention / Employee reports share
   (the OWL screens' From · To · Employee · Time frame · Generate).
   value = { from, to, employeeId, timeFrame }; onChange gets the next value. */
const FRAMES = { today: "Today", yesterday: "Yesterday", last_week: "Last week", this_month: "This month", last_month: "Last month", last_year: "Last year" };
const selStyle = { border: 0, background: "none", outline: 0, font: "inherit", color: "inherit" };

export default function ReportFilters({ value, onChange, employees = [], frames = ["yesterday", "last_month", "last_year"], onGenerate, busy, allowEmptyDates = false, children }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const pickFrame = (k) => { const r = R.presetRange(k); set(r ? { timeFrame: k, from: r[0], to: r[1] } : { timeFrame: "" }); };
  return (
    <div className="toolbar" style={{ flexWrap: "wrap" }}>
      <span className="input" style={{ height: 32 }}>
        <Icon n="cal" size={16} />
        <input type="date" aria-label="From" value={value.from || ""} max={value.to || undefined} onChange={(e) => set({ from: e.target.value, timeFrame: "" })} style={{ ...selStyle, width: 130 }} />
        <span className="mini">to</span>
        <input type="date" aria-label="To" value={value.to || ""} min={value.from || undefined} onChange={(e) => set({ to: e.target.value, timeFrame: "" })} style={{ ...selStyle, width: 130 }} />
      </span>
      {allowEmptyDates && (value.from || value.to) && <Button size="sm" kind="ghost" onClick={() => set({ from: "", to: "", timeFrame: "" })}>Any date</Button>}
      <span className="input" style={{ height: 32 }}>
        <Select value={value.timeFrame || ""} onChange={(e) => pickFrame(e.target.value)} style={selStyle} aria-label="Time frame">
          <option value="">Custom dates</option>
          {frames.map((k) => <option key={k} value={k}>{FRAMES[k] || k}</option>)}
        </Select>
      </span>
      <span className="input" style={{ height: 32, minWidth: 200 }}>
        <Select value={value.employeeId || ""} onChange={(e) => set({ employeeId: e.target.value })} style={selStyle} aria-label="Employee">
          <option value="">All employees</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Select>
      </span>
      {children}
      <Button kind="primary" icon="chart" busy={busy} onClick={onGenerate}>Generate report</Button>
    </div>
  );
}
