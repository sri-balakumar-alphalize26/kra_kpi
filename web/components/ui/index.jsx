"use client";
/* The small UI kit every screen is built from. Styles: ui.css + shell.css;
   names follow the design canvas so the mockups port 1:1. */
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import ServerDown from "./ServerDown";
import { initials, avatarColor } from "@/lib/me";
import { usePhoto } from "@/lib/photos";

export { Icon };

/* ---- buttons ---- */
/* `spinAt="end"`: the busy spinner sits in the button's right-hand corner
   and the label stays centred (full-width form buttons). */
export function Button({ kind = "default", size, icon, children, className = "", busy, spinAt, ...rest }) {
  const k = { primary: "btn-primary", danger: "btn-danger", ok: "btn-ok", ghost: "btn-ghost", default: "" }[kind] || "";
  const s = size === "sm" ? { height: 28, fontSize: 12.5 } : size === "lg" ? { height: 46, fontSize: 15, fontWeight: 800, borderRadius: 12 } : undefined;
  const end = spinAt === "end";
  return (
    /* rest first, then disabled: a caller's own disabled={false} must not
       re-enable a button whose request is still running. */
    <button className={`btn ${k} ${end ? "spin-end" : ""} ${className}`} style={s} {...rest} disabled={busy || rest.disabled}>
      {busy && !end ? <span className="spin" style={{ width: 14, height: 14, borderWidth: 2 }} /> : icon ? <Icon n={icon} size={16} /> : null}
      {children}
      {busy && end && <span className="spin" aria-label="Loading" />}
    </button>
  );
}
export function IconButton({ icon, label, size = 20, className = "", ...rest }) {
  return <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}><Icon n={icon} size={size} /></button>;
}

