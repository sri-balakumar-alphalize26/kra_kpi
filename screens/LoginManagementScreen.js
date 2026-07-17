// LOGIN MANAGEMENT — mobile port of the Odoo web "Login Management (Non-odoo)"
// screen (kpi_user_access.js). Admin-only (opened from a Home Quick Action tile).
// Three sections, all auto-save:
//   1. Team Members — per user: role, mobile (+dial), login on/off, reset password
//   2. Password-reset sender (WhatsApp) — QR connect / status poll / disconnect
//   3. Reset message (WhatsApp) — editable template + live preview + reset default
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch,
  ActivityIndicator, Modal, Image, Alert, FlatList, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import {
  getAccess, setMobile, setUserCountry, setRole, toggleLogin, resetPassword, setOtpMessage,
  waConnect, waStatus, waDelete,
} from '../services/loginManagement';

const log = createLogger('LoginMgmt');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const ROLES = [
  { key: 'admin', label: 'Admin' },
  { key: 'developer', label: 'User' },
  { key: 'client', label: 'Client' },
];
const roleLabel = (k) => (ROLES.find((r) => r.key === k) || {}).label || 'User';

// Substitute placeholders and render *bold* segments for the WhatsApp preview.
function renderPreview(tpl, subs) {
  let str = String(tpl || '')
    .replace(/\{name\}/g, subs.name)
    .replace(/\{code\}/g, subs.code)
    .replace(/\{minutes\}/g, String(subs.minutes))
    .replace(/\{app\}/g, subs.app);
  return str.split('*').map((p, i) => (
    i % 2 === 1
      ? <Text key={i} style={{ fontWeight: '800' }}>{p}</Text>
      : <Text key={i}>{p}</Text>
  ));
}

function Card({ color, icon, iconLib, title, children }) {
  return (
    <View style={[s.card, { borderLeftColor: color }]}>
      <View style={s.cardHead}>
        {iconLib === 'mc'
          ? <MaterialCommunityIcons name={icon} size={18} color={color} />
          : <Ionicons name={icon} size={18} color={color} />}
        <Text style={s.cardTitle}>{title}</Text>
      </View>
      <View style={s.cardBody}>{children}</View>
    </View>
  );
}

