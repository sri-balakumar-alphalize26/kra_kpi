"use client";
/* The top of the Dashboard's right column (the "369 AI Admin Dashboard"
   design): Client details and Employees today. Everything below it on the
   page is the existing dashboard.

   Client details reads /kpi_owner/client_summary for one client: switch off
   = Auto (this month to date, live), on = Week / Month / Custom dates.
   Employees today reads the rows the page already polls (live tracking merged
   with the overview's per-person numbers), so it updates with them. */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Avatar, Select, Skeleton } from "@/components/ui";
import * as A from "@/lib/services/admin";
import { pad, hm, ST, TS, statusOf, cardText, pauseWhy, since, liveRow, timerLevel, STATUS_ORDER } from "./employeeStatus";
import EmployeePopup from "./EmployeePopup";
import ClientTilePopup from "./ClientTilePopup";

const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch (e) { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export default function DashboardTop({ clients, people, onChanged }) {
  return (
    <div className="d3-top">
      <ClientDetails clients={clients} />
      <EmployeesToday people={people} onChanged={onChanged} />
    </div>
  );
}

/* ---------------- Client details ---------------- */
function range(period, from, to) {
  const t = new Date();
  if (period === "week") { const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return [iso(mon), iso(t)]; }
  if (period === "month") return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)];
  return [from, to];
}
function periodLabel(on, period, from, to) {
  if (!on) return "Auto · live, this month to date";
  const [a, b] = range(period, from, to);
  return `${{ week: "This week", month: "This month", custom: "Custom" }[period]} · ${dmy(a)} – ${dmy(b)}`;
}

