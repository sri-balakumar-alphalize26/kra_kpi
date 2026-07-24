// KPI Action Board — the module's task kanban, mirroring the web layout:
// horizontally-scrolling colored lane columns (Pending Review, Regular,
// Important, Urgent, In Progress, Paused, …), each with a count badge and its
// cards stacked vertically. Each card exposes the state-appropriate actions
// (Start / Resume / Complete / Pause / Reassign).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Dimensions,
  ActivityIndicator, Alert, Modal, StatusBar as RNStatusBar, Animated, Easing,
  Platform, UIManager, LayoutAnimation, findNodeHandle,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import KpiTaskDetail from './KpiTaskDetail';
import {
  LANES, groupIntoLanes, laneForTask, fetchTasks, fetchTaskById, fetchUsers,
  startTask, pauseTask, resumeTask, completeTask, reassignTask, createProgress,
  approveTask, rejectTask, getTaskChecklists,
  CHECKLIST_ITEMS, MGR_CHECKLIST_ITEMS, PAUSE_REASONS, PRIORITIES,
  getWorkdayStatus, startWorkday, endWorkday, selfCreateTask, fetchProjects, fetchClientTree, getTodaySummary, getLiveStatus,
  acceptSelfCreated, rejectSelfCreated,
  IDLE_REASONS, setIdleReason, endNonTask, IDLE_NOTE_MAX,
} from '../services/kpiActions';
import { createLogger } from '../api/logger';
import { scheduleTaskReminder, cancelTaskReminder } from '../services/reminders';
import { scheduleTaskAlarm, stopAlarm, alarmAvailable, pickAlarmSound, titleFromUri } from '../services/alarm';
import { getReminders, setReminder, removeReminder, getReminderPresets, setReminderPresets, getAlarmSound, setAlarmSound, getAlarmSettings, setAlarmSettings } from '../api/session';
import DurationTimePicker from '../components/DurationTimePicker';
import { workdayButtonState } from '../utils/workdayState';

const log = createLogger('ActionBoard');

// Default "quick timer" presets (MINUTES) offered in the reminder picker. The user
// can add/remove their own (persisted per device via api/session); these seed the
// list the first time. Capped at MAX_PRESETS chips.
const DEFAULT_PRESET_MINS = [15, 30, 60, 90, 120];
const MAX_PRESETS = 8;

// Pretty label for a preset given in minutes: 15→"15 min", 60→"1 hr", 90→"1 hr 30 min".
function fmtPresetLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}
// States where a task is still being worked (same set the action buttons key off).
// A reminder is auto-cancelled once its task moves OUT of these (completed / review).
const WORKABLE_STATES = ['assigned', 'urgent', 'important', 'regular', 'queue_waiting',
  'pre_approval_approved', 'pre_approval_partial', 'in_progress', 'paused', 'hold', 'rework'];

// Styles for the reminder picker sheet (kept isolated from the board's big `s`).
const rStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 18, padding: 18, ...SHADOW },
  title: { fontSize: 16, fontWeight: '900', color: COLORS.navy },
  taskName: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginTop: 3, marginBottom: 12 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  modeBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff' },
  modeBtnActive: { borderColor: COLORS.primary, backgroundColor: '#E0ECFF' },
  modeTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.muted },
  modeTxtActive: { color: COLORS.primary },
  modeHint: { fontSize: 11.5, color: COLORS.faint, marginBottom: 12, marginTop: 4 },
  soundRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 12, backgroundColor: '#F7FAFF', marginBottom: 12 },
  soundLabel: { flex: 1, fontSize: 13.5, fontWeight: '700', color: COLORS.muted },
  soundValue: { color: COLORS.primary, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  chipTxt: { fontSize: 13, fontWeight: '800', color: COLORS.primary },
  chipEst: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  // "+" chip that opens the quick-timer manager.
  chipAdd: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, borderWidth: 1.5, borderStyle: 'dashed', borderColor: COLORS.primary, backgroundColor: '#EAF2FF' },
  chipAddTxt: { fontSize: 13, fontWeight: '900', color: COLORS.primary },
  // Quick-timer manager popup.
  mgrHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mgrList: { marginTop: 8, marginBottom: 4 },
  mgrRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  mgrLabel: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  mgrDel: { width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center' },
  mgrAddRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  mgrAddBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  mgrAddBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '800', lineHeight: 26 },
  mgrHint: { fontSize: 12, color: COLORS.faint, marginTop: 12 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  customInput: { flex: 1, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 44, paddingHorizontal: 12, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff' },
  reasonInput: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff', marginTop: 4 },
  reasonHint: { fontSize: 12, color: COLORS.muted, marginTop: 5, marginLeft: 2 },
  setBtn: { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 18, height: 44, alignItems: 'center', justifyContent: 'center' },
  setBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  clearTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.red },
  cancelTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.muted },
});

// Last-known workday-open state, cached across board remounts so re-entering the
// board shows the correct Start/End label instantly (no 2–3s "Start Workday"
// flash while getWorkdayStatus() resolves). null = not resolved yet this session.
let WORKDAY_CACHE = null;
// Last-known "day done" (developer ended their own workday today → no restart
// until tomorrow). Cached the same way so re-entry shows "Workday ended for
// today" instantly instead of flashing a tappable Start button.
let DAYDONE_CACHE = false;

// Smooth layout transitions for the accordion expand/collapse (needs enabling on
// Android). animateNext() is called right before the toggle state changes.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animateNext = () => LayoutAnimation.configureNext(
  LayoutAnimation.create(200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
);

const TOP = (RNStatusBar.currentHeight || 0) + 12;
const POLL_MS = 20000;   // silent live refresh interval
// "Not now" on the "Not on a task?" popup buys this long before it asks again.
// Long enough to find and tap a task's Start button; short enough that it can't be
// used to duck the question for the rest of the day.
const IDLE_SNOOZE_MS = 60000;
const TICK_MS = 1000;    // live-timer tick for in-progress cards
const { height: SH } = Dimensions.get('window');
const LANE_MAX_H = Math.round(SH * 0.78); // lane card-scroll height, adapts to screen

// Live elapsed seconds: base accrued time + (now − start) while running.
function liveSeconds(task, nowMs) {
  const base = task.timer_total_seconds || 0;
  if (task.task_state === 'in_progress' && task.timer_start_datetime) {
    const started = Date.parse(task.timer_start_datetime); // ISO "…Z" (UTC)
    if (!Number.isNaN(started)) return base + Math.max(0, (nowMs - started) / 1000);
  }
  return base;
}

// Seconds elapsed since an ISO anchor (UTC "…Z"), for live counters.
function secsSince(isoZ, nowMs) {
  if (!isoZ) return 0;
  const t = Date.parse(isoZ);
  return Number.isNaN(t) ? 0 : Math.max(0, (nowMs - t) / 1000);
}
// Running task time = accrued base + live since timer_start.
function liveFromAnchor(startIso, base, nowMs) {
  return (base || 0) + secsSince(startIso, nowMs);
}
// Productive = finished-log base + the currently-running task's live seconds.
function productiveLive(live, nowMs) {
  const base = live?.productive_base || 0;
  const at = live?.active_task;
  if (at && at.timer_start) return base + secsSince(at.timer_start, nowMs);
  return base;
}

const PRIORITY = {
  urgent:    { label: 'Urgent',    bg: COLORS.redBg,   fg: COLORS.red },
  important: { label: 'Important', bg: '#EDE9FE',      fg: '#7C3AED' },
  regular:   { label: 'Regular',   bg: '#E0ECFF',      fg: COLORS.primary },
};

