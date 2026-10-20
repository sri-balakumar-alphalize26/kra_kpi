"use client";
import { useEffect, useState } from "react";
import { Avatar, Button, Lozenge, Modal, PageHeader, Skeleton, stateTone, useFlags } from "@/components/ui";
import { useTaskActions } from "@/components/task/TaskActions";
import * as R from "@/lib/services/reports";
import ReportsNav from "./ReportsNav";
import ReportFilters from "./ReportFilters";

/* KPI Unit report (port of the OWL kpi_unit_report): per employee — tasks,
   estimate total, estimate units, duration — and the task breakdown on click.
   Times are days of 8 hours. */
const PRI = { urgent: "danger", important: "paused", regular: "todo" };

export default function UnitReport() {
  const flags = useFlags();
  const acts = useTaskActions();
  const [staff, setStaff] = useState([]);
  const [f, setF] = useState(() => { const r = R.presetRange("this_month"); return { from: r[0], to: r[1], employeeId: "", timeFrame: "" }; });
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); /* {id, name, tasks|null} */
  useEffect(() => { R.fetchStaff().then(setStaff).catch(() => {}); }, []);

  const generate = async () => {
    setBusy(true);
    try { const r = R.assertOk(await R.generateUnitReport(f), "Could not build the report."); setRows(r.data || []); }
    catch (e) { flags.err(e.message); } finally { setBusy(false); }
  };
  const showTasks = async (row) => {
    setOpen({ id: row.employee_id, name: row.employee_name, tasks: null });
    try { const r = R.assertOk(await R.fetchUnitEmployeeTasks({ employeeId: row.employee_id, from: f.from, to: f.to }), "Could not load the tasks."); setOpen({ id: row.employee_id, name: r.employee_name || row.employee_name, tasks: r.tasks || [] }); }
    catch (e) { flags.err(e.message); setOpen(null); }
  };
  const list = rows || [];
  const tot = { tasks: list.reduce((s, r) => s + (r.no_of_tasks || 0), 0), est: list.reduce((s, r) => s + (r.estimate_total_hours || 0), 0), unit: list.reduce((s, r) => s + (r.estimate_unit || 0), 0), dur: list.reduce((s, r) => s + (r.duration_hours || 0), 0) };
  const exportCsv = () => R.downloadText(R.csv(list, [{ key: "employee_name", label: "Employee" }, { key: "no_of_tasks", label: "Tasks" }, { key: "estimate_total_display", label: "Estimate total" }, { label: "Estimate unit", get: (r) => (r.estimate_unit || 0).toFixed(2) }, { key: "duration_display", label: "Duration" }]), `Unit_report_${f.from}_${f.to}.csv`);

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "Unit report" }]} title="Unit report" meta="Days are 8 hours: 3d 2h 30m = 26.5 hours">
        <Button icon="download" onClick={exportCsv} disabled={!list.length}>CSV</Button>
      </PageHeader>
      <div className="page">
        <ReportsNav />
        <ReportFilters value={f} onChange={setF} employees={staff} onGenerate={generate} busy={busy} />
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!rows && !busy && <div className="empty">Set the filters and press Generate report.</div>}
          {busy && !rows && <div style={{ padding: 16 }}><Skeleton rows={6} /></div>}
          {rows && (
            <table className="table">
              <thead><tr><th>No</th><th>Employee</th><th className="num">Tasks</th><th className="num">Estimate total</th><th className="num">Estimate unit</th><th className="num">Duration</th></tr></thead>
              <tbody>
                {list.map((r, i) => (
                  <tr key={r.employee_id} style={{ cursor: "pointer" }} onClick={() => showTasks(r)}>
                    <td>{i + 1}</td><td><Avatar name={r.employee_name} uid={r.employee_id} size={22} /> <b>{r.employee_name}</b></td>
                    <td className="num"><b>{r.no_of_tasks}</b></td><td className="num">{r.estimate_total_display}</td><td className="num">{(r.estimate_unit || 0).toFixed(2)}</td><td className="num">{r.duration_display}</td>
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={6} className="empty">No data for these filters.</td></tr>}
              </tbody>
              {list.length > 0 && <tfoot><tr><td colSpan={2} style={{ fontWeight: 900, color: "var(--navy)" }}>Total</td><td className="num" style={{ fontWeight: 900 }}>{tot.tasks}</td><td className="num" style={{ fontWeight: 900 }}>{R.dhm(tot.est)}</td><td className="num" style={{ fontWeight: 900 }}>{tot.unit.toFixed(2)}</td><td className="num" style={{ fontWeight: 900 }}>{R.dhm(tot.dur)}</td></tr></tfoot>}
            </table>
          )}
        </div>
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `Tasks — ${open.name}` : ""} width={980} footer={<Button kind="ghost" onClick={() => setOpen(null)}>Close</Button>}>
        {open && !open.tasks && <Skeleton rows={5} />}
        {open?.tasks && (
          <div className="table-scroll" style={{ maxHeight: "60vh" }}>
            <table className="table">
              <thead><tr><th>Seq</th><th>Task</th><th>KRA</th><th>Priority</th><th>Status</th><th className="num">Estimated h</th><th className="num">Hours spent</th><th className="num">Units spent</th><th /></tr></thead>
              <tbody>
                {open.tasks.map((t) => { const [tone, lbl] = stateTone(t.task_state); return (
                  <tr key={t.id}>
                    <td><span className="ref">#{t.seq_no}</span></td><td><b>{t.name}</b></td><td>{t.kra_name || "—"}</td>
                    <td><Lozenge tone={PRI[t.priority] || "neutral"}>{t.priority || "—"}</Lozenge></td><td><Lozenge tone={tone}>{lbl}</Lozenge></td>
                    <td className="num">{(t.estimated_hrs || 0).toFixed(2)}</td><td className="num">{(t.hrs_spent || 0).toFixed(2)}</td><td className="num">{(t.unit_spent || 0).toFixed(2)}</td>
                    <td><Button size="sm" onClick={() => { setOpen(null); acts.openTask(t.id); }}>View</Button></td>
                  </tr>
                ); })}
                {!open.tasks.length && <tr><td colSpan={9} className="empty">No tasks for this employee in the period.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  );
}
