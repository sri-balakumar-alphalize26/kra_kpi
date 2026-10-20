// USERS (admin) — Odoo Settings→Users style, but KRA/KPI roles ONLY.
// List every internal user with their KRA/KPI Role (User / Client / Admin), and
// create/edit one via an in-screen modal: Name · Login · Email · KRA/KPI Role ·
// Mobile · Active. No Odoo Role / groups / companies. New users get the app PIN
// seeded to 1111 (they log in with mobile + 1111, then change it). Admin-only.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Switch,
  ActivityIndicator, Modal, RefreshControl, KeyboardAvoidingView, Platform,
  ScrollView, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import FieldError from '../components/FieldError';
import useAppDialog from '../components/useAppDialog';
import {
  fetchUsers, createUser, updateUser, setUserRole, setUserMobile, resetUserPassword, changePassword,
} from '../services/users';

const log = createLogger('Users');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const ROLES = [
  { key: 'developer', label: 'User' },
  { key: 'client', label: 'Client' },
  { key: 'coordinator', label: 'Coordinator' },
  { key: 'admin', label: 'Admin' },
];
const ROLE_META = {
  admin:     { label: 'Admin',  bg: '#EDE9FE', fg: '#6D28D9', icon: 'shield-account' },
  coordinator: { label: 'Coordinator', bg: '#FEF3C7', fg: '#B45309', icon: 'account-tie' },
  client:    { label: 'Client', bg: '#CFFAFE', fg: '#0E7490', icon: 'briefcase-account' },
  developer: { label: 'User',   bg: '#DBEAFE', fg: '#1D4ED8', icon: 'account' },
};
const roleMeta = (r) => ROLE_META[r] || ROLE_META.developer;

const EMPTY_FORM = { name: '', login: '', email: '', role: 'developer', mobile: '', active: true, password: '' };