export default function LoginManagementScreen({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);
  const [users, setUsers] = useState([]);
  const [dial, setDial] = useState('91');
  const [mobileLen, setMobileLen] = useState(10);
  const [countries, setCountries] = useState([]);
  const [pickCountryForUser, setPickCountryForUser] = useState(null); // user whose country is being picked
  const [appName, setAppName] = useState('the app');
  const [otpMinutes, setOtpMinutes] = useState(5);
  const [otpTemplate, setOtpTemplate] = useState('');
  const [otpDefault, setOtpDefault] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [savedFlash, setSavedFlash] = useState('');
  const [roleForUser, setRoleForUser] = useState(null); // user whose role is being picked
  const [resetForUser, setResetForUser] = useState(null); // user whose password reset is being confirmed
  const [disconnectOpen, setDisconnectOpen] = useState(false); // WhatsApp disconnect confirm

  // WhatsApp session
  const [waState, setWaState] = useState('none');
  const [waSessionId, setWaSessionId] = useState(0);
  const [waPhone, setWaPhone] = useState('');
  const [waQr, setWaQr] = useState('');
  const [waError, setWaError] = useState('');
  const [waBusy, setWaBusy] = useState(false);

  const pollRef = useRef(null);
  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);
  const startPoll = useCallback((sid) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await waStatus(sid);
        const qr = r?.qr_image || '';
        log.info('wa qr', { state: r?.state, len: qr.length, head: qr.slice(0, 12) });
        setWaState(r?.state || 'none');
        setWaPhone(r?.phone_number || '');
        setWaQr(qr);
        setWaError(r?.error || '');
        if (['connected', 'disconnected', 'error', 'none'].includes(r?.state)) stopPoll();
      } catch (e) { log.warn('waStatus poll failed', e?.message); }
    }, 2000); // fast poll so the freshest (unexpired) QR is always on screen
  }, [stopPoll]);

  const flash = useCallback((key) => {
    setSavedFlash(key);
    setTimeout(() => setSavedFlash((k) => (k === key ? '' : k)), 1400);
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getAccess();
      setIsMock(!!d.isMock);
      setUsers((d.users || []).map((u) => ({ ...u, _mobile: u.mobile || '' })));
      setDial(String(d.dial || '91'));
      setMobileLen(Number(d.mobile_length) || 10);
      setCountries(d.countries || []);
      setAppName(d.app_name || 'the app');
      setOtpMinutes(Number(d.otp_minutes) || 5);
      setOtpTemplate(d.otp_template || '');
      setOtpDefault(d.otp_default || '');
      setWaState(d.wa_state || 'none');
      setWaSessionId(d.wa_session_id || 0);
      setWaPhone(d.wa_phone || '');
      // Resume polling if a QR scan was in progress.
      if (d.wa_state === 'waiting_qr' && d.wa_session_id) startPoll(d.wa_session_id);
    } catch (e) {
      log.warn('load failed', e?.message);
    }
  }, [startPoll]);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
    return () => stopPoll();
  }, [load, stopPoll]);

  // ── User savers ─────────────────────────────────────────────────────────────
  const onMobileChange = (uid, text) => {
    const u = users.find((x) => x.id === uid);
    const cap = (u && u.mobile_length) || mobileLen;
    const local = String(text || '').replace(/[^\d]/g, '').slice(0, cap);
    setUsers((list) => list.map((x) => (x.id === uid ? { ...x, _mobile: local } : x)));
  };

  // Country label for a user's picker button (their own, or the default).
  const userCountryLabel = (u) => {
    const c = countries.find((x) => x.id === u.country_id);
    return c ? `+${c.phone_code}` : `+${dial}`;
  };

  // Set ONE user's country (dial + local length). Empty co (id false) clears it
  // back to the company default. Drives their app-login mobile AND WhatsApp number.
  const chooseUserCountry = async (u, co) => {
    setPickCountryForUser(null);
    const cid = co && co.id ? co.id : false;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, country_id: cid } : x)));
    try {
      const res = await setUserCountry(u.id, cid);
      if (res?.status) {
        const nd = String(res.dial || dial || '91');
        const nl = Number(res.mobile_length) || mobileLen || 10;
        setUsers((list) => list.map((x) => (x.id === u.id
          ? { ...x, country_id: res.country_id || false, dial: nd, mobile_length: nl }
          : x)));
        flash('country:' + u.id);
      }
    } catch (e) { log.warn('setUserCountry', e?.message); }
  };
  const saveMobile = async (u) => {
    try { await setMobile(u.id, u._mobile || ''); flash('mobile:' + u.id); }
    catch (e) { log.warn('setMobile', e?.message); }
  };
  const onToggle = async (u) => {
    const next = !u.enabled;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, enabled: next } : x)));
    try { await toggleLogin(u.id, next); } catch (e) { log.warn('toggleLogin', e?.message); }
  };
  const onReset = (u) => setResetForUser(u);
  const confirmReset = async () => {
    const u = resetForUser;
    setResetForUser(null);
    if (!u) return;
    try { await resetPassword(u.id); flash('pw:' + u.id); } catch (e) { log.warn('resetPassword', e?.message); }
  };
  const onPickRole = async (u, role) => {
    setRoleForUser(null);
    if (role === u.role) return;
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, role } : x)));
    try { await setRole(u.id, role); flash('role:' + u.id); } catch (e) { log.warn('setRole', e?.message); }
  };

  // ── WhatsApp ────────────────────────────────────────────────────────────────
  const connect = async () => {
    setWaBusy(true); setWaError('');
    try {
      const r = await waConnect();
      if (r?.status) { setWaSessionId(r.session_id); setWaState(r.state || 'waiting_qr'); startPoll(r.session_id); }
      else setWaError(r?.message || 'Could not connect.');
    } catch (e) { setWaError('Could not connect. Try again.'); }
    finally { setWaBusy(false); }
  };
  const disconnect = () => setDisconnectOpen(true);
  const confirmDisconnect = async () => {
    setDisconnectOpen(false);
    stopPoll();
    try { await waDelete(waSessionId); } catch (e) { log.warn('waDelete', e?.message); }
    setWaState('none'); setWaQr(''); setWaPhone(''); setWaSessionId(0);
  };

  // ── Reset message template ──────────────────────────────────────────────────
  const saveTemplate = async () => {
    try { await setOtpMessage(otpTemplate); flash('tpl'); } catch (e) { log.warn('setOtpMessage', e?.message); }
  };
  const resetTemplate = async () => {
    setOtpTemplate(otpDefault);
    try { await setOtpMessage(''); flash('tpl'); } catch (e) { log.warn('resetOtp', e?.message); }
  };

  const shownUsers = useMemo(
    () => (roleFilter === 'all' ? users : users.filter((u) => u.role === roleFilter)),
    [users, roleFilter],
  );

  const previewSubs = { name: 'Marc Demo', code: '4821', minutes: otpMinutes, app: appName };

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.hTitle} numberOfLines={1}>Login Management</Text>
        <View style={{ width: 40 }} />
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to manage live logins</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

          {/* 1. Team Members */}
          <Card color="#6366f1" iconLib="mc" icon="account-group" title="Team Members">
            <Text style={s.hint}>Set each user's mobile number, role, and login on/off, or reset a password.
              Turning login OFF blocks that user everywhere (app AND Odoo).</Text>

            {/* Role filter */}
            <View style={s.filterRow}>
              {[{ k: 'all', label: 'All' }, ...ROLES.map((r) => ({ k: r.key, label: r.label }))].map((f) => {
                const on = roleFilter === f.k;
                return (
                  <TouchableOpacity key={f.k} style={[s.filterPill, on && s.filterPillOn]} onPress={() => setRoleFilter(f.k)} activeOpacity={0.85}>
                    <Text style={[s.filterPillTxt, on && s.filterPillTxtOn]}>{f.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {shownUsers.length === 0 ? (
              <Text style={[s.hint, { marginTop: 12 }]}>No users in this role.</Text>
            ) : shownUsers.map((u) => (
              <View key={u.id} style={s.userRow}>
                {/* Line 1: name + login switch */}
                <View style={s.userTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.userName}>{u.name}</Text>
                    <Text style={s.userLogin}>{u.login}</Text>
                  </View>
                  <View style={s.userSwitch}>
                    <Text style={s.userSmall}>Login</Text>
                    <Switch value={!!u.enabled} onValueChange={() => onToggle(u)} trackColor={{ true: COLORS.primary }} />
                  </View>
                </View>

                {/* Line 2: role pill + reset password */}
                <View style={s.userMeta}>
                  <TouchableOpacity
                    style={[s.rolePill, u.is_system && s.rolePillLocked]}
                    onPress={() => !u.is_system && setRoleForUser(u)}
                    activeOpacity={u.is_system ? 1 : 0.8}
                  >
                    <MaterialCommunityIcons name="shield-account" size={14} color={COLORS.primary} />
                    <Text style={s.rolePillTxt}>{roleLabel(u.role)}</Text>
                    {!u.is_system && <Ionicons name="chevron-down" size={14} color={COLORS.muted} />}
                    {savedFlash === 'role:' + u.id && <Text style={s.tickSm}>✓</Text>}
                  </TouchableOpacity>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity style={s.resetBtn} onPress={() => onReset(u)} activeOpacity={0.85}>
                    <Ionicons name="key-outline" size={14} color={COLORS.red} />
                    <Text style={s.resetBtnTxt}>{savedFlash === 'pw:' + u.id ? 'Reset ✓' : 'Reset password'}</Text>
                  </TouchableOpacity>
                </View>

                {/* Line 3: tap the +code to set this user's country, then the mobile */}
                <View style={s.waRow}>
                  <TouchableOpacity style={s.dialBadgeSm} onPress={() => setPickCountryForUser(u)} activeOpacity={0.7}>
                    <Text style={s.dialBadgeSmTxt}>{userCountryLabel(u)}</Text>
                    <Ionicons name="chevron-down" size={12} color={COLORS.muted} style={{ marginLeft: 2 }} />
                  </TouchableOpacity>
                  <TextInput
                    style={s.waInput} keyboardType="phone-pad" maxLength={u.mobile_length || mobileLen}
                    placeholder={`Mobile — ${u.mobile_length || mobileLen} digits`} placeholderTextColor={COLORS.faint}
                    value={u._mobile} onChangeText={(t) => onMobileChange(u.id, t)}
                    onEndEditing={() => saveMobile(u)}
                  />
                  {(savedFlash === 'mobile:' + u.id || savedFlash === 'country:' + u.id) && <Text style={s.tickInline}>✓</Text>}
                </View>

                {(u.last_login || u.last_device) ? (
                  <Text style={s.userLast}>
                    {u.last_login ? `Last login ${u.last_login}` : 'Never logged in'}
                    {u.last_device ? ` · ${u.last_device}` : ''}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>

          {/* 2. Password-reset sender (WhatsApp) */}
          <Card color="#16a34a" iconLib="mc" icon="whatsapp" title="Password-reset sender (WhatsApp)">
            {waState === 'connected' ? (
              <View>
                <View style={s.waConnected}>
                  <View style={s.waDot} />
                  <Text style={s.waConnTxt}>Connected{waPhone ? ` · ${waPhone}` : ''}</Text>
                </View>
                <TouchableOpacity style={s.waDangerBtn} onPress={disconnect} activeOpacity={0.85}>
                  <Ionicons name="trash-outline" size={16} color="#fff" />
                  <Text style={s.waDangerTxt}>Delete connection</Text>
                </TouchableOpacity>
              </View>
            ) : waState === 'waiting_qr' ? (
              <View style={{ alignItems: 'center' }}>
                {waQr ? (
                  <Image
                    key={waQr.slice(0, 32)}
                    source={{ uri: 'data:image/png;base64,' + waQr }}
                    style={s.qr}
                    resizeMode="contain"
                    fadeDuration={0}
                  />
                ) : (
                  <View style={[s.qr, s.qrPlaceholder]}><ActivityIndicator color={COLORS.primary} /></View>
                )}
                <Text style={s.waSteps}>1. Open WhatsApp on the sender phone.{'\n'}2. Settings → Linked Devices → Link a Device.{'\n'}3. Scan this QR code.</Text>
                <View style={s.waWaiting}>
                  <ActivityIndicator size="small" color={COLORS.muted} />
                  <Text style={s.waWaitingTxt}>Waiting for you to scan…</Text>
                </View>
                <TouchableOpacity style={s.waCancelBtn} onPress={disconnect} activeOpacity={0.85}>
                  <Text style={s.waCancelTxt}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <Text style={s.hint}>Connect a WhatsApp account that will send the one-time reset codes to users.</Text>
                {!!waError && <Text style={s.err}>{waError}</Text>}
                <TouchableOpacity style={s.waConnectBtn} onPress={connect} disabled={waBusy} activeOpacity={0.9}>
                  {waBusy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <MaterialCommunityIcons name="whatsapp" size={18} color="#fff" />
                      <Text style={s.waConnectTxt}>Connect a new WhatsApp server</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </Card>

          {/* 3. Reset message (WhatsApp) */}
          <Card color="#0ea5e9" iconLib="mc" icon="message-text-outline" title="Reset message (WhatsApp)">
            <View style={s.tplHead}>
              <Text style={s.label}>Message template</Text>
              <TouchableOpacity onPress={resetTemplate} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.tplReset}>↺ Reset to default</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={s.tplInput} multiline value={otpTemplate}
              onChangeText={setOtpTemplate} onEndEditing={saveTemplate}
              placeholder="Message…" placeholderTextColor={COLORS.faint}
            />
            <Text style={s.hint}>Placeholders: {'{name}'} {'{code}'} {'{minutes}'} {'{app}'} · wrap *text* for bold.
              {savedFlash === 'tpl' ? '  ✓ Saved' : ''}</Text>

            <Text style={[s.label, { marginTop: 14 }]}>Preview</Text>
            <View style={s.previewBubble}>
              <Text style={s.previewTxt}>{renderPreview(otpTemplate, previewSubs)}</Text>
            </View>
          </Card>
        </ScrollView>
      )}

      {/* Role picker */}
      <Modal visible={!!roleForUser} transparent animationType="fade" onRequestClose={() => setRoleForUser(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setRoleForUser(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Role — {roleForUser?.name}</Text>
              <TouchableOpacity onPress={() => setRoleForUser(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {ROLES.map((r) => {
              const on = roleForUser?.role === r.key;
              return (
                <TouchableOpacity key={r.key} style={[s.ccRow, on && s.ccRowOn]} onPress={() => onPickRole(roleForUser, r.key)} activeOpacity={0.8}>
                  <Text style={s.ccRowName}>{r.label}</Text>
                  {on && <Text style={s.ccRowTick}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Per-user country picker */}
      <Modal visible={!!pickCountryForUser} transparent animationType="fade" onRequestClose={() => setPickCountryForUser(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPickCountryForUser(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle} numberOfLines={1}>Country — {pickCountryForUser?.name || ''}</Text>
              <TouchableOpacity onPress={() => setPickCountryForUser(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={[{ id: false, name: `Default (+${dial})`, phone_code: dial, _default: true }, ...countries]}
              keyExtractor={(c) => String(c.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const cur = pickCountryForUser ? (pickCountryForUser.country_id || false) : false;
                const on = (item.id || false) === cur;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} onPress={() => chooseUserCountry(pickCountryForUser, item)} activeOpacity={0.8}>
                    <Text style={s.ccRowName}>{item.name}</Text>
                    {!item._default && <Text style={s.ccRowMeta}>+{item.phone_code}</Text>}
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Reset-password confirm popup */}
      <Modal visible={!!resetForUser} transparent animationType="fade" onRequestClose={() => setResetForUser(null)}>
        <View style={s.confirmWrap}>
          <View style={s.confirmCard}>
            <View style={s.confirmIcon}>
              <Ionicons name="key" size={30} color={COLORS.red} />
            </View>
            <Text style={s.confirmTitle}>Reset password?</Text>
            <Text style={s.confirmMsg}>
              <Text style={{ fontWeight: '900', color: COLORS.navy }}>{resetForUser?.name}</Text>'s app password
              will be reset to <Text style={{ fontWeight: '900', color: COLORS.navy }}>1111</Text> and they'll
              be asked to set a new one on next login.
            </Text>
            <View style={s.confirmBtns}>
              <TouchableOpacity style={[s.confirmBtn, s.confirmCancel]} onPress={() => setResetForUser(null)} activeOpacity={0.85}>
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.confirmBtn, s.confirmDo]} onPress={confirmReset} activeOpacity={0.85}>
                <Ionicons name="key-outline" size={16} color="#fff" />
                <Text style={s.confirmDoTxt}>Reset to 1111</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Disconnect WhatsApp confirm popup */}
      <Modal visible={disconnectOpen} transparent animationType="fade" onRequestClose={() => setDisconnectOpen(false)}>
        <View style={s.confirmWrap}>
          <View style={s.confirmCard}>
            <View style={s.confirmIcon}>
              <MaterialCommunityIcons name="link-variant-off" size={30} color={COLORS.red} />
            </View>
            <Text style={s.confirmTitle}>Disconnect WhatsApp?</Text>
            <Text style={s.confirmMsg}>
              This logs the sender out and removes the connection. Password-reset codes stop until you connect again.
            </Text>
            <View style={s.confirmBtns}>
              <TouchableOpacity style={[s.confirmBtn, s.confirmCancel]} onPress={() => setDisconnectOpen(false)} activeOpacity={0.85}>
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.confirmBtn, s.confirmDo]} onPress={confirmDisconnect} activeOpacity={0.85}>
                <Ionicons name="trash-outline" size={16} color="#fff" />
                <Text style={s.confirmDoTxt}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 16, borderLeftWidth: 4, overflow: 'hidden', ...SHADOW },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  cardBody: { padding: 14 },

  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 4, lineHeight: 17 },
  err: { color: COLORS.red, fontSize: 12.5, marginTop: 8 },

  filterRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  filterPill: { paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: '#F1F4F9', borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  filterPillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterPillTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted },
  filterPillTxtOn: { color: '#fff' },

  userRow: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#F1F4F9', marginTop: 6 },
  userTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  userName: { fontSize: 14.5, fontWeight: '800', color: COLORS.ink },
  userLogin: { fontSize: 12, color: COLORS.muted, marginTop: 1 },
  userSwitch: { alignItems: 'center' },
  userSmall: { fontSize: 10, color: COLORS.muted, marginBottom: 2 },
  userMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  rolePill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 32, borderRadius: 10, backgroundColor: '#EEF2FF', borderWidth: 1, borderColor: '#DCE4FB' },
  rolePillLocked: { opacity: 0.65 },
  rolePillTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  tickSm: { color: COLORS.green, fontSize: 13, fontWeight: '900', marginLeft: 2 },
  resetBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 32, borderRadius: 10, backgroundColor: COLORS.redBg, borderWidth: 1, borderColor: '#F6C9C9' },
  resetBtnTxt: { fontSize: 12, fontWeight: '800', color: COLORS.red },

  waRow: { flexDirection: 'row', alignItems: 'center' },
  dialBadgeSm: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F4F9', borderWidth: 1, borderColor: COLORS.line, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, paddingHorizontal: 10, height: 44, justifyContent: 'center' },
  dialBadgeSmTxt: { fontSize: 14, fontWeight: '800', color: COLORS.navy },
  waInput: { flex: 1, borderWidth: 1, borderColor: COLORS.line, borderLeftWidth: 0, borderTopRightRadius: 10, borderBottomRightRadius: 10, height: 44, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  tickInline: { fontSize: 16, color: COLORS.green, fontWeight: '900', marginLeft: 8 },
  userLast: { fontSize: 11, color: COLORS.faint, marginTop: 8 },

  // WhatsApp card
  waConnected: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#DCFCE7', borderRadius: 10, paddingHorizontal: 12, height: 44, marginBottom: 12 },
  waDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#16A34A' },
  waConnTxt: { fontSize: 13.5, fontWeight: '800', color: '#166534' },
  waDangerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.red, borderRadius: 12, height: 48 },
  waDangerTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  qr: { width: 220, height: 220, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  qrPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  waSteps: { fontSize: 12.5, color: COLORS.muted, lineHeight: 20, marginTop: 14, alignSelf: 'stretch' },
  waWaiting: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  waWaitingTxt: { fontSize: 12.5, color: COLORS.muted, fontWeight: '600' },
  waCancelBtn: { marginTop: 14, paddingVertical: 10, paddingHorizontal: 20 },
  waCancelTxt: { fontSize: 14, fontWeight: '700', color: COLORS.muted },
  waConnectBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#16a34a', borderRadius: 12, height: 50, marginTop: 12 },
  waConnectTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Reset-message card
  tplHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tplReset: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  tplInput: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, padding: 12, minHeight: 110, fontSize: 14, color: COLORS.ink, backgroundColor: '#fff', textAlignVertical: 'top' },
  previewBubble: { backgroundColor: '#DCF8C6', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#C5EBB0' },
  previewTxt: { fontSize: 13.5, color: '#0B3D0B', lineHeight: 20 },

  // Role picker modal
  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 26,
  },
  modalSheet: {
    width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20,
    maxHeight: '70%', paddingBottom: 12, overflow: 'hidden',
  },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  ccRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowMeta: { fontSize: 13, color: COLORS.muted, marginRight: 8 },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },

  // Reset-password confirm popup
  confirmWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  confirmCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 22 },
  confirmIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  confirmTitle: { fontSize: 19, fontWeight: '900', color: COLORS.navy },
  confirmMsg: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', lineHeight: 20, marginTop: 8 },
  confirmBtns: { flexDirection: 'row', gap: 12, marginTop: 20, width: '100%' },
  confirmBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 50, borderRadius: 14 },
  confirmCancel: { backgroundColor: '#EEF2F8' },
  confirmCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  confirmDo: { backgroundColor: COLORS.red },
  confirmDoTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
