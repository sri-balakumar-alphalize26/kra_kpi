// LIVE TRACKING (admin) — "who is doing what right now" + attendance.
// Mobile port of the web kpi_live_tracking screen: per developer, their current
// activity (running task + live elapsed / Break / Lunch / Meeting / No tasks /
// Idle / Not started) and today's attendance (Present · Late came HH:MM · Absent ·
// Yet to start). Polls /kpi_owner/live_tracking every 15s; ticks the elapsed every
// second in between so it feels live. Admin-only (route is gated server-side too).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, StatusBar as RNStatusBar, Modal, TextInput,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import PulseDot from '../components/PulseDot';
import { fetchLiveTracking, revertWorkday } from '../services/liveTracking';
import * as H from '../utils/haptics';
import { createLogger } from '../api/logger';

const log = createLogger('LiveTracking');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const POLL_MS = 15000;

// Per activity: pill colours + icon (mirrors the web screen's hues).
const ACT = {
  task:     { bg: '#E0ECFF', fg: '#2563EB', icon: 'clipboard-check' },
  break:    { bg: '#FEF3C7', fg: '#D97706', icon: 'coffee' },
  lunch:    { bg: '#FFEDD5', fg: '#EA580C', icon: 'silverware-fork-knife' },
  meeting:  { bg: '#EDE9FE', fg: '#7C3AED', icon: 'account-group' },
  no_tasks: { bg: '#F1F5F9', fg: '#64748B', icon: 'inbox-outline' },
  idle:     { bg: '#F1F5F9', fg: '#94A3B8', icon: 'sleep' },
  offline:  { bg: '#F8FAFC', fg: '#94A3B8', icon: 'power-sleep' },
};

