"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, Button, Field, Input, Lozenge, PageHeader, useFlags, Select } from "@/components/ui";
import { useMe } from "@/lib/me";
import { SKINS, MODES, useTheme } from "@/lib/theme";
import { setPref } from "@/lib/prefs";
import * as M from "@/lib/services/more";

/* Profile: account, photo (res.users.image_1920 in Odoo), appearance, change
   password (/kpi_app/set_password), attendance this month when the attendance
   module is installed. */
export default function Profile({ portal = false }) {
  const { me, refresh, signOut } = useMe();
  const flags = useFlags();
  const sp = useSearchParams();
  const { skin, setSkin, mode, setMode } = useTheme();
  const [pw, setPw] = useState({ a: "", b: "" });
  const [busy, setBusy] = useState(false);
  const [att, setAtt] = useState(null);
  const [avatar, setAvatar] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const loadPhoto = () => M.fetchMyPhoto(me.uid).then((p) => setAvatar(p.has ? M.myPhotoUrl(me.uid, p.version) : null));
  /* A client's profile carries no staff items: no multitask switch, no
     attendance, no pointer to Login management. */
  const staff = !portal && me.role !== "client";
  useEffect(() => { loadPhoto(); if (staff) M.fetchAttendanceMine().then(setAtt); }, [me.uid, staff]); // eslint-disable-line react-hooks/exhaustive-deps
  const roleLabel = { admin: "Admin", developer: "Developer", client: "Client" }[me.role] || me.role;

  const change = async (e) => {
    e.preventDefault();
    if (pw.a.length < 4) { flags.err("Password must be at least 4 characters."); return; }
    if (pw.a !== pw.b) { flags.err("The two passwords don't match."); return; }
    setBusy(true);
    try { M.assertOk(await M.setAppPassword(pw.a), "Could not change the password."); flags.ok("Password changed."); setPw({ a: "", b: "" }); refresh(); }
    catch (ex) { flags.err(ex.message); } finally { setBusy(false); }
  };
  /* Square-cropped to 512 px JPEG; Odoo derives the smaller sizes from it. */
  const savePhoto = async (b64) => {
    setPhotoBusy(true);
    try { await M.saveMyPhoto(me.uid, b64); setPref("avatar", me.uid, null); await loadPhoto(); window.dispatchEvent(new Event(M.PHOTO_EVENT)); flags.ok(b64 ? "Photo saved." : "Photo removed."); }
    catch (ex) { flags.err(ex.message || "Could not save the photo."); } finally { setPhotoBusy(false); }
  };
  const pickAvatar = (e) => {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    const img = new Image(); const url = URL.createObjectURL(f);
    img.onerror = () => { URL.revokeObjectURL(url); flags.err("That file is not an image we can read."); };
    img.onload = () => { const c = document.createElement("canvas"); const n = Math.min(512, img.width, img.height) || 512; c.width = c.height = n; const s = Math.min(img.width, img.height); c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n); URL.revokeObjectURL(url); savePhoto(c.toDataURL("image/jpeg", 0.88).split(",")[1]); };
    img.src = url;
  };
  /* /kpi_attendance/mine (kra_kpi_attendance_bridge): {status, has_employee, message,
     today:{status_display,…}, month:{present, late, half_day, absent, leave, wfh, label},
     days:[row] newest first}. */
  const days = att?.days || [];
  const month = att?.month || {};
  const recorded = days.filter((d) => d.check_in);
  const lastIn = recorded[0];

  return (
    <>
      <PageHeader crumbs={[portal ? { label: "Portal", href: "/portal" } : { label: "Your work" }, { label: "Profile" }]} title="Profile" />
      <div className="g12" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="cardbox" style={{ alignItems: "center", textAlign: "center", padding: "28px 16px" }}>
            <Avatar name={me.name} id={me.uid} size={88} src={avatar} style={{ boxShadow: "var(--shadow-lg)" }} />
            <b style={{ fontSize: 19, fontWeight: 900, color: "var(--navy)" }}>{me.name}</b>
            <Lozenge tone="progress">{roleLabel}</Lozenge>
            <span className="mini">{me.login}</span>
            <div className="row"><label className="btn" style={{ height: 30, cursor: photoBusy ? "wait" : "pointer", opacity: photoBusy ? 0.6 : 1 }}>{photoBusy ? "Saving…" : avatar ? "Change photo" : "Add photo"}<input type="file" accept="image/*" hidden disabled={photoBusy} onChange={pickAvatar} /></label>{avatar && <Button size="sm" kind="ghost" busy={photoBusy} onClick={() => savePhoto(false)}>Remove</Button>}</div>
            <span className="mini">Saved to your account, so it follows you to every device.</span>
          </div>
          <div className="cardbox"><h2>Appearance</h2>
            <div className="kv"><span className="lbl">Mode</span><span className="input" style={{ height: 32, flex: 1 }}><Select value={mode} onChange={(e) => setMode(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{MODES.map((m) => <option key={m.key} value={m.key}>{m.label}{m.key === "system" ? " (follow device)" : ""}</option>)}</Select></span></div>
            <div className="kv"><span className="lbl">Colour skin</span><span className="input" style={{ height: 32, flex: 1 }}><Select value={skin} onChange={(e) => setSkin(e.target.value)} style={{ border: 0, background: "none", outline: 0, width: "100%", font: "inherit", color: "inherit" }}>{SKINS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select></span></div>
          </div>
          <Button kind="danger" size="lg" onClick={signOut}>Sign out</Button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="cardbox"><h2>Account</h2>
            <div className="kv"><span className="lbl">Name</span><span className="val">{me.name}</span></div>
            <div className="kv"><span className="lbl">Login</span><span className="val">{me.login}</span></div>
            <div className="kv"><span className="lbl">Role</span><span className="val">{roleLabel}</span>{staff && <span className="right mini">set by admin in Login management</span>}</div>
            {staff && <div className="kv"><span className="lbl">Multitask</span><span className="val">{me.flags?.allowMultitask ? "On — several tasks can run at once" : "Off — one running task at a time"}</span><span className="right mini">set by admin</span></div>}
            {me.mustChange && <div className="callout" style={{ background: "var(--over-bg)", borderColor: "var(--danger)", color: "var(--over)" }}>Your password is still the default one. Set your own below.</div>}
          </div>
          <div className="g21" style={{ gridTemplateColumns: staff ? "1fr 1fr" : "1fr" }}>
            <form className="cardbox" onSubmit={change}><h2>Change password</h2>
              <Field label="New password"><Input type="password" autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} autoFocus={sp.get("change") === "1"} /></Field>
              <Field label="Repeat new password"><Input type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
              <Button kind="primary" type="submit" busy={busy} style={{ alignSelf: "flex-start" }}>Update password</Button>
              <p className="mini" style={{ margin: 0 }}>This is the password for the phone app and this site. Odoo's own password is separate.</p>
            </form>
            {staff && <div className="cardbox"><h2>My attendance <small>{month.label ? `${month.label} ${month.year || ""}`.trim() : "this month"}</small></h2>
              {!att && <span className="mini">Loading…</span>}
              {att && (att.notInstalled || att.status === false) && <span className="mini">{att.notInstalled ? "Attendance isn't installed on this server." : att.message || "Attendance isn't enabled in the app."}</span>}
              {att?.status === true && att.has_employee === false && <span className="mini">{att.message || "Your login is not linked to an HR employee yet."}</span>}
              {att?.status === true && att.has_employee !== false && (
                <>
                  <div className="pillset">
                    <span className="chip-sm" style={{ background: "var(--lz-done-bg)", color: "var(--lz-done)" }}>Present {month.present ?? 0}</span>
                    <span className="chip-sm" style={{ background: "var(--lz-paused-bg)", color: "var(--lz-paused)" }}>Late {month.late ?? 0}</span>
                    {month.half_day > 0 && <span className="chip-sm" style={{ background: "var(--lz-paused-bg)", color: "var(--lz-paused)" }}>Half day {month.half_day}</span>}
                    <span className="chip-sm" style={{ background: "var(--over-bg)", color: "var(--over)" }}>Absent {month.absent ?? 0}</span>
                    {month.leave > 0 && <span className="chip-sm" style={{ background: "var(--hover)", color: "var(--navy)" }}>Leave {month.leave}</span>}
                  </div>
                  <div className="kv" style={{ border: 0 }}><span className="mini">Today: {att.today?.status_display || att.today?.status_label || "—"}{att.today?.check_in_office_time ? ` · in ${att.today.check_in_office_time}` : ""}{att.today?.check_out_office_time ? ` · out ${att.today.check_out_office_time}` : ""}{lastIn && !att.today?.check_in ? ` · last check-in ${lastIn.label || lastIn.date}` : ""}</span></div>
                </>
              )}
            </div>}
          </div>
        </div>
      </div>
    </>
  );
}