// Format seconds as "Hh Mm Ss" like the web card's Time line.
function fmtHMS(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}h ${m}m ${r}s`;
}

// A task's estimate in seconds (0 when unset) — used to offer an "at estimate" reminder.
function estimateSecs(task) {
  return ((task.estimate_hours || 0) * 3600) + ((task.estimate_minutes || 0) * 60);
}

// Short clock label ("3:05 PM") for the reminder pill on a card.
function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

// Initials for the assignee avatar chip.
function initials(name) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

// Small icon + label + value row (the card's meta lines).
function MetaRow({ icon, lib = 'ion', label, value, valueColor, trailing }) {
  const IconCmp = lib === 'mc' ? MaterialCommunityIcons : Ionicons;
  return (
    <View style={s.metaRow}>
      <IconCmp name={icon} size={15} color={COLORS.faint} style={{ width: 18 }} />
      <Text style={s.metaLabel}>{label}</Text>
      <Text style={[s.metaValue, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
      {trailing}
    </View>
  );
}

// Meta rows (Assignee / Time / Estimate + paused reason) and the state-appropriate
// action buttons. Shared by TaskCard (kanban) and TaskListRow (accordion list) so
// both views behave identically — same button set, same runAction wiring, same
// busy spinner. Reassign stays gated behind isAdmin, so role behavior is preserved.
function TaskDetailBody({ task, onAction, busyId, nowMs, isAdmin, reminder, readOnly = false }) {
  const st = task.task_state;
  const running = st === 'in_progress';
  const busy = busyId === task.id;
  const canStart = ['assigned', 'urgent', 'important', 'regular', 'queue_waiting',
    'pre_approval_approved', 'pre_approval_partial'].includes(st);
  const canResume = ['paused', 'hold', 'rework'].includes(st);
  const canComplete = ['in_progress', 'paused', 'hold', 'rework'].includes(st);
  const canPause = st === 'in_progress';
  // Exactly the "Pending Review" lane rule (laneForTask in services/kpiActions.js)
  // and the same condition the server enforces on accept/reject_self_created.
  // Independent of task_state: the dev may already be working it.
  const awaitingReview = !!task.is_self_created && !task.admin_accepted;
  return (
    <>
      {/* Meta */}
      <View style={s.metaBlock}>
        {task.time_by_user && task.time_by_user.length ? (
          task.time_by_user.map((tu) => (
            <View key={tu.user_id} style={s.metaRow}>
              <View style={s.avatar}><Text style={s.avatarTxt}>{initials(tu.user_name)}</Text></View>
              <Text style={[s.metaValue, { flex: 1 }]} numberOfLines={1}>
                {tu.user_name}{tu.is_current ? ' (currently working)' : ''}
              </Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tu.is_current ? COLORS.green : COLORS.muted, marginLeft: 8 }}>{tu.display}</Text>
            </View>
          ))
        ) : (
          <View style={s.metaRow}>
            <View style={s.avatar}><Text style={s.avatarTxt}>{initials(task.user_name)}</Text></View>
            <Text style={s.metaLabel}>Assignee</Text>
            <Text style={s.metaValue} numberOfLines={1}>{task.user_name || 'Unassigned'}</Text>
          </View>
        )}
        <MetaRow icon="time-outline" label="Time" value={fmtHMS(liveSeconds(task, nowMs))}
          valueColor={running ? COLORS.green : undefined} />
        <MetaRow icon="flag-outline" label="Estimate" value={task.estimate_display || '00:00'} />
      </View>
      {task.paused_reason && ['paused', 'hold', 'rework'].includes(st) ? (
        <View style={s.pausedPill}>
          <Ionicons name="pause-circle" size={14} color={COLORS.amber} />
          <Text style={s.pausedPillTxt} numberOfLines={2}>Paused: {task.paused_reason}</Text>
        </View>
      ) : null}

      {/* Actions. Hidden entirely while the workday hasn't started: every one of
          these changes a task, which is exactly what read-only withholds. The
          whole row goes (not just the buttons) so there's no dead gap, and the
          banner above already explains why. Card + list both render this
          component, so they stay in step automatically. */}
      {!readOnly && (
        <View style={s.btnRow}>
          {busy ? (
            <View style={s.btnBusy}><ActivityIndicator color={COLORS.primary} /></View>
          ) : (
            <>
              {/* Pending Review — a developer created this task themselves and it
                  stays OUT of the official flow until an admin decides. Only the
                  admin sees these, and only while it's still awaiting acceptance. */}
              {isAdmin && awaitingReview && (
                <Btn label="Accept" icon="checkmark-done" kind="green" onPress={() => onAction('acceptSelf', task)} />
              )}
              {isAdmin && awaitingReview && (
                <Btn label="Reject" icon="close-circle" kind="ghostRed" onPress={() => onAction('rejectSelf', task)} />
              )}
              {canStart && <Btn label="Start" icon="play" kind="primary" onPress={() => onAction('start', task)} />}
              {canResume && <Btn label="Resume" icon="play" kind="green" onPress={() => onAction('resume', task)} />}
              {canPause && <Btn label="Pause" icon="pause" kind="amber" onPress={() => onAction('pause', task)} />}
              {canComplete && <Btn label="Complete" icon="checkmark-circle" kind="red" onPress={() => onAction('complete', task)} />}
              {canComplete && <Btn label="Partial Finish" icon="flag-outline" kind="ghostRed" onPress={() => onAction('partial', task)} />}
              {/* Developer finished it → admin reviews: Approve (with QA checklist) sends it
                  to the client; Reject sends it back to the same developer with a reason. */}
              {isAdmin && st === 'partially_completed' && (
                <Btn label="Approve" icon="checkmark-done" kind="green" onPress={() => onAction('approveDone', task)} />
              )}
              {isAdmin && st === 'partially_completed' && (
                <Btn label="Reject" icon="close-circle" kind="ghostRed" onPress={() => onAction('rejectDone', task)} />
              )}
              {isAdmin && <Btn label="Reassign" icon="swap-horizontal" kind="ghost" onPress={() => onAction('reassign', task)} />}
              {/* Developer-only per-task alarm: set a local "wrap up" reminder so
                  you don't keep re-checking elapsed vs. estimate. */}
              {!isAdmin ? (() => {
                // Show the target time only while the reminder is still in the
                // FUTURE; once it fires (time passed) the button resets to "Remind me".
                const active = reminder && Date.parse(reminder.whenIso) > (nowMs || Date.now());
                // A snoozed alarm reads "Snoozed <time>" (with a 😴) so it's clear
                // the alarm was pushed back, not freshly set. Snooze only exists on
                // the alarm path, so this never shows for a plain 🔔 reminder.
                const snoozed = active && reminder.snoozed && reminder.mode === 'alarm';
                const icon = reminder?.mode === 'alarm' ? '⏰' : '🔔';
                return (
                  <Btn
                    label={active
                      ? (snoozed ? `😴 Snoozed ${fmtClock(reminder.whenIso)}` : `${icon} ${fmtClock(reminder.whenIso)}`)
                      : 'Remind me'}
                    icon={active ? 'notifications' : 'notifications-outline'}
                    kind={active ? 'amber' : 'ghost'}
                    onPress={() => onAction('reminder', task)}
                  />
                );
              })() : null}
            </>
          )}
        </View>
      )}
    </>
  );
}

// One row of the list view: an "Odoo attendance"-style accordion — task name +
// priority dot + chevron; tapping expands to reveal the shared TaskDetailBody.
// Mirrors the chevron-forward/down conditional-render pattern used by KraNode /
// OwnerDashboard's ClientCard.
function TaskListRow({ task, expanded, onToggle, onAction, busyId, nowMs, isAdmin, reminder, pulse, onRowRef, onOpenDetail, readOnly = false }) {
  const p = PRIORITY[task.priority] || PRIORITY.regular;
  const running = task.task_state === 'in_progress';
  // Rotate the chevron 0°→90° as the row expands/collapses.
  const rot = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(rot, { toValue: expanded ? 1 : 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [expanded, rot]);
  const spin = rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });

  // Arrival highlight (from a notification tap): a brief highlight wash that
  // beats TWICE, so the task the notification pointed to visibly flashes.
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
  const washOpacity = beat.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] });

  return (
    <Animated.View
      ref={(r) => { onRowRef && onRowRef(task.id, r); }}
      style={[s.listRow, expanded && s.listRowOpen, pulse && s.listRowPulse]}
    >
      {/* Highlight wash — fades in/out with the double heartbeat. */}
      <Animated.View pointerEvents="none" style={[s.listPulseWash, { opacity: washOpacity }]} />
      {/* The WHOLE row toggles the dropdown; the NAME is a nested touchable that
          opens KPI Details instead. Nesting (rather than two siblings sized by
          flex) is what makes "name → details, anywhere else → dropdown" reliable:
          the inner touchable swallows taps on the text, everything else — the
          spacer, the Live pill, the chevron — falls through to the outer one. */}
      <TouchableOpacity style={s.listHead} onPress={onToggle} activeOpacity={0.7}>
        <View style={[s.listDot, { backgroundColor: p.fg }]} />
        <TouchableOpacity style={s.listNameHit} activeOpacity={0.6} disabled={!onOpenDetail}
          onPress={() => onOpenDetail && onOpenDetail(task)}>
          <Text style={[s.listName, !!onOpenDetail && s.listNameLink]} numberOfLines={1}>{task.name}</Text>
        </TouchableOpacity>
        {/* Belongs to the OUTER touchable, so the empty middle of the row opens
            the dropdown rather than the details. */}
        <View style={s.listSpacer} />
        {running && (
          <View style={s.livePill}>
            <View style={s.liveDot} />
            <Text style={s.liveTxt}>Live</Text>
          </View>
        )}
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
        </Animated.View>
      </TouchableOpacity>
      {expanded && (
        <View style={s.listBody}>
          <View style={[s.pill, s.listPill, { backgroundColor: p.bg }]}>
            <View style={[s.pillDot, { backgroundColor: p.fg }]} />
            <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
          </View>
          <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} reminder={reminder} readOnly={readOnly} />
        </View>
      )}
    </Animated.View>
  );
}

function TaskCard({ task, onAction, busyId, nowMs, isAdmin, reminder, pulse, onMeasure, onOpenDetail, readOnly = false }) {
  const p = PRIORITY[task.priority] || PRIORITY.regular;
  const running = task.task_state === 'in_progress';

  // One-shot highlight + heartbeat when this card is the notification target.
  // `beat` drives BOTH the scale (heartbeat) and a highlight-overlay opacity.
  // Both are native-driver-safe (transform scale + opacity); we never animate
  // borderColor/backgroundColor directly.
  const beat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    beat.setValue(0);
    // One heartbeat = a big thump + a small thump (rise-fall-rise-fall).
    const oneBeat = () => Animated.sequence([
      Animated.timing(beat, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0.35, duration: 160, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0.85, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0.2, duration: 200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]);
    // Run the heartbeat twice (short gap between), then hold and release.
    Animated.sequence([
      oneBeat(),
      Animated.delay(240),
      oneBeat(),
      Animated.timing(beat, { toValue: 0.5, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.delay(450),
      Animated.timing(beat, { toValue: 0, duration: 450, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [pulse, beat]);

  // scale: 1 → ~1.06 at the beat peak.
  const scale = beat.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  // highlight wash opacity — kept light so the contrasting tint + ring pop the
  // card without hiding its (dark) text/buttons.
  const washOpacity = beat.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] });

  return (
    <Animated.View
      style={{ transform: [{ scale }] }}
      onLayout={onMeasure ? (e) => onMeasure(e.nativeEvent.layout.y) : undefined}
    >
    <View style={s.card}>
      {/* Notification-focus highlight — a contrasting wash + ring that fades in
          with the heartbeat, then out. Sits above the card bg, below content. */}
      <Animated.View
        pointerEvents="none"
        style={[s.focusWash, { opacity: washOpacity }]}
      />
      {/* Colored priority accent bar */}
      <View style={[s.accent, { backgroundColor: p.fg }]} />

      <View style={s.cardBody}>
        {/* Title + priority pill. The title opens KPI Details — matching the web
            board, where the task name is what you tap. In the list view the name
            is already the accordion toggle, so there it's an ⓘ button instead. */}
        <TouchableOpacity style={s.cardTop} onPress={() => onOpenDetail && onOpenDetail(task)}
          activeOpacity={0.6} disabled={!onOpenDetail}>
          <Text style={[s.cardTitle, !!onOpenDetail && s.cardTitleLink]} numberOfLines={2}>{task.name}</Text>
          {onOpenDetail && <Ionicons name="information-circle-outline" size={16} color={COLORS.primary} style={{ marginLeft: 6, marginTop: 2 }} />}
        </TouchableOpacity>
        <View style={s.chipRow}>
          <View style={[s.pill, { backgroundColor: p.bg }]}>
            <View style={[s.pillDot, { backgroundColor: p.fg }]} />
            <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
          </View>
          {running && (
            <View style={s.livePill}>
              <View style={s.liveDot} />
              <Text style={s.liveTxt}>Live</Text>
            </View>
          )}
        </View>

        {/* Meta + actions (shared with the list view) */}
        <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} reminder={reminder} readOnly={readOnly} />
      </View>
    </View>
    </Animated.View>
  );
}

// A lane column that fades + slides up on mount, staggered by its index so the
// columns cascade in left-to-right when the board first renders. Plays once.
// Keeps the lane's onLayout (used to record its x-offset for scroll-to-focus).
function AnimatedLane({ index, style, onLayout, children }) {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 380,
      delay: index * 80,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter, index]);
  const animStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) }],
  };
  return (
    <Animated.View style={[style, animStyle]} onLayout={onLayout}>
      {children}
    </Animated.View>
  );
}

function Btn({ label, icon, kind, onPress }) {
  return (
    <TouchableOpacity style={[s.btn, s[`btn_${kind}`]]} onPress={onPress} activeOpacity={0.85}>
      <Ionicons name={icon} size={14} color={s[`btnTxt_${kind}`].color} />
      <Text style={[s.btnTxt, s[`btnTxt_${kind}`]]}>{label}</Text>
    </TouchableOpacity>
  );
}

// One node of the End Workday "Workday Map" (start → task → break → … → end).
// The server already sends a ready-to-render `timeline`; each task chip shows its
// outcome + the last note/reason underneath (mirrors the web popup).
function WorkdayMapChip({ node: n }) {
  const icon = n.icon || '';
  const label = n.label || '';
  let border = '#94A3B8';
  let note = '';
  let timeLine = n.time || '';
  if (n.kind === 'break') {
    // Mirrors AWAY_COLORS in the web board's kpi_action.js — keep them in step.
    // no_tasks is teal, not red: having nothing assigned is not the developer's
    // fault and must not be coloured like a warning.
    const bc = { break: '#F59E0B', lunch: '#10B981', meeting: '#3B82F6', away: '#6B7280', leave: '#8B5CF6', urgent: '#EF4444', no_tasks: '#0891B2', other: '#F59E0B' };
    border = bc[n.break_type] || '#F59E0B';
    if (n.duration_display) timeLine = `${n.time || ''}${n.time ? ' · ' : ''}${n.duration_display}`;
    // The typed note + a live marker. This branch used to drop n.reason entirely,
    // so a note saved against a meeting/break was stored and then never shown —
    // while the saved PNG printed it, leaving the image and the popup disagreeing
    // about the same day.
    const bparts = [];
    if (n.running) bparts.push('▶ In progress');
    if (n.reason) bparts.push(n.reason);
    note = bparts.join(' — ');
  } else if (n.kind === 'task') {
    const oc = { completed: '#16A34A', submitted: '#0D9488', paused: '#F59E0B', active: '#3B82F6', worked: '#64748B', moved: '#F97316' };
    border = oc[n.outcome] || '#3B82F6';
    const ocLabel = { completed: '✓ Completed', submitted: '◑ Verification pending', paused: '⏸ Paused', active: '▶ In progress', worked: '', moved: '↪ Moved' }[n.outcome] || '';
    const parts = [];
    if (ocLabel) parts.push(ocLabel);
    if (n.reason) parts.push(n.reason);
    note = parts.join(' — ');
  }
  return (
    <View style={[s.mapChip, { borderColor: border, borderTopColor: border }]}>
      <Text style={s.mapChipLabel} numberOfLines={2}>{icon} {label}</Text>
      {timeLine ? <Text style={s.mapChipTime}>{timeLine}</Text> : null}
      {note ? <Text style={s.mapChipNote} numberOfLines={2}>({note})</Text> : null}
    </View>
  );
}

// A dropdown filter pill (Assignee / Priority / Status).
function FilterDropdown({ label, open, onToggle, options, selected, getKey, getLabel, onPick }) {
  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity style={[s.filter, open && s.filterOn]} onPress={onToggle} activeOpacity={0.8}>
        <Text style={s.filterTxt} numberOfLines={1}>{label}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={15} color={COLORS.muted} />
      </TouchableOpacity>
      {open && (
        <View style={s.filterList}>
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {options.map((o) => {
              const on = getKey(o) === selected;
              return (
                <TouchableOpacity key={String(getKey(o))} style={[s.filterItem, on && s.filterItemOn]} onPress={() => onPick(o)}>
                  <Text style={[s.filterItemTxt, on && { color: COLORS.primary, fontWeight: '800' }]}>{getLabel(o)}</Text>
                  {on && <Ionicons name="checkmark" size={16} color={COLORS.primary} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

export default function KpiActionBoard({
  onBack, focusTaskId, onFocusHandled, focusStatus,
  // workdayLocked: a developer whose workday hasn't started (device unpaired).
  // The board stays fully BROWSABLE — lanes, filters, search, details — but every
  // task ACTION is hidden, because starting work requires pairing at the computer.
  // onNeedPair: send them to the PIN screen (the only thing that opens a workday).
  // onWorkdayEnded: End Workday un-pairs server-side → flip to read-only at once.
  workdayLocked = false, onNeedPair, onWorkdayEnded,
}) {
  const [raw, setRaw] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [myOnly, setMyOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [nowMs, setNowMs] = useState(() => 0); // live-timer clock; set on mount

  // ── Notification focus: scroll-to + heartbeat a specific task's card ──────
  const [pulseId, setPulseId] = useState(null);   // task id currently pulsing
  const boardRef = useRef(null);                   // horizontal lanes ScrollView
  const laneRefs = useRef({});                     // laneKey → vertical ScrollView ref
  const laneX = useRef({});                        // laneKey → x offset in the board
  const cardY = useRef({});                        // taskId → y offset within its lane
  const listScrollRef = useRef(null);              // list-view vertical ScrollView
  const listRowRefs = useRef({});                  // taskId → TaskListRow node (for scroll-to)
  const handledFocusRef = useRef(null);            // last focusTaskId acted on (idempotency vs polls)
  const fetchedFocusRef = useRef(null);            // last focusTaskId we tried to fetch-by-id (avoid loops)

  // Reassign modal
  const [reassignFor, setReassignFor] = useState(null);
  const [users, setUsers] = useState([]);
  const [reassignReason, setReassignReason] = useState('');
  const [reassignUser, setReassignUser] = useState(null);
  const [reassignTried, setReassignTried] = useState(false); // show inline required-field errors only after a submit attempt

  // Pause modal
  const [pauseFor, setPauseFor] = useState(null);
  const [pauseCode, setPauseCode] = useState('break');
  const [pauseNote, setPauseNote] = useState('');
  const [pauseDropdown, setPauseDropdown] = useState(false);

  // Finish (Complete / Partial) modal
  const [finishFor, setFinishFor] = useState(null);
  const [finishPartial, setFinishPartial] = useState(false);
  const [finishSummary, setFinishSummary] = useState('');
  const [checklist, setChecklist] = useState({});

  // "You haven't started your workday" — asked on every board entry while locked,
  // so it's a prompt, not a trap: Cancel keeps them browsing read-only.
  const [startPrompt, setStartPrompt] = useState(false);
  // "Day done" = developer ended their own workday today → one start + one end
  // per day, no restart until tomorrow. Cached across remounts like workdayOpen.
  // Declared here (before startPrompt's effect) because that effect reads it.
  const [dayDone, setDayDoneState] = useState(DAYDONE_CACHE);
  const setDayDone = (v) => { DAYDONE_CACHE = !!v; setDayDoneState(!!v); };
  // Don't nag "you haven't started your workday" when they actually ENDED it
  // today — that would invite a restart the one-per-day rule forbids.
  useEffect(() => { if (workdayLocked && !dayDone) setStartPrompt(true); }, [workdayLocked, dayDone]);
  // Read-only = locked. (The popup is just the explanation; dismissing it doesn't
  // grant anything — otherwise Cancel would look like it unlocked the board.)
  const readOnly = workdayLocked;

  // Pending Review — admin accepts (with a type) or sends back (with a note) a
  // task a developer created themselves.
  const [acceptFor, setAcceptFor] = useState(null);
  const [acceptType, setAcceptType] = useState('requirement');
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  // Admin review of a developer-completed task: Approve (with QA checklist) → client; Reject → same dev.
  const [approveFor, setApproveFor] = useState(null);
  const [mgrChecklist, setMgrChecklist] = useState({});
  const [empChecklist, setEmpChecklist] = useState(null);   // dev's submitted checklist (read-only)
  const [rejectDoneFor, setRejectDoneFor] = useState(null);
  const [rejectDoneNote, setRejectDoneNote] = useState('');

  // Filters
  const [filterAssignee, setFilterAssignee] = useState(null); // user id or null
  const [filterPriority, setFilterPriority] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);     // lane key or null
  const [openFilter, setOpenFilter] = useState(null);         // 'assignee'|'priority'|'status'|null

  // Page-entrance animation (fade + slide up) on mount.
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const enterStyle = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] };

  // View mode: 'list' = vertical accordion (default), 'board' = horizontal kanban.
  // Available to every role. Two-level accordion in list mode:
  //   expandedLanes = which status headings are open (default: all collapsed —
  //                   only the Regular/Paused/… headings show until tapped).
  //   expandedId    = the single open task row inside an open heading (null = none).
  const [viewMode, setViewMode] = useState('list');
  // When opened focused on a status (from a Home stat card), that lane's heading
  // starts expanded so its tasks show immediately.
  const [expandedLanes, setExpandedLanes] = useState(() => (focusStatus ? new Set([focusStatus]) : new Set()));
  const [expandedId, setExpandedId] = useState(null);

  // KPI Details — a full screen that REPLACES the board, exactly as the web pane
  // replaces its list. Its own component owns the loading/writes; the board just
  // says which task and takes it back on Back.
  const [detailTask, setDetailTask] = useState(null);
  const openDetail = useCallback((task) => setDetailTask(task), []);

  // Cross-fade the body when switching board ⇄ list (also fades in on first mount).
  const bodyFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    bodyFade.setValue(0);
    Animated.timing(bodyFade, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [viewMode, bodyFade]);
  const bodyStyle = { flex: 1, opacity: bodyFade };

  // Workday
  // Seed from the cache so re-entry shows the right label immediately; null until
  // the first getWorkdayStatus() of the session resolves (button shows a spinner).
  const [workdayOpen, setWorkdayOpenState] = useState(WORKDAY_CACHE);
  const setWorkdayOpen = (v) => { WORKDAY_CACHE = v; setWorkdayOpenState(v); };
  const [workdayBusy, setWorkdayBusy] = useState(false);
  const [endSummary, setEndSummary] = useState(null); // payload for the End Workday popup
  const [endNote, setEndNote] = useState('');
  const [endBusy, setEndBusy] = useState(false);
  const [live, setLive] = useState(null); // live_status payload for the activity strip

  // "Not on a task?" — Meeting / Break / No tasks.
  const [idlePopup, setIdlePopup] = useState(false);
  const [idleBusy, setIdleBusy] = useState(null);   // the reason code being sent
  const [idleNote, setIdleNote] = useState('');     // optional, shows on the Map
  const [nontaskBusy, setNontaskBusy] = useState(false);
  // Switching ENDS the running block and starts another — a real edit to the day's
  // record, and a mis-tap would cut a meeting short. Confirm it first.
  const [switchTo, setSwitchTo] = useState(null);   // an IDLE_REASONS entry, or null
  // The server asks via a notification that carries no kpi_id, so it can't be
  // tapped through to anywhere. Raise the popup here instead — but only ONCE per
  // prompt, or a 15s poll would re-open it every 15s and trap them. Holds the
  // prompt NUMBER already shown, so dismissing #1 still lets #2 and #3 through.
  const idleAskedRef = useRef(0);
  // "Not now" buys a short grace, then it asks again. The popup covers the board,
  // so it MUST stay closable — otherwise reaching a task's Start button, the very
  // thing that answers the question, would be impossible. A timestamp, not a
  // boolean: the escape has to expire or it's just a loophole.
  const idleSnoozeRef = useRef(0);

  // Styled error popup ("Can't start this task", etc.)
  const [errorPopup, setErrorPopup] = useState(null); // { title, message } | null
  const showError = (title, message) => setErrorPopup({ title, message });

  // Per-task reminder alarms (developer-only). Map { [taskId]: {notifId, whenIso} }
  // loaded from AsyncStorage; reminderFor = the task whose picker is open.
  const [reminders, setReminders] = useState({});
  const [reminderFor, setReminderFor] = useState(null);
  const [reminderCustom, setReminderCustom] = useState('');
  // Optional note the user types — shown on the alarm/notification when it fires.
  const [reminderReason, setReminderReason] = useState('');
  // Which kind of reminder the picker will set: 'notify' = a single sound
  // notification (expo-notifications); 'alarm' = a full-screen ringing alarm that
  // loops until Stop (notifee, Android). Seeded from the task's existing reminder.
  const [reminderMode, setReminderMode] = useState('notify');
  // User-editable quick-timer presets (minutes), shared by BOTH Notify and Alarm.
  // presetMgrOpen = the manager popup (opened by the + chip); newPresetMins = its input.
  const [presetMins, setPresetMins] = useState(DEFAULT_PRESET_MINS);
  const [presetMgrOpen, setPresetMgrOpen] = useState(false);
  const [newPresetMins, setNewPresetMins] = useState('');
  // Chosen system alarm sound { uri, title } (null = device default). Applies to
  // alarm mode only; shared globally (one setting, like the presets).
  const [alarmSound, setAlarmSoundState] = useState(null);
  // Global alarm behaviour { ringMins, snoozeMins }, and the open wheel-picker
  // request { field, mode, initial, title } (null = closed).
  const [alarmSettings, setAlarmSettingsState] = useState({ ringMins: 5, snoozeMins: 5 });
  const [durPicker, setDurPicker] = useState(null);
  useEffect(() => {
    getReminders().then((m) => { setReminders(m || {}); log.info('reminders restored', { count: Object.keys(m || {}).length }); }).catch(() => {});
    // null = never customised (keep defaults); an array (even empty) = the user's
    // saved list, honoured as-is so deletions stick across relaunches.
    getReminderPresets().then((arr) => { if (Array.isArray(arr)) { setPresetMins(arr); log.info('reminder presets restored', { count: arr.length }); } }).catch(() => {});
    getAlarmSound().then((snd) => {
      if (snd) {
        // Always re-derive the name from the URI so old/generic saves self-heal.
        const fixed = { ...snd, title: titleFromUri(snd.uri) || snd.title };
        setAlarmSoundState(fixed);
        log.info('alarm sound restored', { title: fixed.title, uri: fixed.uri });
      }
    }).catch(() => {});
    getAlarmSettings().then((s) => { setAlarmSettingsState(s); log.info('alarm settings restored', s); }).catch(() => {});
  }, []);

  // Open the phone's ringtone picker and save the chosen system alarm sound.
  const chooseAlarmSound = async () => {
    log.info('alarm sound: open picker', { current: alarmSound?.uri || 'default' });
    const snd = await pickAlarmSound(alarmSound);
    if (!snd) { log.info('alarm sound: unchanged'); return; }
    setAlarmSoundState(snd);
    await setAlarmSound(snd);
    log.info('alarm sound: saved', { title: snd.title, uri: snd.uri });
  };

  // Wheel-picker confirm → route the value: ring/snooze settings, or a wall-clock
  // time turned into "remind me in N seconds".
  const onDurConfirm = async (result) => {
    const dp = durPicker;
    setDurPicker(null);
    if (!dp) return;
    if (dp.field === 'ring') {
      const ringMins = Math.max(0, result.minutes);
      setAlarmSettingsState((s) => ({ ...s, ringMins }));
      await setAlarmSettings({ ringMins });
      log.info('alarm setting: saved', { field: 'ringMins', value: ringMins });
    } else if (dp.field === 'snooze') {
      const snoozeMins = Math.max(1, result.minutes);
      setAlarmSettingsState((s) => ({ ...s, snoozeMins }));
      await setAlarmSettings({ snoozeMins });
      log.info('alarm setting: saved', { field: 'snoozeMins', value: snoozeMins });
    } else if (dp.field === 'customTime') {
      const t = new Date(); t.setHours(result.hour24, result.minute, 0, 0);
      if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);   // already passed → tomorrow
      const secs = Math.max(1, Math.round((t.getTime() - Date.now()) / 1000));
      log.info('custom time picked', { hour24: result.hour24, minute: result.minute, secs });
      applyReminder(dp.task, secs);
    }
  };

  // Cancel whichever kind a stored reminder is — an alarm loops in the OS (notifee)
  // and must be stopped via stopAlarm; a notify reminder is a scheduled expo notif.
  const cancelReminderEntry = async (rem) => {
    if (!rem?.notifId) return;
    log.info('reminder: cancel entry', { notifId: rem.notifId, mode: rem.mode || 'notify' });
    if (rem.mode === 'alarm') await stopAlarm(rem.notifId);
    else await cancelTaskReminder(rem.notifId);
  };

  const applyReminder = async (task, secs) => {
    if (!task) return;
    // Alarm needs notifee's native module (post-rebuild). If it's not there yet,
    // fall back to the plain notification so the reminder still gets set.
    const wantAlarm = reminderMode === 'alarm' && Platform.OS === 'android' && alarmAvailable();
    log.info('reminder: apply', { id: task.id, mins: Math.round((secs / 60) * 10) / 10, mode: wantAlarm ? 'alarm' : 'notify', alarmAvail: alarmAvailable() });
    const prev = reminders[String(task.id)];
    await cancelReminderEntry(prev);
    const reason = (reminderReason || '').trim();
    let r = null;
    if (wantAlarm) {
      // Alarm: schedule an exact full-screen ringing notification via notifee.
      const whenMs = Date.now() + Math.max(1, Math.round(secs)) * 1000;
      const notifId = await scheduleTaskAlarm(task, whenMs, reason);
      if (notifId) r = { notifId, whenIso: new Date(whenMs).toISOString(), mode: 'alarm', reason };
    } else {
      // Notify: a single scheduled notification (also the iOS fallback for alarm).
      const res = await scheduleTaskReminder(task, secs, reason);
      if (res) r = { ...res, mode: 'notify', reason };
    }
    setReminderFor(null); setReminderCustom(''); setReminderReason('');
    if (!r) {
      log.warn('reminder: not set (permission/schedule failed)', { id: task.id });
      showError('Reminder', 'Could not set the reminder — check notification permission in settings.');
      return;
    }
    await setReminder(task.id, r);
    setReminders((m) => ({ ...m, [String(task.id)]: r }));
    log.info('reminder: set', { id: task.id, whenIso: r.whenIso, mode: r.mode });
  };
  const clearReminderFor = async (task) => {
    if (!task) return;
    log.info('reminder: clear', { id: task.id });
    const prev = reminders[String(task.id)];
    await cancelReminderEntry(prev);
    await removeReminder(task.id);
    setReminders((m) => { const n = { ...m }; delete n[String(task.id)]; return n; });
    setReminderFor(null);
  };

  // Quick-timer preset management (shared by Notify + Alarm). Keeps the list
  // positive, deduped, sorted ascending, and capped at MAX_PRESETS; persists it.
  const savePresets = (arr) => {
    const clean = Array.from(new Set(arr.filter((n) => Number.isFinite(n) && n > 0)))
      .sort((a, b) => a - b).slice(0, MAX_PRESETS);
    setPresetMins(clean);
    setReminderPresets(clean);
    return clean;
  };
  const addPreset = () => {
    const m = parseInt(newPresetMins, 10);
    if (!m || m <= 0 || presetMins.length >= MAX_PRESETS) return;
    savePresets([...presetMins, m]);
    setNewPresetMins('');
    log.info('reminder: preset added', { mins: m });
  };
  const removePreset = (m) => {
    savePresets(presetMins.filter((x) => x !== m));
    log.info('reminder: preset removed', { mins: m });
  };
  // Once a reminded task leaves the workable set (completed / sent for review),
  // cancel its reminder so it never pings about a finished task.
  useEffect(() => {
    if (!raw || !raw.length) return;
    (async () => {
      let next = null;
      for (const t of raw) {
        const key = String(t.id);
        const rem = reminders[key];
        if (!rem) continue;
        const expired = Date.parse(rem.whenIso) < Date.now();     // already fired
        const done = !WORKABLE_STATES.includes(t.task_state);     // task finished / in review
        if (expired || done) {
          log.info(expired ? 'reminder: expired, cleared' : 'reminder: auto-cancel (task done)', { id: t.id, state: t.task_state });
          // Only cancel the OS reminder if it hasn't fired yet (task finished early).
          // An already-fired alarm must keep ringing until the user taps Stop, so
          // don't silence it here — just drop it from the card map.
          if (!expired) await cancelReminderEntry(rem);
          await removeReminder(t.id);
          next = next || { ...reminders };
          delete next[key];
        }
      }
      if (next) setReminders(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  const [createdPopup, setCreatedPopup] = useState(null); // { ref, name } after a New Task is created

  // New Task modal
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [ntName, setNtName] = useState('');
  const [ntProject, setNtProject] = useState(null);
  const [ntHours, setNtHours] = useState('1');
  const [ntMinutes, setNtMinutes] = useState('0');
  const [ntPriority, setNtPriority] = useState('regular');
  const [ntDesc, setNtDesc] = useState('');
  const [projects, setProjects] = useState([]);
  const [ntProjectOpen, setNtProjectOpen] = useState(false);
  const [clientTree, setClientTree] = useState([]);   // [{id, name, projects:[{id,display}]}]
  const [ntClient, setNtClient] = useState(null);
  const [ntClientOpen, setNtClientOpen] = useState(false);
  const [ntBusy, setNtBusy] = useState(false);

  const load = useCallback(async (opts = {}) => {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      log.info(opts.silent ? 'poll refresh' : 'load board', { myOnly });
      const res = await fetchTasks({ myTasksOnly: myOnly });
      setRaw(res.tasks);
      setIsAdmin(res.isAdmin);
      setIsMock(res.isMock);
    } catch (e) {
      log.error('load failed', e?.message);
      // Don't clobber a working board on a silent poll failure.
      if (!opts.silent) setError(e.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [myOnly]);

  useEffect(() => { load(); }, [load]);

  // Live-timer tick: re-render every second so in-progress cards count up.
  useEffect(() => {
    setNowMs(new Date().getTime());
    const id = setInterval(() => setNowMs(new Date().getTime()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Auto-reset reminders: once a reminder's set time passes, drop it from state so
  // the card's bell flips back to "Remind me" on its own (no manual refresh) — and
  // clear it from storage. Runs on a short interval independent of the board poll.
  useEffect(() => {
    const id = setInterval(() => {
      setReminders((prev) => {
        const now = Date.now();
        const expired = Object.keys(prev).filter((k) => Date.parse(prev[k].whenIso) < now);
        if (!expired.length) return prev;
        const next = { ...prev };
        expired.forEach((k) => { delete next[k]; removeReminder(k); });
        log.info('reminder: auto-reset expired', { ids: expired });
        return next;
      });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Live board refresh: silently re-fetch on an interval so external changes show.
  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), POLL_MS);
    log.info('live polling started', { everyMs: POLL_MS });
    return () => clearInterval(id);
  }, [load]);

  // Check workday state on mount.
  useEffect(() => {
    getWorkdayStatus().then((r) => {
      setWorkdayOpen(!!r?.is_open);
      setDayDone(!!r?.day_done);
    }).catch(() => {});
  }, []);

  // ONE place that reacts to a live_status payload, so the 15s poll and the
  // after-an-action refresh can never drift apart on when to ask.
  const applyLive = useCallback((r) => {
    setLive(r);
    log.info('live ←', {
      workday_open: !!r?.workday_open,
      active_task: !!r?.active_task,
      nontask: r?.nontask ? r.nontask.reason : false,
      idle_prompt: !!r?.idle_prompt,
      seq: r?.idle_prompt_seq || 0,
    });
    // Nothing running and nothing declared → ask. Ask #1 exists from the moment
    // the workday opens (the server no longer waits for the 10-min cron), and each
    // cron re-ask bumps the number so a dismissed #1 can't swallow #2 and #3.
    const seq = r?.idle_prompt_seq || 0;
    const snoozed = Date.now() < idleSnoozeRef.current;
    if (r?.idle_prompt && !snoozed && seq > idleAskedRef.current) {
      idleAskedRef.current = seq;
      log.info('idle prompt → opening popup', { seq });
      setIdlePopup(true);
    }
    // Answered — the server drops idle_prompt for a started task, a declared
    // block, or "no tasks". Reset so a later idle stretch asks from the top.
    if (!r?.idle_prompt) { idleAskedRef.current = 0; idleSnoozeRef.current = 0; }
  }, []);

  // Closing without answering: a short grace to go start a task, then ask again.
  // Re-arms idleAskedRef so the SAME prompt number can re-open once it expires.
  const snoozeIdle = useCallback(() => {
    idleSnoozeRef.current = Date.now() + IDLE_SNOOZE_MS;
    idleAskedRef.current = 0;
    setIdleNote('');   // don't let a typed note leak onto a later, different reason
    setIdlePopup(false);
    log.info('idle prompt snoozed', { seconds: IDLE_SNOOZE_MS / 1000 });
  }, []);

  // Poll the live activity strip (running task / active break / anchors).
  useEffect(() => {
    let alive = true;
    const tick = () => getLiveStatus().then((r) => { if (alive) applyLive(r); }).catch(() => {});
    tick();
    const id = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [applyLive]);

  // Refresh the strip immediately instead of waiting up to 15s — the pill
  // appearing/disappearing is the only feedback these actions give.
  const refreshLive = useCallback(
    () => getLiveStatus().then(applyLive).catch(() => {}), [applyLive]);

  async function chooseIdleReason(code) {
    log.info('idle reason', { code, hasNote: !!idleNote.trim() });
    setIdleBusy(code);
    try {
      const res = await setIdleReason(code, idleNote);
      if (res && res.status === false) {
        showError("Couldn't save that", res.message || 'Failed');
        return;
      }
      setIdlePopup(false);
      setSwitchTo(null);
      setIdleNote('');
      // No need to touch idleAskedRef — the answer drops idle_prompt server-side
      // and applyLive resets from that.
      await refreshLive();
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setIdleBusy(null); }
  }

  async function endNonTaskBlock() {
    log.info('end non-task block');
    setNontaskBusy(true);
    try {
      const res = await endNonTask();
      if (res && res.status === false) {
        showError("Couldn't end that", res.message || 'Failed');
        return;
      }
      await refreshLive();
      // Meeting over with no task to start — the case starting a task can't
      // cover. Re-ask now so "I have no tasks" is one tap, not a 10-min wait.
      // Needed even though applyLive raises the popup on a cron prompt: a block
      // declared from the status button never had one, so idle_prompt is false
      // and nothing else would ask. Leave idleAskedRef alone — it tracks cron
      // prompts, and claiming one here would swallow the real prompt #1.
      if (res && res.ask_again) setIdlePopup(true);
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setNontaskBusy(false); }
  }

  // Filter by search + assignee + priority + status, then group into lanes.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return raw.filter((t) => {
      if (q && !((t.name || '').toLowerCase().includes(q) || (t.user_name || '').toLowerCase().includes(q))) return false;
      if (filterAssignee != null && t.user_id !== filterAssignee) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterStatus && laneForTask(t) !== filterStatus) return false;
      return true;
    });
  }, [raw, search, filterAssignee, filterPriority, filterStatus]);

  const lanes = useMemo(() => groupIntoLanes(filtered), [filtered]);

  // ── Notification focus effect ────────────────────────────────────────────
  // When App passes a focusTaskId (from a notification tap): clear filters so
  // the card is guaranteed rendered, scroll the board to the card's lane and
  // the lane to the card, then fire a one-shot heartbeat. Runs once per id —
  // guarded so the 20s silent poll (which mutates `raw`) can't restart it.
  useEffect(() => {
    if (!focusTaskId) return;
    if (handledFocusRef.current === focusTaskId) return;
    // Type-tolerant match: the notification's kpi_id may arrive as a string while
    // task.id is a number (or vice-versa).
    const task = raw.find((t) => String(t.id) === String(focusTaskId));
    if (!task) {
      // Not in the board's scoped list yet. While still loading, wait for it.
      if (loading) {
        log.info('noti focus: waiting for board load', { focusTaskId, rawCount: raw.length });
        return;
      }
      // Loaded but absent (reassigned away / completed / not the dev's own task).
      // Fetch it by id ONCE and inject it so the reveal can run; if that fails,
      // tell the user.
      if (fetchedFocusRef.current !== focusTaskId) {
        fetchedFocusRef.current = focusTaskId;
        log.info('noti focus: not in board → fetching by id', { focusTaskId, rawIds: raw.map((t) => t.id) });
        fetchTaskById(focusTaskId).then((t) => {
          if (t && t.id != null) {
            log.info('noti focus: fetched task, injecting', { id: t.id, name: t.name });
            setRaw((prev) => (prev.some((x) => String(x.id) === String(t.id)) ? prev : [...prev, t]));
            // raw changes → this effect re-runs → task now found → reveal.
          } else {
            log.info('noti focus: fetch-by-id returned nothing', { focusTaskId });
            handledFocusRef.current = focusTaskId;
            showError('Task not available', "This task couldn't be opened — it may have been removed.");
            onFocusHandled && onFocusHandled();
          }
        });
      }
      return;
    }
    handledFocusRef.current = focusTaskId;
    log.info('noti focus: task found → switching to kanban', { focusTaskId, name: task.name, state: task.task_state });

    // 1. Clear every filter so the target task can't be hidden. Honor the CURRENT
    //    view: in list view, expand its status + row so it's revealed; in board
    //    view, the scroll below brings its card into view. Both then heartbeat.
    setSearch('');
    setFilterAssignee(null);
    setFilterPriority(null);
    setFilterStatus(null);
    setOpenFilter(null);

    const laneKey = laneForTask(task);

    // Notification focus works best in the kanban board (reliable scroll-to-card +
    // heartbeat), so switch to board view. Also pre-expand the list row in case the
    // user toggles back to list.
    setViewMode('board');
    setExpandedLanes((prev) => new Set(prev).add(laneKey));
    setExpandedId(focusTaskId);
    log.info('noti focus: view=board, lane', { laneKey });

    // 2. Scroll to the card — but the view is switching list→board, so the lane/
    //    card offsets (set via onLayout) may not be measured on the first tick.
    //    Retry until they are (up to ~1.6s).
    let t1 = null;
    let tries = 0;
    const tryScroll = () => {
      tries += 1;
      const x = laneX.current[laneKey];
      const y = cardY.current[focusTaskId];
      if (boardRef.current && typeof x === 'number') {
        boardRef.current.scrollTo({ x: Math.max(0, x - 8), animated: true });
        const laneRef = laneRefs.current[laneKey];
        if (laneRef && typeof y === 'number') {
          laneRef.scrollTo({ y: Math.max(0, y - 8), animated: true });
        }
        log.info('noti focus: scrolled board', { laneKey, laneX: x, cardY: y, tries });
        return;
      }
      if (tries < 10) { t1 = setTimeout(tryScroll, 160); }
      else { log.info('noti focus: scroll gave up (offsets not measured)', { laneKey, tries }); }
    };
    t1 = setTimeout(tryScroll, 250);

    // 3. Trigger the heartbeat + highlight on the card, then release.
    const t2 = setTimeout(() => { log.info('noti focus: heartbeat pulse', { focusTaskId }); setPulseId(focusTaskId); }, 420);
    const t3 = setTimeout(() => {
      setPulseId(null);
      onFocusHandled && onFocusHandled();
    }, 3400);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [focusTaskId, raw, loading, onFocusHandled]);

  // Status focus (from a Home stat card): in board/kanban view, scroll right to
  // the selected lane (list view auto-expands it via expandedLanes seed instead).
  // Reuses the same laneX offsets + boardRef the notification-focus effect uses.
  useEffect(() => {
    if (!focusStatus || viewMode !== 'board' || loading) return;
    const t = setTimeout(() => {
      const x = laneX.current[focusStatus];
      if (boardRef.current && typeof x === 'number') {
        boardRef.current.scrollTo({ x: Math.max(0, x - 8), animated: true });
      }
    }, 260);
    return () => clearTimeout(t);
  }, [focusStatus, viewMode, loading]);

  const totalTasks = raw.length;
  const shownTasks = filtered.length;
  const runningCount = useMemo(() => raw.filter((t) => t.task_state === 'in_progress').length, [raw]);

  // New Task is valid only with a name, a project, and a non-zero estimate.
  const ntValid = !!ntName.trim() && !!ntProject &&
    ((parseInt(ntHours, 10) || 0) * 60 + (parseInt(ntMinutes, 10) || 0)) > 0;

  // Distinct assignees present in the data, for the Assignee filter.
  const assigneeOptions = useMemo(() => {
    const map = new Map();
    for (const t of raw) if (t.user_id && !map.has(t.user_id)) map.set(t.user_id, t.user_name || 'User');
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [raw]);

  async function toggleWorkday() {
    // ONE decision, shared with the Home read-only bar (utils/workdayState.js).
    const { action } = workdayButtonState({ locked: workdayLocked, workdayOpen: workdayOpen === true, dayDone });
    log.info('workday toggle', { action, currentlyOpen: workdayOpen, workdayLocked, dayDone });
    // Ended for today → button is disabled; nothing to do (one start + one end).
    if (action === 'none') return;
    // Unpaired: starting/continuing the workday IS pairing. Route to the PIN
    // screen — only a verified PIN opens the workday, so nothing starts here.
    if (action === 'pair') { onNeedPair && onNeedPair(); return; }
    setWorkdayBusy(true);
    try {
      if (action === 'end') {
        // Don't end yet — open the summary popup first.
        const payload = await getTodaySummary();
        setEndNote('');
        setEndSummary(payload || {});
      } else { // action === 'start': already paired, session not open → open directly.
        const res = await startWorkday();
        if (res && res.status === false) {
          // Backend refused because today was already ended (one per day).
          if (res.day_done) { setDayDone(true); setWorkdayOpen(false); showError('Workday ended', res.message || 'You already ended your workday today.'); }
          else showError("Can't start workday", res.message || 'Failed');
        } else { setWorkdayOpen(true); setDayDone(false); }
      }
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setWorkdayBusy(false); }
  }

  async function confirmEndWorkday() {
    log.info('end workday confirmed', { note: !!endNote.trim() });
    setEndBusy(true);
    try {
      const res = await endWorkday(endNote.trim());
      if (res && res.status === false) { showError("Can't end workday", res.message || 'Failed'); return; }
      setWorkdayOpen(false);
      // Ended by the developer → one start + one end per day: mark today done so
      // the button flips straight to "Workday ended for today" (disabled), with
      // no restartable "Start Workday" in between.
      setDayDone(true);
      setEndSummary(null);
      // Ending the workday UN-PAIRS the device server-side (action_end_day →
      // _unpair). Tell App now instead of waiting up to 5s for the pairing poll
      // to notice — otherwise the board keeps showing Start/Pause/Complete on a
      // device that can no longer work, and a tap in that window would stick.
      onWorkdayEnded && onWorkdayEnded();
      await load({ silent: true });
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setEndBusy(false); }
  }

  function openNewTask() {
    setNewTaskOpen(true);
    setNtName(''); setNtProject(null); setNtHours('1'); setNtMinutes('0'); setNtPriority('regular'); setNtDesc('');
    setNtProjectOpen(false); setNtClient(null); setNtClientOpen(false);
    if (clientTree.length === 0) fetchClientTree().then(setClientTree).catch(() => {});
  }

  async function submitNewTask() {
    if (!ntName.trim()) return Alert.alert('Task name required', 'Enter a task name.');
    if (!ntProject) return Alert.alert('Project required', 'Choose a project (KRA).');
    const h = parseInt(ntHours, 10) || 0;
    const m = parseInt(ntMinutes, 10) || 0;
    if (h * 60 + m <= 0) return Alert.alert('Estimate required', 'Estimate must be greater than zero.');
    log.info('new task submit', { name: ntName.trim(), kraId: ntProject.id, h, m, priority: ntPriority });
    setNtBusy(true);
    try {
      const res = await selfCreateTask({
        name: ntName.trim(), kraId: ntProject.id, estimateHours: h, estimateMinutes: m, priority: ntPriority, description: ntDesc.trim(),
      });
      if (res && res.status === false) { Alert.alert('Cannot create', res.message || 'Failed'); return; }
      setNewTaskOpen(false);
      await load({ silent: true });
      setCreatedPopup({ ref: (res && res.external_ref) || '', name: ntName.trim() });
    } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
    finally { setNtBusy(false); }
  }

  async function runAction(kind, task) {
    log.info('user action', kind, { id: task.id, name: task.name, state: task.task_state });
    if (kind === 'reminder') {
      log.info('reminder: open picker', { id: task.id, name: task.name, state: task.task_state });
      // Seed the mode toggle + reason from any existing reminder (default 'notify').
      setReminderMode(reminders[String(task.id)]?.mode === 'alarm' ? 'alarm' : 'notify');
      setReminderReason(reminders[String(task.id)]?.reason || '');
      setPresetMgrOpen(false);
      setReminderFor(task); setReminderCustom(''); return;
    }
    if (kind === 'reassign') {
      setReassignFor(task);
      setReassignReason('');
      setReassignUser(null);
      setReassignTried(false);
      if (users.length === 0) fetchUsers().then(setUsers).catch(() => {});
      return;
    }
    if (kind === 'pause') {
      setPauseFor(task);
      setPauseCode('break');
      setPauseNote('');
      setPauseDropdown(false);
      return;
    }
    if (kind === 'complete' || kind === 'partial') {
      setFinishFor(task);
      setFinishPartial(kind === 'partial');
      setFinishSummary('');
      setChecklist({});
      return;
    }
    // Pending Review — accepting also CATEGORISES the task (its provisional
    // TASK-### ref is re-numbered into REQ/UPT/BUG), so the admin must pick a
    // type; rejecting asks for a note the developer will see.
    if (kind === 'acceptSelf') {
      setAcceptFor(task);
      setAcceptType('requirement');
      return;
    }
    if (kind === 'rejectSelf') {
      setRejectFor(task);
      setRejectNote('');
      return;
    }
    // Admin reviewing a developer-completed (partially_completed) task.
    if (kind === 'approveDone') {
      setApproveFor(task);
      setMgrChecklist({});
      setEmpChecklist(null);
      // Pull the developer's submitted checklist so the admin can see what was done.
      getTaskChecklists(task.id).then((r) => { if (r && r.employee_checklist) setEmpChecklist(r.employee_checklist); }).catch(() => {});
      return;
    }
    if (kind === 'rejectDone') {
      setRejectDoneFor(task);
      setRejectDoneNote('');
      return;
    }

    setBusyId(task.id);
    try {
      const fn = kind === 'start' ? startTask : resumeTask;
      const res = await fn(task.id);
      if (res && res.status === false) {
        showError(kind === 'start' ? "Can't start this task" : "Can't resume this task", res.message || 'Action failed');
      }
      await load({ silent: true });
    } catch (e) {
      showError('Something went wrong', e.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  // Pause: a note is required for 'other' and 'urgent' (matches web).
  async function submitPause() {
    const task = pauseFor;
    const noteRequired = pauseCode === 'other' || pauseCode === 'urgent';
    if (noteRequired && !pauseNote.trim()) {
      return Alert.alert('Note required', 'Please add a note for this pause reason.');
    }
    const label = (PAUSE_REASONS.find((r) => r.code === pauseCode) || {}).label || 'Paused';
    const reason = pauseNote.trim() || label;
    setPauseFor(null);
    setBusyId(task.id);
    try {
      const res = await pauseTask(task.id, reason, pauseCode);
      if (res && res.status === false) Alert.alert('Cannot pause', res.message || 'Failed');
      await load({ silent: true });
    } catch (e) { Alert.alert('Error', e.message || 'Pause failed'); }
    finally { setBusyId(null); }
  }

  // Finish: Partial needs only a summary; full Complete needs summary + all 5 boxes.
  async function submitFinish() {
    const task = finishFor;
    if (!finishSummary.trim()) {
      return Alert.alert('Progress summary required', 'Please describe what you did before finishing.');
    }
    if (!finishPartial) {
      const missing = CHECKLIST_ITEMS.filter((c) => !checklist[c.key]);
      if (missing.length) {
        return Alert.alert('Checklist incomplete',
          'Tick all checklist items, or use "Partial Finish" to submit a summary only.');
      }
    }
    setFinishFor(null);
    setBusyId(task.id);
    try {
      // 1) submit the required progress summary
      const pr = await createProgress(task.id, finishSummary.trim());
      if (pr && pr.status === false) { Alert.alert('Cannot save summary', pr.message || 'Failed'); return; }
      // 2) complete (full) or partial-finish
      const checklistObj = finishPartial
        ? {}
        : CHECKLIST_ITEMS.reduce((o, c) => ({ ...o, [c.key]: true }), {});
      const res = await completeTask(task.id, checklistObj, finishPartial);
      if (res && res.status === false) Alert.alert('Cannot finish', res.message || 'Failed');
      await load({ silent: true });
    } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
    finally { setBusyId(null); }
  }

  // Pending Review → accept into the official flow, categorised as REQ/UPT/BUG.
  async function submitAcceptSelf() {
    const task = acceptFor;
    const docType = acceptType;
    setAcceptFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      await acceptSelfCreated(task.id, docType);
      await load({ silent: true });
    } catch (e) { Alert.alert('Cannot accept', e.message || 'Failed'); }
    finally { setBusyId(null); }
  }

  // Pending Review → send back to the developer with a note. The note is what
  // tells them what to fix, so it's required (the server allows an empty one,
  // but "No reason given" helps nobody).
  async function submitRejectSelf() {
    if (!rejectNote.trim()) return;
    const task = rejectFor;
    const note = rejectNote.trim();
    setRejectFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      await rejectSelfCreated(task.id, note, false);
      await load({ silent: true });
    } catch (e) { Alert.alert('Cannot send back', e.message || 'Failed'); }
    finally { setBusyId(null); }
  }

  // Admin approves the developer's completed work → all QA boxes required → task
  // goes to the client for sign-off (the client is notified server-side).
  async function submitApproveDone() {
    const task = approveFor;
    const missing = MGR_CHECKLIST_ITEMS.filter((c) => !mgrChecklist[c.key]);
    if (missing.length) {
      return Alert.alert('Checklist incomplete', 'Please tick every QA item before approving.');
    }
    setApproveFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      const checklistObj = MGR_CHECKLIST_ITEMS.reduce((o, c) => ({ ...o, [c.key]: true }), {});
      const res = await approveTask(task.id, checklistObj);
      if (res && res.status === false) Alert.alert('Cannot approve', res.message || 'Failed');
      await load({ silent: true });
    } catch (e) { Alert.alert('Error', e.message || 'Approve failed'); }
    finally { setBusyId(null); }
  }

  // Admin rejects the developer's work → back to the SAME developer (paused) with
  // the reason; they Resume to continue. A reason is required.
  async function submitRejectDone() {
    if (!rejectDoneNote.trim()) return;
    const task = rejectDoneFor;
    const note = rejectDoneNote.trim();
    setRejectDoneFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      const res = await rejectTask(task.id, note);
      if (res && res.status === false) Alert.alert('Cannot reject', res.message || 'Failed');
      await load({ silent: true });
    } catch (e) { Alert.alert('Error', e.message || 'Reject failed'); }
    finally { setBusyId(null); }
  }

  async function submitReassign() {
    if (!reassignUser || !reassignReason.trim()) { setReassignTried(true); return; }
    const task = reassignFor;
    setReassignFor(null);
    setBusyId(task.id);
    try {
      const res = await reassignTask(task.id, reassignUser.id, reassignReason.trim());
      if (res && res.status === false) Alert.alert('Cannot reassign', res.message || 'Failed');
      await load({ silent: true });
    } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
    finally { setBusyId(null); }
  }

  // KPI Details takes over the whole screen, the way the web detail pane replaces
  // the web board. Safe to return early here: every hook above has already run,
  // and the board's state stays mounted-in-memory so Back restores it untouched
  // (same scroll position, same open lanes) with no navigation stack involved.
  if (detailTask) {
    return (
      <KpiTaskDetail
        task={detailTask}
        onBack={() => setDetailTask(null)}
        onChanged={() => load({ silent: true })}
      />
    );
  }

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      <Animated.View style={[{ flex: 1 }, enterStyle]}>
      {/* Header row: back + title + refresh */}
      <View style={[s.header, { paddingTop: TOP }]}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={s.title}>{focusStatus ? (LANES.find((l) => l.key === focusStatus)?.label || 'Tasks') : 'KPI Action Board'}</Text>
          {!loading && !error ? (
            <Text style={s.subtitle}>Showing {shownTasks} of {totalTasks} task{totalTasks === 1 ? '' : 's'}</Text>
          ) : null}
        </View>
        <TouchableOpacity onPress={() => load()} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {/* Toolbar: All/My toggle + role badge, then New Task + Start/End Workday */}
      <View style={s.toolbar}>
        {isAdmin && (
          <View style={s.segment}>
            <TouchableOpacity style={[s.seg, !myOnly && s.segOn]} onPress={() => setMyOnly(false)}>
              <Ionicons name="people" size={14} color={!myOnly ? '#fff' : COLORS.muted} />
              <Text style={[s.segTxt, !myOnly && s.segTxtOn]}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.seg, myOnly && s.segOn]} onPress={() => setMyOnly(true)}>
              <Ionicons name="person" size={14} color={myOnly ? '#fff' : COLORS.muted} />
              <Text style={[s.segTxt, myOnly && s.segTxtOn]}>My</Text>
            </TouchableOpacity>
          </View>
        )}
        {isAdmin && (
          <View style={s.roleBadge}>
            <Text style={s.roleBadgeTxt}>{myOnly ? 'My Tasks' : 'Coordinator · All'}</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        {/* Creating a task is work → hidden while the workday hasn't started. */}
        {!readOnly && (
          <TouchableOpacity style={s.newTaskBtn} onPress={openNewTask} activeOpacity={0.85}>
            <Ionicons name="add" size={16} color={COLORS.primary} />
            <Text style={s.newTaskTxt}>New Task</Text>
          </TouchableOpacity>
        )}
        {/* Label + action come from the shared decision helper so this button and
            the Home read-only bar can never disagree: End / Continue / Start /
            "Workday ended for today" (disabled). Locked → routes to the PIN screen. */}
        {(() => {
          const showSpinner = !readOnly && (workdayBusy || workdayOpen === null);
          const wd = workdayButtonState({ locked: readOnly, workdayOpen: workdayOpen === true, dayDone });
          const icon = wd.action === 'end' ? 'stop-circle'
            : wd.action === 'none' ? 'checkmark-done-circle' : 'play-circle';
          return (
            <TouchableOpacity
              style={[s.workdayBtn,
                wd.action === 'end' && s.workdayBtnEnd,
                wd.disabled && { backgroundColor: COLORS.muted },
                showSpinner && s.workdayBtnLoading]}
              onPress={toggleWorkday} activeOpacity={0.85}
              disabled={wd.disabled || showSpinner}
            >
              {showSpinner ? <ActivityIndicator color="#fff" size="small" /> : (
                <>
                  <Ionicons name={icon} size={16} color="#fff" />
                  <Text style={s.workdayTxt}>{wd.label}</Text>
                </>
              )}
            </TouchableOpacity>
          );
        })()}
      </View>

      {/* Why the action buttons are missing — stated, not left to be discovered. */}
      {readOnly && (
        <View style={s.roBanner}>
          <Ionicons name={dayDone ? 'checkmark-done' : 'lock-closed'} size={13} color={COLORS.red} />
          <Text style={s.roBannerTxt}>
            {dayDone
              ? 'Workday ended for today — tasks are read-only until tomorrow.'
              : 'Read-only — start your workday to work on tasks.'}
          </Text>
        </View>
      )}

      {/* Live activity strip + idle warning (when a workday is open) */}
      {live?.workday_open ? (
        <>
          <View style={s.liveStrip}>
            {/* Row 1: LIVE badge + working/idle */}
            <View style={s.liveRow}>
              <View style={s.liveBadge}>
                <View style={s.liveBadgeDot} />
                <Text style={s.liveBadgeTxt}>LIVE</Text>
              </View>
              {live.active_task ? (
                <View style={s.liveWorking}>
                  <Ionicons name="play" size={13} color={COLORS.green} />
                  <Text style={s.liveWorkingTxt} numberOfLines={1}>
                    Working: "{live.active_task.name}"  {fmtHMS(liveFromAnchor(live.active_task.timer_start, live.active_task.timer_total_seconds, nowMs))}
                  </Text>
                </View>
              ) : (
                <View style={s.liveWorking}>
                  <Ionicons name="pause" size={13} color={COLORS.faint} />
                  <Text style={s.liveIdle}>No task running</Text>
                  {/* Say so up front. Without this a 9:31 meeting can only be
                      declared by waiting to be asked at 9:40.
                      Hidden while a break is active: they paused a task WITH a
                      reason, so they have already said why — asking again is
                      noise, and the badge next to this says it too. */}
                  {!readOnly && !live.nontask && !live.active_break ? (
                    <TouchableOpacity style={s.notOnTaskBtn} onPress={() => setIdlePopup(true)} activeOpacity={0.85}>
                      <Text style={s.notOnTaskTxt}>Not on a task?</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </View>

            {/* Row 1b: the open Meeting / Break / No-tasks block.
                The OTHER two reasons sit right here, because switching IS how a
                block ends: "morning meeting over, I have no tasks" is one tap —
                the meeting closes and no-tasks begins, both landing on the Map.
                The third way out is the task card's own Start button, which
                already closes the block on the tick the timer starts. */}
            {/* Gated on !active_task as well as on the block: while a task runs,
                PAUSE already offers Break/Lunch/Meeting with its own note, and two
                ways to say the same thing is how records end up contradicting each
                other. The server can no longer leave a block open during a task
                (start_task AND resume_task both close it) — this makes any future
                regression surface as a missing button rather than as time counted
                twice. */}
            {live.nontask && !live.active_task ? (
              <View style={s.nontaskBox}>
                <View style={s.nontaskPill}>
                  <Text style={s.nontaskPillTxt} numberOfLines={1}>
                    ⏸ {live.nontask.reason_label} · started {live.nontask.start_display} · {fmtHMS(secsSince(live.nontask.start_raw, nowMs))}
                  </Text>
                </View>
                {!readOnly ? (
                  <>
                    <View style={s.nontaskBtnRow}>
                      {IDLE_REASONS.filter((r) => r.code !== live.nontask.reason).map((r) => (
                        <TouchableOpacity
                          key={r.code}
                          style={[s.nontaskSwitch, r.code === 'no_tasks' && s.nontaskSwitchAlert]}
                          onPress={() => setSwitchTo(r)}
                          disabled={!!idleBusy}
                          activeOpacity={0.85}
                        >
                          {idleBusy === r.code
                            ? <ActivityIndicator size="small" color={COLORS.primary} />
                            : <Text style={[s.nontaskSwitchTxt,
                                r.code === 'no_tasks' && { color: COLORS.red }]}>
                                {r.emoji} {r.label}
                              </Text>}
                        </TouchableOpacity>
                      ))}
                    </View>
                    {/* No [End] button on purpose: there is nothing it could do that
                        these buttons and Start don't already. Every exit closes this
                        block — Start (at the timer's tick), another reason (splits),
                        End Workday, or the midnight cron — so a block cannot leak. */}
                    <Text style={s.nontaskHint}>
                      Starting a task, or picking another reason above, ends this automatically.
                    </Text>
                  </>
                ) : null}
              </View>
            ) : null}

            {/* Row 2: break pill (full width — shows the whole line) */}
            {live.active_break ? (
              <View style={s.breakPill}>
                <Text style={s.breakPillTxt}>
                  ☕ {live.active_break.type_label}{live.active_break.source_task_name ? ` (from "${live.active_break.source_task_name}")` : ''} · started {live.active_break.start_display} · {fmtHMS(secsSince(live.active_break.start_raw, nowMs))}
                </Text>
              </View>
            ) : null}

            {/* Row 3: Presence · Productive */}
            <Text style={s.livePresence}>
              Presence {fmtHMS(secsSince(live.login_raw, nowMs))} · Productive <Text style={s.liveProductive}>{fmtHMS(productiveLive(live, nowMs))}</Text>
            </Text>
          </View>
          <View style={s.idleWarn}>
            <Ionicons name="warning" size={14} color={COLORS.red} />
            <Text style={s.idleWarnTxt} numberOfLines={2}>
              A task is running — if you go idle it auto-pauses after 5 min and that time is logged as Away (never Productive).
            </Text>
          </View>
        </>
      ) : null}

      {/* Search */}
      <View style={s.searchBox}>
        <Ionicons name="search" size={18} color={COLORS.faint} />
        <TextInput
          style={s.searchInput}
          placeholder="Search tasks…"
          placeholderTextColor={COLORS.faint}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={18} color={COLORS.faint} /></TouchableOpacity>
        ) : null}
      </View>

      {/* Filter dropdowns: Assignee · Priority · Status */}
      <View style={s.filterRow}>
        <FilterDropdown
          label={filterAssignee == null ? 'All Assignees' : (assigneeOptions.find((a) => a.id === filterAssignee)?.name || 'Assignee')}
          open={openFilter === 'assignee'}
          onToggle={() => setOpenFilter(openFilter === 'assignee' ? null : 'assignee')}
          options={[{ id: null, name: 'All Assignees' }, ...assigneeOptions]}
          selected={filterAssignee}
          getKey={(o) => o.id}
          getLabel={(o) => o.name}
          onPick={(o) => { setFilterAssignee(o.id); setOpenFilter(null); }}
        />
        <FilterDropdown
          label={filterPriority == null ? 'All Priorities' : (PRIORITIES.find((p) => p.code === filterPriority)?.label || 'Priority')}
          open={openFilter === 'priority'}
          onToggle={() => setOpenFilter(openFilter === 'priority' ? null : 'priority')}
          options={[{ code: null, label: 'All Priorities' }, ...PRIORITIES]}
          selected={filterPriority}
          getKey={(o) => o.code}
          getLabel={(o) => o.label}
          onPick={(o) => { setFilterPriority(o.code); setOpenFilter(null); }}
        />
        <FilterDropdown
          label={filterStatus == null ? 'All Statuses' : (LANES.find((l) => l.key === filterStatus)?.label || 'Status')}
          open={openFilter === 'status'}
          onToggle={() => setOpenFilter(openFilter === 'status' ? null : 'status')}
          options={[{ key: null, label: 'All Statuses' }, ...LANES]}
          selected={filterStatus}
          getKey={(o) => o.key}
          getLabel={(o) => o.label}
          onPick={(o) => { setFilterStatus(o.key); setOpenFilter(null); }}
        />
        {/* View toggle (all roles): kanban board ⇄ vertical accordion list.
            Icon shows the view you'll switch TO. */}
        <TouchableOpacity
          style={s.viewToggle}
          onPress={() => { setOpenFilter(null); setViewMode(viewMode === 'board' ? 'list' : 'board'); }}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name={viewMode === 'board' ? 'list' : 'grid'} size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {isMock && !loading && !error ? (
        <View style={s.mockHint}>
          <Ionicons name="information-circle-outline" size={16} color={COLORS.amber} />
          <Text style={s.mockTxt}>Sample data — connect to Odoo to see live tasks.</Text>
        </View>
      ) : null}

      {/* Body — kanban lanes (board) or vertical accordion (list) */}
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /><Text style={s.centerTxt}>Loading tasks…</Text></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={() => load()}><Ionicons name="refresh" size={18} color="#fff" /><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : viewMode === 'board' ? (
        <Animated.View style={bodyStyle}>
        <ScrollView
          ref={boardRef}
          horizontal
          showsHorizontalScrollIndicator
          style={s.board}
          contentContainerStyle={s.boardRow}
          directionalLockEnabled
        >
          {LANES.map((l, i) => {
            const items = lanes[l.key] || [];
            return (
              <AnimatedLane
                key={l.key}
                index={i}
                style={s.lane}
                onLayout={(e) => { laneX.current[l.key] = e.nativeEvent.layout.x; }}
              >
                {/* Colored lane header */}
                <View style={[s.laneHead, { backgroundColor: l.color }]}>
                  <Text style={s.laneTitle} numberOfLines={1}>{l.label}</Text>
                  <View style={s.laneCount}><Text style={s.laneCountTxt}>{items.length}</Text></View>
                </View>
                {/* Lane body — cards stacked vertically.
                    nestedScrollEnabled lets this scroll up/down inside the
                    horizontal board ScrollView (required on Android). */}
                <ScrollView
                  ref={(r) => { laneRefs.current[l.key] = r; }}
                  style={s.laneBody}
                  contentContainerStyle={{ padding: 10, paddingBottom: 24 }}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  {items.length === 0 ? (
                    <View style={s.laneEmpty}>
                      <MaterialCommunityIcons name="tray" size={28} color={COLORS.faint} />
                      <Text style={s.laneEmptyTxt}>Nothing here yet</Text>
                    </View>
                  ) : (
                    items.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        onAction={runAction}
                        busyId={busyId}
                        nowMs={nowMs}
                        isAdmin={isAdmin}
                        reminder={reminders[String(t.id)]}
                        pulse={pulseId === t.id}
                        onMeasure={(y) => { cardY.current[t.id] = y; }}
                        onOpenDetail={openDetail}
                        readOnly={readOnly}
                      />
                    ))
                  )}
                </ScrollView>
              </AnimatedLane>
            );
          })}
        </ScrollView>
        </Animated.View>
      ) : (
        /* List view — vertical accordion, grouped by status. Same filtered data,
           same actions; each row expands to reveal the shared TaskDetailBody. */
        <Animated.View style={bodyStyle}>
        <ScrollView
          ref={listScrollRef}
          style={s.listScroll}
          contentContainerStyle={{ padding: 14, paddingBottom: 28 }}
          showsVerticalScrollIndicator={false}
        >
          {filtered.length === 0 ? (
            <View style={s.center}>
              <MaterialCommunityIcons name="tray" size={40} color={COLORS.faint} />
              <Text style={s.centerTxt}>No tasks match.</Text>
            </View>
          ) : (
            LANES.map((l) => {
              const items = lanes[l.key] || [];
              if (items.length === 0) return null;
              const laneOpen = expandedLanes.has(l.key);
              return (
                <View key={l.key} style={{ marginBottom: 16 }}>
                  {/* Level 1: status heading — tap the arrow to reveal its tasks. */}
                  <TouchableOpacity
                    style={[s.listSection, { backgroundColor: l.color }]}
                    onPress={() => { animateNext(); setExpandedLanes((prev) => {
                      const next = new Set(prev);
                      next.has(l.key) ? next.delete(l.key) : next.add(l.key);
                      return next;
                    }); }}
                    activeOpacity={0.85}
                  >
                    <Ionicons name={laneOpen ? 'chevron-down' : 'chevron-forward'} size={18} color="#fff" />
                    <Text style={s.listSectionTxt} numberOfLines={1}>{l.label}</Text>
                    <View style={s.laneCount}><Text style={s.laneCountTxt}>{items.length}</Text></View>
                  </TouchableOpacity>
                  {/* Level 2: task rows — each expands to its details + actions. */}
                  {laneOpen && items.map((t) => (
                    <TaskListRow
                      key={t.id}
                      task={t}
                      expanded={expandedId === t.id}
                      onToggle={() => { animateNext(); setExpandedId(expandedId === t.id ? null : t.id); }}
                      onAction={runAction}
                      busyId={busyId}
                      nowMs={nowMs}
                      isAdmin={isAdmin}
                      reminder={reminders[String(t.id)]}
                      pulse={pulseId === t.id}
                      onRowRef={(id, r) => { listRowRefs.current[id] = r; }}
                      onOpenDetail={openDetail}
                      readOnly={readOnly}
                    />
                  ))}
                </View>
              );
            })
          )}
        </ScrollView>
        </Animated.View>
      )}
      </Animated.View>

      {/* Reassign modal — mirrors web "Reassign KPI Task" */}
      <Modal visible={!!reassignFor} transparent animationType="fade" onRequestClose={() => setReassignFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>🔄  Reassign KPI Task</Text>
              <TouchableOpacity onPress={() => setReassignFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: LANE_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                <View style={s.bannerBlue}>
                  <Text style={s.bannerBlueTxt}>
                    ⚠️  <Text style={{ fontWeight: '900' }}>Important:</Text> Reassigning resets the task to its priority state and clears the timer. All progress is recorded in history.
                  </Text>
                </View>

                <Text style={s.kv}>Task: <Text style={s.kvStrong}>{reassignFor?.name}</Text></Text>
                <Text style={s.kv}>Current Assignee: <Text style={s.kvStrong}>{reassignFor?.user_name || 'Unassigned'}</Text></Text>
                <View style={s.kvRow}>
                  <Text style={s.kv}>Current State: </Text>
                  <View style={s.stateChip}><Text style={s.stateChipTxt}>{reassignFor?.task_state}</Text></View>
                </View>
                <Text style={s.kv}>Time Spent: <Text style={s.kvStrong}>{fmtHMS(reassignFor?.timer_total_seconds)}</Text></Text>

                <View style={s.hr} />

                <Text style={s.fieldLabel}>Select New Assignee *</Text>
                <View style={s.selectBox}>
                  {users.length === 0 ? <Text style={s.centerTxt}>Loading users…</Text> : (
                    <ScrollView style={{ maxHeight: 150 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {users.map((u) => (
                        <TouchableOpacity key={u.id} style={[s.userRow, reassignUser?.id === u.id && s.userRowOn]} onPress={() => setReassignUser(u)}>
                          <Text style={[s.userTxt, reassignUser?.id === u.id && { color: COLORS.primary, fontWeight: '800' }]}>{u.name}</Text>
                          {reassignUser?.id === u.id && <Ionicons name="checkmark" size={18} color={COLORS.primary} />}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  )}
                </View>
                <Text style={s.fieldHint}>You can reassign to the same employee to reset the task</Text>
                {reassignTried && !reassignUser ? <Text style={s.mandatory}>Please select a developer.</Text> : null}

                <Text style={s.fieldLabel}>Reason for Reassignment *</Text>
                <TextInput
                  style={[s.reasonInput, { minHeight: 80 }, reassignTried && !reassignReason.trim() ? { borderColor: COLORS.red } : null]}
                  placeholder="Please explain why you are reassigning this task (e.g., workload balancing, availability, skill match, etc.)"
                  placeholderTextColor={COLORS.faint}
                  value={reassignReason}
                  onChangeText={setReassignReason}
                  multiline
                />
                {reassignTried && !reassignReason.trim() ? <Text style={s.mandatory}>This field is mandatory</Text> : null}
              </View>
            </ScrollView>

            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setReassignFor(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={s.footConfirm} onPress={submitReassign}><Text style={s.footConfirmTxt}>🔄  Confirm Reassignment</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Pause modal — mirrors the web "Pause Task" dialog */}
      <Modal visible={!!pauseFor} transparent animationType="fade" onRequestClose={() => setPauseFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            {/* Header with title + X */}
            <View style={s.modalHead}>
              <Text style={s.modalHeadTitle}>Pause Task</Text>
              <TouchableOpacity onPress={() => setPauseFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.muted} />
              </TouchableOpacity>
            </View>

            <View style={s.modalPad}>
              <Text style={s.taskLabel}>Task: <Text style={s.taskName}>{pauseFor?.name}</Text></Text>
              <Text style={s.whyTitle}>Why are you pausing?</Text>

              {/* Quick-pick buttons — Urgent pushed to the far right in red */}
              <View style={s.quickRow}>
                <View style={s.quickLeft}>
                  {PAUSE_REASONS.filter((r) => r.quick && r.code !== 'urgent').map((r) => {
                    const on = pauseCode === r.code;
                    return (
                      <TouchableOpacity key={r.code} style={[s.quick, on && s.quickOn]} onPress={() => setPauseCode(r.code)}>
                        <Text style={s.quickEmoji}>{r.emoji}</Text>
                        <Text style={[s.quickTxt, on && { color: COLORS.primary }]}>{r.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity style={[s.quickUrgent, pauseCode === 'urgent' && s.quickUrgentOn]} onPress={() => setPauseCode('urgent')}>
                  <Text style={s.quickEmoji}>🚨</Text>
                  <Text style={[s.quickTxt, { color: pauseCode === 'urgent' ? '#fff' : COLORS.red }]}>Urgent</Text>
                </TouchableOpacity>
              </View>

              {/* Dropdown — full reason list */}
              <TouchableOpacity style={s.dropdown} onPress={() => setPauseDropdown((o) => !o)} activeOpacity={0.8}>
                <Text style={s.dropdownTxt}>{(PAUSE_REASONS.find((r) => r.code === pauseCode) || {}).label}</Text>
                <Ionicons name={pauseDropdown ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
              </TouchableOpacity>
              {pauseDropdown && (
                <View style={s.dropdownList}>
                  <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {PAUSE_REASONS.map((r) => {
                      const on = pauseCode === r.code;
                      return (
                        <TouchableOpacity key={r.code} style={[s.dropdownItem, on && s.dropdownItemOn]} onPress={() => { setPauseCode(r.code); setPauseDropdown(false); }}>
                          <Text style={[s.dropdownItemTxt, on && { color: COLORS.primary, fontWeight: '800' }]}>{r.label}</Text>
                          {on && <Ionicons name="checkmark" size={17} color={COLORS.primary} />}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Note — capped: this text is drawn inside a Workday Map chip, and
                  the Map is what gets frozen into the saved End Workday image. */}
              <TextInput
                style={s.pauseNote}
                placeholder="Optional note (required for 'Other' and 'Urgent')…"
                placeholderTextColor={COLORS.faint}
                value={pauseNote}
                onChangeText={setPauseNote}
                maxLength={IDLE_NOTE_MAX}
                multiline
              />
              <Text style={s.idleNoteHint}>
                Keep it short — this shows on your Workday Map. {pauseNote.length}/{IDLE_NOTE_MAX}
              </Text>

              <Text style={s.pauseHelp}>Every pause reason is tracked as away-time in your day summary — never counted as productive.</Text>
            </View>

            {/* Footer */}
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setPauseFor(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={s.footConfirm} onPress={submitPause}><Text style={s.footConfirmTxt}>Confirm Pause</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Finish modal — Partial Finish (amber, summary) or Complete (green, checklist) */}
      <Modal visible={!!finishFor} transparent animationType="fade" onRequestClose={() => setFinishFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, finishPartial ? s.headAmber : s.headGreen]}>
              <Text style={finishPartial ? s.headAmberTitle : s.headGreenTitle}>
                {finishPartial ? '🏁  Partial Finish' : '✓  Complete Task'}
              </Text>
              <TouchableOpacity onPress={() => setFinishFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={finishPartial ? '#7a5200' : '#fff'} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: LANE_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                <Text style={s.kv}>Task: <Text style={s.kvStrong}>{finishFor?.name}</Text></Text>

                {finishPartial ? (
                  <View style={s.bannerYellow}>
                    <Text style={s.bannerYellowTxt}>
                      ⓘ  This finishes the task <Text style={{ fontWeight: '900' }}>as-is</Text> and sends it for review with just your summary — no full checklist. Use <Text style={{ fontWeight: '900' }}>Complete</Text> for fully-done work.
                    </Text>
                  </View>
                ) : null}

                <Text style={s.fieldLabel}>Progress Summary *</Text>
                <TextInput
                  style={[s.reasonInput, { minHeight: 100 }]}
                  placeholder={finishPartial ? "What was done, what's left, why you're finishing now…" : 'What did you do on this task?'}
                  placeholderTextColor={COLORS.faint}
                  value={finishSummary}
                  onChangeText={setFinishSummary}
                  multiline
                />

                {!finishPartial && (
                  <>
                    <Text style={s.fieldLabel}>Checklist (all required)</Text>
                    {CHECKLIST_ITEMS.map((c) => {
                      const on = !!checklist[c.key];
                      return (
                        <TouchableOpacity key={c.key} style={s.checkRow} onPress={() => setChecklist((p) => ({ ...p, [c.key]: !p[c.key] }))}>
                          <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? COLORS.primary : COLORS.faint} />
                          <Text style={s.checkTxt}>{c.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}
              </View>
            </ScrollView>

            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setFinishFor(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[s.footConfirm, !finishPartial && { backgroundColor: COLORS.green }]} onPress={submitFinish}>
                <Text style={s.footConfirmTxt}>{finishPartial ? '🏁  Finish & Send for Review' : '✓  Complete'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* New Task modal — mirrors web "New Task — Pending Review" */}
      <Modal visible={newTaskOpen} transparent animationType="fade" onRequestClose={() => setNewTaskOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headPurple]}>
              <Text style={s.headPurpleTitle}>＋  New Task — Pending Review</Text>
              <TouchableOpacity onPress={() => setNewTaskOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: LANE_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                <Text style={s.fieldLabel}>Task Name *</Text>
                <TextInput style={[s.textInput, !ntName.trim() && s.inputErr]} placeholder="What needs doing?" placeholderTextColor={COLORS.faint} value={ntName} onChangeText={setNtName} />
                {!ntName.trim() ? <Text style={s.mandatory}>Task name is required</Text> : null}

                <Text style={s.fieldLabel}>Client *</Text>
                <TouchableOpacity style={[s.dropdown, !ntClient && s.inputErr]} onPress={() => { setNtClientOpen((o) => !o); setNtProjectOpen(false); }} activeOpacity={0.8}>
                  <Text style={[s.dropdownTxt, !ntClient && { color: COLORS.faint }]} numberOfLines={1}>
                    {ntClient ? ntClient.name : '— choose a client —'}
                  </Text>
                  <Ionicons name={ntClientOpen ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
                {ntClientOpen && (
                  <View style={s.dropdownList}>
                    <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {clientTree.length === 0 && <Text style={[s.centerTxt, { padding: 12 }]}>Loading clients…</Text>}
                      {clientTree.map((c) => (
                        <TouchableOpacity key={c.id} style={[s.dropdownItem, ntClient?.id === c.id && s.dropdownItemOn]} onPress={() => { setNtClient(c); setNtProject(null); setNtClientOpen(false); }}>
                          <Text style={[s.dropdownItemTxt, ntClient?.id === c.id && { color: COLORS.primary, fontWeight: '800' }]}>{c.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}

                <Text style={s.fieldLabel}>Project *</Text>
                <TouchableOpacity style={[s.dropdown, !ntProject && s.inputErr]} disabled={!ntClient} onPress={() => setNtProjectOpen((o) => !o)} activeOpacity={0.8}>
                  <Text style={[s.dropdownTxt, !ntProject && { color: COLORS.faint }]} numberOfLines={1}>
                    {ntProject ? ntProject.display : (ntClient ? '— choose a project —' : 'Select a client first')}
                  </Text>
                  <Ionicons name={ntProjectOpen ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
                {!ntProject ? <Text style={s.mandatory}>Please choose a project</Text> : null}
                {ntProjectOpen && ntClient && (
                  <View style={s.dropdownList}>
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {(ntClient.projects || []).map((p) => (
                        <TouchableOpacity key={p.id} style={[s.dropdownItem, ntProject?.id === p.id && s.dropdownItemOn]} onPress={() => { setNtProject(p); setNtProjectOpen(false); }}>
                          <Text style={[s.dropdownItemTxt, ntProject?.id === p.id && { color: COLORS.primary, fontWeight: '800' }]}>{p.display}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}

                <View style={s.twoCol}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.fieldLabel}>Estimate Hours</Text>
                    <TextInput style={s.textInput} keyboardType="number-pad" selectTextOnFocus value={ntHours} onChangeText={setNtHours} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.fieldLabel}>Minutes</Text>
                    <TextInput style={s.textInput} keyboardType="number-pad" selectTextOnFocus value={ntMinutes} onChangeText={setNtMinutes} />
                  </View>
                </View>

                <Text style={s.fieldLabel}>Priority</Text>
                <View style={s.segFull}>
                  {PRIORITIES.map((p) => {
                    const on = ntPriority === p.code;
                    return (
                      <TouchableOpacity key={p.code} style={[s.segFullItem, on && s.segFullItemOn]} onPress={() => setNtPriority(p.code)}>
                        <Text style={[s.segFullTxt, on && { color: '#fff' }]}>{p.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={s.fieldLabel}>Description</Text>
                <TextInput style={[s.textInput, { minHeight: 70, textAlignVertical: 'top' }]} multiline value={ntDesc} onChangeText={setNtDesc} />

                <View style={s.bannerBlue}>
                  <Text style={s.bannerBlueTxt}>
                    This goes to your <Text style={{ fontWeight: '900' }}>Pending Review</Text> lane — start working it right away; an admin accepts it into the main flow (your time carries over).
                  </Text>
                </View>
              </View>
            </ScrollView>

            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setNewTaskOpen(false)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.primary }, !ntValid && s.footDisabled]}
                onPress={submitNewTask}
                disabled={ntBusy || !ntValid}
              >
                {ntBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.footConfirmTxt}>Create Task</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Styled success popup after creating a "+ New Task" — shows the new ref */}
      <Modal visible={!!createdPopup} transparent animationType="fade" onRequestClose={() => setCreatedPopup(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headGreenSoft]}>
              <Text style={s.headGreenSoftTitle}>✓  Task created</Text>
              <TouchableOpacity onPress={() => setCreatedPopup(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#0F5132" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              {createdPopup?.ref ? (
                <View style={s.createdRefRow}>
                  <Text style={s.createdRefLbl}>Reference</Text>
                  <View style={s.createdRefBadge}><Text style={s.createdRefTxt}>{createdPopup.ref}</Text></View>
                </View>
              ) : null}
              <Text style={s.createdName} numberOfLines={2}>{createdPopup?.name}</Text>
              <View style={s.createdInfo}>
                <Ionicons name="time-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>In <Text style={{ fontWeight: '800' }}>Pending Review</Text> — an admin will review it, pick the type (Requirement / Update / Bug) and assign it.</Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={[s.footConfirm, { backgroundColor: COLORS.green }]} onPress={() => setCreatedPopup(null)}><Text style={s.footConfirmTxt}>Done</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Workday not started → ask, don't block. Start Workday goes to the PIN
          (the only thing that opens a workday); Cancel keeps them browsing
          read-only. Shown on every board entry while locked, so it can't trap
          them and can't be missed. */}
      <Modal visible={startPrompt} transparent animationType="fade" onRequestClose={() => setStartPrompt(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>⏱  Workday not started</Text>
              <TouchableOpacity onPress={() => setStartPrompt(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdInfoTxt}>
                You haven't started your workday, so tasks are read-only — you can look
                around, but Start, Pause and Complete are hidden.
              </Text>
              <View style={s.createdInfo}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>
                  Starting your workday pairs this device with your computer — you'll get a PIN to enter there.
                </Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setStartPrompt(false)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.green }]}
                onPress={() => { setStartPrompt(false); onNeedPair && onNeedPair(); }}
              >
                <Text style={s.footConfirmTxt}>Start Workday</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Pending Review → ACCEPT. Accepting also categorises the task: the server
          re-numbers its provisional TASK-### into the chosen REQ/UPT/BUG sequence
          and prefixes the name, which is exactly what the "Task created" popup
          promises the developer. */}
      <Modal visible={!!acceptFor} transparent animationType="fade" onRequestClose={() => setAcceptFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headGreenSoft]}>
              <Text style={s.headGreenSoftTitle}>✓  Accept task</Text>
              <TouchableOpacity onPress={() => setAcceptFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#0F5132" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdName} numberOfLines={2}>{acceptFor?.name}</Text>
              <Text style={s.modalLabel}>Task type</Text>
              <View style={s.typeRow}>
                {[
                  { key: 'requirement', label: 'Requirement', ref: 'REQ' },
                  { key: 'update', label: 'Update', ref: 'UPT' },
                  { key: 'bug', label: 'Bug', ref: 'BUG' },
                ].map((t) => {
                  const on = acceptType === t.key;
                  return (
                    <TouchableOpacity
                      key={t.key} style={[s.typeChip, on && s.typeChipOn]}
                      onPress={() => setAcceptType(t.key)} activeOpacity={0.85}
                    >
                      <Text style={[s.typeChipTxt, on && s.typeChipTxtOn]}>{t.label}</Text>
                      <Text style={[s.typeChipRef, on && s.typeChipTxtOn]}>{t.ref}-###</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={s.createdInfo}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>
                  It enters the official flow and gets a real reference. If the developer
                  hasn't started, the client is asked to approve; any time already logged is kept.
                </Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setAcceptFor(null)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.footConfirm, { backgroundColor: COLORS.green }]} onPress={submitAcceptSelf}>
                <Text style={s.footConfirmTxt}>Accept</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Pending Review → REJECT (send back). The note is what tells the developer
          what to fix, so it's required here. The task stays in Pending Review. */}
      <Modal visible={!!rejectFor} transparent animationType="fade" onRequestClose={() => setRejectFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>↩  Send back to developer</Text>
              <TouchableOpacity onPress={() => setRejectFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdName} numberOfLines={2}>{rejectFor?.name}</Text>
              <Text style={s.modalLabel}>What needs to change? (required)</Text>
              <TextInput
                style={s.reasonInput}
                placeholder="e.g. Wrong project — move it under Alphalize > Phase 2"
                placeholderTextColor={COLORS.faint}
                value={rejectNote} onChangeText={setRejectNote} multiline
              />
              <View style={s.createdInfo}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>
                  The developer is notified with this note and the task stays in Pending Review
                  so they can fix and resubmit it.
                </Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setRejectFor(null)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.red }, !rejectNote.trim() && { opacity: 0.5 }]}
                onPress={submitRejectSelf} disabled={!rejectNote.trim()}
              >
                <Text style={s.footConfirmTxt}>Send back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Admin: Approve a developer-completed task (QA checklist) → goes to client. */}
      <Modal visible={!!approveFor} transparent animationType="fade" onRequestClose={() => setApproveFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headGreen]}>
              <Text style={s.headGreenTitle}>✓  Approve &amp; send to client</Text>
              <TouchableOpacity onPress={() => setApproveFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: LANE_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                <Text style={s.kv}>Task: <Text style={s.kvStrong}>{approveFor?.name}</Text></Text>
                {empChecklist ? (
                  <>
                    <Text style={s.fieldLabel}>📝 Developer's checklist (what they submitted)</Text>
                    {CHECKLIST_ITEMS.map((c) => {
                      const on = !!empChecklist[c.key];
                      return (
                        <View key={c.key} style={s.checkRow}>
                          <Ionicons name={on ? 'checkmark-circle' : 'close-circle'} size={20} color={on ? COLORS.green : COLORS.faint} />
                          <Text style={[s.checkTxt, !on && { color: COLORS.faint }]}>{c.label}</Text>
                        </View>
                      );
                    })}
                    <View style={{ height: 1, backgroundColor: '#eef1f5', marginVertical: 12 }} />
                  </>
                ) : null}
                <Text style={s.fieldLabel}>QA checklist (all required)</Text>
                {MGR_CHECKLIST_ITEMS.map((c) => {
                  const on = !!mgrChecklist[c.key];
                  return (
                    <TouchableOpacity key={c.key} style={s.checkRow} onPress={() => setMgrChecklist((p) => ({ ...p, [c.key]: !p[c.key] }))}>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? COLORS.primary : COLORS.faint} />
                      <Text style={s.checkTxt}>{c.label}</Text>
                    </TouchableOpacity>
                  );
                })}
                <View style={s.createdInfo}>
                  <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                  <Text style={s.createdInfoTxt}>Approving sends the task to the client to sign off — they are notified.</Text>
                </View>
              </View>
            </ScrollView>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setApproveFor(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[s.footConfirm, { backgroundColor: COLORS.green }]} onPress={submitApproveDone}>
                <Text style={s.footConfirmTxt}>✓  Approve</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Admin: Reject a developer-completed task → back to the same developer with a reason. */}
      <Modal visible={!!rejectDoneFor} transparent animationType="fade" onRequestClose={() => setRejectDoneFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>↩  Reject — send back to developer</Text>
              <TouchableOpacity onPress={() => setRejectDoneFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdName} numberOfLines={2}>{rejectDoneFor?.name}</Text>
              <Text style={s.modalLabel}>What needs to change? (required)</Text>
              <TextInput
                style={s.reasonInput}
                placeholder="e.g. Deploy is missing the migration — please redo and resubmit"
                placeholderTextColor={COLORS.faint}
                value={rejectDoneNote} onChangeText={setRejectDoneNote} multiline
              />
              <View style={s.createdInfo}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>The task goes back to the same developer (paused) with this note — they Resume to continue.</Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setRejectDoneFor(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.red }, !rejectDoneNote.trim() && { opacity: 0.5 }]}
                onPress={submitRejectDone} disabled={!rejectDoneNote.trim()}
              >
                <Text style={s.footConfirmTxt}>Send back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* "Not on a task?" — raised from workday start onwards whenever nothing is
          running and nothing is declared, again by the 10-min check, by the strip
          button, and after ending a block with no task to follow. */}
      <Modal visible={idlePopup} transparent animationType="fade" onRequestClose={snoozeIdle}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>Not on a task?</Text>
              <TouchableOpacity onPress={snoozeIdle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={{ padding: 18 }}>
              <Text style={s.idleIntro}>
                Nothing is running. Tell us why so your time is recorded correctly.
              </Text>
              {/* Says which button is for what. Red because getting this wrong is
                  what puts a wrong record on someone's day. */}
              <View style={s.idleGuide}>
                <Text style={s.idleGuideTxt}>• Meeting before your task? Tap <Text style={s.idleGuideB}>In a meeting</Text>.</Text>
                <Text style={s.idleGuideTxt}>• Nothing assigned yet? Tap <Text style={s.idleGuideB}>I have no tasks</Text>.</Text>
                <Text style={s.idleGuideTxt}>• Ready to work? Close this (✕) and press <Text style={s.idleGuideB}>Start</Text> on your task.</Text>
              </View>
              {IDLE_REASONS.map((r) => (
                <TouchableOpacity
                  key={r.code}
                  style={[s.idleOpt, r.code === 'no_tasks' && s.idleOptAlert]}
                  onPress={() => chooseIdleReason(r.code)}
                  disabled={!!idleBusy}
                  activeOpacity={0.85}
                >
                  <Text style={s.idleOptEmoji}>{r.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.idleOptLabel}>{r.label}</Text>
                    {/* Say who hears about it — the difference between these
                        options is exactly that, and it must not be a surprise. */}
                    <Text style={s.idleOptNote}>{r.note}</Text>
                  </View>
                  {idleBusy === r.code ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
                </TouchableOpacity>
              ))}

              {/* Optional note. Capped because it is drawn inside a Workday Map
                  chip — and the Map is what gets frozen into the saved image. */}
              <TextInput
                style={s.idleNote}
                placeholder="Optional note (e.g. sprint planning)…"
                placeholderTextColor={COLORS.faint}
                value={idleNote}
                onChangeText={setIdleNote}
                maxLength={IDLE_NOTE_MAX}
                editable={!idleBusy}
              />
              <Text style={s.idleNoteHint}>
                Keep it short — this shows on your Workday Map. {idleNote.length}/{IDLE_NOTE_MAX}
              </Text>

              {/* Closable on purpose: this popup covers the board, so a modal you
                  couldn't close would make reaching a task's Start button — the
                  very thing that answers this — impossible. It asks again shortly. */}
              <TouchableOpacity onPress={snoozeIdle} disabled={!!idleBusy}>
                <Text style={s.idleLater}>I have a task — let me start it</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Switching ends the running block and starts another — show the hand-off
          rather than a bare "are you sure", because the fear is that ending a
          meeting loses it. It doesn't, and the popup says so. */}
      <Modal visible={!!switchTo} transparent animationType="fade" onRequestClose={() => setSwitchTo(null)}>
        <View style={s.confirmWrap}>
          <View style={s.confirmCard}>
            <View style={s.swIcon}>
              <Ionicons name="swap-horizontal" size={26} color={COLORS.primary} />
            </View>
            <Text style={s.confirmTitle}>Switch to {switchTo?.label}?</Text>

            {/* from → to */}
            <View style={s.swFlow}>
              <View style={s.swRow}>
                <Text style={s.swEmoji}>⏸</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.swName}>{live?.nontask?.reason_label}</Text>
                  <Text style={s.swMeta}>
                    started {live?.nontask?.start_display}
                    {live?.nontask?.start_raw ? ` · ${fmtHMS(secsSince(live.nontask.start_raw, nowMs))}` : ''}
                  </Text>
                </View>
                <Text style={s.swTag}>ends now</Text>
              </View>

              <Ionicons name="arrow-down" size={16} color={COLORS.faint} style={{ marginVertical: 2 }} />

              <View style={s.swRow}>
                <Text style={s.swEmoji}>{switchTo?.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.swName}>{switchTo?.label}</Text>
                </View>
                <Text style={[s.swTag, { color: COLORS.green }]}>starts now</Text>
              </View>
            </View>

            {/* The whole reason this popup exists: ending a meeting SOUNDS
                destructive. It isn't — say so plainly. */}
            <Text style={s.confirmMsg}>
              {live?.nontask?.reason_label} is saved to your Workday Map. Nothing is lost.
            </Text>
            {switchTo?.code === 'no_tasks' ? (
              <Text style={s.swWarn}>Your admins will be told straight away.</Text>
            ) : null}

            <View style={s.confirmBtns}>
              <TouchableOpacity
                style={[s.confirmBtn, s.confirmCancel]}
                onPress={() => setSwitchTo(null)}
                disabled={!!idleBusy}
                activeOpacity={0.85}
              >
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.confirmBtn, s.swDo]}
                onPress={() => chooseIdleReason(switchTo.code)}
                disabled={!!idleBusy}
                activeOpacity={0.85}
              >
                {idleBusy
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={s.confirmDoTxt}>Yes, switch</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Per-task reminder picker (developer alarm). */}
      <Modal visible={!!reminderFor} transparent animationType="fade" onRequestClose={() => setReminderFor(null)}>
        <TouchableOpacity style={rStyles.backdrop} activeOpacity={1} onPress={() => { setReminderFor(null); setPresetMgrOpen(false); }}>
          <TouchableOpacity style={rStyles.sheet} activeOpacity={1}>
            {presetMgrOpen ? (
              <>
                <View style={rStyles.mgrHeader}>
                  <Text style={rStyles.title}>Quick timers</Text>
                  {/* X → back to the Remind-me popup (changes are already saved). */}
                  <TouchableOpacity onPress={() => setPresetMgrOpen(false)} activeOpacity={0.7}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={22} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>
                <Text style={rStyles.taskName}>Shown in the Remind-me popup for both Notify and Alarm.</Text>
                <View style={rStyles.mgrList}>
                  {presetMins.map((m) => (
                    <View key={m} style={rStyles.mgrRow}>
                      <Text style={rStyles.mgrLabel}>{fmtPresetLabel(m)}</Text>
                      <TouchableOpacity style={rStyles.mgrDel} activeOpacity={0.8} onPress={() => removePreset(m)}>
                        <Ionicons name="trash-outline" size={16} color={COLORS.red} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {presetMins.length === 0 ? (
                    <Text style={rStyles.mgrHint}>No quick timers yet — add one below.</Text>
                  ) : null}
                </View>
                {presetMins.length < MAX_PRESETS ? (
                  <View style={rStyles.mgrAddRow}>
                    <TextInput style={rStyles.customInput} keyboardType="number-pad" placeholder="Minutes (e.g. 45)"
                      placeholderTextColor={COLORS.faint} value={newPresetMins}
                      onChangeText={(t) => setNewPresetMins(t.replace(/[^0-9]/g, ''))} onSubmitEditing={addPreset} />
                    <TouchableOpacity style={[rStyles.mgrAddBtn, !newPresetMins && { opacity: 0.4 }]} disabled={!newPresetMins}
                      activeOpacity={0.85} onPress={addPreset}>
                      <Text style={rStyles.mgrAddBtnTxt}>＋</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Text style={rStyles.mgrHint}>Maximum {MAX_PRESETS} quick timers.</Text>
                )}
                <View style={rStyles.footer}>
                  <View />
                  <TouchableOpacity onPress={() => setPresetMgrOpen(false)} activeOpacity={0.7}>
                    <Text style={[rStyles.cancelTxt, { color: COLORS.primary }]}>Done</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
            <Text style={rStyles.title}>Remind me about this task</Text>
            <Text style={rStyles.taskName} numberOfLines={2}>{reminderFor?.name}</Text>
            <View style={rStyles.modeRow}>
              <TouchableOpacity style={[rStyles.modeBtn, reminderMode === 'notify' && rStyles.modeBtnActive]}
                activeOpacity={0.85} onPress={() => setReminderMode('notify')}>
                <Text style={[rStyles.modeTxt, reminderMode === 'notify' && rStyles.modeTxtActive]}>🔔 Notify</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[rStyles.modeBtn, reminderMode === 'alarm' && rStyles.modeBtnActive]}
                activeOpacity={0.85} onPress={() => setReminderMode('alarm')}>
                <Text style={[rStyles.modeTxt, reminderMode === 'alarm' && rStyles.modeTxtActive]}>⏰ Alarm</Text>
              </TouchableOpacity>
            </View>
            <Text style={rStyles.modeHint}>
              {reminderMode === 'alarm'
                ? (alarmAvailable()
                    ? 'Rings full-screen and loops until you tap Stop.'
                    : 'Rings full-screen on a dev build; here it falls back to a notification.')
                : 'A single notification with sound.'}
            </Text>
            {/* Optional note — shown on the alarm/notification when it fires. Blank = plain. */}
            <TextInput
              style={rStyles.reasonInput}
              placeholder="Reason (optional) — shows when it rings"
              placeholderTextColor={COLORS.faint}
              value={reminderReason}
              onChangeText={setReminderReason}
              maxLength={80}
              returnKeyType="done"
            />
            {reminderReason.trim() ? (
              <Text style={rStyles.reasonHint}>Shows as: “{reminderReason.trim()}”</Text>
            ) : null}
            {/* Pick the alarm's sound from the phone's ringtone picker. Alarm mode +
                Android. Shown even without the alarm engine (Expo Go) so you can
                configure it now; the choice takes effect once you're on a dev build. */}
            {reminderMode === 'alarm' && Platform.OS === 'android' ? (
              <>
                <TouchableOpacity style={rStyles.soundRow} activeOpacity={0.8} onPress={chooseAlarmSound}>
                  <Ionicons name="musical-notes-outline" size={18} color={COLORS.primary} />
                  <Text style={rStyles.soundLabel} numberOfLines={1}>
                    Alarm sound: <Text style={rStyles.soundValue}>{alarmSound?.title || 'Default alarm'}</Text>
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
                </TouchableOpacity>
                <TouchableOpacity style={rStyles.soundRow} activeOpacity={0.8}
                  onPress={() => setDurPicker({ field: 'ring', mode: 'duration', initial: alarmSettings.ringMins, title: 'Rings for', infiniteLabel: 'Ring until I stop it' })}>
                  <Ionicons name="timer-outline" size={18} color={COLORS.primary} />
                  <Text style={rStyles.soundLabel} numberOfLines={1}>
                    Rings for: <Text style={rStyles.soundValue}>{alarmSettings.ringMins > 0 ? fmtPresetLabel(alarmSettings.ringMins) : 'Until I stop it'}</Text>
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
                </TouchableOpacity>
                <TouchableOpacity style={rStyles.soundRow} activeOpacity={0.8}
                  onPress={() => setDurPicker({ field: 'snooze', mode: 'duration', initial: alarmSettings.snoozeMins, title: 'Snooze for' })}>
                  <Ionicons name="bed-outline" size={18} color={COLORS.primary} />
                  <Text style={rStyles.soundLabel} numberOfLines={1}>
                    Snooze: <Text style={rStyles.soundValue}>{fmtPresetLabel(alarmSettings.snoozeMins)}</Text>
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
                </TouchableOpacity>
              </>
            ) : null}
            <View style={rStyles.chips}>
              {presetMins.map((m) => (
                <TouchableOpacity key={m} style={rStyles.chip} activeOpacity={0.85}
                  onPress={() => applyReminder(reminderFor, m * 60)}>
                  <Text style={rStyles.chipTxt}>{fmtPresetLabel(m)}</Text>
                </TouchableOpacity>
              ))}
              {(() => {
                if (!reminderFor || reminderFor.task_state !== 'in_progress') return null;
                const left = Math.round(estimateSecs(reminderFor) - liveSeconds(reminderFor, nowMs));
                if (left <= 60) return null;   // already at/over estimate
                const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60);
                return (
                  <TouchableOpacity style={[rStyles.chip, rStyles.chipEst]} activeOpacity={0.85}
                    onPress={() => applyReminder(reminderFor, left)}>
                    <Text style={[rStyles.chipTxt, { color: '#fff' }]}>At estimate ({h > 0 ? `${h}h ` : ''}{m}m left)</Text>
                  </TouchableOpacity>
                );
              })()}
              {/* + chip → opens the quick-timer manager (add/remove presets). */}
              <TouchableOpacity style={rStyles.chipAdd} activeOpacity={0.85}
                onPress={() => { setNewPresetMins(''); setPresetMgrOpen(true); }}>
                <Text style={rStyles.chipAddTxt}>＋</Text>
              </TouchableOpacity>
            </View>
            <View style={rStyles.customRow}>
              <TextInput style={rStyles.customInput} keyboardType="number-pad" placeholder="Custom minutes"
                placeholderTextColor={COLORS.faint} value={reminderCustom}
                onChangeText={(t) => setReminderCustom(t.replace(/[^0-9]/g, ''))} />
              <TouchableOpacity style={[rStyles.setBtn, !reminderCustom && { opacity: 0.4 }]} disabled={!reminderCustom}
                activeOpacity={0.85} onPress={() => applyReminder(reminderFor, Math.max(1, parseInt(reminderCustom, 10) || 0) * 60)}>
                <Text style={rStyles.setBtnTxt}>Set</Text>
              </TouchableOpacity>
            </View>
            {/* Or pick an actual clock time to be reminded at (works for both modes). */}
            <TouchableOpacity style={[rStyles.soundRow, { marginTop: 10, marginBottom: 0 }]} activeOpacity={0.8}
              onPress={() => setDurPicker({ field: 'customTime', mode: 'clock', task: reminderFor,
                initial: { hour24: new Date().getHours(), minute: new Date().getMinutes() }, title: 'Remind me at' })}>
              <Ionicons name="time-outline" size={18} color={COLORS.primary} />
              <Text style={rStyles.soundLabel}>Or remind me <Text style={rStyles.soundValue}>at a clock time ▸</Text></Text>
              <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
            </TouchableOpacity>
            <View style={rStyles.footer}>
              {reminders[String(reminderFor?.id)] ? (
                <TouchableOpacity onPress={() => clearReminderFor(reminderFor)} activeOpacity={0.7}>
                  <Text style={rStyles.clearTxt}>Clear reminder</Text>
                </TouchableOpacity>
              ) : <View />}
              <TouchableOpacity onPress={() => setReminderFor(null)} activeOpacity={0.7}>
                <Text style={rStyles.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Wheel picker for ring / snooze duration and the custom clock-time reminder. */}
      {durPicker ? (
        <DurationTimePicker
          mode={durPicker.mode}
          initial={durPicker.initial}
          title={durPicker.title}
          infiniteLabel={durPicker.infiniteLabel}
          onCancel={() => { log.info('picker: cancel', { field: durPicker.field }); setDurPicker(null); }}
          onConfirm={onDurConfirm}
        />
      ) : null}

      {/* Styled error popup — "Can't start this task", etc. */}
      <Modal visible={!!errorPopup} transparent animationType="fade" onRequestClose={() => setErrorPopup(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>⛔  {errorPopup?.title}</Text>
              <TouchableOpacity onPress={() => setErrorPopup(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.errorMsg}>{errorPopup?.message}</Text>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footConfirm} onPress={() => setErrorPopup(null)}><Text style={s.footConfirmTxt}>OK</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* End Workday summary — mirrors the web logout summary */}
      <Modal visible={!!endSummary} transparent animationType="fade" onRequestClose={() => setEndSummary(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headRed]}>
              <View style={s.headRedTitleRow}>
                <Ionicons name="power" size={18} color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.headRedTitle} numberOfLines={1}>End Workday — {endSummary?.dev || 'you'}</Text>
              </View>
              <TouchableOpacity onPress={() => setEndSummary(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: LANE_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                {/* Three stat tiles */}
                <View style={s.statTiles}>
                  <View style={s.statTile}>
                    <Text style={s.statTileLbl}>Login</Text>
                    <Text style={s.statTileVal}>{endSummary?.login_at || '—'}</Text>
                  </View>
                  <View style={s.statTile}>
                    <Text style={s.statTileLbl}>Productive (task time)</Text>
                    <Text style={[s.statTileBig, { color: COLORS.green }]}>{endSummary?.productive_display || '0m'}</Text>
                  </View>
                  <View style={s.statTile}>
                    <Text style={s.statTileLbl}>Presence (wall clock)</Text>
                    {/* Green at/over the standard day, red under it. The verdict is
                        decided server-side (met_standard) so the app, the web popup
                        and the saved image always agree. */}
                    <Text style={[s.statTileBig, {
                      color: endSummary?.met_standard ? COLORS.green : COLORS.red,
                    }]}>
                      {endSummary?.presence_display || '0m'}
                    </Text>
                    {endSummary?.standard_display ? (
                      <Text style={[s.statTileFoot, {
                        color: endSummary?.met_standard ? COLORS.green : COLORS.red,
                      }]}>
                        {endSummary.met_standard ? '✓ ' : '▾ '}
                        {endSummary.standard_display} standard
                      </Text>
                    ) : null}
                  </View>
                </View>

                {/* Away time breakdown */}
                <View style={s.awayBox}>
                  <Text style={s.awayTitle}>☕  Away time <Text style={s.awaySub}>(inside Presence — never Productive)</Text></Text>
                  <View style={s.awayGrid}>
                    {[
                      ['Break', endSummary?.break_display],
                      ['Lunch', endSummary?.lunch_display],
                      ['Meeting', endSummary?.meeting_display],
                      // Its own bucket: time with nothing assigned is not the
                      // developer's fault and must not read as idling.
                      ['No tasks', endSummary?.no_tasks_display],
                      ['Other', endSummary?.other_display],
                      ['Away (auto)', endSummary?.away_display],
                      ['Other/Idle', endSummary?.other_idle_display],
                    ].map(([lbl, val]) => (
                      <View key={lbl} style={s.awayCell}>
                        <Text style={s.awayCellLbl}>{lbl}</Text>
                        <Text style={s.awayCellVal}>{val || '0m'}</Text>
                      </View>
                    ))}
                  </View>
                  {(endSummary?.away_events || []).map((e, i) => {
                    // Urgent breaks are highlighted yellow, matching the web module.
                    const urgent = /urgent/i.test(e.label || '') || /urgent/i.test(e.reason || '') || e.is_urgent === true;
                    return (
                      <View key={i} style={s.awayEvent}>
                        <View style={[s.awayTag, urgent && s.awayTagUrgent]}>
                          <Text style={[s.awayTagTxt, urgent && s.awayTagTxtUrgent]}>{e.label}</Text>
                        </View>
                        <Text style={s.awayEventTxt} numberOfLines={1}>
                          {e.start}–{e.end} ({e.duration_display}){e.from ? ` from "${e.from}"` : ''}
                        </Text>
                      </View>
                    );
                  })}
                </View>

                {/* Workday Map — the day's flow (start → task → break → … → end) */}
                {(endSummary?.timeline || []).length > 0 ? (
                  <View style={s.mapBox}>
                    <Text style={s.mapTitle}>🗺  Workday Map <Text style={s.awaySub}>(your day in order)</Text></Text>
                    <View style={s.mapFlow}>
                      {endSummary.timeline.map((n, i) => (
                        <React.Fragment key={i}>
                          {i > 0 ? <Text style={s.mapArrow}>→</Text> : null}
                          <WorkdayMapChip node={n} />
                        </React.Fragment>
                      ))}
                    </View>
                  </View>
                ) : null}

                <Text style={s.endHint}>⚠  Use Complete for finished tasks — Pause is only for breaks/interruptions.</Text>

                {/* Tasks worked today */}
                <Text style={s.tasksTitle}>Tasks worked today ({(endSummary?.tasks || []).length})</Text>
                <View style={s.taskTableHead}>
                  <Text style={[s.thRef]}>Ref</Text>
                  <Text style={[s.thTitle]}>Title</Text>
                  <Text style={[s.thTime]}>Time</Text>
                </View>
                {(endSummary?.tasks || []).length === 0 ? (
                  <Text style={[s.centerTxt, { paddingVertical: 12 }]}>No task time logged.</Text>
                ) : (endSummary.tasks).map((t) => (
                  <View key={t.kpi_id} style={s.taskRow}>
                    <Text style={s.tdRef}>{t.ref}</Text>
                    <Text style={s.tdTitle} numberOfLines={1}>{t.name}</Text>
                    <Text style={s.tdTime}>{t.duration_display}</Text>
                  </View>
                ))}

                <Text style={s.fieldLabel}>Optional note for owner / coordinator:</Text>
                <TextInput style={[s.textInput, { minHeight: 60, textAlignVertical: 'top' }]} multiline value={endNote} onChangeText={setEndNote} placeholder="Anything to add…" placeholderTextColor={COLORS.faint} />
              </View>
            </ScrollView>

            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setEndSummary(null)}>
                <Text style={s.footCancelTxt}>← Continue Working</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.footConfirm, { backgroundColor: COLORS.red, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }]} onPress={confirmEndWorkday} disabled={endBusy}>
                {endBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                  <>
                    <Ionicons name="log-out-outline" size={17} color="#fff" />
                    <Text style={s.footConfirmTxt}>Logout & Send Summary</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // gradient drawn on top via GradientBackground

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 6 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  subtitle: { fontSize: 12, color: COLORS.muted, marginTop: 1, fontWeight: '600' },

  // Toolbar
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, marginTop: 6 },
  segment: { flexDirection: 'row', backgroundColor: '#E7ECF3', borderRadius: 10, padding: 3 },
  seg: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, height: 30, borderRadius: 8 },
  segOn: { backgroundColor: COLORS.primary },
  segTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted },
  segTxtOn: { color: '#fff' },
  roleBadge: { backgroundColor: COLORS.greenBg, borderRadius: 8, paddingHorizontal: 10, height: 28, justifyContent: 'center' },
  roleBadgeTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.green },
  newTaskBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#EAF1FE', borderWidth: 1.5, borderColor: COLORS.primary },
  newTaskTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  workdayBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, paddingHorizontal: 12, borderRadius: 10, backgroundColor: COLORS.green, minWidth: 108, justifyContent: 'center' },
  workdayBtnEnd: { backgroundColor: COLORS.red },
  workdayBtnLoading: { backgroundColor: '#94A3B8' },
  workdayTxt: { fontSize: 12.5, fontWeight: '800', color: '#fff' },

  // Filter dropdowns
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, marginTop: 10, zIndex: 20 },
  filter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 42, paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  filterOn: { borderColor: COLORS.primary },
  filterTxt: { flex: 1, fontSize: 12.5, fontWeight: '700', color: COLORS.ink },
  filterList: { position: 'absolute', top: 46, left: 0, right: 0, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, ...SHADOW, zIndex: 30 },
  filterItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  filterItemOn: { backgroundColor: '#EEF3FF' },
  filterItemTxt: { fontSize: 13.5, color: COLORS.ink },

  // View-mode toggle (board ⇄ list), sits at the end of the filter row.
  viewToggle: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#EAF1FE', borderWidth: 1.5, borderColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },

  // List (accordion) view
  listScroll: { flex: 1 },
  listSection: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, marginBottom: 8 },
  listSectionTxt: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  listRow: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, marginBottom: 8, overflow: 'hidden' },
  listRowOpen: { borderColor: COLORS.primary },
  // Notification-arrival highlight: brighter border + a colored wash overlay.
  listRowPulse: { borderColor: COLORS.primary, borderWidth: 2 },
  listPulseWash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#DCE7FB', borderRadius: 14 },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52 },
  listDot: { width: 9, height: 9, borderRadius: 5 },
  // NOT flex:1 — the name must claim only its own width, or its touchable covers
  // the row and every tap opens details instead of the dropdown.
  listName: { fontSize: 14, fontWeight: '700', color: COLORS.ink },
  // Same "opens details" cue as the kanban card and the web board.
  listNameLink: { color: COLORS.primary, textDecorationLine: 'underline' },
  // Shrinks (so long names still truncate to one line) but never grows.
  listNameHit: { flexShrink: 1, paddingVertical: 15 },
  // Eats the leftover width for the OUTER (dropdown) touchable.
  listSpacer: { flex: 1, alignSelf: 'stretch', minWidth: 8 },
  listBody: { paddingHorizontal: 14, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#F0F3F8', paddingTop: 10 },
  listPill: { alignSelf: 'flex-start', marginBottom: 4 },

  // Live activity strip (stacked rows so the break line + totals fit on a phone)
  liveStrip: { marginHorizontal: 14, marginTop: 10, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.red, borderRadius: 6, paddingHorizontal: 7, height: 22 },
  liveBadgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveBadgeTxt: { color: '#fff', fontSize: 10.5, fontWeight: '900' },
  liveWorking: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  liveWorkingTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.green, flexShrink: 1 },
  liveIdle: { fontSize: 12.5, color: COLORS.muted, fontWeight: '600' },
  breakPill: { alignSelf: 'flex-start', backgroundColor: '#FDE68A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  breakPillTxt: { fontSize: 12, fontWeight: '800', color: '#6b5200' },

  // "Not on a task?" — declare a meeting/break without waiting to be asked.
  notOnTaskBtn: { marginLeft: 8, backgroundColor: '#E0E7FF', borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4 },
  notOnTaskTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },

  // The open Meeting/Break block. Violet, deliberately NOT the break pill's
  // amber — this is time that is never counted as task time.
  nontaskBox: { gap: 6 },
  nontaskPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#EDE9FE', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  nontaskPillTxt: { flex: 1, fontSize: 12, fontWeight: '800', color: '#4C1D95' },
  // The other two reasons + End, right under the pill. Wraps rather than shrinking:
  // on a narrow phone these must stay tappable, not squeeze into slivers.
  nontaskBtnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  nontaskSwitch: {
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff',
  },
  nontaskSwitchAlert: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  nontaskSwitchTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },
  // Says why there is no End button, so its absence reads as designed, not missing.
  nontaskHint: { fontSize: 10.5, color: COLORS.faint, marginTop: 2 },

  // Switch confirm — same centered-card idiom as the other confirm popups.
  confirmWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  confirmCard: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 22, alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 22 },
  swIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#E0E7FF', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  confirmTitle: { fontSize: 18.5, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  swFlow: { width: '100%', backgroundColor: COLORS.bg, borderRadius: 14, padding: 12, marginTop: 14, alignItems: 'center', gap: 2 },
  swRow: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%' },
  swEmoji: { fontSize: 19 },
  swName: { fontSize: 14, fontWeight: '900', color: COLORS.ink },
  swMeta: { fontSize: 11, color: COLORS.faint, marginTop: 1 },
  swTag: { fontSize: 11, fontWeight: '800', color: COLORS.muted },
  confirmMsg: { fontSize: 12.5, color: COLORS.muted, textAlign: 'center', lineHeight: 18, marginTop: 12 },
  swWarn: { fontSize: 12, fontWeight: '800', color: COLORS.red, textAlign: 'center', marginTop: 6 },
  confirmBtns: { flexDirection: 'row', gap: 12, marginTop: 18, width: '100%' },
  confirmBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, borderRadius: 14 },
  confirmCancel: { backgroundColor: '#EEF2F8' },
  confirmCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 14.5 },
  swDo: { backgroundColor: COLORS.primary },
  confirmDoTxt: { color: '#fff', fontWeight: '800', fontSize: 14.5 },

  // The "Not on a task?" popup.
  idleIntro: { fontSize: 13.5, color: COLORS.muted, marginBottom: 10, lineHeight: 19 },
  idleGuide: {
    backgroundColor: COLORS.redBg, borderRadius: 10, padding: 10, marginBottom: 12,
    borderWidth: 1, borderColor: '#FCA5A5',
  },
  idleGuideTxt: { fontSize: 11.5, color: COLORS.red, lineHeight: 17 },
  idleGuideB: { fontWeight: '900' },
  idleOpt: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 12,
    paddingHorizontal: 13, paddingVertical: 12, marginBottom: 10,
  },
  idleOptAlert: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  idleOptEmoji: { fontSize: 20 },
  idleOptLabel: { fontSize: 14.5, fontWeight: '800', color: COLORS.ink },
  idleOptNote: { fontSize: 11.5, color: COLORS.muted, marginTop: 2, lineHeight: 15 },
  idleNote: {
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 14, color: COLORS.ink, marginTop: 4,
  },
  // Red on purpose: the length limit is a real constraint (it has to fit the Map
  // chip), not a suggestion, so it should read as one.
  idleNoteHint: { fontSize: 11.5, color: COLORS.red, marginTop: 6, marginBottom: 4 },
  idleLater: { fontSize: 13, fontWeight: '700', color: COLORS.faint, textAlign: 'center', paddingVertical: 8 },
  livePresence: { fontSize: 12, color: COLORS.muted, fontWeight: '600' },
  liveProductive: { color: COLORS.green, fontWeight: '800' },
  idleWarn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginTop: 6, backgroundColor: COLORS.redBg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  idleWarnTxt: { flex: 1, fontSize: 11.5, color: '#8a1c14', fontWeight: '600' },

  toggleRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, marginTop: 8, marginBottom: 2 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 38, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  toggleOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleTxt: { fontSize: 13, fontWeight: '800', color: COLORS.muted },
  toggleTxtOn: { color: '#fff' },

  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 10, backgroundColor: '#fff', borderRadius: 14, paddingHorizontal: 14, height: 46, borderWidth: 1, borderColor: COLORS.line },
  searchInput: { flex: 1, fontSize: 15, color: COLORS.ink },

  // Horizontal kanban board
  board: { flex: 1 },
  boardRow: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 },
  lane: {
    width: 278, marginRight: 14, borderRadius: 18, overflow: 'hidden',
    backgroundColor: '#EEF1F7',
    borderWidth: 1, borderColor: '#E4E9F2',
  },
  laneHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 15, paddingVertical: 13,
  },
  laneTitle: { flex: 1, color: '#fff', fontSize: 14.5, fontWeight: '900', letterSpacing: 0.2 },
  laneCount: {
    minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center',
  },
  laneCountTxt: { fontSize: 12.5, fontWeight: '900', color: COLORS.ink },
  laneBody: { maxHeight: LANE_MAX_H },
  laneEmpty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 44 },
  laneEmptyTxt: { fontSize: 12.5, color: COLORS.faint, fontWeight: '600' },

  mockHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: COLORS.amberBg, borderRadius: 10 },
  mockTxt: { flex: 1, fontSize: 12, color: COLORS.amber, fontWeight: '600' },

  // Card — colored accent bar + padded body
  card: {
    backgroundColor: '#fff', borderRadius: 14, marginBottom: 12, overflow: 'hidden',
    flexDirection: 'row', ...SHADOW,
  },
  // Notification-focus highlight overlay: a contrasting wash + ring that the
  // heartbeat fades in then out. Absolute-fills the card, sits under content
  // (pointerEvents none) so buttons stay tappable.
  focusWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  accent: { width: 5 },
  cardBody: { flex: 1, padding: 13 },
  // Row, not a bare block: the title now shares the line with the ⓘ affordance.
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '800', color: COLORS.navy, lineHeight: 20 },
  // Underlined + primary, the same "this opens details" cue the web board gives
  // the task name (kra_style.scss .kpi-task).
  cardTitleLink: { color: COLORS.primary, textDecorationLine: 'underline' },

  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 4 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillTxt: { fontSize: 11, fontWeight: '800' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.greenBg, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 4 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.green },
  liveTxt: { fontSize: 11, fontWeight: '800', color: COLORS.green },

  pausedPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.amberBg, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, marginBottom: 12 },
  pausedPillTxt: { flex: 1, fontSize: 12, fontWeight: '700', color: '#8a5a00' },
  metaBlock: { gap: 8, marginBottom: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaLabel: { fontSize: 12.5, color: COLORS.muted, width: 66 },
  metaValue: { flex: 1, fontSize: 13, color: COLORS.ink, fontWeight: '700' },
  avatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontSize: 9, fontWeight: '800' },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 2 },
  btnBusy: { height: 36, justifyContent: 'center', paddingLeft: 6 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 36, paddingHorizontal: 13, borderRadius: 10 },
  btnTxt: { fontSize: 12.5, fontWeight: '800' },
  btn_primary: { backgroundColor: COLORS.primary }, btnTxt_primary: { color: '#fff' },
  btn_green: { backgroundColor: COLORS.green }, btnTxt_green: { color: '#fff' },
  btn_amber: { backgroundColor: COLORS.amber }, btnTxt_amber: { color: '#fff' },
  btn_red: { backgroundColor: COLORS.red }, btnTxt_red: { color: '#fff' },
  btn_ghost: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line }, btnTxt_ghost: { color: COLORS.muted },
  btn_ghostRed: { backgroundColor: COLORS.redBg, borderWidth: 1.5, borderColor: '#F3C4C0' }, btnTxt_ghostRed: { color: COLORS.red },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  centerTxt: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 60 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, backgroundColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 22, height: 44 },
  retryTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  modalWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 18, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  modalSub: { fontSize: 13.5, color: COLORS.muted, marginTop: 2, marginBottom: 8 },
  modalLabel: { fontSize: 13, fontWeight: '800', color: COLORS.navy, marginTop: 12, marginBottom: 6 },
  userRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, marginBottom: 6 },
  userRowOn: { backgroundColor: '#EAF1FE', borderColor: COLORS.primary },
  userTxt: { fontSize: 14.5, color: COLORS.ink },
  reasonInput: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, padding: 12, minHeight: 60, fontSize: 14.5, color: COLORS.ink, textAlignVertical: 'top' },
  // Read-only banner — sits under the toolbar and explains the missing buttons.
  roBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    marginHorizontal: 14, marginBottom: 4, paddingVertical: 8, paddingHorizontal: 11,
    backgroundColor: COLORS.redBg, borderRadius: 10,
    borderLeftWidth: 3, borderLeftColor: COLORS.red,
  },
  roBannerTxt: { flex: 1, fontSize: 12, color: COLORS.red, fontWeight: '700' },
  // Pending Review → Accept: pick the type the task is filed as (drives its
  // REQ/UPT/BUG reference).
  typeRow: { flexDirection: 'row', gap: 8 },
  typeChip: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  typeChipOn: { borderColor: COLORS.green, backgroundColor: '#F0FDF4' },
  typeChipTxt: { fontSize: 13, fontWeight: '800', color: COLORS.muted },
  typeChipTxtOn: { color: COLORS.green },
  typeChipRef: { fontSize: 10.5, fontWeight: '700', color: COLORS.faint, marginTop: 2 },
  reasonChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reasonChip: { paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff', justifyContent: 'center' },
  reasonChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  reasonChipTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.ink },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  checkTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 18 },
  modalBtn: { flex: 1, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalCancel: { backgroundColor: '#EEF2F8' }, modalCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  modalOk: { backgroundColor: COLORS.primary }, modalOkTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // Web-style dialog (Pause Task)
  modalCard: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalHeadTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy },
  modalPad: { paddingHorizontal: 18, paddingTop: 14 },
  taskLabel: { fontSize: 14, color: COLORS.ink, fontWeight: '800' },
  taskName: { fontWeight: '600', color: COLORS.muted },
  whyTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 10 },

  quickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  quickLeft: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flex: 1 },
  quick: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 36, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  quickOn: { borderColor: COLORS.primary, backgroundColor: '#EAF1FE' },
  quickEmoji: { fontSize: 14 },
  quickTxt: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  quickUrgent: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 36, borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.red, backgroundColor: COLORS.redBg },
  quickUrgentOn: { backgroundColor: COLORS.red, borderColor: COLORS.red },

  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 46, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 14, marginTop: 12 },
  dropdownTxt: { fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  dropdownList: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, marginTop: 6, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  dropdownItemOn: { backgroundColor: '#EEF3FF' },
  dropdownItemTxt: { fontSize: 14, color: COLORS.ink },

  pauseNote: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, padding: 12, minHeight: 72, fontSize: 14.5, color: COLORS.ink, textAlignVertical: 'top', marginTop: 12 },
  pauseHelp: { fontSize: 12, color: COLORS.muted, marginTop: 12, marginBottom: 6, lineHeight: 17 },

  modalFoot: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 6 },
  footCancel: { paddingHorizontal: 18, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F8' },
  footCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 14.5 },
  footConfirm: { paddingHorizontal: 20, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5A623' },
  footConfirmTxt: { color: '#fff', fontWeight: '900', fontSize: 14.5 },

  // Colored modal headers
  headAmber: { backgroundColor: '#F5A623' },
  headAmberTitle: { fontSize: 16.5, fontWeight: '900', color: '#3d2c00' },
  headGreen: { backgroundColor: COLORS.green },
  headGreenTitle: { fontSize: 16.5, fontWeight: '900', color: '#fff' },
  headPurple: { backgroundColor: COLORS.primary },
  headPurpleTitle: { fontSize: 16.5, fontWeight: '900', color: '#fff' },
  headRed: { backgroundColor: COLORS.red },
  headRedTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 },
  headRedTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  // Soft (pale) green header — used by the "Task created" success popup, which
  // wants dark green text/icon on a light header (distinct from the solid
  // headGreen above that the Complete-Task popup uses with white text).
  headGreenSoft: { backgroundColor: '#DCFCE7' },
  headGreenSoftTitle: { fontSize: 16.5, fontWeight: '900', color: '#0F5132' },
  createdRefRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  createdRefLbl: { fontSize: 12, color: COLORS.muted, fontWeight: '700' },
  createdRefBadge: { backgroundColor: '#E0ECFF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  createdRefTxt: { fontSize: 14, fontWeight: '900', color: '#2563EB', letterSpacing: 0.5 },
  createdName: { fontSize: 15, fontWeight: '700', color: COLORS.ink, marginBottom: 12 },
  createdInfo: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  createdInfoTxt: { flex: 1, fontSize: 12.5, color: COLORS.muted, lineHeight: 18 },

  // End Workday summary
  statTiles: { flexDirection: 'row', gap: 8, marginTop: 12 },

  // Workday Map (End Workday popup) — flowing chips: start → task → break → … → end.
  mapBox: { marginTop: 12, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 },
  mapTitle: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginBottom: 8 },
  mapFlow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  mapArrow: { color: '#9CA3AF', fontSize: 15, fontWeight: '700' },
  mapChip: { borderWidth: 1, borderTopWidth: 3, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: '#fff', minWidth: 92, maxWidth: 152 },
  mapChipLabel: { fontSize: 12, fontWeight: '700', color: COLORS.ink },
  mapChipTime: { fontSize: 10.5, color: COLORS.muted, marginTop: 1 },
  mapChipNote: { fontSize: 10.5, color: '#374151', fontStyle: 'italic', marginTop: 1 },
  statTile: { flex: 1, backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 10 },
  statTileLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  statTileVal: { fontSize: 13, color: COLORS.ink, fontWeight: '800', marginTop: 4 },
  statTileBig: { fontSize: 19, fontWeight: '900', marginTop: 4 },
  // The standard-day verdict under Presence — green at/over, red under.
  statTileFoot: { fontSize: 10.5, fontWeight: '800', marginTop: 2 },
  awayBox: { backgroundColor: '#FEF9E7', borderRadius: 12, padding: 12, marginTop: 14 },
  awayTitle: { fontSize: 13.5, fontWeight: '900', color: COLORS.ink },
  awaySub: { fontSize: 11.5, fontWeight: '600', color: COLORS.muted },
  awayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  awayCell: { width: '31.5%', backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 8, alignItems: 'center' },
  awayCellLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  awayCellVal: { fontSize: 14, color: COLORS.ink, fontWeight: '900', marginTop: 2 },
  awayEvent: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  awayTag: { backgroundColor: '#E7ECF3', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  awayTagTxt: { fontSize: 11, fontWeight: '800', color: COLORS.ink },
  awayTagUrgent: { backgroundColor: '#F6C244' },   // yellow, like the web module
  awayTagTxtUrgent: { color: '#5c4400' },
  awayEventTxt: { flex: 1, fontSize: 11.5, color: COLORS.muted },
  endHint: { fontSize: 12.5, color: COLORS.red, fontWeight: '700', marginTop: 12 },
  tasksTitle: { fontSize: 14.5, fontWeight: '900', color: COLORS.navy, marginTop: 16, marginBottom: 6 },
  taskTableHead: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: COLORS.line, paddingBottom: 6 },
  thRef: { width: 50, fontSize: 12, fontWeight: '800', color: COLORS.muted },
  thTitle: { flex: 1, fontSize: 12, fontWeight: '800', color: COLORS.muted },
  thTime: { width: 64, fontSize: 12, fontWeight: '800', color: COLORS.muted, textAlign: 'right' },
  taskRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  tdRef: { width: 50, fontSize: 13, fontWeight: '800', color: COLORS.ink },
  tdTitle: { flex: 1, fontSize: 13, color: COLORS.ink },
  tdTime: { width: 64, fontSize: 13, fontWeight: '800', color: COLORS.navy, textAlign: 'right' },

  // Info banners
  bannerBlue: { backgroundColor: '#DBF0F7', borderRadius: 10, padding: 12, marginTop: 12, marginBottom: 4 },
  bannerBlueTxt: { fontSize: 12.5, color: '#0b5566', lineHeight: 18 },
  bannerYellow: { backgroundColor: '#FEF6D8', borderRadius: 10, padding: 12, marginTop: 12, marginBottom: 4 },
  bannerYellowTxt: { fontSize: 12.5, color: '#6b5200', lineHeight: 18 },

  // Key/value rows in modals
  kv: { fontSize: 14, color: COLORS.ink, marginTop: 6 },
  kvStrong: { fontWeight: '800', color: COLORS.navy },
  kvRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  stateChip: { backgroundColor: '#22B8CF', borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  stateChipTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  hr: { height: 1, backgroundColor: COLORS.line, marginVertical: 14 },

  // Form fields
  fieldLabel: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 7 },
  fieldHint: { fontSize: 12, color: COLORS.muted, marginTop: 5 },
  mandatory: { fontSize: 12, color: COLORS.red, marginTop: 5, fontWeight: '700' },
  textInput: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14.5, color: COLORS.ink },
  inputErr: { borderColor: '#F3C4C0' },
  footDisabled: { opacity: 0.45 },
  selectBox: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, padding: 4 },
  twoCol: { flexDirection: 'row', gap: 12 },
  segFull: { flexDirection: 'row', gap: 8 },
  segFullItem: { flex: 1, height: 40, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  segFullItemOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  segFullTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.ink },

  errorMsg: { fontSize: 14.5, color: COLORS.ink, lineHeight: 21, paddingVertical: 10 },
});
