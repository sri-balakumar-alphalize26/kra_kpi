// MEETINGS — Odoo's Meetings menu (kpi.meeting), asked for on WhatsApp. Mobile
// port of the web's My Work › Meetings (web/components/work/Meetings.jsx): the
// same five tabs with counts (Waiting · Confirmed · Open now · Finished · All),
// "Only meetings I join", Upcoming / No time set, and a search over subject,
// client and who joins. Tap a meeting for its details and attendance.
//
// 🎥 Join opens the room as ME (/kpi_meeting/my_link → the browser; the server
// names me from Odoo). Share client link hands over the /kpi/meet/<token> page
// the client is sent.
//
// READ-ONLY on purpose. Confirm & send link / Open now / Finished / Send summary /
// Cancel each post into the client's WhatsApp group; they stay on the web and in
// Odoo. Who may see what is Odoo's own ACL (plain ORM reads), so no gate here.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Modal, Share,
  ActivityIndicator, RefreshControl, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { getSession } from '../api/session';
import * as M from '../services/meetings';

const log = createLogger('MeetingsScreen');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

const TONE = {
  paused: { bg: '#FEF3C7', fg: '#B45309' },
  review: { bg: '#DBEAFE', fg: '#1D4ED8' },
  progress: { bg: '#DCFCE7', fg: '#15803D' },
  done: { bg: '#E0E7FF', fg: '#4338CA' },
  neutral: { bg: '#F1F5F9', fg: '#475569' },
};
const stateOf = (st) => {
  const [tone, label] = M.STATES[st] || ['neutral', st];
  return { ...(TONE[tone] || TONE.neutral), label };
};
const todayStr = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

