// CLIENT "My Tasks" — the client's own tasks. Data comes from
// /kpi_client_portal/dashboard, which is scoped server-side to the caller's client
// (client_user_ids), so a client sees ONLY their own client's tasks.
//
// The ONE place a client acts: "Approval needed" — when an admin assigns a
// developer to their task, the client approves/rejects that assignment here,
// in-app (no WhatsApp). Silence auto-approves after the configured window
// (Configuration → Timers & Away → Client approval window).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, StatusBar as RNStatusBar, Modal, TextInput,
  Animated, Easing,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { getClientDashboard } from '../services/clientPortal';
import { fetchPreApprovals, decidePreApproval, holdPreApproval, submitClientSignoff } from '../services/preApproval';
import { REJECT_REASONS } from '../services/kpiActions';
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
  // Where a client's reject lands — shown from THEIR side, so "Changes
  // Requested" reads better than the backend's "Rework Required".
  rework:              { label: 'Changes Requested', bg: '#FFEDD5', fg: '#EA580C' },
  awaiting_client:     { label: 'Awaiting You', bg: '#CFFAFE', fg: '#0891B2' },
  completed:           { label: 'Completed',   bg: '#DCFCE7', fg: '#16A34A' },
};
const KIND_META = {
  requirement: { label: 'REQ', fg: '#2563EB' },
  update:      { label: 'UPT', fg: '#EA580C' },
  bug:         { label: 'BUG', fg: '#DC2626' },
};
const stateChip = (st) => STATE_META[st] || { label: st || '—', bg: '#E2E8F0', fg: '#475569' };
const PRIO_LABEL = { urgent: 'Urgent', important: 'Important', regular: 'Regular' };

// Arrival highlight for a task opened from a notification: a wash that beats
// TWICE so the row visibly flashes. Same values as the board's TaskListRow
// (KpiActionBoard.js) so the two screens feel identical.
function useHeartbeat(pulse) {
  const beat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    beat.setValue(0);
    const oneBeat = () => Animated.sequence([
      Animated.timing(beat, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]);
    Animated.sequence([oneBeat(), Animated.delay(160), oneBeat()]).start();
  }, [pulse, beat]);
  return beat.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] });
}

function TaskCard({ t, highlight, onPress, pulse, onLayout }) {
  const sc = stateChip(t.task_state);
  const kind = KIND_META[t.kind] || null;
  const washOpacity = useHeartbeat(pulse);
  return (
    <TouchableOpacity
      onLayout={onLayout}
      style={[s.card, highlight && s.cardHi, pulse && s.cardPulse]}
      onPress={onPress} activeOpacity={0.85}
    >
      <Animated.View pointerEvents="none" style={[s.pulseWash, { opacity: washOpacity }]} />
      <View style={s.cardTop}>
        {kind ? <View style={[s.kindTag, { borderColor: kind.fg }]}><Text style={[s.kindTxt, { color: kind.fg }]}>{kind.label}</Text></View> : null}
        <Text style={s.cardTitle} numberOfLines={2}>{t.name}</Text>
        <Ionicons name="chevron-forward" size={16} color={COLORS.faint} style={{ marginTop: 1 }} />
      </View>
      <View style={s.metaRow}>
        <View style={[s.stateChip, { backgroundColor: sc.bg }]}><Text style={[s.stateTxt, { color: sc.fg }]}>{sc.label}</Text></View>
        {t.has_signed_certificate ? (
          <View style={s.certTag}><Ionicons name="ribbon" size={12} color="#16A34A" /><Text style={s.certTxt}>Certificate</Text></View>
        ) : null}
      </View>
      {t.project_name ? <Text style={s.sub} numberOfLines={1}>📁 {t.project_name}</Text> : null}
      <Text style={s.sub} numberOfLines={1}>
        👤 {t.primary_assignee || 'Unassigned'}
      </Text>
    </TouchableOpacity>
  );
}

const DRow = ({ label, value }) => (
  <View style={s.dRow}>
    <Text style={s.dLabel}>{label}</Text>
    <Text style={s.dValue} numberOfLines={3}>{value}</Text>
  </View>
);