function ClientDetails({ clients }) {
  const list = useMemo(() => (clients || []).map((c) => ({ id: c.client_id, name: c.client_name })), [clients]);
  const t = new Date();
  const [st, setSt] = useState(() => load("kpi.db.client", { clientId: 0, on: false, period: "week", from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }));
  const set = (patch) => setSt((s) => { const n = { ...s, ...patch }; save("kpi.db.client", n); return n; });
  const clientId = list.some((c) => c.id === st.clientId) ? st.clientId : list[0]?.id;
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tile, setTile] = useState(null); /* which tile's popup is open */

  useEffect(() => {
    if (!clientId) return;
    const [a, b] = st.on ? range(st.period, st.from, st.to) : [null, null];
    if (st.on && (!a || !b)) return;
    let gone = false;
    setBusy(true);
    A.fetchClientSummary(clientId, a, b)
      .then((r) => { if (gone) return; if (r?.status === false) setErr(r.message || "Couldn't load this client."); else { setData(r); setErr(""); } })
      .catch((e) => { if (!gone) setErr(e.message); })
      .finally(() => { if (!gone) setBusy(false); });
    return () => { gone = true; };
  }, [clientId, st.on, st.period, st.from, st.to]);

  const d = data && data.client?.id === clientId ? data : null;
  const used = d?.hours_used || 0, quoted = d?.hours_quoted || 0;
  const over = quoted > 0 && used > quoted;
  const pct = quoted > 0 ? Math.min(100, Math.round((used / quoted) * 100)) : 0;
  const hoursNote = !quoted ? (used ? "no quote on the tasks worked" : "no time logged in this period")
    : over ? `${Math.round((used / quoted - 1) * 100)}% over quote` : `${Math.round((quoted - used) * 10) / 10}h left on quote`;
  const sym = d?.currency?.symbol || "";
  const inv = d?.last_invoice;
  const invState = inv ? `${inv.name} · ${inv.payment_status === "paid" ? "Paid" : { draft: "Draft", finalized: "Finalized", sent: "Sent" }[inv.state] || inv.state}` : "No invoice yet";
  const due = d && d.amount_due > 0
    ? `${sym}${Number(d.amount_due).toLocaleString("en-IN", { maximumFractionDigits: 0 })} due${d.due_date ? ` on ${dmy(d.due_date)}` : ""}`
    : "Nothing due";

  return (
    <section className="d3-card" aria-labelledby="d3-clients-h">
      <div className="d3-head">
        <div className="d3-l">
          <h2 id="d3-clients-h">Client details</h2>
          {list.length > 1 && (
            <span className="d3-pick"><span className="d3-lbl">Client</span>
              <span className="input" style={{ height: 34, minWidth: 180 }}><Select value={String(clientId || "")} onChange={(e) => set({ clientId: Number(e.target.value) })} aria-label="Client" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", fontWeight: 600 }}>
                {list.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </Select></span>
            </span>
          )}
        </div>
        <div className="d3-ctrls">
          <button type="button" className="d3-switch" role="switch" aria-checked={st.on} aria-label="Filter by period" onClick={() => set({ on: !st.on })}><span className="d3-track"><span className="d3-knob" /></span>Filter</button>
          {!st.on && <span className="d3-auto"><i />Auto</span>}
          <div className={`d3-seg ${st.on ? "" : "off"}`} role="group" aria-label="Period">
            {[["week", "Week"], ["month", "Month"], ["custom", "Custom"]].map(([k, l]) => (
              <button key={k} type="button" disabled={!st.on} className={st.on && st.period === k ? "on" : ""} aria-pressed={st.on && st.period === k} onClick={() => set({ period: k })}>{l}</button>
            ))}
          </div>
        </div>
      </div>
      {st.on && st.period === "custom" && (
        <div className="d3-custom">
          <label htmlFor="d3-from">From</label><input id="d3-from" type="date" value={st.from} max={st.to} onChange={(e) => set({ from: e.target.value })} />
          <label htmlFor="d3-to">To</label><input id="d3-to" type="date" value={st.to} min={st.from} onChange={(e) => set({ to: e.target.value })} />
        </div>
      )}

      {!clients ? <Skeleton rows={4} /> : !list.length ? <div className="d3-empty">No clients yet. Add one in KRA / KPI Master.</div> : (
        <>
          <div className="d3-cbar" aria-busy={busy || undefined}>
            <div className="d3-who">
              <Avatar name={d?.client?.name || list.find((c) => c.id === clientId)?.name || "?"} id={clientId} size={40} />
              <div><div className="d3-cname">{d?.client?.name || list.find((c) => c.id === clientId)?.name}</div>
                <div className="d3-csub">{d ? `${d.open} open request${d.open === 1 ? "" : "s"} · ${d.in_progress} in progress` : "Loading…"}</div></div>
            </div>
            <div className="d3-plabel">{periodLabel(st.on, st.period, st.from, st.to)}{busy && <span className="spin d3-spin" aria-label="Loading" />}</div>
          </div>
          {err && <div className="d3-err" role="alert">{err}</div>}
          <div className={`d3-tiles ${busy ? "is-busy" : ""}`}>
            <Tile t="Open requests" v={d?.open} n={`${d?.new_need_estimate ?? 0} new, need estimate`} onOpen={d && (() => setTile("open"))} />
            <Tile t="In progress" v={d?.in_progress} tone="d3-prog" n="tasks being worked on" onOpen={d && (() => setTile("in_progress"))} />
            <Tile t="Waiting sign-off" v={d?.waiting_signoff} tone="d3-wait" n="delivered, client to approve" onOpen={d && (() => setTile("waiting"))} />
            <Tile t="Certified" v={d?.certified} tone="d3-ok" n="signed off in period" onOpen={d && (() => setTile("certified"))} />
            <Tile t="Hours used / quoted" onOpen={d && (() => setTile("hours"))}>
              <div className={`v ${over ? "d3-bad" : ""}`}>{d ? `${used}h` : "—"} <small>/ {d ? `${quoted}h` : "—"}</small></div>
              <div className="d3-bar"><i className={over ? "d3-bad" : ""} style={{ width: `${over ? 100 : pct}%` }} /></div>
              <div className={`n ${over ? "d3-bad" : ""}`} style={{ marginTop: 4 }}>{d ? hoursNote : ""}</div>
            </Tile>
            <Tile t="Billing" onOpen={d && (() => setTile("billing"))}>
              <div className="v small">{d ? invState : "—"}</div>
              <div className={`n ${d?.overdue ? "d3-bad" : ""}`} style={{ marginTop: 4 }}>{d ? `${due}${d.overdue ? " · overdue" : ""}` : ""}</div>
            </Tile>
          </div>
        </>
      )}
      {tile && d && (
        <ClientTilePopup kind={tile} client={d.client} period={periodLabel(st.on, st.period, st.from, st.to)}
          range={st.on ? range(st.period, st.from, st.to) : null} onClose={() => setTile(null)} />
      )}
    </section>
  );
}

/* A tile opens its popup (the rows behind the number) on click or Enter. */
function Tile({ t, v, n, tone, onOpen, children }) {
  const open = onOpen || undefined;
  return (
    <div className={`d3-tile ${open ? "is-link" : ""}`} role={open ? "button" : undefined} tabIndex={open ? 0 : undefined}
      aria-label={open ? `${t}: show the list` : undefined} onClick={open}
      onKeyDown={open ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } : undefined}>
      <div className="t">{t}{open && <span className="d3-more" aria-hidden="true">›</span>}</div>
      {children || <><div className={`v ${tone || ""}`}>{v ?? "—"}</div><div className="n">{n}</div></>}
    </div>
  );
}