export default function MeetingsScreen({ onBack }) {
  const [filter, setFilter] = useState('requested');
  const [mine, setMine] = useState(false);
  const [upcoming, setUpcoming] = useState(false);
  const [noTime, setNoTime] = useState(false);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [uid, setUid] = useState(null);

  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { getSession().then((u) => setUid(u?.uid || null)).catch(() => {}); }, []);

  // The web's domainFor(): the tab's own domain plus every toggle.
  const domainFor = useCallback((key) => {
    const d = [...((M.FILTERS.find((f) => f.key === key) || {}).domain || [])];
    if (mine && uid) d.push(['organizer_id', '=', uid]);
    if (upcoming) d.push(['scheduled_start', '>=', todayStr()]);
    if (noTime) d.push(['scheduled_start', '=', false]);
    const w = q.trim();
    if (w) d.push('|', '|', ['name', 'ilike', w], ['client_kra_id', 'ilike', w], ['organizer_id', 'ilike', w]);
    return d;
  }, [mine, uid, upcoming, noTime, q]);

  const load = useCallback(async () => {
    setError('');
    try {
      const [res, n] = await Promise.all([M.listMeetings(domainFor(filter)), M.countMeetings(domainFor)]);
      setIsMock(!!res.isMock);
      setRows(res.rows);
      setCounts(n || {});
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load the meetings.');
      setRows((r) => r || []);
    } finally {
      setRefreshing(false);
    }
  }, [filter, domainFor]);

  useEffect(() => { load(); }, [load]);

  const submitSearch = () => { if (draft !== q) setQ(draft); };

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <View style={s.hTitleWrap}>
          <Text style={s.hTitle} numberOfLines={1}>Meetings</Text>
        </View>
        <TouchableOpacity onPress={() => { setRefreshing(true); load(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.primary} />
            : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      </View>

      {/* Waiting · Confirmed · Open now · Finished · All */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
        contentContainerStyle={s.tabs}>
        {M.FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <TouchableOpacity key={f.key} style={[s.tab, on && s.tabOn]} onPress={() => setFilter(f.key)} activeOpacity={0.85}>
              <Text style={[s.tabTxt, on && s.tabTxtOn]}>{f.label}</Text>
              {!!counts[f.key] && (
                <View style={[s.tabCount, on && s.tabCountOn]}>
                  <Text style={[s.tabCountTxt, on && { color: COLORS.primary }]}>{counts[f.key]}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline — connect to a server to see meetings</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: BOTTOM_PAD }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} colors={[COLORS.primary]} />}
      >
        <View style={s.pillRow}>
          <Pill on={mine} onPress={() => setMine((v) => !v)} label="Only meetings I join" />
          <Pill on={upcoming} onPress={() => setUpcoming((v) => !v)} label="Upcoming" />
          <Pill on={noTime} onPress={() => setNoTime((v) => !v)} label="No time set" />
        </View>
        <View style={s.searchBox}>
          <Ionicons name="search" size={16} color={COLORS.muted} />
          <TextInput
            style={s.searchInput} value={draft} onChangeText={setDraft}
            placeholder="Subject, client, who joins…" placeholderTextColor={COLORS.faint}
            returnKeyType="search" onSubmitEditing={submitSearch} onEndEditing={submitSearch}
          />
          {!!draft && (
            <TouchableOpacity onPress={() => { setDraft(''); setQ(''); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={COLORS.faint} />
            </TouchableOpacity>
          )}
        </View>

        {!!error && (
          <View style={s.errorCard}>
            <Ionicons name="alert-circle-outline" size={18} color="#B91C1C" />
            <Text style={s.errorTxt}>{error}</Text>
            <TouchableOpacity onPress={load} style={s.retryBtn}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
          </View>
        )}

        {rows === null ? (
          <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
        ) : !rows.length ? (
          <View style={s.emptyCard}>
            <Ionicons name="videocam-outline" size={28} color={COLORS.faint} />
            <Text style={s.emptyTitle}>{filter === 'requested' ? 'No meetings waiting' : 'No meetings here'}</Text>
            <Text style={s.emptyTxt}>A client taps Request a Meeting on WhatsApp and picks a time. It arrives
              here with nobody assigned.</Text>
          </View>
        ) : rows.map((m) => {
          const st = stateOf(m.state);
          return (
            <TouchableOpacity key={m.id} style={s.card} onPress={() => setOpenId(m.id)} activeOpacity={0.85}>
              <View style={s.rowTop}>
                <Text style={s.when} numberOfLines={1}>
                  {m.scheduled_start ? M.localWhen(m.scheduled_start) : `Asked: ${m.requested_text || 'no time yet'}`}
                </Text>
                <View style={[s.stateChip, { backgroundColor: st.bg }]}><Text style={[s.stateTxt, { color: st.fg }]}>{st.label}</Text></View>
              </View>
              <Text style={s.title} numberOfLines={2}>{m.name}</Text>
              {!!m.kpi_id && <Text style={s.meta} numberOfLines={1}>{M.m2o(m.kpi_id)}</Text>}
              <View style={[s.rowTop, { marginTop: 6 }]}>
                {m.is_internal && <View style={s.refChip}><Text style={s.refTxt}>Internal</Text></View>}
                <Text style={s.meta} numberOfLines={1}>{M.m2o(m.client_kra_id) || '—'}</Text>
              </View>
              <View style={s.metaRow}>
                {m.organizer_id
                  ? <Text style={s.meta} numberOfLines={1}>👤 {M.m2o(m.organizer_id)}</Text>
                  : <Text style={s.nobody}>Nobody yet</Text>}
                <Text style={s.meta}>{m.actual_minutes ? `Ran ${m.actual_minutes} min` : m.requested_by_name ? `Asked by ${m.requested_by_name}` : ''}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <MeetingSheet id={openId} onClose={() => setOpenId(null)} />
    </View>
  );
}

function Pill({ on, onPress, label }) {
  return (
    <TouchableOpacity style={[s.pill, on && s.pillOn]} onPress={onPress} activeOpacity={0.85}>
      <Text style={[s.pillTxt, on && s.pillTxtOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

// One meeting: when, who, the room, attendance and what was written afterwards.
function MeetingSheet({ id, onClose }) {
  const [m, setM] = useState(null);
  const [sheet, setSheet] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!id) { setM(null); setSheet([]); setError(''); setMsg(''); return; }
    let alive = true;
    (async () => {
      try {
        const r = await M.readMeeting(id);
        if (!alive) return;
        if (!r) { setError('This meeting no longer exists.'); return; }
        setM(r);
        const a = await M.attendance(id);
        if (alive) setSheet(a);
      } catch (e) {
        if (alive) setError(e?.message || 'Could not load the meeting.');
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const join = async () => {
    setBusy('join'); setMsg('');
    try { await M.joinMeeting(id); }
    catch (e) { setMsg(e?.message || 'Could not open the meeting.'); }
    finally { setBusy(''); }
  };
  const share = async () => {
    setBusy('share'); setMsg('');
    try {
      const url = await M.clientLink(id);
      await Share.share({ message: url });
    } catch (e) { setMsg(e?.message || 'Could not get the client link.'); }
    finally { setBusy(''); }
  };

  const st = m ? stateOf(m.state) : null;
  const roomOpen = m && ['confirmed', 'live'].includes(m.state);
  const people = (m?.participant_summary || '').trim();

  return (
    <Modal visible={!!id} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={s.sheet} activeOpacity={1}>
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle} numberOfLines={2}>{m?.name || 'Meeting'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {!m && !error ? (
            <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
          ) : error ? (
            <Text style={[s.errorTxt, { padding: 16 }]}>{error}</Text>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 28, gap: 10 }}>
              <View style={s.rowTop}>
                <View style={[s.stateChip, { backgroundColor: st.bg, marginLeft: 0 }]}><Text style={[s.stateTxt, { color: st.fg }]}>{st.label}</Text></View>
                {m.is_internal && <View style={s.refChip}><Text style={s.refTxt}>Internal</Text></View>}
              </View>

              <Text style={s.metaBlock}>
                {[
                  m.scheduled_start ? `🕒 ${M.localWhen(m.scheduled_start)} · ${m.duration_minutes || 30} min`
                    : `🕒 Asked: ${m.requested_text || 'no time yet'}`,
                  m.local_when && `Client's time: ${m.local_when}`,
                  m.kpi_id && `📌 ${M.m2o(m.kpi_id)}`,
                  M.m2o(m.client_kra_id) && `🏢 ${M.m2o(m.client_kra_id)}`,
                  `👤 ${M.m2o(m.organizer_id) || 'Nobody yet'}`,
                  m.requested_by_name && `Asked by ${m.requested_by_name}`,
                  m.confirmed_by_id && `Confirmed by ${M.m2o(m.confirmed_by_id)}${m.confirmed_at ? `, ${M.localWhen(m.confirmed_at)}` : ''}`,
                  m.opened_at && `Opened ${M.localWhen(m.opened_at)}`,
                  m.ended_at && `Ended ${M.localWhen(m.ended_at)}`,
                  m.actual_minutes ? `Ran for ${m.actual_minutes} min` : '',
                  m.state === 'cancelled' && m.cancel_reason && `Cancelled: ${m.cancel_reason}`,
                ].filter(Boolean).join('\n')}
              </Text>

              {!!msg && (
                <TouchableOpacity style={s.errorCard} onPress={() => setMsg('')} activeOpacity={0.8}>
                  <Ionicons name="alert-circle-outline" size={16} color="#B91C1C" />
                  <Text style={s.errorTxt}>{msg}  ✕</Text>
                </TouchableOpacity>
              )}

              {roomOpen && (
                <View style={s.btnRow}>
                  <TouchableOpacity style={s.joinBtn} onPress={join} disabled={!!busy} activeOpacity={0.85}>
                    {busy === 'join' ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons name="videocam" size={16} color="#fff" />}
                    <Text style={s.joinTxt}>Join meeting</Text>
                  </TouchableOpacity>
                  {!m.is_internal && (
                    <TouchableOpacity style={s.ghostBtn} onPress={share} disabled={!!busy} activeOpacity={0.85}>
                      {busy === 'share' ? <ActivityIndicator size="small" color={COLORS.navy} />
                        : <Ionicons name="share-social-outline" size={15} color={COLORS.navy} />}
                      <Text style={s.ghostTxt}>Share client link</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              {m.state === 'requested' && (
                <Text style={s.hint}>Not confirmed yet — set the time and who joins, then Confirm & send
                  link, on the web or in Odoo. That posts the link into the client's group.</Text>
              )}

              <View style={s.box}>
                <Text style={s.boxHead}>👥 Attendance</Text>
                {!sheet.length && <Text style={s.boxLine}>{people || 'Nobody joined yet.'}</Text>}
                {sheet.map((p, i) => (
                  <View key={i} style={s.attRow}>
                    <Text style={s.attName} numberOfLines={1}>{p.name}{p.user ? '' : ' (client)'}</Text>
                    <Text style={s.meta}>{p.absent ? '❌ absent' : `${p.minutes || 0} min${p.removed ? ' ⚠️' : ''}`}</Text>
                  </View>
                ))}
              </View>

              <View style={s.soft}><Text style={s.softHead}>📝 Summary{m.summary_posted ? ' · sent' : ''}</Text><Text style={s.softTxt}>{m.summary || 'No summary yet.'}</Text></View>
              <View style={s.soft}><Text style={s.softHead}>✅ Action items</Text><Text style={s.softTxt}>{m.action_items || 'None written.'}</Text></View>
              {!!m.notes && <Text style={s.meta}>🔒 {m.notes}</Text>}
            </ScrollView>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  center: { paddingVertical: 40, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  hTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },

  tabs: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#fff', ...SHADOW },
  tabOn: { backgroundColor: COLORS.primary },
  tabTxt: { fontSize: 13, fontWeight: '800', color: COLORS.navy },
  tabTxtOn: { color: '#fff' },
  tabCount: { minWidth: 20, height: 18, borderRadius: 9, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  tabCountOn: { backgroundColor: '#fff' },
  tabCountTxt: { fontSize: 10.5, fontWeight: '900', color: '#fff' },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14, marginTop: 6 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line },
  pillOn: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  pillTxt: { fontSize: 12, fontWeight: '700', color: COLORS.navy },
  pillTxtOn: { color: '#fff' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, paddingHorizontal: 12, height: 44, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.ink, paddingVertical: 0 },

  errorCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', borderRadius: 12, padding: 12, marginBottom: 12 },
  errorTxt: { flex: 1, color: '#B91C1C', fontSize: 12.5, fontWeight: '600' },
  retryBtn: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  retryTxt: { color: '#B91C1C', fontWeight: '800', fontSize: 12 },

  emptyCard: { backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', gap: 6, ...SHADOW },
  emptyTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  emptyTxt: { fontSize: 12.5, color: COLORS.muted, textAlign: 'center', lineHeight: 18 },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 10, ...SHADOW },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  when: { flex: 1, fontSize: 13, fontWeight: '800', color: COLORS.ink },
  title: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy, marginTop: 4 },
  meta: { fontSize: 11.5, color: COLORS.muted, flexShrink: 1 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  nobody: { fontSize: 11.5, fontWeight: '800', color: COLORS.amber },
  refChip: { backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  refTxt: { fontSize: 11.5, fontWeight: '800', color: '#475569' },
  stateChip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, marginLeft: 'auto' },
  stateTxt: { fontSize: 11, fontWeight: '800' },

  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '88%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  sheetTitle: { flex: 1, fontSize: 16, fontWeight: '900', color: COLORS.navy },
  close: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  metaBlock: { fontSize: 12.5, color: COLORS.ink, lineHeight: 20 },
  hint: { fontSize: 12, color: COLORS.muted, lineHeight: 17 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  joinBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.green, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  joinTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff' },
  ghostTxt: { color: COLORS.navy, fontWeight: '800', fontSize: 12.5 },
  box: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, overflow: 'hidden' },
  boxHead: { fontSize: 12, fontWeight: '800', color: COLORS.navy, backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 5 },
  boxLine: { fontSize: 12.5, color: COLORS.ink, paddingHorizontal: 8, paddingVertical: 5 },
  attRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 5, borderTopWidth: 1, borderTopColor: COLORS.line },
  attName: { flex: 1, fontSize: 12.5, color: COLORS.ink },
  soft: { backgroundColor: '#F1F5F9', borderRadius: 8, padding: 8 },
  softHead: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginBottom: 2 },
  softTxt: { fontSize: 12.5, color: COLORS.ink },
});