// Parse the server's 'YYYY-MM-DD HH:MM:SS' (UTC) into ms. Built explicitly rather
// than via `new Date(str)` — RN/iOS parses that format inconsistently.
function parseServerTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Live countdown to auto-approval. Anchored to the SERVER clock (server_now) so a
// device with the wrong time still counts down correctly.
//
// Only ever promises an auto-approve when the server says one is really coming
// (`auto_approves`, which mirrors the cron's exact domain). A held task, or a
// non-client task that can never auto-approve, says so instead of counting down
// to something that will never happen.
function Countdown({ deadlineAt, serverNow, autoApproves, held }) {
  const deadline = parseServerTs(deadlineAt);
  const srvNow = parseServerTs(serverNow);
  // Offset between this device's clock and the server's, measured once on mount.
  const skewRef = useRef(deadline && srvNow ? Date.now() - srvNow : 0);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!deadline || !autoApproves) return undefined;
    const tick = () => setLeft(Math.max(0, deadline - (Date.now() - skewRef.current)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, autoApproves]);

  if (held) return <Text style={s.cdHeld}>⏸ Held — won't approve automatically</Text>;
  // No auto-approve coming → never imply one.
  if (!autoApproves || !deadline) return <Text style={s.cdWait}>⚠️ Awaiting your approval</Text>;
  if (left <= 0) return <Text style={s.cdDue}>⏳ Approving automatically…</Text>;
  const total = Math.floor(left / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  // Drop the minutes segment under a minute → "(45s left)", not "(0m 45s left)".
  const rem = m > 0 ? `${m}m ${sec}s left` : `${sec}s left`;
  return <Text style={s.cd}>⏳ Approving automatically ({rem})</Text>;
}