/* ---- lozenge (status pill) ---- */
const TONES = {
  todo: ["var(--lz-todo-bg)", "var(--lz-todo)"], progress: ["var(--lz-prog-bg)", "var(--lz-prog)"],
  done: ["var(--lz-done-bg)", "var(--lz-done)"], paused: ["var(--lz-paused-bg)", "var(--lz-paused)"],
  review: ["var(--lz-review-bg)", "var(--lz-review)"], danger: ["var(--over-bg)", "var(--over)"],
  fresh: ["var(--fresh)", "var(--over)"], neutral: ["var(--hover)", "var(--subtle)"],
};
export function Lozenge({ tone = "todo", children, style, className = "", title }) {
  const [bg, fg] = TONES[tone] || TONES.todo;
  return <span className={`lz ${className}`} title={title} style={{ background: bg, color: fg, ...style }}>{children}</span>;
}
/* kra.kpi.task_state → tone + label */
export function stateTone(state) {
  switch (state) {
    case "in_progress": return ["progress", "In progress"];
    case "paused": return ["paused", "Paused"];
    case "partially_completed": return ["review", "In review"];
    case "awaiting_client": return ["review", "Awaiting client"];
    case "completed": return ["done", "Done"];
    case "rework": return ["danger", "Rework"];
    case "pending_review": return ["review", "Pending review"];
    case "urgent": return ["danger", "Urgent"];
    case "important": return ["paused", "Important"];
    case "regular": return ["todo", "To do"];
    case "assigned": case "queue_waiting": return ["todo", "To do"];
    case "pre_approval_approved": return ["todo", "Ready to start"];
    case "pre_approval_pending": return ["review", "Waiting for client"];
    case "hold": return ["paused", "On hold"];
    /* Anything else: readable words, never the raw code. */
    default: return ["todo", state ? state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—"];
  }
}

/* ---- avatar ----
   `uid`: a res.users id — shows that person's profile photo (lib/photos.js,
   batched + cached) and falls back to coloured initials. `id` only picks the
   initials' colour (clients, projects…). `src` wins over both. */
export function Avatar({ name, id, uid, size = 28, src, className = "", style }) {
  const photo = usePhoto(src ? 0 : uid);
  const [broken, setBroken] = useState(false);
  const bg = avatarColor(uid ?? id ?? name);
  const s = { width: size, height: size, fontSize: Math.round(size * 0.38), background: bg, ...style };
  const img = src || (!broken && photo);
  if (img) return <img className={`avatar ${className}`} src={img} alt={name || ""} title={name} onError={() => setBroken(true)} style={{ ...s, objectFit: "cover" }} />;
  return <span className={`avatar ${className}`} style={s} aria-label={name} title={name}>{initials(name)}</span>;
}

/* ---- flags (toasts) ---- */
const FlagCtx = createContext(null);
export function FlagHost({ children }) {
  const [flags, setFlags] = useState([]);
  const dismiss = useCallback((id) => setFlags((f) => f.filter((x) => x.id !== id)), []);
  const push = useCallback((kind, text, { ttl = 5000 } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setFlags((f) => [...f, { id, kind, text }]);
    if (ttl) setTimeout(() => dismiss(id), ttl);
    return id;
  }, [dismiss]);
  /* Stable identity: consumers put `flags` in effect deps (Reminders), and a
     fresh object per render re-ran those effects on every toast. */
  const api = useMemo(() => ({
    ok: (t, o) => push("ok", t, o), err: (t, o) => push("err", t, { ttl: 8000, ...o }), warn: (t, o) => push("warn", t, o), info: (t, o) => push("ok", t, o), dismiss,
  }), [push, dismiss]);
  return (
    <FlagCtx.Provider value={api}>
      {children}
      <div className="flags" role="status" aria-live="polite">
        {flags.map((f) => (
          <div key={f.id} className={`flag ${f.kind}`}>
            <Icon n={f.kind === "err" ? "warn" : f.kind === "warn" ? "info" : "check"} size={18} />
            <span>{f.text}</span>
            <IconButton icon="x" label="Dismiss" size={14} onClick={() => dismiss(f.id)} />
          </div>
        ))}
      </div>
    </FlagCtx.Provider>
  );
}
export function useFlags() {
  return useContext(FlagCtx) || { ok() {}, err() {}, warn() {}, info() {}, dismiss() {} };
}

/* ---- states ---- */
export function Skeleton({ rows = 3, height = 14 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} style={{ height, width: `${90 - (i % 3) * 18}%`, borderRadius: 6, background: "var(--hover)" }} />
      ))}
    </div>
  );
}
export function Empty({ icon = "inbox", title, text, action }) {
  return (
    <div className="empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <Icon n={icon} size={36} />
      <b style={{ color: "var(--navy)", fontSize: 15 }}>{title}</b>
      {text && <span>{text}</span>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry, title = "Couldn't load this" }) {
  /* Odoo unreachable (ApiError status 0 / the OFFLINE text): the running-server scene. */
  if (error && (error.status === 0 || /can't reach the server/i.test(error.message || ""))) return <ServerDown compact message={error.message} onRetry={onRetry} />;
  return (
    <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>
      <Icon n="warn" size={18} />
      <span style={{ flex: 1 }}><b>{title}</b>{error?.message ? ` — ${error.message}` : ""}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
export function StaleBar({ onRetry, error }) {
  return (
    <div className="callout" style={{ background: "var(--lz-paused-bg)", borderColor: "var(--pri-important)", color: "var(--lz-paused)", padding: "8px 12px" }}>
      <Icon n="info" size={16} />
      <span style={{ flex: 1 }}>Showing the last data we had{error?.message ? ` — ${error.message}` : ""}.</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/* ---- page header ---- */
export function PageHeader({ crumbs = [], title, children, meta }) {
  return (
    <>
      {crumbs.length > 0 && (
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span>/</span>}
              {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="head">
        <h1>{title}</h1>
        {meta && <span className="mini" style={{ marginLeft: 4 }}>{meta}</span>}
        {children && <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{children}</span>}
      </div>
    </>
  );
}

/* ---- modal + confirm ---- */
export function Modal({ open, onClose, title, children, footer, width = 560 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented) onClose?.(); }; /* an open Select handles its own Escape */
    document.addEventListener("keydown", onKey);
    /* Same as the task panel: the page behind a dialog doesn't scroll. */
    const html = document.documentElement;
    const gap = window.innerWidth - html.clientWidth;
    const prev = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
    html.style.overflow = "hidden";
    if (gap > 0) html.style.paddingRight = `${gap}px`;
    return () => { document.removeEventListener("keydown", onKey); html.style.overflow = prev.overflow; html.style.paddingRight = prev.paddingRight; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" style={{ position: "fixed", zIndex: 80 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        {/* Title and footer stay put; only the body scrolls, so close / refresh
            buttons in the title and the footer buttons are always reachable. */}
        {title && <h2>{title}</h2>}
        <div className="modal-b">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Confirm({ open, onClose, onConfirm, title, text, confirmLabel = "Confirm", danger, busy }) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={460}
      footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm} autoFocus>{confirmLabel}</Button></>}>
      {text && <p style={{ margin: 0, fontSize: 14, lineHeight: "21px" }}>{text}</p>}
    </Modal>
  );
}

/* ---- Select: our dropdown instead of the browser's <select> ----
   Drop-in for a native select: same value / onChange(e => e.target.value) /
   disabled and plain <option> children, so a call site only swaps the tag.
   The list opens in a popup on <body> (so tables and dialogs don't clip it),
   gets a search box past 8 options, and works from the keyboard. Values come
   back as strings, like the native one. */
const optText = (n) => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(optText).join("") : isValidElement(n) ? optText(n.props.children) : String(n));
export function Select({ value, onChange, disabled, children, style, className = "", placeholder = "Choose…", "aria-label": ariaLabel }) {
  const opts = Children.toArray(children).filter((c) => isValidElement(c) && c.type === "option").map((c) => ({
    value: String(c.props.value ?? optText(c.props.children)), label: c.props.children, text: optText(c.props.children), disabled: !!c.props.disabled,
  }));
  const cur = opts.find((o) => o.value === String(value ?? ""));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState(null);
  const btn = useRef(null), pop = useRef(null), list = useRef(null);
  const searchable = opts.length > 8;
  const shown = q ? opts.filter((o) => o.text.toLowerCase().includes(q.toLowerCase())) : opts;

  const place = useCallback(() => {
    const box = btn.current?.closest(".input") || btn.current;
    if (!box) return;
    const r = box.getBoundingClientRect(), maxH = 320;
    const below = window.innerHeight - r.bottom - 8, up = below < 220 && r.top > below;
    setPos({ left: Math.min(r.left, window.innerWidth - Math.max(r.width, 220) - 8), width: Math.max(r.width, 220), top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, maxH: Math.min(maxH, (up ? r.top : below) - 8) });
  }, []);
  const show = () => { if (disabled) return; setQ(""); setHi(Math.max(0, opts.findIndex((o) => o.value === cur?.value))); place(); setOpen(true); };
  const close = useCallback((refocus) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  const pick = (o) => { if (o.disabled) return; if (o.value !== String(value ?? "")) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } }); close(true); };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) close(false); };
    const onMove = (e) => { if (!pop.current?.contains(e.target)) place(); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onMove, true);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("resize", place); window.removeEventListener("scroll", onMove, true); };
  }, [open, close, place]);
  useLayoutEffect(() => { if (open) list.current?.querySelector(".sel-opt.hi")?.scrollIntoView({ block: "nearest" }); }, [open, hi, q]);

  const onKey = (e) => {
    if (!open) { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); } return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[hi]) pick(shown[hi]); }
    else if (e.key === "Tab") close(false);
  };

  return (
    <>
      <button ref={btn} type="button" className={`sel-btn ${className}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => (open ? close(false) : show())} onKeyDown={onKey} style={style}>
        <span className={cur ? "v" : "v ph"}>{cur ? cur.label : placeholder}</span>
        <Icon n="chev" size={14} />
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="sel-pop" style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }} onKeyDown={onKey}>
          {searchable && <label className="sel-q"><Icon n="search" size={14} /><input autoFocus value={q} placeholder="Search…" aria-label="Search options" onChange={(e) => { setQ(e.target.value); setHi(0); }} /></label>}
          <div ref={list} className="sel-list" role="listbox" style={{ maxHeight: pos.maxH - (searchable ? 44 : 0) }}>
            {shown.map((o, i) => (
              <div key={o.value + i} role="option" aria-selected={o.value === cur?.value} aria-disabled={o.disabled} className={`sel-opt ${i === hi ? "hi" : ""} ${o.value === cur?.value ? "on" : ""} ${o.disabled ? "off" : ""}`}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
                <span>{o.label}</span>{o.value === cur?.value && <Icon n="check" size={14} />}
              </div>
            ))}
            {!shown.length && <div className="sel-none">No match</div>}
          </div>
        </div>, document.body)}
    </>
  );
}

/* ---- promise dialogs (instead of the browser's confirm / prompt) ----
     const dlg = useDialogs();
     if (!(await dlg.confirm({ title: "Delete X?", text: "…", confirmLabel: "Delete", danger: true }))) return;
     const v = await dlg.form({ title: "Add manual", fields: [{ key: "name", label: "Title", value: "" },
       { key: "role", label: "For", value: "developer", options: [{ value: "developer", label: "Developers" }] }] });
   confirm resolves true/false; form resolves the values object, or null on Cancel. */
const DialogCtx = createContext(null);
export function DialogHost({ children }) {
  const [d, setD] = useState(null); /* { kind, opts, resolve } */
  const open = useCallback((kind, opts) => new Promise((resolve) => setD({ kind, opts: opts || {}, resolve })), []);
  const [api] = useState(() => ({ confirm: (o) => open("confirm", o), form: (o) => open("form", o) }));
  const done = (v) => { d?.resolve(v); setD(null); };
  return (
    <DialogCtx.Provider value={api}>
      {children}
      {d?.kind === "confirm" && <Confirm open title={d.opts.title} text={d.opts.text} confirmLabel={d.opts.confirmLabel || "OK"} danger={d.opts.danger} onClose={() => done(false)} onConfirm={() => done(true)} />}
      {d?.kind === "form" && <FormDialog opts={d.opts} onDone={done} />}
    </DialogCtx.Provider>
  );
}
export function useDialogs() {
  const api = useContext(DialogCtx);
  if (!api) throw new Error("useDialogs needs a <DialogHost> above it (the Shell provides one).");
  return api;
}
function FormDialog({ opts, onDone }) {
  const [vals, setVals] = useState(() => Object.fromEntries((opts.fields || []).map((f) => [f.key, f.value ?? ""])));
  const missing = (opts.fields || []).some((f) => f.required !== false && !String(vals[f.key] ?? "").trim());
  const submit = (e) => { e?.preventDefault(); if (!missing) onDone(vals); };
  return (
    <Modal open onClose={() => onDone(null)} title={opts.title} width={460}
      footer={<><Button kind="ghost" onClick={() => onDone(null)}>Cancel</Button><Button kind="primary" disabled={missing} onClick={submit}>{opts.confirmLabel || "Save"}</Button></>}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {opts.text && <p style={{ margin: 0, fontSize: 14, lineHeight: "21px" }}>{opts.text}</p>}
        {(opts.fields || []).map((f, i) => (
          <Field key={f.key} label={f.label} required={f.required !== false}>
            {f.options
              ? <span className="input"><Select value={vals[f.key]} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></span>
              : <Input type={f.type || "text"} autoComplete={f.type === "password" ? "off" : undefined} value={vals[f.key]} autoFocus={i === 0} placeholder={f.placeholder} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />}
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ---- dropdown menu (click outside / Esc closes) ---- */
export function useOutside(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return ref;
}

/* ---- refresh spinner ---- */
/* [spinning, run]: run(...loaders) calls every loader (each returns a
   promise), keeps `spinning` true until all have settled, and for at least
   `min` ms so a fast reload still shows. A click while spinning is ignored.
   Put className="is-spinning" on the refresh icon while `spinning`. */
export function useSpin(min = 500) {
  const [spinning, setSpinning] = useState(false);
  const busy = useRef(false);
  const run = useCallback(async (...loaders) => {
    if (busy.current) return;
    busy.current = true; setSpinning(true);
    const t0 = Date.now();
    await Promise.allSettled(loaders.map((f) => Promise.resolve().then(f)));
    setTimeout(() => { busy.current = false; setSpinning(false); }, Math.max(0, min - (Date.now() - t0)));
  }, [min]);
  return [spinning, run];
}

/* ---- form field ---- */
/* `required` adds Odoo's red asterisk after the label, so a mandatory field
   says so before Save is pressed rather than after. */
export function Field({ label, error, hint, required, children, className = "" }) {
  return (
    <label className={`field ${className}`}>
      {required ? <span>{label}<span className="req" aria-hidden="true"> *</span></span> : label}
      {children}
      {error && <small className="err" style={{ color: "var(--danger)", fontSize: 12 }}>{error}</small>}
      {hint && !error && <small className="mini">{hint}</small>}
    </label>
  );
}
export function Input({ icon, right, className = "", style, ...rest }) {
  /* Number boxes select their value on the first click, so typing replaces
     the 0 instead of adding to it. The mouseup right after focus is swallowed
     because some browsers clear the selection there. */
  const num = rest.type === "number";
  const onFocus = num ? (e) => { e.currentTarget.dataset.fresh = "1"; e.currentTarget.select(); rest.onFocus?.(e); } : rest.onFocus;
  const onMouseUp = num ? (e) => { if (e.currentTarget.dataset.fresh) { e.preventDefault(); delete e.currentTarget.dataset.fresh; } rest.onMouseUp?.(e); } : rest.onMouseUp;
  return (
    <span className={`input ${className}`} style={style}>
      {icon && <Icon n={icon} size={16} />}
      <input {...rest} onFocus={onFocus} onMouseUp={onMouseUp} style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%", minWidth: 0 }} />
      {right}
    </span>
  );
}
export function Tabs({ items, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <span key={it.key} role="tab" tabIndex={0} aria-selected={it.key === value} className={it.key === value ? "on" : ""}
          onClick={() => onChange(it.key)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onChange(it.key); }} style={{ cursor: "pointer" }}>
          {it.label}{it.count != null && <em>{it.count}</em>}
        </span>
      ))}
    </div>
  );
}