/* ---------------- Employees today ---------------- */
function EmployeesToday({ people, onChanged }) {
  const [f, setF] = useState(() => load("kpi.db.emp", { emp: "all", status: "all" }));
  const [openId, setOpenId] = useState(null); /* the person whose popup is open */
  const setFilter = (n) => { setF(n); save("kpi.db.emp", n); };
  /* Live timers: re-render every minute and add the time since the poll. */
  const arrived = useMemo(() => Date.now(), [people]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(id); }, []);
  const rows = useMemo(() => (people || [])
    .map((p) => { const r = liveRow(p, now - arrived); const s = statusOf(r); return { ...r, _s: s, _lvl: timerLevel(r, s) }; })
    .sort((a, b) => STATUS_ORDER[a._s] - STATUS_ORDER[b._s] || (a.name || "").localeCompare(b.name || "")), [people, now, arrived]);
  const counts = useMemo(() => rows.reduce((c, p) => ({ ...c, [p._s]: (c[p._s] || 0) + 1 }), { all: rows.length }), [rows]);
  const shown = rows.filter((p) => (f.emp === "all" || p.user_id === f.emp) && (f.status === "all" || p._s === f.status));
  /* Three or more absent: one compact row of faces instead of full cards. */
  const absentees = shown.filter((p) => p._s === "absent");
  const compact = absentees.length >= 3;
  const cards = compact ? shown.filter((p) => p._s !== "absent") : shown;
  const open = (id) => setOpenId(id);

  return (
    <section className="d3-card" aria-labelledby="d3-emp-h">
      <div className="d3-head">
        <h2 id="d3-emp-h">Employees <small>today · live task details</small></h2>
        {people && <span className="d3-lbl">Showing {shown.length} of {rows.length}</span>}
      </div>
      {!people ? <Skeleton rows={5} /> : (
        <div className="d3-ebody">
          <div className="d3-egrid">
            {cards.map((p) => {
              const [line, sub] = cardText(p, p._s);
              return (
                <article key={p.user_id} className={`d3-emp s-${p._s} ${p._lvl ? `t-${p._lvl}` : ""}`} role="button" tabIndex={0} aria-label={`Open ${p.name}'s details`}
                  onClick={() => open(p.user_id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(p.user_id); } }}>
                  <div className="d3-etop">
                    <span className="d3-av"><Avatar name={p.name} uid={p.user_id} size={38} /><i /></span>
                    <div style={{ minWidth: 0 }}><div className="d3-ename">{p.name}</div><div className="d3-erole">{p.role || "Developer"} · {since(p)}</div></div>
                    <span className="d3-badge">{ST[p._s]}</span>
                  </div>
                  <div className="d3-strip"><b>{line}</b>{sub && <small>{sub}</small>}</div>
                  <div className="d3-tasks">
                    {(p.top_tasks || []).map((t) => (
                      <Fragment key={t.id}>
                        <div className="d3-task"><span className="code">{t.ref || `#${t.id}`}</span><span className="ttl" title={t.name}>{t.name}</span><span className={`st t-${t.state}`}>{TS[t.state] || t.state}</span></div>
                        {t.state === "paused" && pauseWhy(t) && <div className="d3-task-why" title={pauseWhy(t)}>⏸ {pauseWhy(t)}</div>}
                      </Fragment>
                    ))}
                    {!(p.top_tasks || []).length && <div className="d3-task none">No open tasks</div>}
                  </div>
                  <div className="d3-efoot" title="Productive time today, out of an 8-hour day">
                    <span>Today {hm(p.productive_today)}</span>
                    <div className="d3-bar"><i style={{ width: `${Math.min(100, ((p.productive_today || 0) / (8 * 3600)) * 100)}%` }} /></div>
                    <span>{p.done_week || 0} done this week</span>
                  </div>
                </article>
              );
            })}
            {compact && (
              <div className="d3-absent" aria-label={`${absentees.length} absent`}>
                <span className="d3-absent-h">Absent <em>{absentees.length}</em></span>
                <div className="d3-absent-list">
                  {absentees.map((p) => (
                    <button key={p.user_id} type="button" className="d3-absent-p" title={`${p.name} · ${p.day_done ? "workday ended" : p.attendance === "pending" ? "not checked in yet" : "no workday started"}`} onClick={() => open(p.user_id)}>
                      <Avatar name={p.name} uid={p.user_id} size={26} /><span>{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!shown.length && <div className="d3-empty">No employees match this filter.</div>}
          </div>
          <aside className="d3-filter" aria-label="Employee filter">
            <div className="t">Status</div>
            <div className="d3-schips">
              {["all", "working", "break", "lunch", "absent"].map((k) => (
                <button key={k} type="button" className={`d3-schip ${f.status === k ? "on" : ""}`} aria-pressed={f.status === k} onClick={() => setFilter({ status: k, emp: "all" })}>
                  {k === "all" ? "All" : ST[k]} {counts[k] || 0}
                </button>
              ))}
            </div>
            <div className="t">Employees</div>
            <div className="d3-elist">
              <button type="button" className={`d3-eopt ${f.emp === "all" ? "on" : ""}`} onClick={() => setFilter({ emp: "all", status: "all" })}><i className="s-all" /><span>All employees</span><em>{rows.length}</em></button>
              {rows.map((p) => (
                <button key={p.user_id} type="button" className={`d3-eopt ${f.emp === p.user_id ? "on" : ""}`} onClick={() => setFilter({ emp: p.user_id, status: "all" })}>
                  <i className={`s-${p._s}`} /><span>{p.name}</span><em>{ST[p._s]}</em>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
      {/* The live row is looked up on every render, so the popup's header
          follows the 30 s poll while it is open. */}
      {openId && rows.find((p) => p.user_id === openId) && (
        <EmployeePopup person={rows.find((p) => p.user_id === openId)} onClose={() => setOpenId(null)} onChanged={onChanged} />
      )}
    </section>
  );
}
