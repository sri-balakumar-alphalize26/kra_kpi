// CLIENT "My Tasks" — a read-only list of the client's own tasks. Data comes from
// /kpi_client_portal/dashboard, which is scoped server-side to the caller's client
// (client_user_ids), so a client sees ONLY their own client's tasks. No actions.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { getClientDashboard } from '../services/clientPortal';
import { createLogger } from '../api/logger';

const log = createLogger('ClientTasks');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const STATE_META = {
  assigned:            { label: 'Assigned',    bg: '#E0ECFF', fg: '#2563EB' },
  urgent:              { label: 'Urgent',      bg: '#FEE2E2', fg: '#DC2626' },
  important:           { label: 'Important',   bg: '#F3E8FF', fg: '#9333EA' },
  regular:             { label: 'Regular',     bg: '#E0ECFF', fg: '#2563EB' },
  in_progress:         { label: 'In Progress', bg: '#FFEDD5', fg: '#EA580C' },
  paused:              { label: 'On Hold',     bg: '#FCE7F3', fg: '#DB2777' },
  partially_completed: { label: 'Verifying',   bg: '#FEF9C3', fg: '#CA8A04' },
  awaiting_client:     { label: 'Awaiting You', bg: '#CFFAFE', fg: '#0891B2' },
  completed:           { label: 'Completed',   bg: '#DCFCE7', fg: '#16A34A' },
};
const KIND_META = {
  requirement: { label: 'REQ', fg: '#2563EB' },
  update:      { label: 'UPT', fg: '#EA580C' },
  bug:         { label: 'BUG', fg: '#DC2626' },
};
const stateChip = (st) => STATE_META[st] || { label: st || '—', bg: '#E2E8F0', fg: '#475569' };

function TaskCard({ t, highlight }) {
  const sc = stateChip(t.task_state);
  const kind = KIND_META[t.kind] || null;
  return (
    <View style={[s.card, highlight && s.cardHi]}>
      <View style={s.cardTop}>
        {kind ? <View style={[s.kindTag, { borderColor: kind.fg }]}><Text style={[s.kindTxt, { color: kind.fg }]}>{kind.label}</Text></View> : null}
        <Text style={s.cardTitle} numberOfLines={2}>{t.name}</Text>
      </View>
      <View style={s.metaRow}>
        <View style={[s.stateChip, { backgroundColor: sc.bg }]}><Text style={[s.stateTxt, { color: sc.fg }]}>{sc.label}</Text></View>
        {t.has_signed_certificate ? (
          <View style={s.certTag}><Ionicons name="ribbon" size={12} color="#16A34A" /><Text style={s.certTxt}>Certificate</Text></View>
        ) : null}
      </View>
      {t.project_name ? <Text style={s.sub} numberOfLines={1}>📁 {t.project_name}</Text> : null}
      <Text style={s.sub} numberOfLines={1}>
        👤 {t.primary_assignee || 'Unassigned'}   ·   ⏱ {t.actual_hours || 0}h / {t.estimate_hours || 0}h
      </Text>
    </View>
  );
}

export default function ClientTasks({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ authorized: true, kpis: [], totals: {}, pending_approvals: [] });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getClientDashboard('all');
      setData(res);
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Failed to load your tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totals = data.totals || {};
  const CHIPS = [
    ['All', totals.all], ['In Progress', totals.in_progress], ['On Hold', totals.paused],
    ['Verifying', totals.partially_completed], ['Completed', totals.completed],
  ];

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title}>My Tasks</Text>
        <TouchableOpacity onPress={() => load()} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /><Text style={s.centerTxt}>Loading…</Text></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={() => load()}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : data.authorized === false ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="account-question-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{data.message || 'Your login is not linked to any client yet. Please contact your admin.'}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 28 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.chipRow}>
            {CHIPS.map(([lbl, n]) => (
              <View key={lbl} style={s.totalChip}>
                <Text style={s.totalNum}>{n || 0}</Text>
                <Text style={s.totalLbl}>{lbl}</Text>
              </View>
            ))}
          </View>

          {(data.pending_approvals || []).length > 0 ? (
            <>
              <Text style={s.sectionTitle}>⚠ Awaiting your sign-off ({data.pending_approvals.length})</Text>
              {data.pending_approvals.map((t) => <TaskCard key={'pa' + t.id} t={t} highlight />)}
            </>
          ) : null}

          <Text style={s.sectionTitle}>All tasks ({(data.kpis || []).length})</Text>
          {(data.kpis || []).length === 0 ? (
            <Text style={s.emptyTxt}>No tasks yet for your client.</Text>
          ) : (data.kpis).map((t) => <TaskCard key={t.id} t={t} />)}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, alignItems: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerTxt: { color: COLORS.muted, marginTop: 10, textAlign: 'center' },
  retry: { marginTop: 14, backgroundColor: COLORS.primary, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '800' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  totalChip: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', minWidth: 64,
    shadowColor: '#0B2A6B', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  totalNum: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  totalLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '600' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginTop: 6, marginBottom: 8 },
  emptyTxt: { color: COLORS.muted, fontStyle: 'italic', paddingVertical: 12 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#EEF2F7' },
  cardHi: { borderColor: '#0891B2', borderWidth: 1.5, backgroundColor: '#F0FDFF' },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  kindTag: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, marginTop: 1 },
  kindTxt: { fontSize: 10, fontWeight: '800' },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  stateChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  stateTxt: { fontSize: 11, fontWeight: '800' },
  certTag: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  certTxt: { fontSize: 11, color: '#16A34A', fontWeight: '700' },
  sub: { fontSize: 12, color: COLORS.muted, marginTop: 5 },
});