function fmtElapsed(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

// The kinds that keep counting up (so we tick them locally between polls).
const TICKING = new Set(['task', 'break', 'lunch', 'meeting', 'no_tasks']);

function Chip({ label, value, tone }) {
  const c = {
    total: { bg: '#EEF2F8', fg: COLORS.muted },
    green: { bg: '#DCFCE7', fg: '#16A34A' },
    blue:  { bg: '#E0ECFF', fg: '#2563EB' },
    amber: { bg: '#FEF3C7', fg: '#B45309' },
    red:   { bg: '#FEE2E2', fg: '#DC2626' },
  }[tone] || { bg: '#EEF2F8', fg: COLORS.muted };
  return (
    <View style={[s.chip, { backgroundColor: c.bg }]}>
      <Text style={[s.chipVal, { color: c.fg }]}>{value}</Text>
      <Text style={[s.chipLbl, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

function Attendance({ row }) {
  if (row.attendance === 'present') {
    return (
      <View style={[s.badge, { backgroundColor: '#DCFCE7' }]}>
        <Text style={[s.badgeTxt, { color: '#16A34A' }]}>
          Present{row.arrival ? ` · ${row.arrival}` : ''}
        </Text>
      </View>
    );
  }
  if (row.attendance === 'late') {
    return (
      <View style={[s.badge, { backgroundColor: '#FEF3C7' }]}>
        <Text style={[s.badgeTxt, { color: '#B45309' }]}>Late · came {row.arrival}</Text>
      </View>
    );
  }
  if (row.attendance === 'absent') {
    return (
      <View style={[s.badge, { backgroundColor: '#FEE2E2' }]}>
        <Text style={[s.badgeTxt, { color: '#DC2626' }]}>Absent</Text>
      </View>
    );
  }
  return (
    <View style={[s.badge, { backgroundColor: '#EEF2F8' }]}>
      <Text style={[s.badgeTxt, { color: COLORS.muted }]}>Yet to start</Text>
    </View>
  );
}

// One employee card.
function Row({ row, nowMs, fetchedAt, onReopen }) {
  const kind = row.activity_kind || 'offline';
  const meta = ACT[kind] || ACT.offline;
  // Live elapsed: server value + seconds since we fetched (for ongoing kinds).
  const live = TICKING.has(kind)
    ? (row.elapsed_seconds || 0) + Math.max(0, Math.floor((nowMs - fetchedAt) / 1000))
    : 0;

  // A developer with multitask enabled can have several timers running. The
  // server sends them all in active_tasks (scalars stay the first one for older
  // builds), so the pill becomes one-per-task instead of one arbitrary task.
  const running = kind === 'task' && row.active_tasks?.length ? row.active_tasks : null;
  const tick = (secs) => fmtElapsed((secs || 0) + Math.max(0, Math.floor((nowMs - fetchedAt) / 1000)));

  let text;
  if (kind === 'task') text = `${row.activity_label || 'Task'} · ${fmtElapsed(live)}`;
  else if (kind === 'break') text = `Break · ${fmtElapsed(live)}`;
  else if (kind === 'lunch') text = `Lunch · ${fmtElapsed(live)}`;
  else if (kind === 'meeting') text = `Meeting · ${fmtElapsed(live)}`;
  else if (kind === 'no_tasks') text = `No tasks · ${fmtElapsed(live)}`;
  else if (kind === 'idle') text = 'Idle — no task running';
  else text = 'Not started';

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.name} numberOfLines={1}>{row.name}</Text>
        <Attendance row={row} />
      </View>
      <View style={s.actRow}>
        {/* live dot — beats while the heartbeat is fresh (at the desk), sits
            still and grey when it isn't, so a stalled row is visible at a glance */}
        <PulseDot active={!!row.active} />
        {running ? (
          <View style={s.pillWrap}>
            {running.length > 1 ? (
              <Text style={s.multiTxt}>Multi-tasking {running.length} tasks</Text>
            ) : null}
            {running.map((at) => (
              <View key={at.id} style={[s.pill, { backgroundColor: meta.bg }]}>
                <MaterialCommunityIcons name={meta.icon} size={14} color={meta.fg} style={{ marginRight: 5 }} />
                <Text style={[s.pillTxt, { color: meta.fg }]} numberOfLines={1}>
                  {at.name} · {tick(at.elapsed_seconds)}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={[s.pill, { backgroundColor: meta.bg }]}>
            {kind !== 'idle' && kind !== 'offline' ? (
              <MaterialCommunityIcons name={meta.icon} size={14} color={meta.fg} style={{ marginRight: 5 }} />
            ) : null}
            <Text style={[s.pillTxt, { color: meta.fg }]} numberOfLines={1}>{text}</Text>
          </View>
        )}
      </View>
      {/* End Workday is one-way for the developer. This is the only way back, and
          it lives here because this is the screen where an admin can see WHOSE
          day ended. Mirrors the web's Live Tracking button. */}
      {row.day_done ? (
        <TouchableOpacity style={s.reopenBtn} activeOpacity={0.8} onPress={() => onReopen(row)}>
          <Ionicons name="arrow-undo" size={14} color={COLORS.amber} />
          <Text style={s.reopenTxt}>Reopen day</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function LiveTracking({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);      // full payload
  const [isMock, setIsMock] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const fetchedAtRef = useRef(Date.now());
  // Reopen-day dialog. A real modal rather than a prompt: the reason is
  // mandatory (the developer is told in these words), and React Native has no
  // window.prompt to lean on the way the web does.
  const [reopenFor, setReopenFor] = useState(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenErr, setReopenErr] = useState('');
  const [reopenBusy, setReopenBusy] = useState(false);

  const load = useCallback(async (silent) => {
    if (!silent) setError(null);
    try {
      const res = await fetchLiveTracking();
      if (res && res.status === false) {
        setError(res.message || 'Could not load live tracking.');
        return;
      }
      setData(res);
      setIsMock(!!res.isMock);
      fetchedAtRef.current = Date.now();
      setNowMs(Date.now());
      setError(null);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load live tracking.');
    }
  }, []);

  // Initial load.
  useEffect(() => { (async () => { setLoading(true); await load(false); setLoading(false); })(); }, [load]);

  // Poll every 15s.
  useEffect(() => {
    const id = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Tick the elapsed once a second (smooth live feel between polls).
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(false); setRefreshing(false); }, [load]);

  const openReopen = useCallback((row) => {
    H.tap();
    setReopenFor(row);
    setReopenReason('');
    setReopenErr('');
  }, []);

  const submitReopen = useCallback(async () => {
    const reason = reopenReason.trim();
    // Required. The server refuses an empty one too — this is the courtesy copy.
    if (!reason) {
      H.err();
      setReopenErr('A reason is required — it is sent to them in your words.');
      return;
    }
    setReopenBusy(true);
    try {
      const res = await revertWorkday(reopenFor.user_id, reason);
      if (res && res.status === false) {
        H.err();
        setReopenErr(res.message || 'Could not reopen that workday.');
        return;
      }
      H.ok();
      setReopenFor(null);
      await load(true);
    } catch (e) {
      log.warn('reopen failed', e?.message);
      setReopenErr(e?.message || 'Could not reopen that workday.');
    } finally {
      setReopenBusy(false);
    }
  }, [reopenFor, reopenReason, load]);

  const rows = data?.rows || [];

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>Live Tracking</Text>
        <TouchableOpacity onPress={() => load(false)} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server for live data</Text>
        </View>
      )}

      {/* Summary chips */}
      {data ? (
        <View style={s.chips}>
          <Chip label="Employees" value={data.total ?? rows.length} tone="total" />
          <Chip label="Present" value={data.present_count ?? 0} tone="green" />
          <Chip label="Active now" value={data.active_count ?? 0} tone="blue" />
          <Chip label="Late" value={data.late_count ?? 0} tone="amber" />
          <Chip label="Absent" value={data.absent_count ?? 0} tone="red" />
        </View>
      ) : null}
      {data?.cutoff_display ? (
        <Text style={s.cutoff}>Absent / late after {data.cutoff_display}</Text>
      ) : null}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={38} color={COLORS.red} />
          <Text style={s.errTxt}>{error}</Text>
          <TouchableOpacity onPress={() => load(false)} style={s.retry}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="account-group-outline" size={44} color={COLORS.faint} />
          <Text style={s.empty}>No developers to track.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.user_id)}
          renderItem={({ item }) => (
            <Row row={item} nowMs={nowMs} fetchedAt={fetchedAtRef.current} onReopen={openReopen} />
          )}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}

      {/* Reopen an ended workday. Everything it can honestly undo it undoes; the
          rest it declares — which is why the reason is required and why the copy
          spells out what stays paused and who gets told. */}
      <Modal visible={!!reopenFor} transparent animationType="fade"
        onRequestClose={() => setReopenFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>↩  Reopen workday</Text>
              <TouchableOpacity onPress={() => setReopenFor(null)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalBody}>
              <Text style={s.modalLead}>
                Reopen <Text style={{ fontWeight: '900' }}>{reopenFor?.name}</Text>'s day?
              </Text>
              <Text style={s.modalNote}>
                Their day&apos;s summary has already been sent — everyone who received it
                is told it was reopened, and {reopenFor?.name} is told in your words.
                Any task they had running stays paused until they resume it.
              </Text>
              {reopenErr ? (
                <View style={s.errBox}>
                  <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                  <Text style={s.errTxt2}>{reopenErr}</Text>
                </View>
              ) : null}
              <Text style={s.fieldLabel}>Reason *</Text>
              <TextInput
                style={[s.reasonInput, reopenErr && !reopenReason.trim() && { borderColor: COLORS.red }]}
                placeholder="Why is this day being reopened?"
                placeholderTextColor={COLORS.faint}
                value={reopenReason}
                onChangeText={(t) => { setReopenReason(t); if (reopenErr) setReopenErr(''); }}
                multiline
              />
            </View>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setReopenFor(null)} disabled={reopenBusy}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.footConfirm} onPress={submitReopen} disabled={reopenBusy}>
                {reopenBusy ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={s.footConfirmTxt}>Reopen day</Text>}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: TOP, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '800', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingTop: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  chipVal: { fontSize: 13, fontWeight: '900' },
  chipLbl: { fontSize: 11.5, fontWeight: '700' },
  cutoff: { fontSize: 11.5, color: COLORS.muted, paddingHorizontal: 16, paddingTop: 8, fontStyle: 'italic' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  errTxt: { color: COLORS.red, textAlign: 'center' },
  retry: { marginTop: 12, backgroundColor: COLORS.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '700' },
  empty: { color: COLORS.muted, marginTop: 6 },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10, ...SHADOW },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: '800', color: COLORS.ink },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '800' },

  actRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  // Stacks the per-task pills when someone is multitasking. flexShrink so a long
  // task name wraps inside the card instead of pushing the row off a phone.
  pillWrap: { flexShrink: 1, gap: 5 },
  multiTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted },

  reopenBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    marginTop: 10, paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: 9, borderWidth: 1, borderColor: COLORS.amber, backgroundColor: COLORS.amberBg,
  },
  reopenTxt: { fontSize: 12, fontWeight: '800', color: COLORS.amber },

  // Reopen dialog
  modalWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 460, backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', ...SHADOW },
  modalHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.amberBg, paddingHorizontal: 14, paddingVertical: 12,
  },
  modalTitle: { fontSize: 15.5, fontWeight: '900', color: '#7a5200' },
  modalBody: { paddingHorizontal: 14, paddingVertical: 12 },
  modalLead: { fontSize: 14, color: COLORS.ink, marginBottom: 6 },
  modalNote: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18 },
  fieldLabel: { fontSize: 13, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 6 },
  reasonInput: {
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: COLORS.ink, minHeight: 74,
    textAlignVertical: 'top',
  },
  errBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 12,
    backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8,
  },
  errTxt2: { flex: 1, fontSize: 12.5, color: COLORS.red, fontWeight: '600', lineHeight: 17 },
  modalFoot: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: COLORS.line,
  },
  footCancel: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line },
  footCancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  footConfirm: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 11, backgroundColor: COLORS.amber },
  footConfirmTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
  pill: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 },
  pillTxt: { fontSize: 13, fontWeight: '700' },
});
