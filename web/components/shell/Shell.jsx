"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { TaskActionsProvider, useTaskActions } from "@/components/task/TaskActions";
import { WorkdayButton } from "@/components/work/WorkdayButton";
import SideIcon from "./SideIcon";
import { IdlePrompt } from "@/components/work/IdleFlow";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMe } from "@/lib/me";
import { TOP_NAV, PORTAL_TABS, allowed, allowedMenu, activeKey } from "@/lib/nav";
import KraLoader from "@/components/ui/KraLoader";
import { useResource } from "@/lib/useFetch";
import { getPref, setPref } from "@/lib/prefs";
import { SKINS, MODES, useTheme } from "@/lib/theme";
import { useDesktopNotifications, useDesktopState } from "@/lib/desktopNotify";
import { Avatar, DialogHost, FlagHost, Icon, IconButton, useOutside, useFlags } from "@/components/ui";

/* The Jira-style frame. `variant` is "work" (developers + admins: top nav +
   sidebar) or "portal" (clients: header tabs, no sidebar). Who sees which
   item is decided by lib/nav.js against the role from the Gate. */
export default function Shell({ variant = "work", children }) {
  return (
    <PortalGuard variant={variant}>
      <FlagHost>
        <DialogHost>
          <Frame variant={variant}>{children}</Frame>
        </DialogHost>
      </FlagHost>
    </PortalGuard>
  );
}

/* The client portal is for clients. An admin goes there only when Odoo also
   puts them in the KRA Client group (flags.isClient); any other admin is sent
   to their own home. middleware.js can't tell (the role cookie has no flags). */
function PortalGuard({ variant, children }) {
  const { me } = useMe();
  const router = useRouter();
  const out = variant === "portal" && me?.role === "admin" && !me?.flags?.isClient;
  useEffect(() => { if (out) router.replace("/your-work"); }, [out, router]);
  return out ? <KraLoader /> : children;
}

function Frame({ variant, children }) {
  const { me } = useMe();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);           /* phone drawer */
  const [collapsed, setCollapsed] = useState(false); /* desktop sidebar */
  useEffect(() => { setCollapsed(!!getPref("sideCollapsed", me?.uid, false)); }, [me?.uid]);
  useEffect(() => { setOpen(false); }, [pathname]);
  const toggleCollapsed = () => { setCollapsed((c) => { setPref("sideCollapsed", me?.uid, !c); return !c; }); };
  useDesktopNotifications(me);

  const cls = ["k-app", variant === "work" && collapsed ? "side-collapsed" : "", open ? "side-open" : ""].join(" ");
  const inner = (
    <>
      <DesktopAlertsBar />
      <TopNav variant={variant} onBurger={() => setOpen((o) => !o)} />
      <div className="body">
        {variant === "work" && <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />}
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <main className="main">
          {/* Keyed by page so each new page eases in (see .page-in in shell.css). */}
          <div key={pathname} className="page-in">{children}</div>
        </main>
      </div>
    </>
  );
  /* Work area: the task actions (workday, task panel, task dialogs) wrap the
     top bar as well as the page, so the top bar's Start / End workday button
     can use them. They stay INSIDE .k-app: the task panel and its dialogs are
     styled under .k-app and break (no layer, no position) outside it. */
  return (
    <div className={cls} data-area={variant}>
      {variant === "work" ? <Suspense fallback={null}><TaskActionsProvider>{inner}<IdlePrompt /></TaskActionsProvider></Suspense> : inner}
    </div>
  );
}

/* Default-password warning: lives in the account menu (with a red dot on the
   avatar), not as a banner across every page. */
function MustChangeNote({ href }) {
  return (
    <Link className="pw-note" href={href} role="menuitem">
      <Icon n="warn" size={16} />
      <span>Your password is still the default one. <b>Set your own ›</b></span>
    </Link>
  );
}

/* WhatsApp Web style bar across the top while desktop notifications are not
   on. The browser only shows its permission prompt after a click, hence the
   button. The X hides it for this browser session only. */
function DesktopAlertsBar() {
  const { me } = useMe();
  const d = useDesktopState(me?.uid);
  const [hidden, setHidden] = useState(true);
  useEffect(() => { try { setHidden(sessionStorage.getItem("kpi.desktopBarHidden") === "1"); } catch (_) { setHidden(false); } }, []);
  if (hidden || d.active || d.perm === "unsupported") return null;
  const hide = () => { try { sessionStorage.setItem("kpi.desktopBarHidden", "1"); } catch (_) {} setHidden(true); };
  return (
    <div className="desk-bar" role="status">
      <span className="ic"><Icon n="bell" size={18} /></span>
      {d.perm === "denied"
        ? <span className="txt"><b>Notifications are blocked.</b> Click the lock icon in the address bar, set Notifications to Allow, then reload.</span>
        : <span className="txt"><b>Get notified of new tasks and updates.</b> <button className="lnk" onClick={d.turnOn}>Turn on desktop notifications ›</button></span>}
      <IconButton icon="x" label="Hide for now" size={16} className="x" onClick={hide} />
    </div>
  );
}

