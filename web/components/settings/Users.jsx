"use client";
import { useMemo, useState } from "react";
import { Avatar, Button, ErrorState, Field, Icon, Input, Lozenge, PageHeader, Skeleton, Tabs, useDialogs, useFlags } from "@/components/ui";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/useFetch";
import * as S from "@/lib/services/settings";
import SettingsNav from "./SettingsNav";

/* Users: list with role / mobile / active, create and edit sheet.
   /kpi_user_access/get lists archived users too (active:false): they sit
   under "Archived" and can be switched back on. */
export default function Users() {
  const { me } = useMe();
  const flags = useFlags();
  const dlg = useDialogs();
  const access = useResource(S.ACCESS_PATH, {}, { ttl: 10000 });
  const refused = access.data?.status === false ? { message: access.data.message || access.data.error || "Could not load the users." } : null;
  const all = (refused ? null : access.data?.users) || [];
  const users = all.filter((u) => u.active !== false);
  const archived = all.filter((u) => u.active === false);
  const [q, setQ] = useState(""); const [tab, setTab] = useState("all");
  const [edit, setEdit] = useState(null); /* {} new | user */
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (tab === "archived" ? archived : users).filter((u) => (tab === "all" || tab === "archived" || u.role === tab) && (!q || `${u.name} ${u.login} ${u.email} ${u.mobile}`.toLowerCase().includes(q.toLowerCase()))), [users, archived, tab, q]);
  const refresh = () => { S.invalidateAccess(); access.refresh(); };
  const roleTone = (r) => (r === "admin" ? "review" : r === "client" ? "done" : "progress");

  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      if (!edit.name?.trim() || !edit.login?.trim()) throw new Error("Name and login are required.");
      if (edit.id) {
        S.assertOk(await S.updateUser(edit.id, { name: edit.name, login: edit.login, email: edit.email || "", active: edit.active !== false }), "Could not update.");
        if (edit.role !== edit._role) S.assertOk(await S.setUserRole(edit.id, edit.role));
        if ((edit.mobile || "") !== (edit._mobile || "")) S.assertOk(await S.setUserMobile(edit.id, edit.mobile || ""));
        if (edit.password) S.assertOk(await S.changePassword(edit.id, edit.password));
        flags.ok("User saved.");
      } else {
        const r = await S.createUser({ name: edit.name, login: edit.login, email: edit.email || "", kra_role: edit.role || "developer", mobile: edit.mobile || "", active: true, password: edit.password || "" });
        S.assertOk(r, "Could not create the user.");
        flags.ok(edit.password ? `${edit.name} created. App password: ${edit.password}.` : `${edit.name} created. App password: 1111 (they must change it on first login).`, { ttl: 10000 });
      }
      setEdit(null); refresh();
    } catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  const toggleActive = async (u) => { const on = u.active === false; try { S.assertOk(await S.updateUser(u.id, { name: u.name, login: u.login, email: u.email || "", active: on }), on ? "Could not re-activate." : "Could not archive."); flags.ok(on ? `${u.name} is active again.` : `${u.name} archived.`); refresh(); } catch (e) { flags.err(e.message); } };
  const reset = async (u) => { if (!(await dlg.confirm({ title: "Reset password?", text: `${u.name}'s app password will be reset to 1111.`, confirmLabel: "Reset password", danger: true }))) return; try { S.assertOk(await S.resetPassword(u.id)); flags.ok("Password reset to 1111."); refresh(); } catch (e) { flags.err(e.message); } };

  return (
    <>
      <PageHeader crumbs={[{ label: "Settings" }, { label: "Users" }]} title="Users">
        <label className="search" style={{ margin: 0, width: 220 }}><Icon n="search" size={16} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" aria-label="Search users" style={{ border: 0, background: "none", outline: 0, font: "inherit", color: "inherit", width: "100%" }} /></label>
        <Tabs items={[{ key: "all", label: "All", count: users.length }, ...S.ROLES.map((r) => ({ key: r.code, label: `${r.label}s`, count: users.filter((u) => u.role === r.code).length })), ...(archived.length ? [{ key: "archived", label: "Archived", count: archived.length }] : [])]} value={tab} onChange={setTab} />
        <Button kind="primary" icon="plus" onClick={() => setEdit({ name: "", login: "", email: "", role: "developer", mobile: "", password: "" })}>New user</Button>
      </PageHeader>
      <SettingsNav />
      <div className="page" style={{ position: "relative" }}>
        {(refused || (access.error && !access.data)) && <ErrorState error={refused || access.error} onRetry={access.refresh} />}
        <div className="cardbox table-scroll" style={{ padding: 0 }}>
          {!access.data && !access.error ? <div style={{ padding: 16 }}><Skeleton rows={6} /></div> : refused ? null : (
            <table className="table">
              <thead><tr><th>Name</th><th>Login</th><th>Email</th><th>Role</th><th>Mobile</th><th>Last sign-in</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className={edit?.id === u.id ? "sel" : ""} style={u.active === false ? { opacity: 0.7 } : undefined}>
                    <td><Avatar name={u.name} id={u.id} size={24} /> <b>{u.name}</b>{u.is_system && <> <Lozenge tone="paused">System</Lozenge></>}{u.active === false && <> <Lozenge tone="todo">Archived</Lozenge></>}</td>
                    <td>{u.login}</td><td>{u.email || "—"}</td>
                    <td><Lozenge tone={roleTone(u.role)}>{S.ROLES.find((r) => r.code === u.role)?.label || u.role}</Lozenge></td>
                    <td>{u.mobile ? `+${u.dial || "91"} ${u.mobile}` : <span className="mini">—</span>}</td>
                    <td className="mini">{u.last_login || "never"}{u.last_device ? ` · ${u.last_device}` : ""}</td>
                    <td><span className={`toggle ${u.active !== false ? "on" : ""}`} role="switch" aria-checked={u.active !== false} title={u.active === false ? "Archived: switch on to re-activate" : "Active"} onClick={() => u.id !== me.uid && toggleActive(u)} style={{ cursor: u.id === me.uid ? "not-allowed" : "pointer" }} /></td>
                    <td><span style={{ display: "inline-flex", gap: 6 }}>{u.active === false && <Button size="sm" kind="primary" onClick={() => toggleActive(u)}>Re-activate</Button>}<Button size="sm" onClick={() => setEdit({ ...u, _role: u.role, _mobile: u.mobile, password: "" })}>Edit</Button><Button size="sm" kind="ghost" onClick={() => reset(u)}>Reset to 1111</Button></span></td>
                  </tr>
                ))}
                {access.data && !rows.length && <tr><td colSpan={8} className="empty">{tab === "archived" ? "No archived users." : "No users match."}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        {edit && (
          <form className="sheet" onSubmit={save} aria-label={edit.id ? "Edit user" : "New user"}>
            <h2>{edit.id ? "Edit user" : "New user"} {edit.id && <span className="mini" style={{ fontWeight: 600 }}>· {edit.name}</span>}</h2>
            <div className="grid2"><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field><Field label="Login"><Input value={edit.login} onChange={(e) => setEdit({ ...edit, login: e.target.value })} /></Field></div>
            <Field label="Email"><Input type="email" value={edit.email || ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Role"><Tabs items={S.ROLES.map((r) => ({ key: r.code, label: r.label }))} value={edit.role} onChange={(r) => setEdit({ ...edit, role: r })} /></Field>
            <Field label="Mobile (app login)" hint="Digits only; the country's dial code is added."><Input inputMode="numeric" value={edit.mobile || ""} onChange={(e) => setEdit({ ...edit, mobile: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field label={edit.id ? "New app password (leave empty to keep)" : "App password (empty = 1111)"}><Input type="text" value={edit.password || ""} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {edit.role === "client" && <p className="mini" style={{ margin: 0 }}>After saving, link this person to their company in KRA / KPI master › Client users.</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: "auto" }}><Button type="button" kind="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" kind="primary" busy={busy}>{edit.id ? "Save user" : "Create user"}</Button></div>
          </form>
        )}
      </div>
    </>
  );
}
