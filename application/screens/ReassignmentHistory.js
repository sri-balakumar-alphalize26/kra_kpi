// REASSIGNMENT HISTORY (admin-only) — a read-only list of every KPI task
// reassignment, newest first. Mirrors the web "KPI Reassignment History" view.
// Data comes from /kra_kpi/reassignment_history/all, which is admin-guarded
// server-side (Coordinator / Owner / System). Tap a row for the full details
// (reason + pause info) in a popup.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, Modal, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { getReassignmentHistory } from '../services/reassignmentHistory';
import { createLogger } from '../api/logger';

const log = createLogger('ReassignHistory');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Previous-state labels + pastel chip colors (mirrors the model's Selection).
const STATE_META = {
  assigned:              { label: 'Assigned',              bg: '#E0ECFF', fg: '#2563EB' },
  urgent:                { label: 'Urgent',                bg: '#FEE2E2', fg: '#DC2626' },
  important:             { label: 'Important',             bg: '#F3E8FF', fg: '#9333EA' },
  regular:               { label: 'Regular',               bg: '#E0ECFF', fg: '#2563EB' },
  queue_waiting:         { label: 'Queued',                bg: '#E2E8F0', fg: '#475569' },
  pre_approval_pending:  { label: 'Pre-Approval Pending',  bg: '#FEF9C3', fg: '#CA8A04' },
  pre_approval_approved: { label: 'Pre-Approval Approved', bg: '#DCFCE7', fg: '#16A34A' },
  pre_approval_partial:  { label: 'Partially Approved',    bg: '#FEF9C3', fg: '#CA8A04' },
  in_progress:           { label: 'In Progress',           bg: '#FFEDD5', fg: '#EA580C' },
  paused:                { label: 'Paused',                bg: '#FCE7F3', fg: '#DB2777' },
  hold:                  { label: 'On Hold',               bg: '#FCE7F3', fg: '#DB2777' },
  rework:                { label: 'Rework Required',       bg: '#FEE2E2', fg: '#DC2626' },
  partially_completed:   { label: 'Verification Pending',  bg: '#FEF9C3', fg: '#CA8A04' },
  awaiting_client:       { label: 'Awaiting Client',       bg: '#CFFAFE', fg: '#0891B2' },
  completed:             { label: 'Completed',             bg: '#DCFCE7', fg: '#16A34A' },
};
const stateChip = (st) => STATE_META[st] || { label: st || '—', bg: '#E2E8F0', fg: '#475569' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// reassignment_date arrives pre-converted to the user's TZ as "YYYY-MM-DD HH:MM:SS".
function fmtDateTime(str) {
  if (!str) return '—';
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return String(str);
  const [, y, mo, d, hh, mm] = m;
  let h = parseInt(hh, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${parseInt(d, 10)} ${MONTHS[parseInt(mo, 10) - 1]} ${y}, ${h}:${mm} ${ampm}`;
}

function Avatar({ name, tint }) {
  const initials = (name || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return <View style={[s.avatar, { backgroundColor: tint }]}><Text style={s.avatarTxt}>{initials || '?'}</Text></View>;
}

function RowCard({ r, onPress }) {
  const sc = stateChip(r.previous_state);
  return (
    <TouchableOpacity style={s.card} activeOpacity={0.85} onPress={onPress}>
      <View style={s.cardTop}>
        <View style={s.dateWrap}>
          <Ionicons name="calendar-outline" size={13} color={COLORS.muted} />
          <Text style={s.dateTxt}>{fmtDateTime(r.reassignment_date)}</Text>
        </View>
        <View style={s.timeChip}>
          <Ionicons name="time-outline" size={12} color="#0F5132" />
          <Text style={s.timeTxt}>{r.time_spent || '0h 00m 00s'}</Text>
        </View>
      </View>

      <Text style={s.taskTxt} numberOfLines={2}>{r.kpi_task || r.kpi_name || 'Task'}</Text>

      {/* Previous → New assignee */}
      <View style={s.moveRow}>
        <Avatar name={r.previous_assignee} tint="#FEE2E2" />
        <Text style={s.moveName} numberOfLines={1}>{r.previous_assignee || '—'}</Text>
        <View style={s.arrowBox}>
          <Ionicons name="arrow-forward" size={14} color={COLORS.primary} />
        </View>
        <Avatar name={r.new_assignee} tint="#DCFCE7" />
        <Text style={s.moveName} numberOfLines={1}>{r.new_assignee || '—'}</Text>
      </View>

      <View style={s.metaRow}>
        <View style={[s.stateChip, { backgroundColor: sc.bg }]}><Text style={[s.stateTxt, { color: sc.fg }]}>{sc.label}</Text></View>
        <Text style={s.byTxt} numberOfLines={1}>by {r.reassigned_by || '—'}</Text>
        {r.was_paused ? <View style={s.pausedTag}><Ionicons name="pause" size={11} color="#DB2777" /><Text style={s.pausedTxt}>Paused</Text></View> : null}
        <Ionicons name="chevron-forward" size={16} color={COLORS.faint} />
      </View>
    </TouchableOpacity>
  );
}

export default function ReassignmentHistory({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [authorized, setAuthorized] = useState(true);
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null); // a row → detail popup

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getReassignmentHistory(300);
      setAuthorized(res.authorized !== false);
      setRows(res.history || []);
      log.info('loaded', { count: (res.history || []).length, authorized: res.authorized });
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Failed to load reassignment history');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dc = detail ? stateChip(detail.previous_state) : null;

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title}>Reassignment History</Text>
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
      ) : !authorized ? (
        <View style={s.center}>
          <View style={s.lockWrap}><Ionicons name="lock-closed" size={40} color={COLORS.amber} /></View>
          <Text style={s.lockTitle}>Admins only</Text>
          <Text style={s.centerTxt}>Reassignment history is visible to Admin, Owner and Manager accounts.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 28 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.countTxt}>{rows.length} reassignment{rows.length === 1 ? '' : 's'}</Text>
          {rows.length === 0 ? (
            <View style={s.center}>
              <MaterialCommunityIcons name="swap-horizontal" size={44} color={COLORS.faint} />
              <Text style={s.centerTxt}>No task reassignments yet.</Text>
            </View>
          ) : rows.map((r) => <RowCard key={r.id} r={r} onPress={() => setDetail(r)} />)}
        </ScrollView>
      )}

      {/* Detail popup */}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <MaterialCommunityIcons name="swap-horizontal" size={20} color="#fff" />
              <Text style={s.modalTitle}>Reassignment</Text>
              <TouchableOpacity onPress={() => setDetail(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              <View style={s.modalPad}>
                <Text style={s.dTask} numberOfLines={3}>{detail?.kpi_task || detail?.kpi_name || 'Task'}</Text>
                {detail?.kpi_task && detail?.kpi_name && detail.kpi_task !== detail.kpi_name
                  ? <Text style={s.dTaskSub} numberOfLines={2}>{detail.kpi_name}</Text> : null}

                <View style={s.dMove}>
                  <View style={s.dMoveCol}>
                    <Text style={s.dMoveLbl}>From</Text>
                    <Text style={s.dMoveName}>{detail?.previous_assignee || '—'}</Text>
                  </View>
                  <View style={s.arrowBox}>
                    <Ionicons name="arrow-forward" size={16} color={COLORS.primary} />
                  </View>
                  <View style={s.dMoveCol}>
                    <Text style={s.dMoveLbl}>To</Text>
                    <Text style={[s.dMoveName, { color: COLORS.green }]}>{detail?.new_assignee || '—'}</Text>
                  </View>
                </View>

                <DRow label="Date" value={fmtDateTime(detail?.reassignment_date)} />
                <DRow label="Reassigned by" value={detail?.reassigned_by || '—'} />
                <View style={s.dRow}>
                  <Text style={s.dLabel}>Previous state</Text>
                  {dc ? <View style={[s.stateChip, { backgroundColor: dc.bg }]}><Text style={[s.stateTxt, { color: dc.fg }]}>{dc.label}</Text></View> : <Text style={s.dValue}>—</Text>}
                </View>
                <DRow label="Time spent" value={detail?.time_spent || '0h 00m 00s'} />

                {detail?.reason ? (
                  <View style={s.dBlock}>
                    <Text style={s.dLabel}>Reason</Text>
                    <Text style={s.dReason}>{detail.reason}</Text>
                  </View>
                ) : null}
                {detail?.was_paused && detail?.pause_reason ? (
                  <View style={[s.dBlock, s.dPauseBlock]}>
                    <Text style={[s.dLabel, { color: '#DB2777' }]}>Pause reason</Text>
                    <Text style={s.dReason}>{detail.pause_reason}</Text>
                  </View>
                ) : null}
              </View>
            </ScrollView>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footBtn} onPress={() => setDetail(null)}><Text style={s.footBtnTxt}>Close</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const DRow = ({ label, value }) => (
  <View style={s.dRow}>
    <Text style={s.dLabel}>{label}</Text>
    <Text style={s.dValue} numberOfLines={2}>{value}</Text>
  </View>
);

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  // White square chip behind the back / refresh arrows so they read over the
  // gradient (matches the Generate Client Files header).
  iconBtn: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center', ...SHADOW,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerTxt: { color: COLORS.muted, marginTop: 10, textAlign: 'center' },
  retry: { marginTop: 14, backgroundColor: COLORS.primary, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '800' },
  lockWrap: { width: 84, height: 84, borderRadius: 24, backgroundColor: COLORS.amberBg, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  lockTitle: { fontSize: 20, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },
  countTxt: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginBottom: 10, marginLeft: 2 },

  card: { backgroundColor: '#fff', borderRadius: 12, padding: 13, marginBottom: 10, borderWidth: 1, borderColor: '#EEF2F7' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  dateWrap: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  dateTxt: { fontSize: 12, color: COLORS.muted, fontWeight: '600' },
  timeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DCFCE7', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  timeTxt: { fontSize: 11.5, fontWeight: '800', color: '#0F5132' },
  taskTxt: { fontSize: 14.5, fontWeight: '800', color: COLORS.ink, marginBottom: 9 },

  // Tinted strip so the white arrow chip below actually reads (the card is white).
  moveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 9,
    backgroundColor: '#F7F9FC', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 7,
  },
  avatar: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 10.5, fontWeight: '900', color: '#334155' },
  moveName: { fontSize: 13, fontWeight: '700', color: COLORS.ink, flexShrink: 1, maxWidth: '32%' },
  // White square chip behind the prev → new arrow. Bordered + raised so it reads
  // as a distinct white chip on the tinted strip / "From / To" block.
  arrowBox: {
    width: 28, height: 28, borderRadius: 8, backgroundColor: '#fff',
    borderWidth: 1, borderColor: '#DCE4F2', alignItems: 'center', justifyContent: 'center',
    ...SHADOW,
  },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  stateTxt: { fontSize: 11, fontWeight: '800' },
  byTxt: { flex: 1, fontSize: 12, color: COLORS.muted, fontWeight: '600' },
  pausedTag: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  pausedTxt: { fontSize: 11, color: '#DB2777', fontWeight: '700' },

  // Detail popup
  modalWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.primary, paddingHorizontal: 16, paddingVertical: 13 },
  modalTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  modalPad: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  dTask: { fontSize: 15.5, fontWeight: '900', color: COLORS.navy },
  dTaskSub: { fontSize: 12.5, color: COLORS.muted, marginTop: 2 },
  dMove: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: '#F7F9FC', borderRadius: 12, padding: 12, marginTop: 12, marginBottom: 6 },
  dMoveCol: { flex: 1 },
  dMoveLbl: { fontSize: 11, color: COLORS.faint, fontWeight: '700', marginBottom: 2 },
  dMoveName: { fontSize: 14.5, fontWeight: '800', color: COLORS.ink },
  dRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  dLabel: { fontSize: 13, color: COLORS.muted, fontWeight: '700' },
  dValue: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '700', textAlign: 'right' },
  dBlock: { marginTop: 12 },
  dPauseBlock: { backgroundColor: '#FDF2F8', borderRadius: 10, padding: 11 },
  dReason: { fontSize: 13.5, color: COLORS.ink, lineHeight: 19, marginTop: 5 },
  modalFoot: { paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line },
  footBtn: { height: 46, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  footBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 15 },
});
