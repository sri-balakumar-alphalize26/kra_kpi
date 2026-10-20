"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Avatar, Button, ErrorState, Field, Icon, IconButton, Lozenge, PageHeader, Select, Skeleton, Tabs, useFlags } from "@/components/ui";
import { useResource } from "@/lib/useFetch";
import { invalidate } from "@/lib/api";
import { useMe } from "@/lib/me";
import * as P from "@/lib/services/portal";
import { BulkSignOff, CertificatePreview, SignatureCard, SignatureFields, useSignature } from "./SignOff";

/* The client's tasks: tabs, table, and a right-side sheet to approve the
   estimate/developer (pre-approval), sign off finished work, or send it back.
   Finished work can also be ticked in the table and signed off in one go.

   Two different "approvals" — keep them apart:
   - pre-approval (go-ahead on the developer/estimate) → /kpi_pre_approval/list
   - sign-off (accept finished work)                   → dashboard pending_approvals */
const TABS = [{ key: "all", label: "All" }, { key: "approval", label: "Approval needed" }, { key: "in_progress", label: "In progress" }, { key: "queued", label: "Queued" }, { key: "completed", label: "Completed" }];
const GROUP = { in_progress: ["in_progress", "paused", "hold", "rework", "partially_completed"], queued: ["assigned", "pre_approval_pending", "pre_approval_partial", "pre_approval_approved", "regular", "important", "urgent"], completed: ["completed"] };
const label = (s) => ({ in_progress: ["progress", "In progress"], paused: ["paused", "Paused"], hold: ["paused", "On hold"], rework: ["danger", "Rework"], partially_completed: ["review", "Being reviewed"], awaiting_client: ["review", "Your sign-off needed"], completed: ["done", "Certified"], assigned: ["todo", "Scheduled"], pre_approval_pending: ["review", "Approve estimate"], pre_approval_partial: ["review", "Approve estimate"], pre_approval_approved: ["todo", "Approved · scheduled"] }[s] || ["todo", s || "—"]);

/* Also the Completions page (Odoo's client Completions menu): the same list,
   opened on the tasks waiting for the client's sign-off, with its own title. */
