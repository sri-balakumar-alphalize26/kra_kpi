// LIVE TRACKING (admin) — "who is doing what right now" + attendance.
// Mobile port of the web kpi_live_tracking screen: per developer, their current
// activity (running task + live elapsed / Break / Lunch / Meeting / No tasks /
// Idle / Not started) and today's attendance (Present · Late came HH:MM · Absent ·
// Yet to start). Polls /kpi_owner/live_tracking every 15s; ticks the elapsed every
// second in between so it feels live. Admin-only (route is gated server-side too).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchLiveTracking } from '../services/liveTracking';
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
function Row({ row, nowMs, fetchedAt }) {
  const kind = row.activity_kind || 'offline';
  const meta = ACT[kind] || ACT.offline;
  // Live elapsed: server value + seconds since we fetched (for ongoing kinds).
  const live = TICKING.has(kind)
    ? (row.elapsed_seconds || 0) + Math.max(0, Math.floor((nowMs - fetchedAt) / 1000))
    : 0;

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
        {/* live dot — green when the heartbeat is fresh (at the desk) */}
        <View style={[s.dot, { backgroundColor: row.active ? '#16A34A' : '#CBD5E1' }]} />
        <View style={[s.pill, { backgroundColor: meta.bg }]}>
          {kind !== 'idle' && kind !== 'offline' ? (
            <MaterialCommunityIcons name={meta.icon} size={14} color={meta.fg} style={{ marginRight: 5 }} />
          ) : null}
          <Text style={[s.pillTxt, { color: meta.fg }]} numberOfLines={1}>{text}</Text>
        </View>
      </View>
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
          renderItem={({ item }) => <Row row={item} nowMs={nowMs} fetchedAt={fetchedAtRef.current} />}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}
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
  pill: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 },
  pillTxt: { fontSize: 13, fontWeight: '700' },
});
