"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Button, ErrorState, Field, Input, Lozenge, Modal, PageHeader, Select, Skeleton, Tabs, useDialogs, useFlags, useOutside } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import * as R from "@/lib/services/reports";
import { DELIVERABLES, DELIVERABLE_OTHER_REQUIRED, deliverableOtherValue } from "@/lib/services/kpiActions";
import OtherTypeInput from "@/components/task/OtherTypeInput";
import ReportsNav from "./ReportsNav";
import { blobToB64, saveBlob } from "./exportLibs";
import { buildKraExcel, buildKraPdf, buildKraZip, fmtSec, isoWeek, projectSummary, rowDateOf, totalSeconds, uniqueEmployees } from "./kraExport";

/* KRA report (port of the Odoo kpi_kra_report screen).

   A working document, not just a view: rows can be trimmed, people renamed for
   this report, and report-only tasks added. All of that, the filters and the
   search are kept on the server per user (kra/state_set) in the SAME shape the
   Odoo screen stores, so either screen picks up where the other left off.
   Downloads (PDF, two-sheet Excel, ZIP pack) are built in the browser with the
   same builders as Odoo, and are blocked while the filters differ from the
   ones the table was generated with. */
const selStyle = { border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" };
const today = () => R.ymd(new Date());
const monthStart = () => { const d = new Date(); return R.ymd(new Date(d.getFullYear(), d.getMonth(), 1)); };
const blankFilters = (from = today(), to = today()) => ({ from_date: from, to_date: to, employee_ids: [], kra_ids: [], excluded_kra_ids: [], task_types: [], task_states: [], time_frame: "" });
/* The Odoo screen's filtersSignature: sorted ids, time_frame left out. */
const sigOf = (f) => JSON.stringify({
  from_date: f.from_date, to_date: f.to_date,
  employee_ids: [...f.employee_ids].sort((a, b) => a - b), kra_ids: [...f.kra_ids].sort((a, b) => a - b),
  excluded_kra_ids: [...f.excluded_kra_ids].sort((a, b) => a - b),
  task_types: [...f.task_types].sort(), task_states: [...f.task_states].sort(),
});
const paramsOf = (f) => R.kraParams({ from: f.from_date, to: f.to_date, employees: f.employee_ids, kras: f.kra_ids, excludedKras: f.excluded_kra_ids, types: f.task_types, states: f.task_states });
const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const optId = (o) => o?.code ?? o?.id ?? o;
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b || 0} B`);
const DOC_TYPE_TO_PREFIX = { requirement: "REQ", update: "UPT", bug: "BUG" };
const typeTone = (t) => (/^BUG/i.test(t || "") ? "danger" : /^UP/i.test(t || "") ? "paused" : /^REQ/i.test(t || "") ? "review" : "neutral");
const QUICK = [["", "Custom"], ["today", "Today"], ["yesterday", "Yesterday"], ["last_month", "Last month"], ["last_year", "Last year"]];
const blankTask = () => ({ name: "", kra_id: "", user_id: "", doc_type: "requirement", deliverable_type: "", deliverable_other: "", estimate_hours: 0, estimate_minutes: 0, worked_hours: 0, worked_minutes: 0, priority: "regular", deadline: "", description: "", error: "" });

export default function KraReport() {
  const flags = useFlags();
  const dialogs = useDialogs();
  const filters = useResource(R.KRA_FILTERS_PATH, {}, { ttl: 60000 });
  const f = filters.data?.status === false ? null : filters.data;
  const filtersErr = filters.error || (filters.data?.status === false ? new Error(filters.data.message || "Could not load the filters.") : null);

  const [flt, setFlt] = useState(() => blankFilters(monthStart(), today()));
  const [rep, setRep] = useState(null);          /* {data, filters} from kra/generate */
  const [genSig, setGenSig] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [removed, setRemoved] = useState([]);    /* trimmed row ids (this report only) */
  const [overrides, setOverrides] = useState({}); /* employee_id -> report-only name */
  const [localRows, setLocalRows] = useState([]); /* report-only tasks */
  const [group, setGroup] = useState("none");
  const [isAdmin, setIsAdmin] = useState(false);
  const [counts, setCounts] = useState(null);
  const [ready, setReady] = useState(false);
  const [createdHidden, setCreatedHidden] = useState(null);
  const [zipOpen, setZipOpen] = useState(false);
  const [dl, setDl] = useState(null);
  const [history, setHistory] = useState(null);  /* {rows, loading} | null */
  const [nt, setNt] = useState(null); const [ntBusy, setNtBusy] = useState(false); const [ntMatches, setNtMatches] = useState([]);
  const [rename, setRename] = useState(null);
  const saved = useRef(null);
  const zipRef = useOutside(useCallback(() => setZipOpen(false), []));

  const signature = useMemo(() => sigOf(flt), [flt]);
  const isStale = !!rep && genSig !== signature;
  const setF = (patch) => setFlt((x) => ({ ...x, ...patch }));

  /* ---- generate ---- */
  const generate = useCallback(async (fl, { keepRemoved = false } = {}) => {
    setBusy(true);
    try {
      const r = R.assertOk(await R.generateKraReport(paramsOf(fl)), "Could not build the report.");
      setRep({ data: r.data || [], filters: r.filters || {} });
      setGenSig(sigOf(fl));
      /* The trimmed list refers to rows of the previous run; renames and
         report-only rows are edits to the report and survive. A restore keeps
         them too, so a closed tab does not lose the trimming. */
      if (!keepRemoved) setRemoved([]);
      return r.data || [];
    } catch (e) { flags.err(e.message); return null; } finally { setBusy(false); }
  }, [flags]);

  /* ---- restore the saved view once (Odoo's shape) ---- */
  useEffect(() => {
    let alive = true;
    R.fetchKraContext().then((ctx) => {
      if (!alive) return;
      if (!ctx || ctx.status === false) { setReady(true); return; }
      setIsAdmin(!!ctx.is_admin);
      let s = null;
      try { s = ctx.saved_state ? JSON.parse(ctx.saved_state) : null; } catch (e) { s = null; }
      if (s && typeof s === "object") {
        saved.current = s;
        const sf = s.filters || {};
        const ids = (v) => (Array.isArray(v) ? v : []).map(Number).filter(Boolean);
        const strs = (v) => (Array.isArray(v) ? v : []).map(String).filter(Boolean);
        const next = {
          ...blankFilters(sf.from_date || monthStart(), sf.to_date || today()),
          employee_ids: ids(sf.employee_ids), kra_ids: ids(sf.kra_ids), excluded_kra_ids: ids(sf.excluded_kra_ids),
          task_types: strs(sf.task_types), task_states: strs(sf.task_states), time_frame: sf.time_frame || "",
        };
        setFlt(next);
        setSearch(s.searchQuery || "");
        setRemoved(Array.isArray(s.removedRowIds) ? s.removedRowIds : []);
        setOverrides(s.nameOverrides && typeof s.nameOverrides === "object" ? s.nameOverrides : {});
        setLocalRows(Array.isArray(s.localRows) ? s.localRows : []);
        if (s.webGroup) setGroup(s.webGroup);
        /* Re-run rather than restore rows: the report is a view of live data. */
        if (s.generatedSignature) generate(next, { keepRemoved: true });
      }
      setReady(true);
    });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- remember the view (debounced, fire-and-forget) ---- */
  const latest = useRef({});
  latest.current = { flt, search, removed, overrides, localRows, genSig, group };
  const persistTimer = useRef(null);
  const persist = () => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const v = latest.current;
      const blank = !saved.current && !v.genSig && !v.search.trim() && !v.removed.length && !Object.keys(v.overrides).length && !v.localRows.length
        && !v.flt.employee_ids.length && !v.flt.kra_ids.length && !v.flt.excluded_kra_ids.length && !v.flt.task_types.length && !v.flt.task_states.length;
      R.setKraState(blank ? "" : JSON.stringify({
        filters: { ...v.flt }, searchQuery: v.search, removedRowIds: [...v.removed], nameOverrides: { ...v.overrides },
        localRows: [...v.localRows], generatedSignature: v.genSig || "", webGroup: v.group,
      }));
    }, 600);
  };
  useEffect(() => { if (ready) persist(); }, [ready, flt, search, removed, overrides, localRows, genSig, group]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(persistTimer.current), []);

  /* ---- live counts per filter option ---- */
  useEffect(() => {
    if (!ready) return undefined;
    let stale = false;
    const t = setTimeout(() => { R.kraFilterCounts(paramsOf(flt)).then((r) => { if (!stale && r && r.status !== false) setCounts(r); }); }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [signature, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Absent from the reply means nothing matched: 0, not unknown. */
  const countOf = (facet, id, fallback) => (counts ? counts[facet]?.[String(id)] || 0 : fallback);

  /* ---- the rows every figure is derived from ---- */
  const displayName = useCallback((row) => overrides[row.employee_id] || row.employee_name || "", [overrides]);
  const kept = useMemo(() => localRows.concat(rep?.data || []).filter((r) => !removed.includes(r.id)), [localRows, rep, removed]);
  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return kept;
    return kept.filter((r) => [r.kra_path, r.sub_kra, r.kpi_name, r.employee_name, displayName(r), r.task_type, r.task_state_label, r.external_ref].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [kept, search, displayName]);
  const summary = useMemo(() => projectSummary(rows), [rows]);
  const totalSec = totalSeconds(rows);
  const editCount = removed.length + Object.keys(overrides).length + localRows.length;
  const groups = useMemo(() => {
    const key = group === "kra" ? (r) => r.root_kra || r.kra_path : group === "employee" ? (r) => displayName(r) : () => "";
    const m = new Map();
    for (const r of rows) { const k = key(r) || "—"; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()];
  }, [rows, group, displayName]);

  /* ---- filters ---- */
  const quick = (k) => { const r = k ? R.presetRange(k) : null; setF(r ? { time_frame: k, from_date: r[0], to_date: r[1] } : { time_frame: k }); };
  const toggleKra = (id) => setFlt((x) => { const kra_ids = toggleIn(x.kra_ids, id); return { ...x, kra_ids, excluded_kra_ids: kra_ids.includes(id) ? x.excluded_kra_ids.filter((e) => e !== id) : x.excluded_kra_ids }; });
  const toggleExclude = (id) => setFlt((x) => { const excluded_kra_ids = toggleIn(x.excluded_kra_ids, id); return { ...x, excluded_kra_ids, kra_ids: excluded_kra_ids.includes(id) ? x.kra_ids.filter((e) => e !== id) : x.kra_ids }; });

  const clearAll = async () => {
    const warn = editCount
      ? `This discards ${editCount} change(s) made to this report — trimmed rows, renames and report-only tasks. They exist nowhere else (the Odoo screen shares this saved view).`
      : "This clears the filters and the table so you can start a fresh report.";
    if (!(await dialogs.confirm({ title: "Clear the report?", text: warn, confirmLabel: "Clear", danger: !!editCount }))) return;
    clearTimeout(persistTimer.current);
    setFlt(blankFilters()); setSearch(""); setRemoved([]); setOverrides({}); setLocalRows([]);
    setRep(null); setGenSig(""); setCreatedHidden(null); saved.current = null;
    await R.setKraState("");
  };
  const removeRow = (row) => {
    if (row.is_local) { setLocalRows((l) => l.filter((r) => r.id !== row.id)); return; }
    setRemoved((l) => (l.includes(row.id) ? l : [...l, row.id]));
  };
  const showCreated = async () => {
    const next = { ...flt, task_states: [], task_types: [], employee_ids: [] };
    setFlt(next); setCreatedHidden(null);
    await generate(next);
  };

  /* ---- downloads ---- */
  const exportRows = (list) => list.map((r) => ({ ...r, employee_name: displayName(r), user_breakdown: (r.user_breakdown || []).map((u) => ({ ...u, user_name: overrides[u.user_id] || u.user_name })) }));
  const openDl = (kind, include = {}) => {
    setZipOpen(false);
    setDl({ kind, include, scope: "all", employeeIds: [...flt.employee_ids], period: "range", day: flt.from_date || "", week: isoWeek(flt.from_date || ""), month: (flt.from_date || "").slice(0, 7), sort: "", workedOnly: false, saveCopy: isAdmin, busy: false });
  };
  const rowsForDownload = (d) => {
    let out = rows;
    const ctx = { from: flt.from_date };
    if (d.scope === "employee" && d.employeeIds.length) out = out.filter((r) => d.employeeIds.includes(r.employee_id));
    if (d.period === "day" && d.day) out = out.filter((r) => rowDateOf(r, ctx) === d.day);
    else if (d.period === "week" && d.week) out = out.filter((r) => isoWeek(rowDateOf(r, ctx)) === d.week);
    else if (d.period === "month" && d.month) out = out.filter((r) => rowDateOf(r, ctx).slice(0, 7) === d.month);
    if (d.workedOnly) out = out.filter((r) => (r.time_worked_seconds || 0) > 0);
    const by = {
      name: (a, b) => (a.kpi_name || "").localeCompare(b.kpi_name || ""),
      kra: (a, b) => (a.kra_path || "").localeCompare(b.kra_path || ""),
      employee: (a, b) => displayName(a).localeCompare(displayName(b)),
      time: (a, b) => (b.time_worked_seconds || 0) - (a.time_worked_seconds || 0),
      deadline: (a, b) => (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31"),
    }[d.sort];
    return by ? [...out].sort(by) : out;
  };
  const confirmDownload = async () => {
    if (isStale) { flags.err("Filters changed — click Generate report first."); return; }
    const d = dl;
    const picked = rowsForDownload(d);
    if (!picked.length) { flags.err("No tasks to export with these options."); return; }
    setDl({ ...d, busy: true });
    const ctx = { from: flt.from_date, to: flt.to_date, applied: rep?.filters || {}, search: search.trim(), removedCount: removed.length };
    try {
      const out = d.kind === "zip" ? await buildKraZip(exportRows(picked), ctx, d.include) : d.kind === "pdf" ? await buildKraPdf(exportRows(picked), ctx) : await buildKraExcel(exportRows(picked), ctx);
      saveBlob(out.blob, out.fileName);
      setDl(null);
      if (isAdmin && d.saveCopy) {
        /* Best-effort: the file is already downloaded. */
        try {
          const r = await R.saveKraDownload({ data_b64: await blobToB64(out.blob), filename: out.fileName, kind: d.kind, from_date: flt.from_date || false, to_date: flt.to_date || false, row_count: picked.length, filters_json: signature });
          if (r?.status === false) flags.warn(`Downloaded, but no copy was kept: ${r.message || "refused"}.`);
          else flags.ok("Downloaded — a copy is in the download history.");
        } catch (e) { flags.warn(`Downloaded, but no copy was kept: ${e.message}`); }
      } else flags.ok("Downloaded.");
    } catch (e) {
      flags.err(e.message || "Could not build the file.");
      setDl((x) => (x ? { ...x, busy: false } : x));
    }
  };

  /* ---- download history ---- */
  const openHistory = async () => {
    setHistory({ rows: [], loading: true });
    try { const r = await R.fetchKraDownloads(); if (r?.status === false) { flags.err(r.message || "Not authorized."); setHistory({ rows: [], loading: false }); } else setHistory({ rows: r?.downloads || [], loading: false }); }
    catch (e) { flags.err(e.message); setHistory({ rows: [], loading: false }); }
  };
  const redownload = async (h) => { try { const r = R.assertOk(await R.fetchKraDownload(h.id), "That file is no longer available."); const fn = r.filename || h.filename; R.downloadB64(r.data_b64 || "", fn, R.kraDownloadMime(fn)); } catch (e) { flags.err(e.message); } };
  const deleteHistory = async (h) => {
    if (!(await dialogs.confirm({ title: `Delete "${h.filename}"?`, text: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    try { R.assertOk(await R.deleteKraDownload(h.id), "Could not delete that file."); setHistory((x) => ({ ...x, rows: x.rows.filter((r) => r.id !== h.id) })); } catch (e) { flags.err(e.message); }
  };

  /* ---- new task ---- */
  const ntTimer = useRef(null);
  const openNewTask = () => { const t = blankTask(); if (flt.kra_ids.length === 1) t.kra_id = String(flt.kra_ids[0]); setNt(t); setNtMatches([]); };
  useEffect(() => {
    if (!nt) return undefined;
    clearTimeout(ntTimer.current);
    ntTimer.current = setTimeout(async () => { if (!nt.name.trim() || !nt.kra_id) { setNtMatches([]); return; } setNtMatches(await R.kpiNameMatches(nt.name, nt.kra_id)); }, 350);
    return () => clearTimeout(ntTimer.current);
  }, [nt?.name, nt?.kra_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const submitNewTask = async (scope) => {
    const t = nt;
    const err = (m) => setNt({ ...t, error: m });
    if (!t.name.trim()) return err("Task name is required.");
    if (!t.kra_id) return err("Pick a project.");
    const est = (parseInt(t.estimate_hours, 10) || 0) * 3600 + (parseInt(t.estimate_minutes, 10) || 0) * 60;
    if (est <= 0) return err("Estimate Time is required. Please enter hours and/or minutes.");
    const worked = (parseInt(t.worked_hours, 10) || 0) * 3600 + (parseInt(t.worked_minutes, 10) || 0) * 60;
    if (worked <= 0) return err("Time worked is required. Enter the hours and/or minutes already spent.");
    if (!t.user_id) return err("Pick an assignee — time worked is recorded against a person.");
    if (!t.deliverable_type) return err("Pick a type — Module, App, EXE or Other.");
    const deliverableOther = deliverableOtherValue(t.deliverable_type, t.deliverable_other);
    if (t.deliverable_type === "other" && !deliverableOther) return err(DELIVERABLE_OTHER_REQUIRED);
    if (scope === "report") {
      const kra = (f?.kras || []).find((k) => String(k.id) === String(t.kra_id)) || {};
      const emp = (f?.employees || []).find((e) => String(e.id) === String(t.user_id)) || {};
      setLocalRows((l) => [{
        id: -Date.now(), is_local: true, kra_id: parseInt(t.kra_id, 10), kra_path: kra.name || kra.display || "—", root_kra: kra.name || "—", sub_kra: "-",
        kpi_name: t.name.trim(), external_ref: "", task_type: DOC_TYPE_TO_PREFIX[t.doc_type] || "", task_state: "assigned", task_state_label: "Report only",
        priority: t.priority, deadline: t.deadline || "", employee_id: parseInt(t.user_id, 10) || 0, employee_name: emp.name || "—",
        time_worked_seconds: worked, time_worked_hours: +(worked / 3600).toFixed(2), time_worked_display: fmtSec(worked), user_breakdown: [],
      }, ...l]);
      setNt(null); setNtMatches([]);
      return undefined;
    }
    setNtBusy(true);
    try {
      const kpiId = await R.createKpiOrm({
        name: t.name.trim(), kra_id: parseInt(t.kra_id, 10), doc_type: t.doc_type, deliverable_type: t.deliverable_type, deliverable_other: deliverableOther,
        estimate_hours: parseInt(t.estimate_hours, 10) || 0, estimate_minutes: parseInt(t.estimate_minutes, 10) || 0,
        priority: t.priority, user_id: parseInt(t.user_id, 10), deadline: t.deadline || false, description: t.description,
      });
      /* Filed today, not on the deadline (a future date would push the hours out of this report). */
      if (kpiId) await R.logManualTime(kpiId, worked, t.user_id);
      setNt(null); setNtMatches([]);
      flags.ok(`${t.name.trim()} created.`);
      const data = await generate(flt);
      setCreatedHidden(kpiId && data && !data.some((r) => r.id === kpiId) ? { id: kpiId, name: t.name.trim() } : null);
    } catch (e) { setNt((x) => (x ? { ...x, error: e.message || "Could not create the task." } : x)); }
    finally { setNtBusy(false); }
    return undefined;
  };

  /* ---- rename ---- */
  const beginRename = (row) => setRename({ employee_id: row.employee_id, realName: row.employee_name || "", value: displayName(row), busy: false, error: "" });
  const saveRename = async (scope) => {
    const r = rename;
    const name = (r.value || "").trim();
    if (!name) { setRename({ ...r, error: "Enter a name." }); return; }
    if (scope === "report") {
      setOverrides((o) => { const n = { ...o }; if (name === r.realName) delete n[r.employee_id]; else n[r.employee_id] = name; return n; });
      setRename(null);
      return;
    }
    setRename({ ...r, busy: true, error: "" });
    try {
      R.assertOk(await R.renameUser(r.employee_id, name), "Couldn't rename that person.");
      setOverrides((o) => { const n = { ...o }; delete n[r.employee_id]; return n; });
      setRename(null);
      flags.ok("Renamed everywhere.");
      if (rep) await generate(flt, { keepRemoved: true });
    } catch (e) { setRename((x) => (x ? { ...x, busy: false, error: e.message } : x)); }
  };

  const staleTitle = isStale ? "Filters changed — click Generate report first" : undefined;
  const serialOf = useMemo(() => { const m = new Map(); let i = 0; groups.forEach(([, rs]) => rs.forEach((r) => m.set(r, ++i))); return m; }, [groups]);

  return (
    <>
      <PageHeader crumbs={[{ label: "Reports" }, { label: "KRA report" }]} title="KRA report">
        {rep && (
          <span className="menu-wrap" ref={zipRef}>
            <Button icon="download" disabled={isStale} title={staleTitle || "Bundle the per-task PDFs, plus the full report files you choose"} onClick={() => setZipOpen((o) => !o)}>Download ZIP ▾</Button>
            {zipOpen && (
              <div className="menu" style={{ width: 300 }}>
                <span className="mini" style={{ padding: "6px 10px" }}>What should the archive contain?</span>
                {[[{ pdf: true }, "PDF pack", "full report + one PDF per task"], [{ excel: true }, "Excel pack", "full report + one workbook per project"], [{ pdf: true, excel: true }, "Both packs", "everything above, in one archive"]].map(([inc, l, s]) => (
                  <button key={l} type="button" className="mi" style={{ height: "auto", padding: "8px 10px", flexDirection: "column", alignItems: "flex-start", gap: 2 }} onClick={() => openDl("zip", inc)}><b>{l}</b><span className="mini">{s}</span></button>
                ))}
              </div>
            )}
          </span>
        )}
        {rep && <Button icon="download" disabled={isStale} title={staleTitle || "Download report as PDF"} onClick={() => openDl("pdf")}>PDF</Button>}
        {rep && <Button icon="download" disabled={isStale} title={staleTitle || "Download report as Excel"} onClick={() => openDl("excel")}>Excel</Button>}
      </PageHeader>
      <div className="g12" style={{ flex: 1, minHeight: 0, gridTemplateColumns: "360px minmax(0, 1fr)" }}>
        <div className="cardbox" style={{ overflowY: "auto" }}>
          <h2>Filters {f && <small>{f.employees?.length || 0} employees · {f.kras?.length || 0} KRAs</small>}</h2>
          {filtersErr && !f && <ErrorState error={filtersErr} onRetry={filters.refresh} />}
          {!f && !filtersErr && <Skeleton rows={6} />}
          {f && (
            <>
              <Field label="Quick select"><span className="input"><Select value={flt.time_frame || ""} onChange={(e) => quick(e.target.value)} style={selStyle}>{QUICK.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></span></Field>
              <div className="grid2">
                <Field label="From"><Input type="date" value={flt.from_date} max={flt.to_date} onChange={(e) => setF({ from_date: e.target.value, time_frame: "" })} /></Field>
                <Field label="To"><Input type="date" value={flt.to_date} min={flt.from_date} onChange={(e) => setF({ to_date: e.target.value, time_frame: "" })} /></Field>
              </div>
              <Field label={`KRA ${flt.kra_ids.length ? `(${flt.kra_ids.length})` : "(all)"}${flt.excluded_kra_ids.length ? ` − ${flt.excluded_kra_ids.length} excluded` : ""}`} hint="Tick to include, ⊘ to exclude it and everything under it">
                <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px" }}>
                  {(flt.kra_ids.length > 0 || flt.excluded_kra_ids.length > 0) && <Button size="sm" kind="ghost" onClick={() => setF({ kra_ids: [], excluded_kra_ids: [] })}>Clear</Button>}
                  {(f.kras || []).map((k) => {
                    const c = countOf("kras", k.id, k.task_count);
                    const on = flt.kra_ids.includes(k.id), ex = flt.excluded_kra_ids.includes(k.id);
                    const empty = c === 0 && !on;
                    return (
                      <div key={k.id} className="kv" style={{ padding: "3px 0", gap: 6, border: 0, opacity: empty && !ex ? 0.5 : 1 }}>
                        <label className="chk" style={{ height: "auto", flex: 1, minWidth: 0, gap: 6, paddingLeft: (k.level || 0) * 14, cursor: empty ? "default" : "pointer", textDecoration: ex ? "line-through" : undefined, fontWeight: 500, fontSize: 12.5 }}>
                          <input type="checkbox" checked={on} disabled={empty} onChange={() => toggleKra(k.id)} />
                          <span style={{ overflowWrap: "anywhere" }}>{k.level ? "↳ " : ""}{k.name}</span>
                          {c != null && <span className="mini">{c}</span>}
                        </label>
                        <button type="button" className={`btn ${ex ? "btn-danger" : "btn-ghost"}`} style={{ height: 24, padding: "0 6px", fontSize: 12 }} title={ex ? "Excluded — click to put back" : "Exclude this and everything under it"} aria-label={ex ? `Put back ${k.name}` : `Exclude ${k.name}`} onClick={() => toggleExclude(k.id)}>⊘</button>
                      </div>
                    );
                  })}
                </div>
              </Field>
              <ChipFacet label="Employees" all="All employees" opts={f.employees || []} sel={flt.employee_ids} countOf={(id, fb) => countOf("employees", id, fb)} idOf={(o) => o.id} onToggle={(id) => setF({ employee_ids: toggleIn(flt.employee_ids, id) })} onClear={() => setF({ employee_ids: [] })} />
              <ChipFacet label="Types" all="All types" opts={f.task_types || []} sel={flt.task_types} countOf={(id, fb) => countOf("task_types", id, fb)} idOf={(o) => String(optId(o))} onToggle={(id) => setF({ task_types: toggleIn(flt.task_types, id) })} onClear={() => setF({ task_types: [] })} />
              <ChipFacet label="States" all="All states" opts={f.task_states || []} sel={flt.task_states} countOf={(id, fb) => countOf("task_states", id, fb)} idOf={(o) => String(optId(o))} onToggle={(id) => setF({ task_states: toggleIn(flt.task_states, id) })} onClear={() => setF({ task_states: [] })} />
              <div className="row" style={{ gap: 8 }}>
                <Button kind="primary" size="lg" busy={busy} onClick={() => generate(flt)} style={{ flex: 1 }}>Generate report</Button>
                <Button onClick={() => { setFlt(blankFilters()); setRemoved([]); setSearch(""); }}>Reset</Button>
              </div>
              <span className="mini">Your filters, trimmed rows, renames and report-only tasks are remembered on the server until you press Clear.</span>
            </>
          )}
        </div>

        <div className="cardbox" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px 0", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <ReportsNav />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            {createdHidden && (
              <div className="callout" style={{ background: "var(--lz-done-bg)", borderColor: "var(--pri-regular)", color: "var(--lz-done)", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 220 }}><b>{createdHidden.name}</b> was saved and is on the KPI Action Board, but this report&apos;s filters exclude it — a new task starts as <i>Pre-Approval Approved</i>, so any State, Type or Employee filter hides it.</span>
                <Button size="sm" onClick={showCreated}>Clear those filters and show it</Button>
                <Button size="sm" kind="ghost" onClick={() => setCreatedHidden(null)}>Dismiss</Button>
              </div>
            )}
            {isStale && (
              <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}>
                <span>Filters changed — click <b>Generate report</b> to apply them. Downloads stay disabled until you do, so an export can never disagree with the filters.</span>
              </div>
            )}
            {!rep && !busy && <div className="empty">Select filters and click Generate report. This report shows tasks organised by their KRA hierarchy, with time tracking.</div>}
            {!rep && busy && <Skeleton rows={6} />}
            {rep && (
              <>
                <span className="mini">
                  Showing <b>{rep.filters?.kra_name || "All KRAs"}</b> · {rep.filters?.employee_name || "All Employees"} · {rep.filters?.task_type_name || "All Types"} · {rep.filters?.task_state_name || "All States"} · {rep.filters?.from_date} → {rep.filters?.to_date}
                  {search.trim() ? ` · matching "${search.trim()}"` : ""}
                  {removed.length > 0 && <span style={{ color: "var(--danger)" }}> · {removed.length} rows removed</span>}
                </span>
                {removed.length > 0 && (
                  <div className="callout" style={{ background: "var(--hover)", borderColor: "var(--border)", color: "var(--text)" }}>
                    <span style={{ flex: 1 }}><b>{removed.length}</b> row(s) removed from this report — the tasks themselves are untouched.</span>
                    <Button size="sm" onClick={() => setRemoved([])}>Restore all</Button>
                  </div>
                )}
                <div className="stats" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                  <div className="stat"><small>Total tasks</small><b>{rows.length}</b></div>
                  <div className="stat"><small>Total time worked</small><b>{fmtSec(totalSec)}</b></div>
                  <div className="stat"><small>Employees</small><b>{uniqueEmployees(rows)}</b></div>
                </div>
                <div className="toolbar">
                  <b style={{ color: "var(--navy)" }}>KRA details</b>
                  <span className="right">
                    {isAdmin && <Button size="sm" icon="plus" onClick={openNewTask} title="Add a task to this report, or to the system">New task</Button>}
                    <Button size="sm" kind="ghost" onClick={clearAll} title={editCount ? "Discard this report and start fresh" : "Reset the filters and empty the table"}>Clear{editCount ? ` (${editCount})` : ""}</Button>
                    {isAdmin && <Button size="sm" kind="ghost" onClick={openHistory} title="Reports downloaded earlier">History</Button>}
                    <Input icon="search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" aria-label="Search" style={{ width: 220, height: 30 }} />
                    <span className="mini">Group</span>
                    <Tabs items={[{ key: "none", label: "None" }, { key: "kra", label: "KRA" }, { key: "employee", label: "Employee" }]} value={group} onChange={setGroup} />
                  </span>
                </div>
                {editCount > 0 && (
                  <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)" }}>
                    <span>This report has <b>{editCount}</b> change(s) that exist only here — trimmed rows, renamed people or report-only tasks. They are remembered until you press Clear.</span>
                  </div>
                )}
                <div className="table-scroll" style={{ border: "1px solid var(--border)", borderRadius: 10 }}>
                  <table className="table">
                    <thead><tr><th className="num">#</th><th>Ref</th><th>KRA hierarchy path</th><th>Sub KRA</th><th>Task</th><th>Employee</th><th>Type</th><th>State</th><th className="num">Time worked</th><th>Deadline</th><th /></tr></thead>
                    <tbody>
                      {groups.map(([g, rs]) => (
                        <GroupRows key={g || "all"} g={g} rs={rs} showHead={group !== "none"}
                          renderRow={(r) => (
                            <tr key={`${r.id}`}>
                              <td className="num mini">{serialOf.get(r)}</td>
                              <td><span className="ref">{r.external_ref || (r.is_local ? "—" : `#${r.id}`)}</span></td>
                              <td style={{ whiteSpace: "normal" }}>{r.kra_path}</td>
                              <td>{r.sub_kra && r.sub_kra !== "-" ? <Lozenge tone="neutral">{r.sub_kra}</Lozenge> : <span className="mini">-</span>}</td>
                              <td style={{ whiteSpace: "normal" }}><b>{r.kpi_name}</b>{r.is_local && <Lozenge tone="paused" style={{ marginLeft: 6 }}>report only</Lozenge>}</td>
                              <td>
                                {r.employee_id ? <Avatar name={displayName(r)} uid={r.employee_id} size={22} /> : null} {displayName(r) || "—"}
                                {overrides[r.employee_id] && <span title={`Renamed for this report only — really ${r.employee_name}`}><Lozenge tone="progress" style={{ marginLeft: 6 }}>renamed</Lozenge></span>}
                                {isAdmin && r.employee_id ? <button type="button" className="btn btn-ghost" style={{ height: 22, padding: "0 4px", fontSize: 12, marginLeft: 4 }} title="Rename this person" onClick={() => beginRename(r)}>✎</button> : null}
                                {(r.user_breakdown || []).length > 1 && <span className="mini"> +{r.user_breakdown.length - 1}</span>}
                              </td>
                              <td>{r.task_type ? <Lozenge tone={typeTone(r.task_type)}>{r.task_type}</Lozenge> : <span className="mini">—</span>}</td>
                              <td><Lozenge tone={r.task_state === "completed" ? "done" : r.task_state === "in_progress" ? "progress" : r.task_state === "paused" ? "paused" : "todo"}>{r.task_state_label || r.task_state || "—"}</Lozenge></td>
                              <td className="num">{r.time_worked_display || fmtSec(r.time_worked_seconds)}</td>
                              <td>{r.deadline || "—"}</td>
                              <td><button type="button" className="btn btn-ghost" style={{ height: 24, padding: "0 6px", color: "var(--danger)" }} title="Remove this row from the report (the task itself is not deleted)" onClick={() => removeRow(r)}>✕</button></td>
                            </tr>
                          )} />
                      ))}
                      {!rows.length && <tr><td colSpan={11} className="empty">No data found matching your filters.</td></tr>}
                    </tbody>
                    {rows.length > 0 && <tfoot><tr><td /><td colSpan={7} style={{ fontWeight: 900, color: "var(--navy)" }}>Total · {rows.length} tasks</td><td className="num" style={{ fontWeight: 900 }}>{fmtSec(totalSec)}</td><td colSpan={2} /></tr></tfoot>}
                  </table>
                </div>
                {summary.length > 0 && (
                  <div className="table-scroll" style={{ border: "1px solid var(--border)", borderRadius: 10 }}>
                    <table className="table">
                      <thead><tr><th>KRA summary · KRA path</th><th className="num">Tasks</th><th className="num">Total time</th><th className="num">Employees</th></tr></thead>
                      <tbody>{summary.map((s) => <tr key={s.kra_path}><td style={{ whiteSpace: "normal" }}>{s.kra_path}</td><td className="num">{s.task_count}</td><td className="num">{s.total_display}</td><td className="num">{s.employee_count}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Download options — asked after the format is chosen. */}
      <Modal open={!!dl} onClose={() => !dl?.busy && setDl(null)} title={`Download options · ${dl?.kind === "zip" ? "ZIP pack" : dl?.kind === "pdf" ? "PDF" : "Excel"}`} width={500}
        footer={<><Button kind="ghost" onClick={() => setDl(null)} disabled={dl?.busy}>Cancel</Button><Button kind="primary" icon="download" busy={dl?.busy} onClick={confirmDownload}>{dl?.busy ? "Preparing…" : "Download"}</Button></>}>
        {dl && (
          <>
            <Field label="Who">
              <div className="row" style={{ gap: 14 }}>
                <label className="chk"><input type="radio" checked={dl.scope === "all"} onChange={() => setDl({ ...dl, scope: "all" })} />Everyone in this report</label>
                <label className="chk"><input type="radio" checked={dl.scope === "employee"} onChange={() => setDl({ ...dl, scope: "employee" })} />Only these people</label>
              </div>
            </Field>
            {dl.scope === "employee" && (
              <div className="chips">{(f?.employees || []).map((e) => <button key={e.id} type="button" className={`pill ${dl.employeeIds.includes(e.id) ? "on" : ""}`} style={{ height: 28, fontSize: 12 }} onClick={() => setDl({ ...dl, employeeIds: toggleIn(dl.employeeIds, e.id) })}>{overrides[e.id] || e.name}</button>)}</div>
            )}
            <Field label="Period">
              <span className="input"><Select value={dl.period} onChange={(e) => setDl({ ...dl, period: e.target.value })} style={selStyle}><option value="range">The report&apos;s date range</option><option value="day">A single day</option><option value="week">A week</option><option value="month">A month</option></Select></span>
            </Field>
            {dl.period === "day" && <Input type="date" value={dl.day} onChange={(e) => setDl({ ...dl, day: e.target.value })} />}
            {dl.period === "week" && <Input type="week" value={dl.week} onChange={(e) => setDl({ ...dl, week: e.target.value })} />}
            {dl.period === "month" && <Input type="month" value={dl.month} onChange={(e) => setDl({ ...dl, month: e.target.value })} />}
            <Field label="Sort by">
              <span className="input"><Select value={dl.sort} onChange={(e) => setDl({ ...dl, sort: e.target.value })} style={selStyle}>
                <option value="">Same order as the table</option><option value="name">Task name (A–Z)</option><option value="kra">KRA path (A–Z)</option><option value="employee">Employee (A–Z)</option><option value="time">Time worked (most first)</option><option value="deadline">Deadline (earliest first)</option>
              </Select></span>
            </Field>
            <label className="chk"><input type="checkbox" checked={dl.workedOnly} onChange={(e) => setDl({ ...dl, workedOnly: e.target.checked })} />Only rows with time worked</label>
            {dl.kind === "zip" && <p className="note" style={{ margin: 0 }}>Per-task files are foldered <b>Month / Week / Person</b>, with the whole-report and per-project files at the top of the archive.</p>}
            {isAdmin && <label className="chk"><input type="checkbox" checked={dl.saveCopy} onChange={(e) => setDl({ ...dl, saveCopy: e.target.checked })} />Keep a copy in the download history</label>}
            <span className="mini">{rowsForDownload(dl).length} row(s) will be exported.</span>
          </>
        )}
      </Modal>

      {/* Download history */}
      <Modal open={!!history} onClose={() => setHistory(null)} title="Download history" width={820} footer={<Button kind="ghost" onClick={() => setHistory(null)}>Close</Button>}>
        {history?.loading && <Skeleton rows={4} />}
        {history && !history.loading && !history.rows.length && <span className="mini">Nothing downloaded yet. Files are kept for as long as Configuration says, then removed automatically.</span>}
        {history && !history.loading && history.rows.length > 0 && (
          <div className="table-scroll" style={{ maxHeight: "60vh" }}>
            <table className="table">
              <thead><tr><th>Downloaded</th><th>File</th><th>Covering</th><th className="num">Size</th><th /></tr></thead>
              <tbody>{history.rows.map((h) => (
                <tr key={h.id}>
                  <td className="mini">{h.generated_at}<div>{h.user_name}</div></td>
                  <td style={{ whiteSpace: "normal" }}><Lozenge tone="neutral">{h.kind}</Lozenge> {h.filename}</td>
                  <td className="mini">{h.from_date} → {h.to_date} · {h.row_count} rows</td>
                  <td className="num mini">{fmtSize(h.file_size)}</td>
                  <td><span style={{ display: "inline-flex", gap: 4 }}><Button size="sm" icon="download" onClick={() => redownload(h)}>Get</Button><Button size="sm" kind="ghost" onClick={() => deleteHistory(h)}>Delete</Button></span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* New task */}
      <Modal open={!!nt} onClose={() => !ntBusy && setNt(null)} title="New task" width={760}
        footer={(
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, width: "100%" }}>
            <div className="row" style={{ gap: 8 }}>
              <Button kind="ghost" onClick={() => setNt(null)} disabled={ntBusy}>Cancel</Button>
              <Button onClick={() => submitNewTask("report")} disabled={ntBusy}>This report only</Button>
              <Button kind="primary" busy={ntBusy} onClick={() => submitNewTask("everywhere")}>{ntBusy ? "Creating…" : "Everywhere"}</Button>
            </div>
            <span className="mini" style={{ maxWidth: 520, textAlign: "right" }}><b>This report only</b> adds a row here and nowhere else — it will read the time you entered forever and will not appear on the board. <b>Everywhere</b> creates a real task.</span>
          </div>
        )}>
        {nt && (
          <>
            <div className="grid3" style={{ gap: 10 }}>
              <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column" }}><Field label="Task name" required><Input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} autoFocus /></Field></div>
              <Field label="Priority" required><span className="input"><Select value={nt.priority} onChange={(e) => setNt({ ...nt, priority: e.target.value })} style={selStyle}><option value="regular">Regular</option><option value="important">Important</option><option value="urgent">Urgent</option></Select></span></Field>
            </div>
            {ntMatches.length > 0 && (
              <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                <span>{ntMatches.length} task(s) here already use this name:</span>
                {ntMatches.map((m) => <span key={m.id} className="mini">{m.external_ref ? `${m.external_ref} · ` : ""}{m.name}{m.assignee ? ` · ${m.assignee}` : ""}</span>)}
                <span className="mini">You can still save — this is only a heads-up.</span>
              </div>
            )}
            <div className="grid3" style={{ gap: 10 }}>
              <Field label="Project (KRA)" required><span className="input"><Select value={nt.kra_id} onChange={(e) => setNt({ ...nt, kra_id: e.target.value })} style={selStyle}><option value="">— pick a project —</option>{(f?.kras || []).map((k) => <option key={k.id} value={String(k.id)}>{k.display || k.name}</option>)}</Select></span></Field>
              <Field label="Assignee" required><span className="input"><Select value={nt.user_id} onChange={(e) => setNt({ ...nt, user_id: e.target.value })} style={selStyle}><option value="">— unassigned —</option>{(f?.employees || []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}</Select></span></Field>
              <Field label="Type (Module / App / EXE / Other)" required><span className="input"><Select value={nt.deliverable_type} onChange={(e) => setNt({ ...nt, deliverable_type: e.target.value })} style={selStyle}><option value="">— choose —</option>{DELIVERABLES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</Select></span></Field>
            </div>
            {nt.deliverable_type === "other" && <OtherTypeInput value={nt.deliverable_other} onChange={(v) => setNt({ ...nt, deliverable_other: v })} autoFocus />}
            <div className="grid3" style={{ gap: 10 }}>
              <Field label="Type" required><span className="input"><Select value={nt.doc_type} onChange={(e) => setNt({ ...nt, doc_type: e.target.value })} style={selStyle}><option value="requirement">Requirement → REQ</option><option value="update">Update → UPT</option><option value="bug">Bug → BUG</option></Select></span></Field>
              <div className="grid2" style={{ gap: 6 }}>
                <Field label="Estimate (h)" required><Input type="number" min="0" value={nt.estimate_hours} onChange={(e) => setNt({ ...nt, estimate_hours: e.target.value })} /></Field>
                <Field label="Estimate (m)"><Input type="number" min="0" max="59" value={nt.estimate_minutes} onChange={(e) => setNt({ ...nt, estimate_minutes: e.target.value })} /></Field>
              </div>
              <Field label="Deadline"><Input type="date" value={nt.deadline} onChange={(e) => setNt({ ...nt, deadline: e.target.value })} /></Field>
            </div>
            <div className="grid3" style={{ gap: 10, alignItems: "end" }}>
              <div className="grid2" style={{ gap: 6 }}>
                <Field label="Time worked (h)" required><Input type="number" min="0" value={nt.worked_hours} onChange={(e) => setNt({ ...nt, worked_hours: e.target.value })} /></Field>
                <Field label="Time worked (m)"><Input type="number" min="0" max="59" value={nt.worked_minutes} onChange={(e) => setNt({ ...nt, worked_minutes: e.target.value })} /></Field>
              </div>
              <span className="mini" style={{ gridColumn: "span 2" }}>Work already done, before the task existed. It is filed today, against the assignee.</span>
            </div>
            <Field label="Description"><span className="input ta" style={{ height: 80 }}><textarea value={nt.description} onChange={(e) => setNt({ ...nt, description: e.target.value })} style={{ ...selStyle, resize: "none", height: "100%" }} /></span></Field>
            {nt.error && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>{nt.error}</div>}
          </>
        )}
      </Modal>

      {/* Rename a person */}
      <Modal open={!!rename} onClose={() => !rename?.busy && setRename(null)} title="Rename" width={460}
        footer={<><Button kind="ghost" onClick={() => setRename(null)} disabled={rename?.busy}>Cancel</Button><Button onClick={() => saveRename("report")} disabled={rename?.busy} title="Show this name on this report only. The person's record is not changed.">This report only</Button><Button kind="primary" busy={rename?.busy} onClick={() => saveRename("everywhere")} title="Change the person's name everywhere it appears">{rename?.busy ? "Saving…" : "Everywhere"}</Button></>}>
        {rename && (
          <>
            <Field label="Name" error={rename.error || undefined} hint={`Currently "${rename.realName}" on their user record.`}><Input value={rename.value} onChange={(e) => setRename({ ...rename, value: e.target.value })} autoFocus /></Field>
          </>
        )}
      </Modal>
    </>
  );
}

/* Employee / Type / State: include-only chips with live counts. An option that
   would return nothing under the other filters is disabled unless selected. */
function ChipFacet({ label, all, opts, sel, countOf, idOf, onToggle, onClear }) {
  return (
    <Field label={`${label} ${sel.length ? `(${sel.length})` : "(all)"}`}>
      <div className="chips">
        <button type="button" className={`pill ${sel.length ? "" : "on"}`} style={{ height: 28, fontSize: 12 }} onClick={onClear}>{all}</button>
        {opts.map((o) => {
          const id = idOf(o);
          const c = countOf(id, o.task_count);
          const on = sel.includes(id);
          const empty = c === 0 && !on;
          return <button key={String(id)} type="button" className={`pill ${on ? "on" : ""}`} disabled={empty} style={{ height: 28, fontSize: 12, opacity: empty ? 0.45 : 1, cursor: empty ? "default" : "pointer" }} onClick={() => onToggle(id)}>{o.name || o.label || id}{c != null ? ` · ${c}` : ""}</button>;
        })}
      </div>
    </Field>
  );
}

function GroupRows({ g, rs, showHead, renderRow }) {
  const sub = rs.reduce((s, r) => s + (r.time_worked_seconds || 0), 0);
  return (
    <>
      {showHead && <tr className="group"><td colSpan={8}>{g} · {rs.length}</td><td className="num">{fmtSec(sub)}</td><td colSpan={2} /></tr>}
      {rs.map((r) => renderRow(r))}
    </>
  );
}
