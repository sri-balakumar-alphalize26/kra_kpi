// NEEDS LINKING (admins / managers) — mobile port of the web's Work ▸ Needs
// Linking (web/components/admin/NeedsLinking.jsx) and Odoo's Clients ▸ Needs
// Linking. Bugs / updates raised "from the old system" that still wait for the
// old requirement's Request ID (/kra_kpi/legacy/pending, oldest first), grouped
// by client. Link saves the Request ID (and a name) through /kra_kpi/legacy/save,
// which renumbers the task under that requirement and marks it Confirmed with
// client, so it leaves this list.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Platform, ActivityIndicator, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { fetchNeedsLinking, saveLegacy } from '../services/kpiActions';

const log = createLogger('NeedsLinking');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

// "req 12" → "REQ-012"; anything else as typed (same as the web).
function normalizeRef(v) {
  const m = /^REQ\s*-?\s*(\d{1,9})$/i.exec(String(v || '').trim());
  if (!m) return String(v || '').trim();
  return `REQ-${String(+m[1]).padStart(3, '0')}`;
}

export default function NeedsLinking({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [link, setLink] = useState({});       // task id → { ref, name } being typed
  const [busy, setBusy] = useState(0);
  const [banner, setBanner] = useState(null); // { type, text }

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 3500); };

  const load = useCallback(async () => {
    const r = await fetchNeedsLinking();
    setLoading(false);
    if (!r?.status) { setError(r?.message || 'Could not load the list.'); return; }
    setError('');
    setTasks(r.tasks || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const m = new Map();
    for (const t of tasks) {
      const k = String(t.client_id || '');
      if (!m.has(k)) m.set(k, { key: k, client: t.client || '—', rows: [] });
      m.get(k).rows.push(t);
    }
    return [...m.values()].sort((a, b) => a.client.localeCompare(b.client));
  }, [tasks]);

  const upd = (id, patch) => setLink((x) => ({ ...x, [id]: { ...(x[id] || {}), ...patch } }));

  async function onLink(t) {
    const l = link[t.id] || {};
    const ref = normalizeRef(l.ref);
    if (!ref) { flash('err', 'Type the Request ID, e.g. REQ-012.'); return; }
    setBusy(t.id);
    try {
      // The message stays as it is; an empty name keeps the one the client gave.
      const r = await saveLegacy(t.id, { ref, name: (l.name || '').trim() || t.legacy_name, note: t.note });
      if (!r?.status) { flash('err', r?.message || 'Could not link it.'); return; }
      log.info('linked', { kpi_id: t.id, ref: r.ref });
      flash('ok', `${t.ref || 'Task'} linked${r.ref ? ` — now ${r.ref}` : ''}.`);
      setLink((x) => { const n = { ...x }; delete n[t.id]; return n; });
      load();
    } catch (e) {
      flash('err', e?.message || 'Could not link it.');
    } finally {
      setBusy(0);
    }
  }

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <View style={s.hTitleWrap}>
          <Text style={s.hTitle} numberOfLines={1}>Needs Linking</Text>
          {tasks.length > 0 && <View style={s.hCount}><Text style={s.hCountTxt}>{tasks.length}</Text></View>}
        </View>
        <TouchableOpacity onPress={() => { setLoading(true); load(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          {loading ? <ActivityIndicator size="small" color={COLORS.primary} /> : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      </View>

      {banner && (
        <View style={[s.banner, banner.type === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.type === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={16} color={banner.type === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.type === 'ok' ? COLORS.green : COLORS.red }]}>{banner.text}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: BOTTOM_PAD + 20 }} keyboardShouldPersistTaps="handled">
        <View style={s.info}>
          <Ionicons name="information-circle" size={18} color="#0369A1" />
          <Text style={s.infoTxt}>Bugs and updates about an old-DB requirement, waiting for its Request ID.</Text>
        </View>
        {!!error && <Text style={s.err}>{error}</Text>}
        {!loading && !error && !tasks.length && (
          <Text style={s.empty}>Nothing to link. Every old-DB bug and update has its Request ID.</Text>
        )}
        {groups.map((g) => (
          <View key={g.key} style={{ marginBottom: 10 }}>
            <Text style={s.group}>{g.client} · {g.rows.length} waiting</Text>
            {g.rows.map((t) => {
              const l = link[t.id] || {};
              const voices = (t.voice_notes || []).length;
              return (
                <View key={t.id} style={s.card}>
                  <View style={s.cardTop}>
                    <Text style={s.ref}>{t.ref || `#${t.id}`}</Text>
                    <View style={s.pending}><Text style={s.pendingTxt}>Pending</Text></View>
                  </View>
                  <Text style={s.name}>{t.name}</Text>
                  {!!t.legacy_name && <Text style={s.meta}>Old task: <Text style={{ fontWeight: '800' }}>{t.legacy_name}</Text></Text>}
                  {!!t.note && <Text style={s.body}>{t.note}</Text>}
                  {!!t.transcript && <Text style={s.meta}>Voice note says: {t.transcript}</Text>}
                  {voices > 0 && <Text style={s.meta}>🎤 {voices} voice note{voices === 1 ? '' : 's'}. Open the task to play {voices === 1 ? 'it' : 'them'}.</Text>}
                  <Text style={s.meta}>{[t.db, t.by, t.date].filter(Boolean).join(' · ')}</Text>
                  <TextInput
                    style={s.input} autoCapitalize="characters"
                    value={l.ref || ''} onChangeText={(v) => upd(t.id, { ref: v })}
                    onEndEditing={() => upd(t.id, { ref: normalizeRef(l.ref) })}
                    placeholder="Request ID, e.g. REQ-012" placeholderTextColor={COLORS.faint}
                  />
                  <TextInput
                    style={s.input}
                    value={l.name || ''} onChangeText={(v) => upd(t.id, { name: v })}
                    placeholder={t.legacy_name ? `Task name (${t.legacy_name})` : 'Task name (optional)'} placeholderTextColor={COLORS.faint}
                  />
                  <TouchableOpacity
                    style={[s.linkBtn, (!(l.ref || '').trim() || busy === t.id) && { opacity: 0.45 }]}
                    disabled={!(l.ref || '').trim() || busy === t.id} onPress={() => onLink(t)}
                  >
                    {busy === t.id ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.linkTxt}>Link</Text>}
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  hTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },
  hCount: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: COLORS.amber, alignItems: 'center', justifyContent: 'center' },
  hCountTxt: { color: '#fff', fontSize: 11.5, fontWeight: '900' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { fontSize: 13, fontWeight: '600', flex: 1 },
  info: { flexDirection: 'row', gap: 9, backgroundColor: '#E0F2FE', borderRadius: 12, padding: 12, marginBottom: 14 },
  infoTxt: { flex: 1, fontSize: 12.5, color: '#0369A1', lineHeight: 18 },
  err: { color: COLORS.red, fontWeight: '700', marginBottom: 10 },
  empty: { color: COLORS.muted, textAlign: 'center', marginTop: 30 },
  group: { fontSize: 13, fontWeight: '900', color: COLORS.navy, marginBottom: 6 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 9, ...SHADOW },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  ref: { fontSize: 13, fontWeight: '900', color: COLORS.primary },
  pending: { backgroundColor: COLORS.amberBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  pendingTxt: { fontSize: 11, fontWeight: '800', color: '#92400E' },
  name: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginBottom: 3 },
  body: { fontSize: 13, color: COLORS.ink, lineHeight: 18, marginTop: 3 },
  meta: { fontSize: 12, color: COLORS.muted, marginTop: 3 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 10, height: 40, marginTop: 8, color: COLORS.ink, backgroundColor: '#F8FAFC' },
  linkBtn: { marginTop: 9, height: 40, borderRadius: 10, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  linkTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
});