function ApprovalCard({ t, busy, onApprove, onReject, onToggleHold, pulse, onLayout }) {
  const kind = KIND_META[t.kind] || null;
  const washOpacity = useHeartbeat(pulse);
  return (
    <View
      onLayout={onLayout}
      style={[s.card, s.cardApprove, t.held && s.cardHeld, pulse && s.cardPulse]}
    >
      <Animated.View pointerEvents="none" style={[s.pulseWash, { opacity: washOpacity }]} />
      <View style={s.cardTop}>
        {kind ? <View style={[s.kindTag, { borderColor: kind.fg }]}><Text style={[s.kindTxt, { color: kind.fg }]}>{kind.label}</Text></View> : null}
        <Text style={s.cardTitle} numberOfLines={2}>{t.name}</Text>
      </View>
      {t.project_name ? <Text style={s.sub} numberOfLines={1}>📁 {t.project_name}</Text> : null}
      {/* The developer IS the thing being approved — lead with it. */}
      <View style={s.devRow}>
        <Ionicons name="person-circle-outline" size={18} color={COLORS.primary} />
        <Text style={s.devTxt}>Assigned to <Text style={s.devName}>{t.developer || 'Unassigned'}</Text></Text>
      </View>
      <View style={s.cdRow}>
        <Countdown
          deadlineAt={t.deadline_at} serverNow={t.server_now}
          autoApproves={t.auto_approves} held={t.held}
        />
        {/* Stop the clock and decide later; Approve/Reject stay usable either way. */}
        <TouchableOpacity
          style={[s.holdBtn, busy && s.actDisabled]} onPress={() => onToggleHold(t)}
          disabled={busy} activeOpacity={0.85} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name={t.held ? 'play' : 'pause'} size={13} color={COLORS.navy} />
          <Text style={s.holdTxt}>{t.held ? 'Resume' : 'Hold'}</Text>
        </TouchableOpacity>
      </View>
      <View style={s.actRow}>
        <TouchableOpacity
          style={[s.actBtn, s.rejectBtn, busy && s.actDisabled]}
          onPress={() => onReject(t)} disabled={busy} activeOpacity={0.85}
        >
          <Ionicons name="close" size={16} color={COLORS.red} />
          <Text style={s.rejectTxt}>Reject</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actBtn, s.approveBtn, busy && s.actDisabled]}
          onPress={() => onApprove(t)} disabled={busy} activeOpacity={0.85}
        >
          {busy ? <ActivityIndicator size="small" color="#fff" /> : (
            <>
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={s.approveTxt}>Approve</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ClientTasks({ onBack, focusTaskId }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ authorized: true, kpis: [], totals: {}, pending_approvals: [] });
  const [approvals, setApprovals] = useState([]);      // tasks awaiting my sign-off
  const [busyId, setBusyId] = useState(null);          // decision in flight
  const [rejectFor, setRejectFor] = useState(null);    // task being rejected (+ reason)
  const [rejectCode, setRejectCode] = useState('');    // chosen REJECT_REASONS code
  const [rejectNote, setRejectNote] = useState('');    // free text (required for 'other')
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('pending');     // active tab: pending | in_progress | completed
  const [detail, setDetail] = useState(null);          // task tapped → detail popup
  // Stage-2 final sign-off (accepting the FINISHED work → signed certificate).
  const [signFor, setSignFor] = useState(null);        // task being signed off
  const [signName, setSignName] = useState('');        // typed signature
  const [signTicks, setSignTicks] = useState({ delivered: false, works: false, authorized: false });
  const [signBusy, setSignBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Approvals are a separate, non-fatal concern: a client with no pending
      // approvals (or an older server) must still get their task list.
      const [res, appr] = await Promise.all([
        getClientDashboard('all'),
        fetchPreApprovals().catch((e) => {
          log.warn('preApprovals failed', e?.message);
          return { kpis: [] };
        }),
      ]);
      setData(res);
      setApprovals(appr.kpis || []);
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Failed to load your tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Arrival from a notification tap ──────────────────────────────────────
  // The task may sit in EITHER section (an "Approval needed" card or the main
  // list), so every card reports its y-offset and we scroll to whichever holds it.
  //
  // Positions come from onLayout rather than an imperative measureLayout: under
  // the New Architecture (Fabric, the default on SDK 54) measureLayout rejects a
  // findNodeHandle() node handle — it threw "must be called with a ref to a
  // native component", so the scroll silently never ran. KpiActionBoard already
  // records lane offsets this way; same pattern here.
  const scrollRef = useRef(null);
  const rowY = useRef({});                 // task id → y offset inside the content
  const onRowLayout = useCallback(
    (id) => (e) => { rowY.current[id] = e.nativeEvent.layout.y; },
    [],
  );
  const [pulseId, setPulseId] = useState(null);

  useEffect(() => {
    if (!focusTaskId || loading) return undefined;
    // Wait a beat for the row to mount so its layout has been reported.
    const t = setTimeout(() => {
      const y = rowY.current[focusTaskId];
      if (y != null && scrollRef.current) {
        scrollRef.current.scrollTo({ y: Math.max(0, y - 70), animated: true });
      }
      setPulseId(focusTaskId);
      log.info('noti focus', { focusTaskId, found: y != null, y });
    }, 320);
    // Clear so the flash can re-run if the same task is tapped again later.
    const clear = setTimeout(() => setPulseId(null), 3000);
    return () => { clearTimeout(t); clearTimeout(clear); };
  }, [focusTaskId, loading, approvals.length, data.kpis]);

  const flashToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((m) => (m === msg ? '' : m)), 2600);
  }, []);

  // Shared by Approve and Reject. Drops the row optimistically, then reloads so
  // the task reappears in the main list with its new state.
  const decide = useCallback(async (t, action, feedback) => {
    setBusyId(t.id);
    try {
      const res = await decidePreApproval(t.id, action, feedback);
      setApprovals((prev) => prev.filter((x) => x.id !== t.id));
      // `late` = the window closed first, so the server had already auto-approved.
      flashToast(res?.late
        ? 'That task had already auto-approved.'
        : (action === 'approve' ? 'Approved — the developer can start.' : 'Rejected — sent back to the team.'));
      load();
    } catch (e) {
      log.error('decide failed', e?.message);
      flashToast(e.message || 'Could not save your decision');
    } finally {
      setBusyId(null);
    }
  }, [flashToast, load]);

  // Hold/Resume isn't a decision — the card stays, only the clock changes, so
  // patch the row in place rather than dropping it.
  const onToggleHold = useCallback(async (t) => {
    setBusyId(t.id);
    try {
      const res = await holdPreApproval(t.id, !t.held);
      setApprovals((prev) => prev.map((x) => (x.id === t.id ? {
        ...x,
        held: !!res.held,
        auto_approves: !!res.auto_approves,
        deadline_at: res.deadline_at || '',
        server_now: res.server_now || x.server_now,
      } : x)));
      flashToast(res.held
        ? 'Held — it won\'t approve automatically.'
        : 'Resumed — the countdown restarted.');
    } catch (e) {
      log.error('hold failed', e?.message);
      flashToast(e.message || 'Could not update the hold');
    } finally {
      setBusyId(null);
    }
  }, [flashToast]);

  const onApprove = useCallback((t) => decide(t, 'approve'), [decide]);
  const onReject = useCallback((t) => { setRejectNote(''); setRejectCode(''); setRejectFor(t); }, []);
  // The reason sent to the server is the preset's label, or the typed text for
  // 'other'. It lands in pre_approval_feedback and is what the admin acts on.
  const rejectReasonText = useCallback(() => {
    if (rejectCode === 'other') return rejectNote.trim();
    const r = REJECT_REASONS.find((x) => x.code === rejectCode);
    return r ? r.label : '';
  }, [rejectCode, rejectNote]);

  const canReject = !!rejectReasonText();

  const confirmReject = useCallback(() => {
    const t = rejectFor;
    const reason = rejectReasonText();
    if (!t || !reason) return;      // mirrored server-side; never send a blank reason
    setRejectFor(null);
    decide(t, 'reject', reason);
  }, [rejectFor, rejectReasonText, decide]);

  // ── Stage-2 final sign-off ───────────────────────────────────────────────
  const openSignoff = useCallback((t) => {
    setSignName('');
    setSignTicks({ delivered: false, works: false, authorized: false });
    setSignFor(t);
  }, []);
  const toggleTick = (k) => setSignTicks((p) => ({ ...p, [k]: !p[k] }));
  // The server rejects the call unless all three are ticked AND a signature is
  // present, so gate the button on exactly the same rule (no failed round-trip).
  const signReady = signTicks.delivered && signTicks.works && signTicks.authorized
    && signName.trim().length > 0;

  const confirmSignoff = useCallback(async () => {
    const t = signFor;
    if (!t || !signReady || signBusy) return;
    setSignBusy(true);
    try {
      await submitClientSignoff(t.id, { signatureText: signName });
      setSignFor(null);
      flashToast('Signed off — thank you! The task is complete.');
      load();
    } catch (e) {
      log.error('signoff failed', e?.message);
      flashToast(e.message || 'Could not submit your sign-off');
    } finally {
      setSignBusy(false);
    }
  }, [signFor, signReady, signBusy, signName, flashToast, load]);

  // Tappable status filters. Counts are derived from the SAME list the chips
  // filter, so "In Progress 3" always means exactly the 3 rows you get on tap —
  // server totals could disagree with the rows actually returned.
  const kpis = data.kpis || [];
  // WhatsApp-style 3 tabs. Each tab is a bucket of task_states:
  //   Pending      = raised / queued / waiting for approval, not started
  //   In Progress  = being worked, on hold, verifying, or awaiting your sign-off
  //   Completed    = done
  const TAB_BUCKETS = {
    pending: ['assigned', 'urgent', 'important', 'regular', 'queue_waiting',
      'pre_approval_pending', 'pre_approval_approved', 'pre_approval_partial'],
    in_progress: ['in_progress', 'paused', 'hold', 'rework', 'partially_completed', 'awaiting_client'],
    completed: ['completed'],
  };
  const TABS = [
    { key: 'pending', label: 'Pending' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed', label: 'Completed' },
  ].map((t) => ({ ...t, n: kpis.filter((k) => TAB_BUCKETS[t.key].includes(k.task_state)).length }));
  const bucket = TAB_BUCKETS[filter] || TAB_BUCKETS.pending;
  const visible = kpis.filter((t) => bucket.includes(t.task_state));
  const activeLabel = (TABS.find((t) => t.key === filter) || TABS[0]).label;

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title}>Requests</Text>
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
          ref={scrollRef}
          contentContainerStyle={{ padding: 14, paddingBottom: 28 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          showsVerticalScrollIndicator={false}
        >
          {/* Three tabs — Pending · In Progress · Completed. Tap to switch. */}
          <View style={s.tabRow}>
            {TABS.map((t) => {
              const on = filter === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  style={[s.tab, on && s.tabOn]}
                  onPress={() => setFilter(t.key)}
                  activeOpacity={0.85}
                >
                  <Text style={[s.tabTxt, on && s.tabTxtOn]}>{t.label}</Text>
                  <View style={[s.tabBadge, on && s.tabBadgeOn]}>
                    <Text style={[s.tabBadgeTxt, on && s.tabBadgeTxtOn]}>{t.n}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Stage 1 — approve the developer the admin assigned. The only place
              a client acts; auto-approves if they don't. */}
          {approvals.length > 0 ? (
            <>
              <Text style={s.sectionTitle}>✋ Approval needed ({approvals.length})</Text>
              {approvals.map((t) => (
                <ApprovalCard
                  key={'ap' + t.id} t={t} busy={busyId === t.id}
                  onApprove={onApprove} onReject={onReject} onToggleHold={onToggleHold}
                  pulse={pulseId === t.id} onLayout={onRowLayout(t.id)}
                />
              ))}
            </>
          ) : null}

          {(data.pending_approvals || []).length > 0 ? (
            <>
              <Text style={s.sectionTitle}>⚠ Awaiting your sign-off ({data.pending_approvals.length})</Text>
              {data.pending_approvals.map((t) => (
                // onLayout goes on the WRAPPER, not the card: layout.y is relative
                // to the parent, so measuring the inner card here would report ~0
                // and scroll to the top of the page instead of to this row.
                <View key={'pa' + t.id} onLayout={onRowLayout(t.id)}>
                  <TaskCard t={t} highlight onPress={() => setDetail(t)} />
                  {/* The work is finished and checked — this is where the client
                      accepts it and the completion certificate is generated. */}
                  <TouchableOpacity style={s.signBtn} onPress={() => openSignoff(t)} activeOpacity={0.85}>
                    <Ionicons name="create-outline" size={16} color="#fff" />
                    <Text style={s.signBtnTxt}>Sign off</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          ) : null}

          <Text style={s.sectionTitle}>
            {filter === 'all' ? `All tasks (${visible.length})` : `${activeLabel} (${visible.length})`}
          </Text>
          {visible.length === 0 ? (
            <Text style={s.emptyTxt}>
              {filter === 'all'
                ? 'No tasks yet for your client.'
                : `Nothing is “${activeLabel}” right now.`}
            </Text>
          ) : visible.map((t) => (
            <TaskCard
              key={t.id} t={t} onPress={() => setDetail(t)}
              pulse={pulseId === t.id} onLayout={onRowLayout(t.id)}
            />
          ))}
        </ScrollView>
      )}

      {/* Reject — asks for a reason so the team knows what to change. */}
      <Modal visible={!!rejectFor} transparent animationType="fade" onRequestClose={() => setRejectFor(null)}>
        <View style={s.mWrap}>
          <View style={s.mCard}>
            <View style={s.mIcon}><Ionicons name="close-circle" size={30} color={COLORS.red} /></View>
            <Text style={s.mTitle}>Reject this assignment?</Text>
            <Text style={s.mMsg} numberOfLines={2}>{rejectFor?.name}</Text>

            {/* One tap = the reason. Only 'Other' needs typing. */}
            <Text style={s.mLabel}>Why?</Text>
            <View style={s.reasonWrap}>
              {REJECT_REASONS.map((r) => {
                const on = rejectCode === r.code;
                return (
                  <TouchableOpacity
                    key={r.code} style={[s.reason, on && s.reasonOn]}
                    onPress={() => setRejectCode(r.code)} activeOpacity={0.85}
                  >
                    <Text style={[s.reasonTxt, on && s.reasonTxtOn]}>{r.emoji} {r.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {rejectCode === 'other' ? (
              <TextInput
                style={s.mInput} placeholder="Tell us what to change (required)"
                placeholderTextColor={COLORS.faint}
                value={rejectNote} onChangeText={setRejectNote} multiline autoFocus
              />
            ) : null}

            <View style={s.mBtns}>
              <TouchableOpacity style={[s.mBtn, s.mCancel]} onPress={() => setRejectFor(null)} activeOpacity={0.85}>
                <Text style={s.mCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.mBtn, s.mDo, !canReject && s.actDisabled]}
                onPress={confirmReject} disabled={!canReject} activeOpacity={0.85}
              >
                <Text style={s.mDoTxt}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Task details — tap any card. Read-only; surfaces the fields the card
          has no room for (ref, priority, deadline, version, certificate). */}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}>
        <View style={s.mWrap}>
          <View style={s.dCard}>
            <View style={s.dHead}>
              <Ionicons name="document-text-outline" size={19} color="#fff" />
              <Text style={s.dHeadTitle}>Task details</Text>
              <TouchableOpacity onPress={() => setDetail(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              <View style={s.dPad}>
                <Text style={s.dName}>{detail?.name}</Text>
                <View style={s.dTagRow}>
                  {detail?.external_ref ? (
                    <View style={s.dRefBadge}><Text style={s.dRefTxt}>{detail.external_ref}</Text></View>
                  ) : null}
                  {detail ? (
                    <View style={[s.stateChip, { backgroundColor: stateChip(detail.task_state).bg }]}>
                      <Text style={[s.stateTxt, { color: stateChip(detail.task_state).fg }]}>
                        {stateChip(detail.task_state).label}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <DRow label="Project" value={detail?.project_name || detail?.client_name || '—'} />
                <DRow label="Assigned to" value={detail?.primary_assignee || 'Not assigned yet'} />
                <DRow label="Priority" value={PRIO_LABEL[detail?.priority] || '—'} />
                {detail?.deadline ? <DRow label="Deadline" value={detail.deadline} /> : null}
                {detail?.related_req_ref ? <DRow label="Linked to" value={detail.related_req_ref} /> : null}
                {detail?.delivery_version ? <DRow label="Version" value={detail.delivery_version} /> : null}
                {detail?.completion_date ? <DRow label="Completed on" value={detail.completion_date} /> : null}

                {detail?.has_signed_certificate ? (
                  <View style={s.dCert}>
                    <Ionicons name="ribbon" size={15} color="#16A34A" />
                    <Text style={s.dCertTxt}>Signed completion certificate available</Text>
                  </View>
                ) : null}
              </View>
            </ScrollView>
            <View style={s.dFoot}>
              <TouchableOpacity style={s.dCloseBtn} onPress={() => setDetail(null)} activeOpacity={0.9}>
                <Text style={s.dCloseTxt}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Final sign-off — accepting the finished work. Ticking all three + a
          typed name is exactly what /kpi_client_approval/approve requires. */}
      <Modal visible={!!signFor} transparent animationType="fade" onRequestClose={() => setSignFor(null)}>
        <View style={s.mWrap}>
          <View style={s.signCard}>
            <View style={s.signHead}>
              <Ionicons name="ribbon" size={20} color="#fff" />
              <Text style={s.signHeadTxt}>Sign off this task</Text>
              <TouchableOpacity onPress={() => setSignFor(null)} disabled={signBusy} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              <View style={s.signPad}>
                <Text style={s.signTask} numberOfLines={3}>{signFor?.name}</Text>
                <Text style={s.signLead}>Please confirm:</Text>
                {[
                  ['delivered', 'The work was delivered to me'],
                  ['works', 'I have checked it and it works'],
                  ['authorized', "I'm authorized to approve this"],
                ].map(([key, label]) => (
                  <TouchableOpacity key={key} style={s.tickRow} onPress={() => toggleTick(key)} activeOpacity={0.7}>
                    <Ionicons
                      name={signTicks[key] ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={signTicks[key] ? COLORS.green : COLORS.faint}
                    />
                    <Text style={s.tickTxt}>{label}</Text>
                  </TouchableOpacity>
                ))}
                <Text style={[s.signLead, { marginTop: 14 }]}>Type your name to sign</Text>
                <TextInput
                  style={s.signInput}
                  placeholder="Your full name"
                  placeholderTextColor={COLORS.faint}
                  value={signName}
                  onChangeText={setSignName}
                  autoCapitalize="words"
                />
                <Text style={s.signNote}>
                  This records your digital approval and generates the completion certificate.
                </Text>
              </View>
            </ScrollView>
            <View style={s.mBtns}>
              <TouchableOpacity style={[s.mBtn, s.mCancel]} onPress={() => setSignFor(null)} disabled={signBusy} activeOpacity={0.85}>
                <Text style={s.mCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.mBtn, s.signDo, !signReady && s.signDoOff]}
                onPress={confirmSignoff}
                disabled={!signReady || signBusy}
                activeOpacity={0.85}
              >
                {signBusy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.mDoTxt}>Sign &amp; Approve</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {toast ? <View style={s.toast}><Text style={s.toastTxt}>{toast}</Text></View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  // White square chip behind the back / refresh arrows so they read over the
  // gradient (matches the Upload + Generate Client Files headers).
  iconBtn: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center', ...SHADOW,
  },
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
  totalChipOn: { backgroundColor: COLORS.primary },
  chipOnTxt: { color: '#fff' },
  totalNum: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  totalLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '600' },
  // 3-tab switcher (Pending / In Progress / Completed)
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: 12, paddingVertical: 10,
    shadowColor: '#0B2A6B', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  tabOn: { backgroundColor: COLORS.primary },
  tabTxt: { fontSize: 13, fontWeight: '800', color: COLORS.navy },
  tabTxtOn: { color: '#fff' },
  tabBadge: { minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: '#EEF3F8', alignItems: 'center', justifyContent: 'center' },
  tabBadgeOn: { backgroundColor: 'rgba(255,255,255,0.25)' },
  tabBadgeTxt: { fontSize: 11, fontWeight: '900', color: COLORS.muted },
  tabBadgeTxtOn: { color: '#fff' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginTop: 6, marginBottom: 8 },
  emptyTxt: { color: COLORS.muted, fontStyle: 'italic', paddingVertical: 12 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: '#EEF2F7' },
  cardHi: { borderColor: '#0891B2', borderWidth: 1.5, backgroundColor: '#F0FDFF' },
  // Arrival-from-notification flash (2 beats). `overflow: hidden` keeps the wash
  // inside the card's rounded corners.
  cardPulse: { borderColor: COLORS.primary, borderWidth: 1.5, overflow: 'hidden' },
  pulseWash: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#DBEAFE', borderRadius: 12,
  },
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

  // ── Approval needed ──────────────────────────────────────────────────────
  cardApprove: { borderColor: COLORS.primary, borderWidth: 1.5, backgroundColor: '#F7FAFF' },
  devRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  devTxt: { fontSize: 13, color: COLORS.ink },
  devName: { fontWeight: '900', color: COLORS.navy },
  cdRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 },
  cd: { flex: 1, fontSize: 12, color: '#CA8A04', fontWeight: '700' },
  cdDue: { flex: 1, fontSize: 12, color: COLORS.muted, fontWeight: '700', fontStyle: 'italic' },
  cdWait: { flex: 1, fontSize: 12, color: '#0891B2', fontWeight: '700' },
  cdHeld: { flex: 1, fontSize: 12, color: COLORS.navy, fontWeight: '700' },
  cardHeld: { borderColor: '#94A3B8', backgroundColor: '#F8FAFC' },
  holdBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10,
    paddingVertical: 5, borderRadius: 8, backgroundColor: '#EEF2F8',
  },
  holdTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.navy },
  mLabel: { alignSelf: 'flex-start', fontSize: 12, fontWeight: '800', color: COLORS.navy, marginTop: 14 },
  reasonWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, width: '100%' },
  reason: {
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#fff',
  },
  reasonOn: { borderColor: COLORS.red, backgroundColor: COLORS.redBg || '#FEE2E2' },
  reasonTxt: { fontSize: 12, fontWeight: '700', color: COLORS.muted },
  reasonTxtOn: { color: COLORS.red },
  actRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, height: 42, borderRadius: 11,
  },
  actDisabled: { opacity: 0.6 },
  approveBtn: { backgroundColor: COLORS.green || '#16A34A' },
  approveTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  rejectBtn: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.red },
  rejectTxt: { color: COLORS.red, fontWeight: '800', fontSize: 14 },

  // ── Reject popup ─────────────────────────────────────────────────────────
  mWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  mCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, alignItems: 'center', padding: 22 },
  mIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: COLORS.redBg || '#FEE2E2', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  mTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  mMsg: { fontSize: 13, color: COLORS.muted, textAlign: 'center', marginTop: 6 },
  mInput: {
    width: '100%', minHeight: 74, borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12,
    padding: 10, marginTop: 14, color: COLORS.ink, textAlignVertical: 'top',
  },
  mBtns: { flexDirection: 'row', gap: 12, marginTop: 16, width: '100%' },
  mBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 14 },
  mCancel: { backgroundColor: '#EEF2F8' },
  mCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  mDo: { backgroundColor: COLORS.red },
  mDoTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // ── Task detail popup ────────────────────────────────────────────────────
  dCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  dHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.primary, paddingHorizontal: 16, paddingVertical: 13 },
  dHeadTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  dPad: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  dName: { fontSize: 15.5, fontWeight: '900', color: COLORS.navy, lineHeight: 21 },
  dTagRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 4, flexWrap: 'wrap' },
  dRefBadge: { backgroundColor: '#E0ECFF', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 },
  dRefTxt: { fontSize: 12, fontWeight: '900', color: '#2563EB', letterSpacing: 0.5 },
  dRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  dLabel: { fontSize: 13, color: COLORS.muted, fontWeight: '700' },
  dValue: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '700', textAlign: 'right' },
  dCert: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#DCFCE7', borderRadius: 10, padding: 10, marginTop: 12 },
  dCertTxt: { flex: 1, fontSize: 12.5, color: '#166534', fontWeight: '700' },
  dFoot: { paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line },
  dCloseBtn: { height: 46, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  dCloseTxt: { color: '#fff', fontWeight: '900', fontSize: 15 },

  // ── Final sign-off ───────────────────────────────────────────────────────
  signBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: COLORS.green, borderRadius: 11, height: 44,
    marginTop: -4, marginBottom: 12,
  },
  signBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 14.5 },
  signCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  signHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.green, paddingHorizontal: 16, paddingVertical: 13 },
  signHeadTxt: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  signPad: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  signTask: { fontSize: 15, fontWeight: '900', color: COLORS.navy, marginBottom: 12 },
  signLead: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginBottom: 6 },
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  tickTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  signInput: {
    borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, paddingHorizontal: 12,
    height: 48, fontSize: 15, color: COLORS.ink, backgroundColor: '#F8FAFF',
  },
  signNote: { fontSize: 12, color: COLORS.muted, marginTop: 10, lineHeight: 17 },
  signDo: { backgroundColor: COLORS.green },
  signDoOff: { backgroundColor: '#9DBBA6' },

  toast: {
    position: 'absolute', left: 20, right: 20, bottom: 28, backgroundColor: COLORS.navy,
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, ...SHADOW,
  },
  toastTxt: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
});