/* ---------------------------------------------------------------- top nav */
function TopNav({ variant, onBurger }) {
  const { me } = useMe();
  const pathname = usePathname();
  const flags = useFlags();
  const name = process.env.NEXT_PUBLIC_APP_NAME || "KRA KPI";
  const items = variant === "work" ? allowed(TOP_NAV, me) : [];
  const tabs = variant === "portal" ? PORTAL_TABS : [];
  const activeTop = activeKey(items, pathname);
  const activeTab = activeKey(tabs, pathname);
  /* The top bar renders inside TaskActionsProvider (work area), which says
     whether a developer may create (their workday must be open). Admins always can. */
  const acts = useTaskActions();
  const showCreate = variant !== "work" || me.role === "admin" || acts?.canCreate !== false;

  return (
    <header className="top">
      <IconButton icon="menu" label="Menu" className="burger" onClick={onBurger} />
      <Link href={me.role === "client" ? "/portal" : "/your-work"} className="logo" aria-label={name} title={name} style={{ textDecoration: "none" }}>
        <img src="/brand/logo369-mark.png" alt="" style={{ height: 38, width: "auto" }} />
      </Link>
      {items.map((it) => (
        <Link key={it.key} href={it.href} className={`nav-btn ${activeTop === it.key ? "on" : ""}`}>{it.label}</Link>
      ))}
      {tabs.length > 0 && (
        <nav className="side-tabs" aria-label="Portal">
          {tabs.map((t) => <Link key={t.key} href={t.href} className={activeTab === t.key ? "on" : ""}>{t.label}</Link>)}
        </nav>
      )}
      <label className="search">
        <Icon n="search" size={16} />
        <input type="search" placeholder={variant === "portal" ? "Search my requests" : "Search tasks, REQ-012…"} aria-label="Search"
          onKeyDown={(e) => { if (e.key === "Enter" && e.currentTarget.value.trim()) location.href = (variant === "portal" ? "/portal/requests" : "/list") + "?q=" + encodeURIComponent(e.currentTarget.value.trim()); }} />
      </label>
      {variant === "work" && <WorkdayButton compact />}
      {showCreate && <button className="btn btn-primary" onClick={() => variant === "portal" ? flags.info("New request opens in the client-portal step.") : window.dispatchEvent(new CustomEvent("kpi:create"))}>
        <Icon n="plus" size={16} />{variant === "portal" ? "New request" : "Create"}
      </button>}
      <ModeToggle />
      <Bell variant={variant} />
      <AvatarMenu />
    </header>
  );
}

/* Sun / moon: flips light ↔ dark. "System" is picked from the avatar menu. */
function ModeToggle() {
  const { isDark, toggle, mode } = useTheme();
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button className={`icon-btn mode-btn ${isDark ? "is-dark" : "is-light"}`} aria-label={label} title={`${label}${mode === "system" ? " (following system)" : ""}`} aria-pressed={isDark} onClick={(e) => toggle(e)}>
      <span className="mode-ic mode-sun"><Icon n="sun" size={20} /></span>
      <span className="mode-ic mode-moon"><Icon n="moon" size={20} /></span>
    </button>
  );
}

function Bell({ variant }) {
  const { data } = useResource("/kpi_notifications/unread_count", {}, { pollMs: 60000 });
  const n = data?.unread_count || 0;
  return (
    <Link href={variant === "portal" ? "/portal/notifications" : "/notifications"} className="icon-btn" aria-label={n ? `${n} unread notifications` : "Notifications"} title="Notifications">
      <Icon n="bell" size={20} />
      {n > 0 && <span className="dot" />}
    </Link>
  );
}