export default function PortalRequests({ initialTab, title = "My requests", signatureCard = false } = {}) {
  const sp = useSearchParams();
  const router = useRouter();
  const flags = useFlags();
  const { me } = useMe();
  const [tab, setTab] = useState(sp.get("tab") || initialTab || "all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);
  const dash = useResource(P.DASH_PATH, { state: "all" }, { pollMs: 30000, ttl: 10000 });
  const preRes = useResource(P.PRE_LIST_PATH, {}, { pollMs: 30000, ttl: 10000 });
  const d = dash.data;
  const preList = useMemo(() => preRes.data?.kpis || [], [preRes.data]);
  const preById = useMemo(() => new Map(preList.map((p) => [p.id, p])), [preList]);
  const signIds = useMemo(() => new Set([...(d?.pending_approvals || []).map((p) => p.id), ...(d?.kpis || []).filter((k) => k.task_state === "awaiting_client").map((k) => k.id)]), [d]);
  /* Pre-approval tasks may not be in the dashboard list yet; show them anyway. */
  const kpis = useMemo(() => {
    const base = d?.kpis || [];
    const have = new Set(base.map((k) => k.id));
    const extraSign = (d?.pending_approvals || []).filter((k) => !have.has(k.id));
    extraSign.forEach((k) => have.add(k.id));
    const extraPre = preList.filter((p) => !have.has(p.id)).map((p) => ({ ...p, primary_assignee: p.developer }));
    return [...base, ...extraSign, ...extraPre];
  }, [d, preList]);
  const needsMe = (k) => signIds.has(k.id) || preById.has(k.id);
  /* Project / developer filters (Odoo's client dashboard): they narrow the list,
     the tab counts and the REQ / UPT / BUG tiles alike. */
  const [projects, setProjects] = useState([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  useEffect(() => { P.fetchClientProjects().then(setProjects).catch(() => setProjects([])); }, []);
  const userOptions = useMemo(() => {
    const seen = new Map();
    for (const x of kpis) if (x.primary_assignee_id && !seen.has(x.primary_assignee_id)) seen.set(x.primary_assignee_id, x.primary_assignee || `User #${x.primary_assignee_id}`);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [kpis]);
  const scoped = useMemo(() => kpis.filter((k) => (!projectFilter || k.project_id === +projectFilter) && (!userFilter || k.primary_assignee_id === +userFilter)), [kpis, projectFilter, userFilter]);
  const byType = useMemo(() => {
    const out = { requirement: { total: 0, done: 0, open: 0 }, update: { total: 0, done: 0, open: 0 }, bug: { total: 0, done: 0, open: 0 } };
    for (const k of scoped) { const b = out[k.kind] || out.requirement; b.total++; if (k.task_state === "completed") b.done++; else b.open++; }
    return out;
  }, [scoped]);
  const rows = useMemo(() => scoped.filter((k) => {
    if (q && !`${k.external_ref} ${k.name} ${k.project_name}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (tab === "all") return true;
    if (tab === "approval") return needsMe(k);
    return (GROUP[tab] || []).includes(k.task_state);
  }), [scoped, tab, q, signIds, preById]); // eslint-disable-line react-hooks/exhaustive-deps
  const signableShown = rows.filter((k) => signIds.has(k.id));
  const pickedTasks = kpis.filter((k) => picked.has(k.id) && signIds.has(k.id));
  useEffect(() => { setPicked((s) => { const n = new Set([...s].filter((id) => signIds.has(id))); return n.size === s.size ? s : n; }); }, [signIds]);

  const focusId = +sp.get("focus");
  const sel = kpis.find((k) => k.id === focusId) || null;
  const pre = preById.get(focusId) || null;
  const open = (k) => router.replace(`/portal/requests?tab=${tab}&focus=${k.id}`, { scroll: false });
  const close = () => router.replace(`/portal/requests?tab=${tab}`, { scroll: false });
  const refresh = () => { invalidate("/kpi_client_portal"); invalidate("/kpi_pre_approval"); invalidate("/kpi_client_approval"); invalidate("/kpi_client_invoice"); dash.refresh(); preRes.refresh(); };
  const togglePick = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allShownPicked = signableShown.length > 0 && signableShown.every((k) => picked.has(k.id));
  const loading = (!d && !dash.error) || (!preRes.data && !preRes.error && !d);

  return (
    <>
      <PageHeader crumbs={[{ label: d?.clients?.[0]?.name || "Portal" }, { label: title }]} title={title}>
        <label className="search" style={{ margin: 0, width: 220 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search requests" aria-label="Search" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
      </PageHeader>
      <div className="page" style={{ maxWidth: 1180 }}>
        {signatureCard && <SignatureCard />}
        <div className="toolbar">
          {projects.length > 1 && (
            <span className="input" style={{ height: 32, minWidth: 200 }}><Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Project" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={String(p.id)}>{p.display || p.name}</option>)}</Select></span>
          )}
          <span className="input" style={{ height: 32, minWidth: 180 }}><Select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Developer" style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}><option value="">All developers</option>{userOptions.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}</Select></span>
          {(projectFilter || userFilter) && <Button size="sm" kind="ghost" onClick={() => { setProjectFilter(""); setUserFilter(""); }}>Clear</Button>}
          {(projectFilter || userFilter) && <span className="mini">{rows.length} task(s){userFilter ? ` · ${userOptions.find((u) => String(u.id) === userFilter)?.name || ""}` : ""}{projectFilter ? ` · ${(projects.find((p) => String(p.id) === projectFilter) || {}).display || ""}` : ""}</span>}
        </div>
        {d && (
          <div className="stats" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {[["requirement", "Requirements", "var(--tint-blue)"], ["update", "Updates / Amendments", "var(--pri-important)"], ["bug", "Bugs", "var(--tint-red)"]].map(([k, l, c]) => (
              <div key={k} className="stat" style={{ borderLeft: `4px solid ${c}` }}><small>{l}</small><b>{byType[k].total}</b><span>✓ {byType[k].done} done · {byType[k].open} open</span></div>
            ))}
          </div>
        )}
        <Tabs items={TABS.map((t) => ({ ...t, count: d ? (t.key === "all" ? scoped.length : t.key === "approval" ? scoped.filter(needsMe).length : scoped.filter((k) => (GROUP[t.key] || []).includes(k.task_state)).length) : undefined }))} value={tab} onChange={setTab} />
        {dash.error && !d && <ErrorState error={dash.error} onRetry={dash.refresh} />}
        {d?.authorized === false && <div className="cardbox"><b style={{ color: "var(--navy)" }}>Your account isn&apos;t linked to a client yet</b><span className="mini">{d.message}</span></div>}
        {signIds.size > 0 && (
          <div className="callout" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet)", color: "var(--tint-violet-text)", flexWrap: "wrap" }}>
            <Icon n="flag" size={18} />
            <span style={{ flex: 1, minWidth: 220 }}>{picked.size ? <><b>{pickedTasks.length} selected</b> for sign-off.</> : <><b>{signIds.size} finished task{signIds.size === 1 ? "" : "s"}</b> waiting for your sign-off. Tick them in the list to sign several at once.</>}</span>
            {picked.size > 0 && <Button size="sm" kind="ghost" onClick={() => setPicked(new Set())}>Clear</Button>}
            {!picked.size && <Button size="sm" onClick={() => { setTab("approval"); setPicked(new Set(signIds)); }}>Select all</Button>}
            <Button size="sm" kind="ok" disabled={!pickedTasks.length} onClick={() => setBulk(pickedTasks)}>Sign off {pickedTasks.length || ""} selected</Button>
          </div>
        )}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {loading ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : (
            <table className="table">
              <thead><tr>
                <th style={{ width: 28 }}>{signableShown.length > 0 && <input type="checkbox" aria-label="Select all finished tasks shown" checked={allShownPicked} onChange={() => setPicked((s) => { const n = new Set(s); signableShown.forEach((k) => (allShownPicked ? n.delete(k.id) : n.add(k.id))); return n; })} />}</th>
                <th>Ref</th><th style={{ width: "30%" }}>Request</th><th>Project</th><th>Status</th><th>Developer</th><th style={{ width: "14%" }}>Progress</th><th>Needed by</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((k) => {
                  const isPre = preById.has(k.id);
                  const isSign = signIds.has(k.id);
                  const [tone, lbl] = isSign ? ["review", "Your sign-off needed"] : isPre ? ["review", "Approve estimate"] : label(k.task_state);
                  const pct = k.task_state === "completed" || isSign ? 100 : k.estimate_hours ? Math.min(100, Math.round(((k.actual_hours || k.hours || 0) / k.estimate_hours) * 100)) : 0;
                  return (
                    <tr key={k.id} className={focusId === k.id ? "sel" : ""} style={{ cursor: "pointer" }} onClick={() => open(k)}>
                      <td onClick={(e) => e.stopPropagation()}>{isSign && <input type="checkbox" aria-label={`Select ${k.external_ref || k.name}`} checked={picked.has(k.id)} onChange={() => togglePick(k.id)} />}</td>
                      <td><span className="ref">{k.external_ref || `#${k.id}`}</span></td>
                      <td><b>{k.name}</b></td><td>{k.project_name || "—"}</td>
                      <td><Lozenge tone={tone}>{lbl}</Lozenge></td>
                      <td>{k.primary_assignee ? <><Avatar name={k.primary_assignee} uid={k.primary_assignee_id} size={22} /> {k.primary_assignee}</> : <span className="mini">to be assigned</span>}</td>
                      <td><span className="prog"><i style={{ width: `${pct}%`, background: k.task_state === "completed" ? "var(--pri-regular)" : isSign ? "var(--tint-violet)" : "var(--brand)" }} /></span></td>
                      <td>{k.deadline || "—"}</td>
                      <td>{(isSign || isPre) ? <Button size="sm" kind="primary" onClick={(e) => { e.stopPropagation(); open(k); }}>{isSign ? "Review" : "Approve"}</Button> : k.has_signed_certificate ? <a className="btn" style={{ height: 28, fontSize: 12, textDecoration: "none" }} href={P.certificateHref(k.id)} onClick={(e) => e.stopPropagation()}>Certificate</a> : <Button size="sm" onClick={(e) => { e.stopPropagation(); open(k); }}>Open</Button>}</td>
                    </tr>
                  );
                })}
                {d && !rows.length && <tr><td colSpan={9} className="empty">Nothing in this tab.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {sel && <RequestSheet key={sel.id} k={sel} pre={pre} canSign={signIds.has(sel.id)} myName={me?.name || ""} onClose={close} onDone={() => { refresh(); close(); }} flags={flags} />}
      {bulk && <BulkSignOff tasks={bulk} defaultName={me?.name || ""} onClose={() => setBulk(null)} onDone={(r) => { setPicked((s) => { const n = new Set(s); (r.approved || []).forEach((id) => n.delete(id)); return n; }); refresh(); }} />}
    </>
  );
}

function RequestSheet({ k, pre, canSign, myName, onClose, onDone, flags }) {
  const [mode, setMode] = useState("view"); /* view | signoff | sendback | pre_reject */
  const [reason, setReason] = useState(""); const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const s = useSignature(myName);
  const [tone, lbl] = canSign ? ["review", "Your sign-off needed"] : pre ? ["review", "Approve estimate"] : label(k.task_state);
  useEffect(() => { const onKey = (e) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey); }, [onClose]);

  const run = async (fn, ok) => { setBusy(true); try { const r = P.assertOk(await fn(), "Could not save."); flags.ok(r?.message && r.message !== "Approved successfully." ? r.message : ok); onDone(); } catch (e) { flags.err(e.message); } finally { setBusy(false); } };

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="sheet" style={{ width: "min(600px, 100vw)", top: 56, zIndex: 46, overflowY: "auto" }} aria-label={k.external_ref || "Request"}>
        <div className="row"><span className="ref" style={{ fontSize: 13 }}>{k.external_ref || `#${k.id}`}</span><Lozenge tone={tone}>{lbl}</Lozenge><IconButton icon="x" label="Close" style={{ marginLeft: "auto" }} onClick={onClose} /></div>
        <h2>{k.name}</h2>
        {k.description && <p style={{ margin: 0, fontSize: 13.5, lineHeight: "20px", whiteSpace: "pre-wrap" }}>{k.description}</p>}
        <dl className="details">
          <dt>Project</dt><dd>{k.project_name || "—"}{k.delivery_version ? ` · ${k.delivery_version}` : ""}</dd>
          <dt>Type</dt><dd>{(k.kind || "").toString().replace(/^\w/, (c) => c.toUpperCase()) || "Request"}</dd>
          <dt>Developer</dt><dd>{k.primary_assignee || pre?.developer || <span className="mini">to be assigned</span>}</dd>
          <dt>Estimate</dt><dd>{k.estimate_hours ? `${k.estimate_hours}h` : "—"}{k.actual_hours || k.hours ? <span className="mini"> · {k.actual_hours || k.hours}h worked</span> : null}</dd>
          <dt>Priority</dt><dd>{k.priority || "regular"}</dd>
          {k.deadline && <><dt>Needed by</dt><dd>{k.deadline}</dd></>}
          {k.completion_date && <><dt>Completed</dt><dd>{k.completion_date}</dd></>}
          {k.client_signed && <><dt>Signed off</dt><dd>by you{k.has_signed_certificate ? <> · <a href={P.certificateHref(k.id)}>certificate</a></> : null}</dd></>}
        </dl>

        {pre && mode === "view" && (
          <div className="cardbox" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet-border)", gap: 8 }}>
            <b style={{ color: "var(--tint-violet-text)" }}>{pre.auto_released ? "Work started without your reply — you can still object" : "Approve the estimate and developer?"}</b>
            <span className="mini">{pre.developer ? `Developer: ${pre.developer}` : ""}{pre.held ? " · on hold — the team will not start" : pre.auto_releases && pre.deadline_at ? ` · starts automatically after ${pre.deadline_at} (server time)` : ""}</span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {!pre.auto_released && <Button kind="ok" busy={busy} onClick={() => run(() => P.decidePreApproval(k.id, "approve"), "Approved — work can start.")}>Approve</Button>}
              <Button kind="ghost" onClick={() => setMode("pre_reject")}>Not like this</Button>
              {!pre.auto_released && <Button kind="ghost" busy={busy} onClick={() => run(() => P.decidePreApproval(k.id, pre.held ? "resume" : "hold"), pre.held ? "Released." : "On hold.")}>{pre.held ? "Release hold" : "Hold"}</Button>}
            </div>
          </div>
        )}
        {mode === "pre_reject" && (
          <div className="cardbox" style={{ gap: 10 }}>
            <b style={{ color: "var(--navy)" }}>What should change?</b>
            <div className="chips">{P.REJECT_REASONS.map((r) => <button key={r.code} className={`pill ${code === r.code ? "on" : ""}`} onClick={() => setCode(r.code)}>{r.emoji} {r.label}</button>)}</div>
            {code === "other" && <Field label="Tell us more"><span className="input ta"><textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>}
            <div className="row"><Button kind="danger" busy={busy} disabled={!code || (code === "other" && !reason.trim())} onClick={() => run(() => P.decidePreApproval(k.id, "reject", code === "other" ? reason.trim() : P.REJECT_REASONS.find((r) => r.code === code)?.label), "Sent back to the team.")}>Send back</Button><Button kind="ghost" onClick={() => setMode("view")}>Cancel</Button></div>
          </div>
        )}

        {canSign && mode === "view" && (
          <div className="cardbox" style={{ background: "var(--lz-review-bg)", borderColor: "var(--tint-violet-border)", gap: 8 }}>
            <b style={{ color: "var(--tint-violet-text)" }}>The team says this is done. Is it?</b>
            <span className="mini">Approving issues a completion certificate{s.sig?.hasSignature ? " with your saved signature" : " signed with your typed name"} and moves it to the next invoice.</span>
            <div className="row"><Button kind="ok" onClick={() => setMode("signoff")}>Review &amp; sign</Button><Button kind="ghost" onClick={() => setMode("sendback")}>Request changes</Button></div>
          </div>
        )}
        {mode === "signoff" && (
          <div className="cardbox" style={{ gap: 10 }}>
            <b style={{ color: "var(--navy)" }}>Sign off {k.external_ref || "this task"}</b>
            <CertificatePreview kpiId={k.id} signer={s.name.trim()} sig={s.sig} />
            <SignatureFields s={s} />
            <div className="row"><Button kind="ok" busy={busy} disabled={!s.ready} onClick={() => run(() => P.signOff(k.id, { signatureText: s.name, notes: s.notes }), "Signed off — certificate issued.")}>Approve &amp; certify</Button><Button kind="ghost" onClick={() => setMode("view")}>Cancel</Button></div>
          </div>
        )}
        {mode === "sendback" && (
          <div className="cardbox" style={{ gap: 10 }}>
            <b style={{ color: "var(--navy)" }}>What isn&apos;t right?</b>
            <Field label="Reason" required><span className="input ta"><textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. The merged table name doesn't show in the waiter app" style={{ border: 0, background: "none", outline: 0, resize: "none", width: "100%", height: "100%", font: "inherit", color: "inherit" }} /></span></Field>
            <div className="row"><Button kind="danger" busy={busy} disabled={!reason.trim()} onClick={() => run(() => P.sendBack(k.id, reason), "Sent back for rework.")}>Request changes</Button><Button kind="ghost" onClick={() => setMode("view")}>Cancel</Button></div>
          </div>
        )}
      </aside>
    </>
  );
}