export default function UsersScreen({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [users, setUsers] = useState([]);
  const [isMock, setIsMock] = useState(false);
  const [query, setQuery] = useState('');

  const [editing, setEditing] = useState(null);   // null = closed | {} create | user edit
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyReset, setBusyReset] = useState(false);
  const [newPw, setNewPw] = useState('');        // edit: Odoo-style Change Password
  const [newPw2, setNewPw2] = useState('');
  // Failures and the reset confirm go through the app's own dialog, which
  // stacks over the editor sheet (RN presents by mount order). The three
  // "you left a box empty" cases do NOT -- those render under the field, so
  // the complaint is not a second window away from the fix.
  const { dialog, showError, confirm } = useAppDialog();
  const [errs, setErrs] = useState({});
  const clearErr = (k) => setErrs((p) => (p[k] ? { ...p, [k]: null } : p));
  const [busyChange, setBusyChange] = useState(false);
  const [showPw, setShowPw] = useState(false);   // eye toggle for the password fields
  const [okMsg, setOkMsg] = useState(null);      // styled success ("Done") popup

  const load = useCallback(async (silent) => {
    if (!silent) setError(null);
    try {
      const res = await fetchUsers();
      if (res && res.status === false) { setError(res.message || 'Could not load users.'); return; }
      setUsers(res?.users || []);
      setIsMock(!!res?.isMock);
      setError(null);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load users.');
    }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(false); setLoading(false); })(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(false); setRefreshing(false); }, [load]);

  const shown = query.trim()
    ? users.filter((u) => {
        const q = query.trim().toLowerCase();
        return (u.name || '').toLowerCase().includes(q) || (u.login || '').toLowerCase().includes(q);
      })
    : users;

  const openCreate = () => { setForm(EMPTY_FORM); setNewPw(''); setNewPw2(''); setShowPw(false); setEditing({}); };
  const openEdit = (u) => {
    setForm({
      name: u.name || '', login: u.login || '', email: u.email || '',
      role: u.role || 'developer', mobile: u.mobile || '', active: u.active !== false, password: '',
    });
    setNewPw(''); setNewPw2(''); setShowPw(false);
    setEditing(u);
  };
  const close = () => { setEditing(null); setForm(EMPTY_FORM); setNewPw(''); setNewPw2(''); setShowPw(false); setOkMsg(null); };

  const isCreate = editing && !editing.id;
  const isSystem = !!(editing && editing.is_system);

  const save = async () => {
    const name = form.name.trim(), login = form.login.trim();
    // Named separately rather than one "Name and Login are required": with a
    // single message you cannot tell which of the two you missed.
    const miss = {};
    if (!name) miss.name = 'Name is required.';
    if (!login) miss.login = 'Login is required.';
    setErrs(miss);
    if (miss.name || miss.login) return;
    setSaving(true);
    try {
      if (isCreate) {
        const res = await createUser({
          name, login, email: form.email.trim(), kra_role: form.role,
          mobile: form.mobile.replace(/\D/g, ''), active: form.active,
          password: (form.password || '').trim(),
        });
        if (!res?.status) { showError('Could not create', res?.message || 'Try again.'); return; }
      } else {
        const u = editing;
        const ru = await updateUser(u.id, {
          name, login, email: form.email.trim(), active: form.active,
        });
        if (!ru?.status) { showError('Could not save', ru?.message || 'Try again.'); return; }
        // Read the answers. Both used to be fire-and-forget, so a refused role
        // change or a mobile number another account already has closed the
        // form looking saved.
        if (!isSystem && form.role !== u.role) {
          const rr = await setUserRole(u.id, form.role);
          if (rr && rr.status === false) { showError('Could not change the role', rr.message || 'Try again.'); return; }
        }
        if ((form.mobile || '').replace(/\D/g, '') !== (u.mobile || '')) {
          const rm = await setUserMobile(u.id, form.mobile.replace(/\D/g, ''));
          if (rm && rm.status === false) { showError('Could not save the mobile number', rm.message || 'Try again.'); return; }
        }
      }
      close();
      await load(true);
    } catch (e) {
      log.warn('save failed', e?.message);
      showError('Error', e?.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const doResetPw = () => {
    if (!editing?.id) return;
    confirm({
      title: 'Reset password?',
      tone: 'danger',
      destructive: true,
      confirmLabel: 'Reset to 1111',
      message: `${editing.name}'s app password will be reset to 1111 and they'll set a new one on next login.`,
      // Returning the promise holds the dialog open, showing "Working…", until
      // the reset lands. The native alert dismissed on tap, so the one account
      // where a refusal matters most reported nothing at all for a moment.
      onConfirm: async () => {
        setBusyReset(true);
        // Check the answer, exactly as doChangePassword below already does.
        // The route REFUSES rather than raises when the caller is not an Odoo
        // system administrator and the target is — so a bare await announced a
        // reset that never happened, on the one account where that matters most.
        try {
          const r = await resetUserPassword(editing.id);
          if (r && r.status === false) { showError('Could not reset', r.message || 'Not authorized.'); return; }
          setOkMsg('Password has been reset to 1111. The user sets a new one on next login.');
        }
        catch (e) { showError('Error', e?.message || 'Could not reset.'); }
        finally { setBusyReset(false); }
      },
    });
  };

  // Odoo-style "Change Password" — set a specific new app PIN for an existing user.
  const doChangePassword = async () => {
    if (!editing?.id) return;
    const pw = (newPw || '').trim();
    if (pw.length < 4) { setErrs({ pw: 'Password must be at least 4 characters.' }); return; }
    if (pw !== (newPw2 || '').trim()) { setErrs({ pw2: 'The two passwords do not match.' }); return; }
    setErrs({});
    setBusyChange(true);
    try {
      const r = await changePassword(editing.id, pw);
      if (!r?.status) { showError('Could not change', r?.message || 'Try again.'); return; }
      setNewPw(''); setNewPw2('');
      setOkMsg(`${editing.name}'s password has been changed. They can log in with it right away.`);
    } catch (e) {
      showError('Error', e?.message || 'Could not change password.');
    } finally {
      setBusyChange(false);
    }
  };

  const renderUser = ({ item: u }) => {
    const m = roleMeta(u.role);
    return (
      <TouchableOpacity style={s.card} onPress={() => openEdit(u)} activeOpacity={0.85}>
        <View style={s.avatar}><Text style={s.avatarTxt}>{(u.name || 'U').trim().charAt(0).toUpperCase()}</Text></View>
        <View style={{ flex: 1 }}>
          <View style={s.nameRow}>
            <Text style={s.name} numberOfLines={1}>{u.name}</Text>
            {u.active === false ? <View style={s.archived}><Text style={s.archivedTxt}>Archived</Text></View> : null}
          </View>
          <Text style={s.sub} numberOfLines={1}>{u.login}{u.email ? ` · ${u.email}` : ''}</Text>
        </View>
        <View style={[s.roleBadge, { backgroundColor: m.bg }]}>
          <MaterialCommunityIcons name={m.icon} size={13} color={m.fg} />
          <Text style={[s.roleBadgeTxt, { color: m.fg }]}>{m.label}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={COLORS.muted} style={{ marginLeft: 4 }} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>Users</Text>
        <TouchableOpacity onPress={openCreate} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="person-add" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to manage users</Text>
        </View>
      )}

      <View style={s.searchWrap}>
        <Ionicons name="search" size={16} color={COLORS.muted} />
        <TextInput
          style={s.search} placeholder="Search by name or login" placeholderTextColor={COLORS.faint}
          value={query} onChangeText={setQuery} autoCapitalize="none"
        />
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={38} color={COLORS.red} />
          <Text style={s.errTxt}>{error}</Text>
          <TouchableOpacity onPress={() => load(false)} style={s.retry}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(u) => String(u.id)}
          renderItem={renderUser}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={<Text style={s.empty}>No users found.</Text>}
        />
      )}

      {/* Create / Edit modal */}
      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.mWrap}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>{isCreate ? 'New User' : 'Edit User'}</Text>
              <TouchableOpacity onPress={close} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              <Text style={s.label}>Name</Text>
              <TextInput style={[s.input, errs.name && s.inputErr]} value={form.name} onChangeText={(t) => { setForm((f) => ({ ...f, name: t })); clearErr('name'); }} placeholder="Full name" placeholderTextColor={COLORS.faint} />
              <FieldError msg={errs.name} />

              <Text style={s.label}>Login</Text>
              <TextInput style={[s.input, errs.login && s.inputErr]} value={form.login} onChangeText={(t) => { setForm((f) => ({ ...f, login: t })); clearErr('login'); }} placeholder="login / username" placeholderTextColor={COLORS.faint} autoCapitalize="none" />
              <FieldError msg={errs.login} />

              <Text style={s.label}>Email</Text>
              <TextInput style={s.input} value={form.email} onChangeText={(t) => setForm((f) => ({ ...f, email: t }))} placeholder="email (optional)" placeholderTextColor={COLORS.faint} autoCapitalize="none" keyboardType="email-address" />

              <Text style={s.label}>KRA / KPI Role</Text>
              <View style={s.segment}>
                {ROLES.map((r) => {
                  const on = form.role === r.key;
                  const disabled = isSystem; // never re-role the base super-admin here
                  return (
                    <TouchableOpacity
                      key={r.key}
                      style={[s.segBtn, on && s.segBtnOn, disabled && s.segDisabled]}
                      onPress={() => !disabled && setForm((f) => ({ ...f, role: r.key }))}
                      activeOpacity={disabled ? 1 : 0.8}
                    >
                      <Text style={[s.segTxt, on && s.segTxtOn]}>{r.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {isSystem ? <Text style={s.hint}>The Odoo administrator's role can't be changed here.</Text> : null}

              <Text style={s.label}>Mobile (app login)</Text>
              <TextInput style={s.input} value={form.mobile} onChangeText={(t) => setForm((f) => ({ ...f, mobile: t.replace(/\D/g, '') }))} placeholder="mobile number" placeholderTextColor={COLORS.faint} keyboardType="phone-pad" />

              <View style={s.switchRow}>
                <Text style={[s.label, { marginBottom: 0 }]}>Active</Text>
                <Switch
                  value={form.active}
                  onValueChange={(v) => setForm((f) => ({ ...f, active: v }))}
                  disabled={isSystem}
                  trackColor={{ true: COLORS.primary }}
                />
              </View>

              {isCreate && (
                <>
                  <Text style={s.label}>Password (app login)</Text>
                  <View style={s.pwWrap}>
                    <TextInput
                      style={s.pwInput} value={form.password}
                      onChangeText={(t) => setForm((f) => ({ ...f, password: t }))}
                      placeholder="Leave blank to start with 1111" placeholderTextColor={COLORS.faint}
                      secureTextEntry={!showPw} autoCapitalize="none"
                    />
                    <TouchableOpacity onPress={() => setShowPw((v) => !v)} style={s.pwEye} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={20} color={COLORS.muted} />
                    </TouchableOpacity>
                  </View>
                  <Text style={s.hint}>Leave blank and the app password starts as <Text style={{ fontWeight: '800' }}>1111</Text> (the user sets their own after first login). Type one here and they can log in with it right away.</Text>
                </>
              )}

              {/* Primary action — saves the identity fields above */}
              <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} activeOpacity={0.9}>
                {saving ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                    <Text style={s.saveTxt}>{isCreate ? 'Create User' : 'Save Changes'}</Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Password is its own concern — grouped in a distinct card (edit only,
                  never for the Odoo super-admin whose password we must not touch) */}
              {!isCreate && !isSystem && (
                <View style={s.pwCard}>
                  <Text style={s.pwHead}>Password</Text>
                  <Text style={s.pwSub}>Set a new app-login password, or reset it to 1111.</Text>

                  <Text style={s.label}>New Password</Text>
                  <View style={s.pwWrap}>
                    <TextInput
                      style={s.pwInput} value={newPw} onChangeText={(t) => { setNewPw(t); clearErr('pw'); }}
                      placeholder="new app password" placeholderTextColor={COLORS.faint}
                      secureTextEntry={!showPw} autoCapitalize="none"
                    />
                    <TouchableOpacity onPress={() => setShowPw((v) => !v)} style={s.pwEye} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={20} color={COLORS.muted} />
                    </TouchableOpacity>
                  </View>
                  <Text style={s.label}>Confirm Password</Text>
                  <View style={s.pwWrap}>
                    <TextInput
                      style={s.pwInput} value={newPw2} onChangeText={(t) => { setNewPw2(t); clearErr('pw2'); }}
                      placeholder="re-type new password" placeholderTextColor={COLORS.faint}
                      secureTextEntry={!showPw} autoCapitalize="none"
                    />
                    <TouchableOpacity onPress={() => setShowPw((v) => !v)} style={s.pwEye} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={20} color={COLORS.muted} />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={[s.changeBtn, busyChange && { opacity: 0.6 }]} onPress={doChangePassword} disabled={busyChange} activeOpacity={0.9}>
                    {busyChange ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="key" size={16} color="#fff" />}
                    <Text style={s.changeTxt}>Change Password</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.resetBtn} onPress={doResetPw} disabled={busyReset} activeOpacity={0.85}>
                    {busyReset ? <ActivityIndicator size="small" color={COLORS.red} /> : <Ionicons name="key-outline" size={16} color={COLORS.red} />}
                    <Text style={s.resetTxt}>Reset password to 1111</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Styled success ("Done") popup — replaces the plain OS alert */}
      <Modal visible={!!okMsg} transparent animationType="fade" onRequestClose={() => setOkMsg(null)}>
        <View style={s.okWrap}>
          <View style={s.okCard}>
            <View style={s.okIcon}><Ionicons name="checkmark-sharp" size={38} color="#fff" /></View>
            <Text style={s.okTitle}>Done</Text>
            <Text style={s.okMsg}>{okMsg}</Text>
            <TouchableOpacity style={s.okBtn} onPress={() => setOkMsg(null)} activeOpacity={0.9}>
              <Text style={s.okBtnTxt}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Last in the tree so it paints above the editor sheet and the Done
          popup, both of which can raise one. */}
      {dialog}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: TOP, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '800', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', marginHorizontal: 14, marginTop: 8, borderRadius: 12, paddingHorizontal: 12, height: 44, ...SHADOW },
  search: { flex: 1, fontSize: 14.5, color: COLORS.ink },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  errTxt: { color: COLORS.red, textAlign: 'center' },
  retry: { marginTop: 12, backgroundColor: COLORS.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '700' },
  empty: { textAlign: 'center', color: COLORS.muted, marginTop: 30 },

  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 10, ...SHADOW },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E0ECFF', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 16, fontWeight: '800', color: COLORS.primary },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 15, fontWeight: '800', color: COLORS.ink, flexShrink: 1 },
  sub: { fontSize: 12, color: COLORS.muted, marginTop: 1 },
  archived: { backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  archivedTxt: { fontSize: 10, fontWeight: '700', color: COLORS.muted },
  roleBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  roleBadgeTxt: { fontSize: 12, fontWeight: '800' },

  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  mWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: 'rgba(15,23,42,0.5)' },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 20, maxHeight: '85%', overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  sheetTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy },

  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6, marginTop: 12 },
  inputErr: { borderColor: COLORS.red },
  input: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  pwWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, backgroundColor: '#fff', paddingRight: 6 },
  pwInput: { flex: 1, height: '100%', paddingHorizontal: 12, fontSize: 15, color: COLORS.ink },
  pwEye: { paddingHorizontal: 6, paddingVertical: 6 },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 8, lineHeight: 17 },

  segment: { flexDirection: 'row', gap: 8 },
  segBtn: { flex: 1, height: 42, borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  segBtnOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  segDisabled: { opacity: 0.5 },
  segTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  segTxtOn: { color: '#fff' },

  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },

  pwCard: { marginTop: 22, backgroundColor: '#F7F9FD', borderRadius: 14, borderWidth: 1, borderColor: '#E6EDF7', padding: 14 },
  pwHead: { fontSize: 15.5, fontWeight: '900', color: COLORS.navy },
  pwSub: { fontSize: 12, color: COLORS.muted, marginTop: 2, lineHeight: 16 },
  changeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, height: 48, borderRadius: 12, backgroundColor: COLORS.primary },
  changeTxt: { color: '#fff', fontWeight: '800', fontSize: 14.5 },

  resetBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, height: 46, borderRadius: 12, borderWidth: 1, borderColor: '#F6C9C9', backgroundColor: COLORS.redBg },
  resetTxt: { color: COLORS.red, fontWeight: '800', fontSize: 14 },

  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, height: 52, borderRadius: 14, backgroundColor: COLORS.primary },
  saveTxt: { color: '#fff', fontWeight: '800', fontSize: 15.5 },

  okWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: 'rgba(15,23,42,0.5)' },
  okCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 22, paddingTop: 24, paddingBottom: 18, alignItems: 'center', ...SHADOW },
  okIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#16A34A', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  okTitle: { fontSize: 20, fontWeight: '900', color: COLORS.navy, marginBottom: 6 },
  okMsg: { fontSize: 14, color: COLORS.muted, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  okBtn: { alignSelf: 'stretch', height: 48, borderRadius: 12, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  okBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 15.5 },
});