function AvatarMenu() {
  const { me, signOut } = useMe();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(close);
  const { skin, setSkin, mode, setMode } = useTheme();
  const profile = me.role === "client" ? "/portal/profile" : "/profile";
  const roleLabel = { admin: "Admin", developer: "Developer", client: "Client" }[me.role] || me.role;
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" style={{ width: "auto", padding: 0, background: "none" }} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
        <Avatar name={me.name} id={me.uid} size={28} />
        {me.mustChange && <span className="dot" aria-label="Password needs changing" />}
      </button>
      {open && (
        <div className="menu" role="menu">
          <header><Avatar name={me.name} id={me.uid} size={36} /><div><b>{me.name}</b><small>{roleLabel} · {me.login}</small></div></header>
          {me.mustChange && <MustChangeNote href={`${profile}?change=1`} />}
          <Link className="mi" href={profile} role="menuitem"><Icon n="user" />Profile</Link>
          <DesktopAlertsItem />
          <div className="sep" />
          <div className="mi" style={{ cursor: "default" }}><Icon n="palette" />Appearance</div>
          <div className="modes" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => (
              <button key={m.key} role="radio" aria-checked={mode === m.key} className={`pill ${mode === m.key ? "on" : ""}`} onClick={(e) => setMode(m.key, e)}>
                <Icon n={m.key === "light" ? "sun" : m.key === "dark" ? "moon" : "monitor"} size={14} />{m.label}
              </button>
            ))}
          </div>
          <div className="swatches" role="radiogroup" aria-label="Colour skin">
            {SKINS.map((t) => (
              <button key={t.key} role="radio" aria-checked={skin === t.key} className={`swatch ${skin === t.key ? "on" : ""}`} onClick={(e) => setSkin(t.key, e)} title={t.label}>
                <i style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 0 50%, ${t.swatch[1]} 50% 100%)`, boxShadow: `inset 0 -6px 0 ${t.swatch[2]}` }} />
                <small>{t.label.split(" ")[0]}</small>
              </button>
            ))}
          </div>
          <div className="sep" />
          <button className="mi danger" role="menuitem" onClick={signOut}><Icon n="logout" />Sign out</button>
          <footer>KRA KPI web {process.env.NEXT_PUBLIC_APP_VERSION}{process.env.NEXT_PUBLIC_APP_BUILD ? ` · ${process.env.NEXT_PUBLIC_APP_BUILD}` : ""}</footer>
        </div>
      )}
    </div>
  );
}

function DesktopAlertsItem() {
  const { me } = useMe();
  const flags = useFlags();
  const d = useDesktopState(me.uid);
  const state = d.perm === "unsupported" ? "Not available" : d.perm === "denied" ? "Blocked" : d.active ? "On" : "Off";
  const click = () => {
    if (d.perm === "unsupported") return flags.info("This browser can't show desktop notifications here. They need HTTPS (or localhost).");
    if (d.perm === "denied") return flags.info("Notifications are blocked for this site. Allow them from the lock icon in the address bar, then reload.");
    return d.active ? d.turnOff() : d.turnOn();
  };
  return (
    <button className="mi" role="menuitemcheckbox" aria-checked={d.active} onClick={click}>
      <Icon n="bell" />Desktop notifications<span className="mini" style={{ marginLeft: "auto" }}>{state}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- sidebar */
function Sidebar({ collapsed, onToggle }) {
  const { me } = useMe();
  const pathname = usePathname();
  const groups = allowedMenu(me);
  const active = activeKey(groups.flatMap((g) => g.items), pathname);
  const admin = me.role === "admin";
  /* Open groups are remembered per user. The group holding the current page
     is always open, so the highlighted item is never hidden. */
  const [open, setOpen] = useState(() => getPref("side.open", me.uid, ["mywork"]) || ["mywork"]);
  const current = groups.find((g) => g.items.some((it) => it.key === active))?.key;
  const isOpen = (k) => open.includes(k) || k === current;
  const toggle = (k) => {
    if (collapsed) { onToggle(); if (!open.includes(k)) setOpen((o) => [...o, k]); return; }
    setOpen((o) => {
      const next = isOpen(k) ? o.filter((x) => x !== k) : [...o, k];
      setPref("side.open", me.uid, next);
      return next;
    });
  };
  return (
    <nav className="side" aria-label="Sections">
      <div className="proj" style={{ cursor: collapsed ? "pointer" : "default" }} onClick={() => { if (collapsed) onToggle(); }} title={collapsed ? "Expand sidebar" : undefined}>
        {/* A plain icon square, not a logo: the 369 logo in the header is the only brand mark. */}
        <span className="proj-tile proj-ic" aria-hidden="true"><Icon n={admin ? "people" : "user"} size={18} /></span>
        <div className="proj-txt"><b>{admin ? "All work" : "My work"}</b><small>{admin ? "Company board" : me.name}</small></div>
        {!collapsed && <IconButton icon="cleft" label="Collapse sidebar" size={16} className="side-toggle" onClick={(e) => { e.stopPropagation(); onToggle(); }} />}
      </div>
      {collapsed && <button className="side-item side-expand" onClick={onToggle} title="Expand sidebar" aria-label="Expand sidebar"><Icon n="cright" size={18} /></button>}
      {groups.map((g) => {
        const show = isOpen(g.key);
        return (
          <div key={g.key} className="side-grp">
            <button type="button" className={`side-item si-item side-grp-h ${!show && current === g.key ? "on" : ""}`} aria-expanded={show} onClick={() => toggle(g.key)} title={collapsed ? g.group : undefined}>
              <SideIcon n={g.icon} /><span>{g.group}</span>
              <Icon n={show ? "chev" : "cright"} size={14} className="side-chev" />
            </button>
            {show && !collapsed && g.items.map((it) => (
              <Link key={it.key} href={it.href} className={`side-item side-sub ${active === it.key ? "on" : ""}`}>
                <span>{it.label}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
