// KPI Action Board — the module's task kanban, mirroring the web layout:
// horizontally-scrolling colored lane columns (Pending Review, Regular,
// Important, Urgent, In Progress, Paused, …), each with a count badge and its
// cards stacked vertically. Each card exposes the state-appropriate actions
// (Start / Resume / Complete / Pause / Reassign).
import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import {
  View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, StyleSheet, Dimensions,
  ActivityIndicator, Modal, StatusBar as RNStatusBar, Animated, Easing,
  Platform, UIManager, LayoutAnimation, findNodeHandle, Keyboard,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Defs, Rect, Stop, LinearGradient as SvgLinearGradient } from 'react-native-svg';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import KpiTaskDetail from './KpiTaskDetail';
import AddTimeModal from '../components/AddTimeModal';
import AppDialog from '../components/AppDialog';
import {
  LANES, groupIntoLanes, laneForTask, isTodayTask, fetchTasks, fetchTaskById, fetchUsers, fetchPeople,
  startTask, pauseTask, resumeTask, completeTask, reassignTask, adminDeleteTask, createProgress,
  switchTask, pauseAllTasks, revertSignoff,
  approveTask, rejectTask, getTaskChecklists,
  CHECKLIST_ITEMS, MGR_CHECKLIST_ITEMS, PAUSE_REASONS, PRIORITIES,
  getWorkdayStatus, startWorkday, endWorkday, pauseWorkday, resumeWorkday,
  selfCreateTask, fetchProjects, fetchClientTree, getTodaySummary, getLiveStatus,
  acceptSelfCreated, rejectSelfCreated,
  IDLE_REASONS, setIdleReason, endNonTask, IDLE_NOTE_MAX,
  sinceResume, BREAK_SWITCH_REASONS, switchBreak,
} from '../services/kpiActions';
import { createLogger } from '../api/logger';
import { scheduleTaskReminder, cancelTaskReminder } from '../services/reminders';
import { scheduleTaskAlarm, stopAlarm, alarmAvailable, pickAlarmSound, titleFromUri } from '../services/alarm';
import { getReminders, setReminder, removeReminder, getReminderPresets, setReminderPresets, getAlarmSound, setAlarmSound, getAlarmSettings, setAlarmSettings } from '../api/session';
import DurationTimePicker from '../components/DurationTimePicker';
import PulseDot from '../components/PulseDot';
import * as H from '../utils/haptics';
import { publishWidgetState, clearWidgetState } from '../utils/taskWidget';
import { workdayButtonState } from '../utils/workdayState';
import { validateWorkdayNote, NOTE_MAX } from '../utils/workdayNote';
// Why a blocked task is blocked, in the server's words. Pure + unit-tested
// against real payloads (utils/__tests__/taskGate.test.js).
import { gateLabel } from '../utils/taskGate';

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
//
// Module scope means it outlives the component — which is the point — but it also
// outlives the LOGIN, and it carries no user identity. Left alone, the next person
// to sign in on this device inherits the previous one's workday: seeded `true`,
// they get live action buttons that every server call then refuses. So logout
// clears it (see resetWorkdayCache below) and nothing else may write it.
let WORKDAY_CACHE = null;

// Called from App's logout(). Module state is per-BUNDLE, not per-session, so
// without this the cache crosses from one account to the next; Expo Go keeps the
// same JS context alive across a sign-out.
//
// There used to be a DAYDONE_CACHE next to it, with the same lifetime and the
// same lack of a user or a date stamp — and a worse failure. Ending your workday
// set it, and nothing ever unset it: not logging out, not the date rolling over.
// The next user, or the same user the next morning, opened the board to a
// DISABLED "Workday ended for today" — and because that state also suppresses the
// "you haven't started your workday" prompt, there was no way forward on screen.
// The one thing that corrected it was a single mount fetch whose failure was
// swallowed. It's gone: `dayDone` is App's, passed in as a prop.
export function resetWorkdayCache() {
  WORKDAY_CACHE = null;
}

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
const { width: SW, height: SH } = Dimensions.get('window');
const LANE_MAX_H = Math.round(SH * 0.78); // lane card-scroll height, adapts to screen

// Phone vs tablet. Read once, like LANE_MAX_H — so it does NOT follow a rotation;
// that is a known limitation, not an oversight.
//
// This exists because "looks right" was only ever true at tablet width. The End
// Workday popup is the worst of it: its tiles and footer were laid out as fixed
// horizontal rows that happen to fit 1200px, and on a phone the text clipped and
// the footer spilled off the left edge.
const IS_NARROW = SW < 480;

// A modal body cannot use LANE_MAX_H. That is 78% of the screen and correct for
// the lane card-scrolls, which sit on a plain page — but a modal body also has to
// leave room for everything around it: modalWrap padding (48), the header (~50),
// the footer (~72) and the End Workday "Pause instead" strip (~60). At 0.78·SH
// plus 230 the card came to 854dp on an 800dp phone, so the footer was pushed off
// the bottom of the screen. On a 1280dp tablet the same sum fits, which is why it
// looked perfect there and broken on a phone.
const MODAL_BODY_MAX_H = Math.max(240, Math.round(SH * 0.78) - 230);

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
// The only two pause reasons that need words. Every other code IS its own
// explanation, and asking for one taught people to type "break" into a box next
// to a button already labelled Break. Urgent keeps it because that text becomes
// the body of the 🚨 alert the owner receives. Mirrors the web's needsNote.
// Reasons that need words typed. 'meeting' is here because "Meeting" alone says
// nothing about what it cost the day — the web already required it, and the app
// showed the box without enforcing it, so the two disagreed about what a valid
// Meeting pause was.
const noteRequiredFor = (code) => code === 'other' || code === 'urgent' || code === 'meeting';

// Work that has already been started and stopped — the same triple `canResume`
// uses, so "shows a Resume button" and "counts as paused" cannot drift apart.
const PAUSED_STATES = ['paused', 'hold', 'rework'];

// Identity of one list-view task row. Lane-scoped, because a task worked today
// appears in BOTH the Today lane and its status lane: keyed by id alone, the two
// copies would collide as FlatList keys and share one open/closed state, so
// opening the actions on one would silently open the other.
const rowKey = (laneKey, taskId) => `t:${laneKey}:${taskId}`;

// Width of the soft cut at the end of a clipped task name, in px. Wide enough to
// read as a fade over two or three characters rather than a hard edge.
const FADE_W = 28;

// Productive = finished-log base + every RUNNING task's live seconds.
//
// This used to add only `active_task`, which is just the first of them, so a
// developer multitasking two timers watched Productive tick at half the rate the
// two task clocks above it were ticking — the same numbers on the same screen
// disagreeing. The server counts every active log, so summing them all is what
// makes the live figure converge on the one it will be replaced by.
export function productiveLive(live, nowMs) {
  const base = live?.productive_base || 0;
  const running = live?.active_tasks?.length
    ? live.active_tasks
    : (live?.active_task ? [live.active_task] : []);
  return running.reduce(
    (sum, at) => sum + (at?.timer_start ? secsSince(at.timer_start, nowMs) : 0),
    base,
  );
}

// Live Presence — TIME AT WORK: the clock since login MINUS whatever the
// workday has been paused for. Matches the server's presence_seconds exactly
// (kpi.work.session._compute_totals), which takes off the same two pieces.
//
// BOTH halves of the pause are needed. paused_base holds the COMPLETED pauses;
// paused_since is the one currently open, which the server deliberately never
// folds into paused_seconds. Read only the base and this clock would run straight
// through the freeze — the exact thing pausing exists to stop.
//
// The `· paused` marker beside this is what says why it has stopped, so a
// deliberately frozen clock cannot read as a stuck display.
export function presenceLive(live, nowMs) {
  if (!live?.login_raw) return 0;
  const paused = (live.paused_base || 0)
    + (live.paused_since ? secsSince(live.paused_since, nowMs) : 0);
  return Math.max(0, secsSince(live.login_raw, nowMs) - paused);
}

// "09:30–18:15 · 1h 20m paused" — the line under Presence that
// reconciles it with the day's own stamps. Presence stops while the workday is
// frozen, so it no longer equals logout - login, and an unexplained mismatch
// between a figure and the two timestamps beside it is exactly what made the raw
// clock the definition before this.
//
// logout_at is empty while the day is still open (the End Workday PREVIEW is
// rendered before the session closes), so the range degrades to just the start
// rather than printing a dangling dash. Empty when nothing was paused: with no
// pause Presence DOES equal the stamps, and there is nothing to explain.
export function presenceFootnote(sum) {
  if (!sum || !(sum.paused_seconds > 0)) return '';
  // HH:MM, not HH:MM:SS. The stamps arrive as '%Y-%m-%d %H:%M:%S' and the whole
  // line has to survive numberOfLines={1} in half a tile on a phone; seconds are
  // three characters twice over and say nothing. Same trim the PNG header uses.
  const hm = (stamp) => ((stamp || '').split(' ')[1] || stamp || '').slice(0, 5);
  const from = hm(sum.login_at);
  const to = hm(sum.logout_at);
  const span = from ? (to ? from + '–' + to : from) : '';
  return (span ? span + ' · ' : '') + (sum.paused_display || '0m') + ' paused';
}

// The Today lane's indigo, shared by its header (via LANES) and the "Today" meta
// row on the card, so the figure and the lane it explains read as one thing.
// Matches `.kpi-today` in the module's kra_style.scss.
const TODAY_FG = '#4F46E5';

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

// Descriptions are typed into plain <textarea>s, but some rows carry HTML from older
// editors — an empty one is stored as '<p><br></p>', which would otherwise render as
// visible markup and count as "has a description". Strip tags and decide on what's left.
function plainText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  // Offer Add time only once the work is at or past the number it was given.
  // Mirrors canAddTime in kpi_action.js:1989 — same states, same 80% threshold,
  // and the same "no estimate means offer it immediately", since any time spent
  // overruns an estimate of zero. The server still has the final say (it refuses
  // once the client owns the number, and for someone else's task); this only
  // decides whether the button is worth showing.
  const canAddTime = (() => {
    if (!['in_progress', 'paused'].includes(st)) return false;
    const estSec = estimateSecs(task);
    if (estSec <= 0) return true;
    return (task.timer_total_seconds || 0) >= estSec * 0.8;
  })();
  // The SERVER's answer on whether work may begin (kra.kpi._start_block, shipped
  // as can_start), not a second opinion derived from task_state. A paused or
  // never-started workday, an unaccepted task and an unapproved client all land
  // here. Payloads from an older server have no can_start — treat that as
  // allowed, so the button behaves as it always did rather than locking up.
  const startBlocked = task.can_start === false;
  const gate = gateLabel(task);
  // Exactly the "Pending Review" lane rule (laneForTask in services/kpiActions.js)
  // and the same condition the server enforces on accept/reject_self_created.
  // Independent of task_state: the dev may already be working it.
  const awaitingReview = !!task.is_self_created && !task.admin_accepted;
  return (
    <>
      {/* Meta */}
      <View style={s.metaBlock}>
        {/* What the developer asked for, while it still differs from what is set.
            Once an admin agrees (or never changes it) the two match and this
            would be noise, so it hides itself. */}
        {task.requested_priority && task.requested_priority !== task.priority ? (
          <View style={s.metaRow}>
            <Ionicons name="flag-outline" size={14} color={COLORS.muted} />
            <Text style={[s.metaValue, { flex: 1 }]} numberOfLines={1}>
              Developer asked for {PRIORITIES.find((p) => p.code === task.requested_priority)?.label || task.requested_priority}
            </Text>
          </View>
        ) : null}
        {task.time_by_user && task.time_by_user.length ? (
          task.time_by_user.map((tu) => (
            <View key={tu.user_id} style={s.metaRow}>
              <View style={s.avatar}><Text style={s.avatarTxt}>{initials(tu.user_name)}</Text></View>
              <Text style={[s.metaValue, { flex: 1 }]} numberOfLines={1}>
                {/* is_current is `uid === k.user_id.id` (kra_api.py map_rec) — it means
                    "this row is the task's CURRENT ASSIGNEE", not "is working right
                    now". Labelling it "currently working" put that phrase on every
                    paused, on-hold and completed task the assignee had ever touched,
                    which is the one reading it cannot support. Whether work is
                    actually running is task_state, so say that only when it is. */}
                {tu.user_name}{tu.is_current ? (running ? ' (currently working)' : ' (assignee)') : ''}
              </Text>
              {/* Green on the same condition as the label above, for the same reason:
                  it is the "live" colour everywhere else on this card, so painting
                  the assignee green on a paused task said running twice over. */}
              <Text style={{ fontSize: 13, fontWeight: '700', color: (tu.is_current && running) ? COLORS.green : COLORS.muted, marginLeft: 8 }}>{tu.display}</Text>
            </View>
          ))
        ) : (
          <View style={s.metaRow}>
            <View style={s.avatar}><Text style={s.avatarTxt}>{initials(task.user_name)}</Text></View>
            <Text style={s.metaLabel}>Assignee</Text>
            <Text style={s.metaValue} numberOfLines={1}>{task.user_name || 'Unassigned'}</Text>
          </View>
        )}
        {/* Who the work is for. A MetaRow and not a chip in cardTop/chipRow: the lane
            is a fixed 278px, so those rows overflow — MetaRow's value truncates. */}
        {task.client_name ? (
          <MetaRow icon="business-outline" label="Client" value={task.client_name} />
        ) : null}
        <MetaRow icon="time-outline" label="Time" value={fmtHMS(liveSeconds(task, nowMs))}
          valueColor={running ? COLORS.green : undefined} />
        {/* A SECOND clock, for a task that was resumed rather than started: the
            Time row above keeps climbing across the whole task, which answers
            "what has this cost" and not "how long have I been back on it". The
            reason comes from pause_reason_code, so it says what you came back
            FROM. Nothing new is fetched for this — see sinceResume(). */}
        {(() => {
          const sr = sinceResume(task);
          return sr ? (
            <MetaRow icon="play-circle-outline" label="Resumed"
              value={`${fmtHMS(secsSince(sr.startIso, nowMs))} ${sr.label}`}
              valueColor={COLORS.green} />
          ) : null;
        })()}
        {/* What this task cost TODAY, which is the number the Today lane sorts by —
            without it the ordering there has no visible reason. Absent when zero,
            so a task not touched today doesn't gain a line reading "0h 0m 0s".

            Static, and deliberately NOT given nowMs like the Time row above: the
            server's today_seconds ALREADY includes the open segment's now − start
            (kra_api.py), so ticking it here would count a running task's elapsed
            time twice. The 20s poll refreshes it, and a still number that is right
            beats a moving one that is wrong. */}
        {(task.today_seconds || 0) > 0 ? (
          <MetaRow icon="today-outline" label="Today" value={fmtHMS(task.today_seconds)}
            valueColor={TODAY_FG} />
        ) : null}
        {/* Why the estimate grew, on the card rather than only in the audit log —
            an estimate that changed with nothing explaining it reads exactly like
            one that was simply wrong. /kra_kpi/tasks/get has always sent these
            three fields (kra_api.py map_rec) and the app read none of them, so the
            overrun was only explicable by opening Task Details or the web.

            The count and the reason are checked separately, matching the web: an
            extension can exist without a reason surviving on the record, and the
            reason is overwritten on each extension so only the latest is here. */}
        <MetaRow
          icon="flag-outline" label="Estimate" value={task.estimate_display || '00:00'}
          trailing={task.estimate_extension_count ? (
            <View
              style={s.extBadge}
              accessibilityLabel={`Extended ${task.estimate_extension_count} time(s) by ${task.estimate_extended_by_name || 'someone'}`}
            >
              <Ionicons name="arrow-up" size={10} color="#B45309" />
              <Text style={s.extBadgeTxt}>extended {task.estimate_extension_count}</Text>
            </View>
          ) : null}
        />
        {/* One line, always. The lane is a fixed 278px and the reason can be 255
            characters; the web truncates it to a single line for the same reason. */}
        {task.estimate_extend_reason ? (
          <Text style={s.extReason} numberOfLines={1}>{task.estimate_extend_reason}</Text>
        ) : null}
      </View>

      {/* What the requester actually asked for. /kra_kpi/tasks/get has always sent
          `description` (kra_api.py map_rec) and the app rendered it nowhere, so the
          only way to read it was to open Task Details — or the web. Clamped: a long
          paste must not push the action buttons off the card. */}
      {plainText(task.description) ? (
        <View style={s.descBlock}>
          <View style={s.descHead}>
            <Ionicons name="document-text-outline" size={13} color={COLORS.muted} />
            <Text style={s.descLabel}>Description</Text>
          </View>
          <Text style={s.descTxt} numberOfLines={4}>{plainText(task.description)}</Text>
        </View>
      ) : null}

      {/* Who finished it, when, and whether an admin has picked it up for review.
          The payload has carried all four of these all along and the app rendered
          none of them — so "is anyone looking at this yet?" could only be answered
          on the web. Shown for work awaiting verification, matching the web card.
          Both the board card and the list dropdown render this component, so they
          get it together. */}
      {st === 'partially_completed' ? (
        <View style={s.doneBlock}>
          {task.completed_by_name ? (
            <View style={s.doneRow}>
              <Ionicons name="checkmark-circle" size={13} color={COLORS.green} />
              <Text style={s.doneTxt}>Completed by: <Text style={s.doneStrong}>{task.completed_by_name}</Text></Text>
            </View>
          ) : null}
          {task.completion_date ? (
            <View style={s.doneRow}>
              <Ionicons name="calendar-outline" size={13} color={COLORS.muted} />
              <Text style={s.doneMuted}>{task.completion_date}</Text>
            </View>
          ) : null}
          {task.coordinator_review_started_at ? (
            <View style={s.doneRow}>
              <Ionicons name="eye-outline" size={13} color={COLORS.primary} />
              <Text style={s.doneInfo}>
                Review started: {task.coordinator_review_started_at}
                {task.coordinator_review_started_by_name ? ` by ${task.coordinator_review_started_by_name}` : ''}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {task.progress_count > 0 ? (
        <View style={s.doneRow}>
          <Ionicons name="checkmark-circle" size={13} color={COLORS.green} />
          <Text style={s.doneTxt}>{task.progress_count} update{task.progress_count === 1 ? '' : 's'}</Text>
        </View>
      ) : null}
      {task.paused_reason && ['paused', 'hold', 'rework'].includes(st) ? (
        <View style={s.pausedPill}>
          <Ionicons name="pause-circle" size={14} color={COLORS.amber} />
          <Text style={s.pausedPillTxt} numberOfLines={2}>Paused: {task.paused_reason}</Text>
        </View>
      ) : null}

      {/* Why Start is dimmed, and when it will un-dim. Without it the button is
          just dead with no explanation, which is what made the workflow feel
          broken rather than merely waiting. Driven by the LABEL and not by
          can_start, because gateLabel deliberately returns '' for finished work
          — gating on can_start alone rendered an empty badge there. */}
      {!readOnly && gate ? (
        <View style={s.gatePill}>
          <Ionicons name="hourglass-outline" size={13} color="#92400E" />
          <Text style={s.gatePillTxt} numberOfLines={2}>{gate}</Text>
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
              {/* Dimmed when the server says no, but still TAPPABLE on purpose.
                  The web disables it and puts the reason in a tooltip; a phone
                  has no hover, so a truly disabled button would refuse silently
                  and read as a bug. Tapping a blocked one shows the server's own
                  message immediately, with no round-trip. */}
              {canStart && <Btn label="Start" icon="play" kind="primary" blocked={startBlocked} onPress={() => onAction('start', task)} />}
              {canResume && <Btn label="Resume" icon="play" kind="green" blocked={startBlocked} onPress={() => onAction('resume', task)} />}
              {canPause && <Btn label="Pause" icon="pause" kind="amber" onPress={() => onAction('pause', task)} />}
              {/* Hand THIS task over to another one. Sits next to Pause because
                  it is the same decision made differently: stop this, and say
                  what you moved to. Per-card on purpose — with multitask running
                  only this task pauses and the others carry on ticking. */}
              {canPause && <Btn label="Switch" icon="swap-horizontal" kind="ghost" onPress={() => onAction('switch', task)} />}
              {/* Extend the estimate from the card, the way the web does. It only
                  appears once the work is near or past the number it was given —
                  in_progress or paused, and 80% of the estimate spent — because
                  before that there is nothing to explain. A task with no estimate
                  at all offers it straight away, since anything is an overrun of
                  zero. Matches canAddTime in kpi_action.js:1989. */}
              {canAddTime && <Btn label="Add time" icon="hourglass-outline" kind="purple" onPress={() => onAction('addTime', task)} />}
              {canComplete && <Btn label="Complete" icon="checkmark-circle" kind="red" onPress={() => onAction('complete', task)} />}
              {/* Teal, not ghostRed. Sharing Delete's colour made a routine
                  "some of it is done" read as destructive — the web gave it its
                  own class (kpi-btn-partial) for exactly that reason. */}
              {canComplete && <Btn label="Partial Finish" icon="flag-outline" kind="teal" onPress={() => onAction('partial', task)} />}
              {/* Developer finished it → admin reviews: Approve (with QA checklist) sends it
                  to the client; Reject sends it back to the same developer with a reason. */}
              {isAdmin && st === 'partially_completed' && (
                <Btn label="Approve" icon="checkmark-done" kind="green" onPress={() => onAction('approveDone', task)} />
              )}
              {isAdmin && st === 'partially_completed' && (
                <Btn label="Reject" icon="close-circle" kind="ghostRed" onPress={() => onAction('rejectDone', task)} />
              )}
              {/* Admin pulls a task back off the client's desk. Only from
                  Awaiting Client — a completed, client-signed task is a billing
                  decision, not a workflow one, and the server refuses it. */}
              {isAdmin && st === 'awaiting_client' && (
                <Btn label="Revert" icon="arrow-undo" kind="amber" onPress={() => onAction('revertSignoff', task)} />
              )}
              {isAdmin && <Btn label="Reassign" icon="swap-horizontal" kind="ghost" onPress={() => onAction('reassign', task)} />}
              {/* Remove a task nobody has worked on. can_admin_delete is the
                  SERVER's answer (kra.kpi._may_admin_delete) — never re-derived
                  here, so the button can't offer what the route would refuse. */}
              {isAdmin && task.can_admin_delete && (
                <Btn label="Delete" icon="trash-outline" kind="ghostRed" onPress={() => onAction('adminDelete', task)} />
              )}
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
// Who a meeting is with. Multi-select, because a meeting rarely has exactly one
// other person, and the list includes CLIENTS — which is why it is fed by its own
// endpoint rather than the assignee list. Checkbox rows with an array toggle,
// matching AssignClientsModal in KraKpiDashboard rather than inventing a third
// control. Shared by the single Pause and Pause-all dialogs so the two cannot
// drift into behaving differently.
function MeetingPicker({ people, busy, query, setQuery, picked, setPicked }) {
  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((u) => String(u.name || '').toLowerCase().includes(q)) : people;
  return (
    <>
      <Text style={s.fieldLabel}>Who is it with?</Text>
      {busy && !people.length ? (
        <View style={{ paddingVertical: 14 }}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <>
          <View style={s.peopleSearch}>
            <Ionicons name="search" size={15} color={COLORS.muted} />
            <TextInput
              style={s.peopleSearchInput}
              placeholder="Search people…"
              placeholderTextColor={COLORS.faint}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
          </View>
          <ScrollView style={s.peopleList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {shown.map((u) => {
              const on = picked.includes(u.id);
              return (
                <TouchableOpacity
                  key={u.id} style={s.personRow} activeOpacity={0.7}
                  onPress={() => {
                    H.select();
                    setPicked((prev) => (prev.includes(u.id)
                      ? prev.filter((x) => x !== u.id)
                      : [...prev, u.id]));
                  }}
                >
                  <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20}
                    color={on ? COLORS.primary : COLORS.faint} />
                  <Text style={s.personName} numberOfLines={1}>{u.name}</Text>
                  <Text style={s.personRole}>{String(u.role || '').toUpperCase()}</Text>
                </TouchableOpacity>
              );
            })}
            {!shown.length ? (
              <Text style={s.idleNoteHint}>
                {people.length ? 'No one matches.' : 'No one else to pick from.'}
              </Text>
            ) : null}
          </ScrollView>
          <Text style={s.idleNoteHint}>
            {picked.length ? `${picked.length} selected` : 'Optional — pick anyone who is in it.'}
          </Text>
        </>
      )}
    </>
  );
}

// Two ways in, and they are deliberately different targets: tapping the ROW
// opens the task; tapping the ARROW expands the actions in place. Splitting them
// by area is what makes both reachable — the old version put the accordion on
// the whole row and the details on the name alone, so which one you got depended
// on hitting a word.
function TaskListRowBase({ task, expanded, rowKey: myRowKey, onToggle, onAction, busyId, nowMs, isAdmin,
                       reminder, pulse, onRowRef, onOpenDetail, readOnly = false }) {
  const p = PRIORITY[task.priority] || PRIORITY.regular;
  const running = task.task_state === 'in_progress';
  // With the client, so there is nothing left for the developer to do on it — the
  // detail sheet is all edit affordances. Admins keep it: they still review and invoice.
  const canOpen = onOpenDetail && (isAdmin || task.task_state !== 'awaiting_client');
  // Chevron rotates 0°→90° as the actions open, so the arrow says which way it
  // goes rather than just sitting there.
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
      {/* The WHOLE row opens the dropdown; the NAME is a nested touchable that
          opens KPI Details instead. Nesting (rather than two siblings sized by
          flex) is what makes "name → details, anywhere else → dropdown" reliable:
          the inner touchable swallows taps on the text, everything else — the
          spacer, the Live pill, the arrow — falls through to the outer one. */}
      {/* Reports its own row key, so the parent hands every row one stable callback
          rather than a fresh closure each render. The arrow is created inside the
          memoised component, so it is only rebuilt when this row actually is.
          The KEY and not the task id: this task may also be on screen in the Today
          lane, and only the copy that was tapped should open. */}
      <TouchableOpacity style={s.listHead} onPress={() => onToggle(myRowKey)} activeOpacity={0.7}>
        <View style={[s.listDot, { backgroundColor: p.fg }]} />
        <TouchableOpacity style={s.listNameHit} activeOpacity={0.6} disabled={!canOpen}
          onPress={() => canOpen && onOpenDetail(task)}>
          {/* Capped at half the row and CLIPPED, not ellipsised, with a fade over
              the last few characters. An ellipsis reads as "the name ends here";
              a fade reads as "there is more", which is true — the full name is in
              the dropdown. Clip rather than tail is what leaves letters under the
              gradient to fade, instead of a "…" sitting in clear space. */}
          <Text style={[s.listName, !!canOpen && s.listNameLink]}
            numberOfLines={1} ellipsizeMode="clip">{task.name}</Text>
          <Svg style={s.listNameFade} width={FADE_W} height="100%" pointerEvents="none">
            <Defs>
              {/* Per-row id. SVG ids are document-global, so every row sharing
                  "nameFade" meant they all painted with whichever definition
                  mounted last — the same collision GradientButton was fixed for
                  in 514f818. Keyed on the task id, which is already unique here. */}
              <SvgLinearGradient id={`nameFade-${task.id}`} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#ffffff" stopOpacity="0" />
                <Stop offset="1" stopColor="#ffffff" stopOpacity="1" />
              </SvgLinearGradient>
            </Defs>
            <Rect x="0" y="0" width={FADE_W} height="100%" fill={`url(#nameFade-${task.id})`} />
          </Svg>
        </TouchableOpacity>
        <View style={s.listSpacer} />
        {/* The priority badge deliberately does NOT live up here. It was tried on
            the row and, on a phone, it ran straight over the Live pill and the
            arrow — the header has room for the name, one live marker and the
            control, and nothing else. The coloured dot on the left already
            carries the priority; the full badge is in the body below. */}
        {running && (
          <View style={s.livePill}>
            {/* Beats while the timer runs — a static dot on a card that says
                "Live" was the one thing on screen not moving. */}
            <PulseDot size={7} color={COLORS.green} />
            <Text style={s.liveTxt}>Live</Text>
          </View>
        )}
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <Ionicons name="chevron-forward" size={18} color={expanded ? COLORS.primary : COLORS.muted} />
        </Animated.View>
      </TouchableOpacity>
      {expanded && (
        <View style={s.listBody}>
          {/* The full name, since the header had to cut it. First thing in the
              dropdown, because "what IS this task" is the reason the cut name
              sent you here. */}
          <Text style={s.listFullName}>{task.name}</Text>
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

// Memoised for the same reason as TaskCard — an expanded lane can hold hundreds
// of rows, and each one mounts two Animated.Values and its own SVG gradient.
const TaskListRow = React.memo(TaskListRowBase);

function TaskCardBase({ task, onAction, busyId, nowMs, isAdmin, reminder, pulse, onMeasure, onOpenDetail, readOnly = false }) {
  // Same rule as TaskListRow: with the client → not the developer's to open.
  const canOpen = onOpenDetail && (isAdmin || task.task_state !== 'awaiting_client');
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
      // Reports its own id alongside the offset, so the parent can hand one stable
      // callback to every card instead of minting a closure per row — which is what
      // lets React.memo below actually hold.
      onLayout={onMeasure ? (e) => onMeasure(task.id, e.nativeEvent.layout.y) : undefined}
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
        <TouchableOpacity style={s.cardTop} onPress={() => canOpen && onOpenDetail(task)}
          activeOpacity={0.6} disabled={!canOpen}>
          <Text style={[s.cardTitle, !!canOpen && s.cardTitleLink]} numberOfLines={2}>{task.name}</Text>
          {canOpen && <Ionicons name="information-circle-outline" size={16} color={COLORS.primary} style={{ marginLeft: 6, marginTop: 2 }} />}
        </TouchableOpacity>
        <View style={s.chipRow}>
          <View style={[s.pill, { backgroundColor: p.bg }]}>
            <View style={[s.pillDot, { backgroundColor: p.fg }]} />
            <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
          </View>
          {running && (
            <View style={s.livePill}>
              <PulseDot size={7} color={COLORS.green} />
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

// Memoised, because the board re-renders every second: a clock tick drives the
// live timer, and without this every card in every lane was rebuilt each time —
// hundreds of them, for one running task's seconds column. The call sites pass
// `nowMs` only to the task that is actually running (0 otherwise), so an idle
// card's props are genuinely unchanged and the memo holds.
const TaskCard = React.memo(TaskCardBase);

// A lane column that fades + slides up on mount, staggered by its index so the
// columns cascade in left-to-right the FIRST time the board is shown.
// Keeps the lane's onLayout (used to record its x-offset for scroll-to-focus).
//
// `stagger` is what makes it play once rather than once per mount. The board
// subtree unmounts every time the view toggles, so this used to replay in full on
// each switch: nine lanes at delay index*80 plus 380ms of duration meant the last
// lane did not finish arriving until roughly a second after the tap. That second
// WAS the "switching is slow" — nothing was being fetched or regrouped, the board
// was just refusing to show itself. Off, the lanes are simply there.
function AnimatedLane({ index, stagger, style, onLayout, children }) {
  const enter = useRef(new Animated.Value(stagger ? 0 : 1)).current;
  useEffect(() => {
    if (!stagger) { enter.setValue(1); return undefined; }
    const anim = Animated.timing(enter, {
      toValue: 1,
      duration: 380,
      delay: index * 80,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [enter, index, stagger]);
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

// Card-button gradients, lifted from the web's kra_style.scss so the two boards
// read as one product. Each pair is the 135° gradient that class paints:
//
//   primary   btn-primary        Start
//   green     btn-success        Resume / Accept / Approve
//   amber     btn-warning        Pause / Revert
//   red       btn-danger         Complete
//   teal      kpi-btn-partial    Partial Finish — its OWN colour. It used to share
//                                ghostRed with Delete, which is what the web fixed
//                                by giving it a class of its own.
//   purple    kpi-btn-addtime    Add time
//   ghost     btn-secondary      Switch / Reassign
//   ghostRed  btn-outline-danger Reject / Delete
// The button's fixed height (mirrors s.btn) and a width past any label we render.
// Both are constants so the gradient rect never has to be measured — see Btn.
const BTN_H = 36;
const BTN_GRAD_W = 400;

const BTN_GRAD = {
  primary:  ['#00b3ff', '#0066ff'],
  green:    ['#39ff6a', '#00c853'],
  amber:    ['#ffd000', '#ff8a00'],
  red:      ['#ff4d6d', '#e00030'],
  teal:     ['#2ee6d6', '#00a99d'],
  purple:   ['#8b7bff', '#4b32e0'],
  ghost:    ['#9aa8bd', '#5b6b82'],
  ghostRed: ['#ff8fa3', '#ff2d55'],
};

// `blocked` = the server won't allow this yet. Dimmed, but deliberately still
// pressable: the handler answers with the reason instead of the action, which is
// the only way to explain a gated button on a device with no tooltips.
function Btn({ label, icon, kind, onPress, blocked = false }) {
  const grad = BTN_GRAD[kind];
  // Per-instance id, via useId for the same reason GradientButton uses it: SVG ids
  // are document-global, so a shared one leaves every button painted with whichever
  // definition mounted last. A board can hold hundreds of these at once.
  const gid = `bg${String(useId()).replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <TouchableOpacity
      style={[s.btn, s[`btn_${kind}`], blocked && s.btnBlocked]}
      // Haptics live HERE rather than in the eight call sites, so every action
      // button feels the same and a new one can't be added without it. A blocked
      // button buzzes as an error: the press is real (it answers with a reason),
      // it just isn't the action asked for, and that difference should be felt
      // before the alert is read.
      onPress={(e) => { blocked ? H.err() : H.tap(); onPress && onPress(e); }}
      activeOpacity={0.85}
    >
      {/* The gradient sits behind the label, drawn with react-native-svg — already a
          dependency, where expo-linear-gradient would be a native module added for
          something the installed library draws.

          Deliberately NOT sized from the button. Two earlier attempts both failed
          on an auto-width button: `width="100%"` resolves against the SVG viewport
          as it was when the rect laid out, which is before the label has measured,
          so the fill stopped short and the button looked half-painted; measuring
          with onLayout fixed the width but only after a state round-trip that, on a
          busy JS thread, landed seconds later — the button visibly changed colour
          after the fact.

          So the ramp runs TOP TO BOTTOM over the one dimension that is already
          known: height is a fixed 36 in s.btn. Width is oversized past any label
          and clipped by the parent's overflow:hidden + borderRadius. Nothing needs
          measuring, so the gradient is correct in the first frame at any width.
          The web's is 135°; vertical is the honest approximation available without
          knowing the width, and at 36px tall the difference is not visible.

          A blocked button keeps its flat fill, so "dimmed and unavailable" still
          reads differently from "ready". */}
      {grad && !blocked ? (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <SvgLinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={grad[0]} />
              <Stop offset="1" stopColor={grad[1]} />
            </SvgLinearGradient>
          </Defs>
          <Rect x="0" y="0" width={BTN_GRAD_W} height={BTN_H} fill={`url(#${gid})`} />
        </Svg>
      ) : null}
      <Ionicons name={blocked ? 'lock-closed' : icon} size={14} color={grad && !blocked ? '#fff' : s[`btnTxt_${kind}`].color} />
      <Text style={[s.btnTxt, s[`btnTxt_${kind}`], grad && !blocked && { color: '#fff' }]}>{label}</Text>
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
    if (n.with) bparts.push(`with ${n.with}`);
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
  // workdayLocked: a developer whose workday is not open. The board stays fully
  // BROWSABLE — lanes, filters, search, details — but every task ACTION is hidden
  // until they start their day. Reading isn't work.
  // onWorkdayStarted / onWorkdayEnded: flip App's read-only state immediately
  // instead of waiting up to 5s for its workday poll.
  // dayDone: App's answer to "did this developer end their own workday today?".
  // App owns it — it polls /kpi_workday/status every 5s, re-reads on foreground,
  // and resets it on logout — so the board reads it instead of keeping a copy.
  workdayLocked = false, dayDone: dayDoneApp = false, onWorkdayStarted, onWorkdayEnded,
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
  // Meeting only: who it was with. Loaded once, lazily, the first time a Meeting
  // pause is opened — most pauses are not meetings and this list includes every
  // client, so fetching it up front would be a request nobody asked for.
  const [people, setPeople] = useState([]);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [meetingWith, setMeetingWith] = useState([]);   // array of user ids
  const [peopleQuery, setPeopleQuery] = useState('');
  // Validation shown inside the pause dialogs rather than as an OS alert.
  const [pauseErr, setPauseErr] = useState('');
  const [pauseAllErr, setPauseAllErr] = useState('');
  // Always change the code through this. Picking a reason that needs no note
  // clears whatever was typed, so a note written for Other cannot end up filed
  // against Lunch after the user changes their mind.
  // `forAll` targets the Pause-all dialog instead of the single one. Both share
  // the people list and the attendee selection — only one pause dialog is ever
  // open at a time, so a second copy of that state would only be a second thing
  // to keep in step.
  const pickPauseCode = (code, { forAll = false } = {}) => {
    if (forAll) {
      setPauseAllCode(code);
      if (!noteRequiredFor(code)) setPauseAllNote('');
    } else {
      setPauseCode(code);
      if (!noteRequiredFor(code)) setPauseNote('');
    }
    if (code !== 'meeting') { setMeetingWith([]); setPeopleQuery(''); }
    else if (!people.length && !peopleBusy) {
      setPeopleBusy(true);
      fetchPeople()
        .then((list) => setPeople(list || []))
        .catch((e) => log.warn('people load failed', e?.message))
        .finally(() => setPeopleBusy(false));
    }
  };

  // Switch modal. `switchFrom` is the task being HANDED OVER — the card the
  // button was pressed on. It is sent as from_kpi_id so that under multitask only
  // that timer stops. `false` means the picker is closed; `null` means "switch
  // whatever I'm on" (the strip button, only offered with one task running).
  const [switchFrom, setSwitchFrom] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchQuery, setSwitchQuery] = useState('');

  // Pause all — one shared reason for every running timer.
  const [pauseAllOpen, setPauseAllOpen] = useState(false);
  const [pauseAllCode, setPauseAllCode] = useState('break');
  const [pauseAllNote, setPauseAllNote] = useState('');
  const [pauseAllBusy, setPauseAllBusy] = useState(false);

  // Admin revert from Awaiting Client. The reason is REQUIRED: this reopens work
  // someone believed was finished, and "why is this back?" with no answer is what
  // wastes everyone's time.
  const [revertFor, setRevertFor] = useState(null);
  const [revertReason, setRevertReason] = useState('');
  const [revertBusy, setRevertBusy] = useState(false);

  // Finish (Complete / Partial) modal
  const [finishFor, setFinishFor] = useState(null);
  const [finishPartial, setFinishPartial] = useState(false);
  const [finishSummary, setFinishSummary] = useState('');
  // Validation message shown inside the Finish dialog, so the complaint and the
  // field it is about are on the same screen.
  const [finishErr, setFinishErr] = useState('');
  const [checklist, setChecklist] = useState({});

  // "You haven't started your workday" — asked on every board entry while locked,
  // so it's a prompt, not a trap: Cancel keeps them browsing read-only.
  const [startPrompt, setStartPrompt] = useState(false);
  // "Day done" = developer ended their own workday today → one start + one end
  // per day, no restart until tomorrow.
  //
  // Two sources, deliberately: the PROP is App's polled truth, and the echo is
  // this board's own answer for the moment before App catches up — the tick after
  // End Workday returns, the server refusing a restart, and admins (App's
  // onWorkdayEnded returns early for anyone who isn't a locked developer, so for
  // them the echo is the only source).
  //
  // The echo yields to the prop the instant the prop changes, which is the whole
  // fix: "not done" now propagates. A new date or a different user makes App
  // report false, and that false lands. The old module-scope cache had no way to
  // hear it — only ever set, never cleared.
  //
  // Declared here (before startPrompt's effect) because that effect reads it.
  const [dayDoneEcho, setDayDoneEcho] = useState(false);
  const dayDone = dayDoneApp || dayDoneEcho;
  const setDayDone = (v) => setDayDoneEcho(!!v);
  useEffect(() => { setDayDoneEcho(false); }, [dayDoneApp]);
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
  // The priority the ADMIN is setting on accept. Seeded from the developer's
  // requested_priority when the modal opens.
  const [acceptPriority, setAcceptPriority] = useState('regular');
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
  // Available to every role. In list mode:
  //   expandedLanes = which status headings are open (default: all collapsed —
  //                   only the Regular/Paused/… headings show until tapped).
  //   expandedRow   = the single task row whose ACTIONS are open (null = none),
  //                   held as a lane-scoped rowKey rather than a task id: the
  //                   same task can be on screen twice (Today + its status lane)
  //                   and only the copy that was tapped should open.
  //                   Opened by the row's arrow; tapping the row itself opens the
  //                   task details instead, so both are reachable.
  const [viewMode, setViewMode] = useState('list');
  // When opened focused on a status (from a Home stat card), that lane's heading
  // starts expanded so its tasks show immediately.
  const [expandedLanes, setExpandedLanes] = useState(() => (focusStatus ? new Set([focusStatus]) : new Set()));
  const [expandedRow, setExpandedRow] = useState(null);

  // KPI Details — a full screen that REPLACES the board, exactly as the web pane
  // replaces its list. Its own component owns the loading/writes; the board just
  // says which task and takes it back on Back.
  const [detailTask, setDetailTask] = useState(null);
  const openDetail = useCallback((task) => setDetailTask(task), []);
  // The task whose estimate is being extended, from the card's Add time button.
  // Null closes the dialog; the board stays exactly where it was.
  const [addTimeFor, setAddTimeFor] = useState(null);

  // The app's own alert/confirm, replacing Alert.alert. The OS dialog is square,
  // grey and system-font — visibly not this app, on a screen that is otherwise
  // rounded cards and gradients. `dlg` holds one at a time; a confirm is any that
  // carries onConfirm.
  const [dlg, setDlg] = useState(null);
  const say = useCallback((title, message, tone = 'info') => {
    // The haptic belongs to the tone, not the call site — a refusal should feel
    // different from a confirmation before either is read.
    if (tone === 'warn' || tone === 'danger') H.err();
    else if (tone === 'ok') H.ok();
    setDlg({ title, message, tone });
  }, []);
  const confirm = useCallback((opts) => setDlg({ ...opts, tone: opts.tone || 'warn' }), []);

  // Cross-fade the body when switching board ⇄ list (also fades in on first mount).
  //
  // Fades from 0.6, not from 0. At 0 the screen went completely blank the instant
  // the toggle was tapped, and stayed blank for as long as the new view took to
  // mount — so a slow switch did not read as slow, it read as broken. Starting
  // part-visible keeps the content on screen while it settles.
  const bodyFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    bodyFade.setValue(0.6);
    Animated.timing(bodyFade, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [viewMode, bodyFade]);
  const bodyStyle = { flex: 1, opacity: bodyFade };
  // The lane cascade is an introduction, so it belongs to the first time the board
  // is seen — not to every toggle back to it.
  const laneIntroDone = useRef(false);
  useEffect(() => { if (viewMode === 'board') laneIntroDone.current = true; }, [viewMode]);

  // Stable identities for the lane FlatLists. Inline versions would be new objects
  // and new functions on every render — and with the 1s clock tick below, that is
  // every second — which would defeat the memoised cards entirely.
  const laneContentStyle = useMemo(() => ({ padding: 10, paddingBottom: 24 }), []);
  const listContentStyle = useMemo(() => ({ padding: 14, paddingBottom: 28 }), []);
  const laneKeyExtractor = useCallback((t) => String(t.id), []);
  const onCardMeasure = useCallback((id, y) => { cardY.current[id] = y; }, []);
  const onRowRef = useCallback((id, r) => { listRowRefs.current[id] = r; }, []);
  // Takes the row's own key, not the task id — see expandedRow above.
  const onRowToggle = useCallback((key) => {
    animateNext();
    setExpandedRow((prev) => (prev === key ? null : key));
  }, []);

  // Workday
  // Seed from the cache so re-entry shows the right label immediately; null until
  // the first getWorkdayStatus() of the session resolves (button shows a spinner).
  const [workdayOpen, setWorkdayOpenState] = useState(WORKDAY_CACHE);
  // Open but frozen: Presence has stopped and no task may start until resumed.
  const [workdayPaused, setWorkdayPaused] = useState(false);
  // { reason, by } when an admin reopened today's workday. Empty otherwise.
  const [reopenInfo, setReopenInfo] = useState({ reason: '', by: '' });
  const [workdayPauseBusy, setWorkdayPauseBusy] = useState(false);
  const setWorkdayOpen = (v) => { WORKDAY_CACHE = v; setWorkdayOpenState(v); };
  const [workdayBusy, setWorkdayBusy] = useState(false);
  const [endSummary, setEndSummary] = useState(null); // payload for the End Workday popup
  const [endNote, setEndNote] = useState('');
  // Advice while typing, never a blocker — the note is optional and always was.
  const [endNoteHint, setEndNoteHint] = useState('');
  const [endBusy, setEndBusy] = useState(false);
  const [live, setLive] = useState(null); // live_status payload for the activity strip

  // "Not on a task?" — Meeting / Break / No tasks.
  const [idlePopup, setIdlePopup] = useState(false);
  const [idleBusy, setIdleBusy] = useState(null);   // the reason code being sent
  const [breakSwitchBusy, setBreakSwitchBusy] = useState(null); // break reason code being switched to
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
  // Every refusal on this screen funnels through here, so the error buzz is
  // attached once rather than at each of the ~15 call sites.
  // Kept as a name because a dozen call sites read better saying "show an error"
  // than "say this, warmly". One popup system underneath, though — the screen used
  // to have its own amber ⛔ modal alongside the OS Alert, which is two answers to
  // the same question.
  const showError = (title, message) => say(title, message, 'warn');

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
  // Admin-only assignee picker on New Task. `assignees` is the list from
  // /kra_kpi/get_users (developers + admins, never clients); ntUser is the
  // chosen one, null meaning "me".
  const [assignees, setAssignees] = useState([]);
  const [ntUser, setNtUser] = useState(null);
  const [ntUserOpen, setNtUserOpen] = useState(false);

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
      setWorkdayPaused(!!r?.is_paused);
      // An admin reopened this day — say so, and say why. Shown under the workday
      // button, which is where someone looks when their day reopens unexpectedly.
      setReopenInfo({ reason: r?.reopened_reason || '', by: r?.reopened_by || '' });
    }).catch((e) => {
      // Say so. This used to be `.catch(() => {})`, and it was the only thing that
      // corrected a stale cached "day done" — so when it failed (offline, or the
      // server mid-restart during a module deploy) the board sat on a disabled
      // "Workday ended for today" with nothing on screen explaining why. The
      // cache is gone, so a failure here now just leaves App's polled value in
      // charge, but a silent network error is still worth a line in the log.
      log.warn('mount workday status failed, using App\'s value', e?.message);
    });
  }, []);

  // ONE place that reacts to a live_status payload, so the 15s poll and the
  // after-an-action refresh can never drift apart on when to ask.
  const applyLive = useCallback((r) => {
    setLive(r);
    // Feed the home-screen widget from the same payload the strip renders, so
    // the two can never disagree about what is running. Fire-and-forget: the
    // widget is an extra and a failed write must not touch this screen.
    publishWidgetState(r);
    // Keep the paused banner and the Resume button honest between mounts. The
    // mount read of /kpi_workday/status is a one-shot, so without this a pause
    // or resume made on the WEB never reached a board that was already open, and
    // coming back from the background left a stale banner until the next remount.
    // live_status carries is_paused for exactly this reason — no extra request.
    if (r && typeof r.is_paused === 'boolean') setWorkdayPaused(r.is_paused);
    // Same argument for workday_open, which was already in the payload and
    // ignored: the mount read was the board's ONLY source, so a day started or
    // ended on the WEB — or a date rollover on a board left open overnight — kept
    // showing yesterday's button until someone remounted the screen.
    if (r && typeof r.workday_open === 'boolean') setWorkdayOpen(r.workday_open);
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
    // A paused workday never asks. The server suppresses this too, so this is
    // belt-and-braces for an app talking to an older build — but it is cheap and
    // the failure it prevents is not: every answer in that popup opens a break or
    // a non-task block, and pausing deliberately closed both.
    if (r?.idle_prompt && !r?.is_paused && !snoozed && seq > idleAskedRef.current) {
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

  // Change the reason on a break that is already running, without touching the
  // task it came from. The old way round was Resume then Pause-with-a-new-reason:
  // two calls that can half-apply, and which bank a few seconds of task time in
  // between that nobody worked. switch_break closes one break and opens the next
  // at the same instant, so Presence and the away buckets stay whole.
  async function doSwitchBreak(code) {
    log.info('switch break', { code });
    setBreakSwitchBusy(code);
    try {
      const res = await switchBreak(code);
      if (res && res.status === false) {
        showError("Couldn't switch that", res.message || 'Failed');
        return;
      }
      await refreshLive();
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setBreakSwitchBusy(null); }
  }

  // Filter by search + assignee + priority + status, then group into lanes.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return raw.filter((t) => {
      if (q && !((t.name || '').toLowerCase().includes(q) || (t.user_name || '').toLowerCase().includes(q))) return false;
      if (filterAssignee != null && t.user_id !== filterAssignee) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      // Today is not a status, so laneForTask never returns it — asking it would
      // filter the board to zero for the one lane people reach for most. It gets
      // the same predicate the grouping uses instead.
      if (filterStatus === 'today') { if (!isTodayTask(t)) return false; }
      else if (filterStatus && laneForTask(t) !== filterStatus) return false;
      return true;
    });
  }, [raw, search, filterAssignee, filterPriority, filterStatus]);

  const lanes = useMemo(() => groupIntoLanes(filtered), [filtered]);

  // The list view as ONE flat array — a heading row per non-empty lane, followed
  // by that lane's tasks when it is open.
  //
  // It used to be a ScrollView mapping every open lane's rows, so opening a lane
  // built all of them at once and the board's default view paid for it on load.
  // Flattening lets a single FlatList virtualise headings and rows together;
  // nesting one list per lane would not, because a VirtualizedList inside a plain
  // ScrollView cannot windowing-cull what its parent has already laid out.
  const listData = useMemo(() => {
    const out = [];
    for (const l of LANES) {
      const items = lanes[l.key] || [];
      if (!items.length) continue;
      const open = expandedLanes.has(l.key);
      out.push({ kind: 'head', key: `h:${l.key}`, lane: l, count: items.length, open });
      // Keyed by LANE + id, not id alone. A task worked today is in Today and in
      // its status lane, so with both open a bare `t:${id}` is emitted twice and
      // FlatList drops one of the rows.
      if (open) for (const t of items) out.push({ kind: 'row', key: rowKey(l.key, t.id), task: t });
    }
    return out;
  }, [lanes, expandedLanes]);
  const listKeyExtractor = useCallback((it) => it.key, []);
  const onLaneToggle = useCallback((key) => {
    animateNext();
    setExpandedLanes((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // Deliberately NOT seeding any lane open. Every heading starts closed and the
  // reader opens the one they want — with 639 tasks, choosing a lane for them is
  // both a guess and the most expensive thing the screen could do on arrival.
  // A focus target from a Home stat card is the one exception, and it is applied
  // in the initial state above.

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
    // The copy in the task's own STATUS lane, which is the one expandedLanes just
    // opened — not the Today copy, which may not be open and is not where focus
    // scrolled to.
    setExpandedRow(rowKey(laneKey, focusTaskId));
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

  // A name and a project. The ESTIMATE IS OPTIONAL — a developer raising a task
  // often doesn't know yet how long it will take, and demanding a number here
  // only produced invented ones; the admin sets or corrects it on Accept.
  //
  // This clause outlived its removal elsewhere: the Alert in submitNewTask was
  // dropped, but the button is disabled={!ntValid}, so a blank estimate left
  // Create Task permanently dead with nothing on screen saying why. Half a rule
  // removed is worse than the whole rule — at least the Alert explained itself.
  const ntValid = !!ntName.trim() && !!ntProject;

  // Distinct assignees present in the data, for the Assignee filter.
  const assigneeOptions = useMemo(() => {
    const map = new Map();
    for (const t of raw) if (t.user_id && !map.has(t.user_id)) map.set(t.user_id, t.user_name || 'User');
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [raw]);

  async function toggleWorkday() {
    // ONE decision, shared with the Home read-only bar (utils/workdayState.js).
    const { action } = workdayButtonState({ workdayOpen: workdayOpen === true, dayDone });
    log.info('workday toggle', { action, currentlyOpen: workdayOpen, workdayLocked, dayDone });
    // Ended for today → button is disabled; nothing to do (one start + one end).
    if (action === 'none') return;
    setWorkdayBusy(true);
    try {
      if (action === 'end') {
        // Don't end yet — open the summary popup first.
        const payload = await getTodaySummary();
        setEndNote('');
        setEndSummary(payload || {});
      } else {
        // 'start' — open the workday directly. This used to route to a PIN screen
        // and wait for a code typed on the computer; the button does the thing now.
        const res = await startWorkday();
        if (res && res.status === false) {
          // Backend refused because today was already ended (one per day).
          if (res.day_done) { setDayDone(true); setWorkdayOpen(false); showError('Workday ended', res.message || 'You already ended your workday today.'); }
          else showError("Can't start workday", res.message || 'Failed');
        } else {
          H.ok();
          setWorkdayOpen(true);
          setDayDone(false);
          // Lift read-only immediately rather than waiting up to 5s for App's poll.
          onWorkdayStarted && onWorkdayStarted();
        }
      }
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setWorkdayBusy(false); }
  }

  // Freeze / un-freeze the whole day. Separate from End Workday because ending
  // is final for the date (one start + one end) — this is for "back in a few
  // hours", e.g. stopping at 4am and picking up again at 10.
  async function toggleWorkdayPause() {
    if (workdayPauseBusy) return;
    setWorkdayPauseBusy(true);
    try {
      const res = workdayPaused ? await resumeWorkday() : await pauseWorkday();
      if (res && res.status === false) {
        showError(workdayPaused ? "Can't resume" : "Can't pause", res.message || 'Failed');
        return;
      }
      // Resuming is a return to work (success); pausing is a deliberate stop.
      if (workdayPaused) H.ok(); else H.warn();
      setWorkdayPaused(!workdayPaused);
      await load({ silent: true });
      // load() refetches TASKS only — it never touches `live`. Without this the
      // strip keeps drawing the pre-pause payload until the 15s poll lands, so
      // Presence and Productive both visibly carry on counting after the tap,
      // which reads as the pause not having worked. Every other action that
      // changes live state already refreshes here, and the web board does the
      // same inside its own pauseWorkday; the app was the one path that did not.
      // It also re-publishes the home-screen widget, via applyLive.
      await refreshLive();
    } catch (e) {
      showError('Something went wrong', e.message || 'Failed');
    } finally {
      setWorkdayPauseBusy(false);
    }
  }

  async function confirmEndWorkday() {
    // Optional, so an empty note sails through. This only stops a note that was typed
    // but says nothing. Never blocks on anything else — ending the day is one-way.
    // The note never blocks. It is labelled "(optional)" and it means it — an empty
    // box ends the day, and so does one word. validateWorkdayNote only trims and
    // clamps now; anything it wants to say about a thin note is a hint shown while
    // typing, not a refusal at the point of pressing the button.
    const check = validateWorkdayNote(endNote);
    log.info('end workday confirmed', { note: !!check.value });
    setEndBusy(true);
    try {
      const res = await endWorkday(check.value);
      if (res && res.status === false) { showError("Can't end workday", res.message || 'Failed'); return; }
      // Heavier than a normal confirm: this is the one action of the day that
      // cannot be undone by the person taking it.
      H.heavy();
      // The day is over — the widget must not keep showing a task as running.
      clearWidgetState();
      setWorkdayOpen(false);
      // Ended by the developer → one start + one end per day: mark today done so
      // the button flips straight to "Workday ended for today" (disabled), with
      // no restartable "Start Workday" in between.
      setDayDone(true);
      setEndSummary(null);
      // Ending the workday returns the app to read-only. Tell App now instead of
      // waiting up to 5s for its workday poll — otherwise the board keeps showing
      // Start/Pause/Complete after the day is over, and a tap in that window
      // would fail server-side.
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
    // Admins file work for other people, so they pick who it is for; a developer
    // is always the assignee of their own task and gets no picker. Defaults to
    // the admin themselves, matching the web. Loaded lazily — a developer never
    // needs this list.
    setNtUser(null);
    setNtUserOpen(false);
    if (isAdmin && !assignees.length) {
      fetchUsers().then((list) => setAssignees(list || [])).catch((e) => log.warn('users load failed', e?.message));
    }
  }

  async function submitNewTask() {
    if (!ntName.trim()) return say('Task name required', 'Enter a task name.', 'warn');
    if (!ntProject) return say('Project required', 'Choose a project (KRA).', 'warn');
    const h = parseInt(ntHours, 10) || 0;
    const m = parseInt(ntMinutes, 10) || 0;
    // Estimate is OPTIONAL, matching the server and the web board. A developer
    // raising a task often doesn't know yet how long it will take, and demanding
    // a number here only produced invented ones. The admin sets or corrects it
    // when they accept the task.
    log.info('new task submit', { name: ntName.trim(), kraId: ntProject.id, h, m, priority: ntPriority });
    setNtBusy(true);
    try {
      const res = await selfCreateTask({
        name: ntName.trim(), kraId: ntProject.id, estimateHours: h, estimateMinutes: m,
        priority: ntPriority, description: ntDesc.trim(),
        // Admin-only; the route ignores it from anyone else and falls back to
        // the caller, so a developer's task can never be filed against someone.
        userId: isAdmin ? (ntUser?.id || 0) : 0,
      });
      if (res && res.status === false) { say('Cannot create', res.message || 'Failed', 'warn'); return; }
      setNewTaskOpen(false);
      await load({ silent: true });
      setCreatedPopup({ ref: (res && res.external_ref) || '', name: ntName.trim() });
    } catch (e) { say('Error', e.message || 'Failed', 'warn'); }
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
    // Add time happens HERE, on the board. Sending the reader to KPI Details meant
    // leaving the list to answer a question about a row in it, and coming back to
    // find their place again. The dialog is the shared AddTimeModal, so the board
    // and the detail screen still cannot disagree about the required reason.
    if (kind === 'addTime') {
      setAddTimeFor(task);
      return;
    }
    if (kind === 'reassign') {
      setReassignFor(task);
      setReassignReason('');
      setReassignUser(null);
      setReassignTried(false);
      if (users.length === 0) fetchUsers().then(setUsers).catch(() => {});
      return;
    }
    if (kind === 'adminDelete') {
      // Permanent and irreversible, so it asks — and it names what it is about to
      // remove rather than saying "this task".
      confirm({
        tone: 'danger',
        destructive: true,
        title: 'Delete this task?',
        message: `${task.external_ref || ''} ${task.name || ''}\n\n`
          + 'This cannot be undone. It is only possible because no time has been '
          + 'logged against it. The assigned developer and the client who raised it '
          + 'are notified.',
        confirmLabel: 'Delete',
        onConfirm: async () => {
          setDlg((d) => (d ? { ...d, busy: true } : d));
          setBusyId(task.id);
          try {
            const res = await adminDeleteTask(task.id);
            if (res && res.status === false) {
              // The server re-checks: a board rendered before someone started
              // the task is refused here, not honoured.
              setDlg(null);
              say("Can't delete", res.message || 'Failed', 'warn');
              return;
            }
            setDlg(null);
            setDetailTask(null);
            await load({ silent: true });
          } catch (e) {
            setDlg(null);
            say('Something went wrong', e.message || 'Failed', 'warn');
          } finally { setBusyId(null); }
        },
      });
      return;
    }
    if (kind === 'pause') {
      setPauseFor(task);
      setPauseCode('break');
      setPauseNote('');
      setPauseDropdown(false);
      // Never carry a previous meeting's attendees — or a stale error — into a
      // new pause.
      setMeetingWith([]);
      setPeopleQuery('');
      setPauseErr('');
      return;
    }
    if (kind === 'complete' || kind === 'partial') {
      setFinishFor(task);
      setFinishPartial(kind === 'partial');
      setFinishSummary('');
      setFinishErr('');
      setChecklist({});
      return;
    }
    // Pending Review — accepting also CATEGORISES the task (its provisional
    // TASK-### ref is re-numbered into REQ/UPT/BUG), so the admin must pick a
    // type; rejecting asks for a note the developer will see.
    if (kind === 'acceptSelf') {
      setAcceptFor(task);
      // Seed BOTH pickers with what the DEVELOPER asked for, so accepting
      // without touching them honours the request and overriding it is
      // deliberate. The type chips used to be hard-coded to 'requirement',
      // which quietly re-filed every bug report the moment it was accepted.
      setAcceptType(task.requested_doc_type || 'requirement');
      setAcceptPriority(task.requested_priority || task.priority || 'regular');
      return;
    }
    if (kind === 'switch') {
      // The card this was pressed on is the one handing over; everything else
      // the developer has running is deliberately left alone.
      setSwitchQuery('');   // a search left from last time would hide the list
      setSwitchFrom(task);
      return;
    }
    if (kind === 'revertSignoff') {
      setRevertFor(task);
      setRevertReason('');
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

    // The server already told us this one is blocked (can_start, from
    // kra.kpi._start_block). Answer with its reason rather than sending a request
    // we know it will refuse — the developer gets the same words, instantly, and
    // a paused workday no longer costs a round-trip per tap.
    if ((kind === 'start' || kind === 'resume') && task.can_start === false) {
      showError(kind === 'start' ? "Can't start this task" : "Can't resume this task",
        task.start_block_message || gateLabel(task) || "This task can't start yet.");
      return;
    }

    setBusyId(task.id);
    try {
      const fn = kind === 'start' ? startTask : resumeTask;
      const res = await fn(task.id);
      if (res && res.status === false) {
        showError(kind === 'start' ? "Can't start this task" : "Can't resume this task", res.message || 'Action failed');
      } else {
        // The timer is now running — confirm it in the hand, since the visible
        // change (a card moving lane) happens after the refresh below.
        H.ok();
      }
      await load({ silent: true });
    } catch (e) {
      showError('Something went wrong', e.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  // Switch: stop the handed-over task and start the chosen one, in ONE server
  // call. Never pause-then-start from here — see services/kpiActions.switchTask.
  async function submitSwitch(target) {
    const from = switchFrom;                 // the card Switch was pressed on
    setSwitchFrom(false);
    setSwitchBusy(true);
    setBusyId(target.id);
    try {
      const res = await switchTask(target.id, from ? from.id : null);
      if (res && res.status === false) {
        showError("Can't switch", res.message || 'Failed');
        return;
      }
      setDetailTask(null);
      await load({ silent: true });
      await refreshLive();
    } catch (e) {
      showError('Something went wrong', e.message || 'Failed');
    } finally {
      setSwitchBusy(false);
      setBusyId(null);
    }
  }

  // Pause all: one reason for every running timer. Same note rule as the single
  // Pause, so the two can't disagree about when a reason needs explaining.
  async function submitPauseAll() {
    if (noteRequiredFor(pauseAllCode) && !pauseAllNote.trim()) {
      H.err();
      return setPauseAllErr(pauseAllCode === 'meeting'
        ? '"Meeting" on its own does not explain the time — say what it is about.'
        : "Please say what you're pausing for.");
    }
    setPauseAllErr('');
    const label = (PAUSE_REASONS.find((r) => r.code === pauseAllCode) || {}).label || 'Paused';
    const reason = pauseAllNote.trim().slice(0, IDLE_NOTE_MAX) || label;
    const withIds = pauseAllCode === 'meeting' ? meetingWith : [];
    setPauseAllBusy(true);
    try {
      const res = await pauseAllTasks(reason, pauseAllCode, withIds);
      if (res && res.status === false) {
        showError("Can't pause your tasks", res.message || 'Failed');
        return;
      }
      setPauseAllOpen(false);
      await load({ silent: true });
      await refreshLive();
    } catch (e) {
      showError('Something went wrong', e.message || 'Failed');
    } finally {
      setPauseAllBusy(false);
    }
  }

  // Revert from Awaiting Client. The reason is required on both sides — the
  // developer reads it on the card, so an empty one helps nobody.
  async function submitRevert() {
    const task = revertFor;
    const reason = revertReason.trim();
    if (!reason) {
      return say('Reason required', 'Please say why it is going back to the developer.', 'warn');
    }
    setRevertBusy(true);
    try {
      const res = await revertSignoff(task.id, reason);
      if (res && res.status === false) {
        showError("Can't revert", res.message || 'Failed');
        return;
      }
      setRevertFor(null);
      setDetailTask(null);
      await load({ silent: true });
    } catch (e) {
      showError('Something went wrong', e.message || 'Failed');
    } finally {
      setRevertBusy(false);
    }
  }

  // Pause: a note is required for 'other' and 'urgent', and the box is only shown
  // for those two. The web now uses the identical rule — it previously demanded a
  // note for Day End, Leave, Technical Issue and the rest, so the two clients
  // disagreed about what a valid pause even was.
  async function submitPause() {
    const task = pauseFor;
    // Inline, inside the dialog — the box it complains about is right there, so
    // an OS alert thrown over the top put the complaint further away than the fix.
    if (noteRequiredFor(pauseCode) && !pauseNote.trim()) {
      H.err();
      return setPauseErr(
        pauseCode === 'urgent'
          ? 'Describe what is urgent — this is sent to the owner straight away.'
          : pauseCode === 'meeting'
            ? '"Meeting" on its own does not explain the time — say what it is about.'
            : "Please say what you're pausing for.");
    }
    setPauseErr('');
    const label = (PAUSE_REASONS.find((r) => r.code === pauseCode) || {}).label || 'Paused';
    // Clamped here as well as by maxLength: the cap is what keeps this readable
    // inside a Workday Map chip, and a paste can outrun the input's own limit.
    const reason = pauseNote.trim().slice(0, IDLE_NOTE_MAX) || label;
    const withIds = pauseCode === 'meeting' ? meetingWith : [];
    setPauseFor(null);
    setBusyId(task.id);
    try {
      const res = await pauseTask(task.id, reason, pauseCode, withIds);
      if (res && res.status === false) say('Cannot pause', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Pause failed', 'warn'); }
    finally { setBusyId(null); }
  }

  // Finish: Partial needs only a summary; full Complete needs summary + at least
  // one box ticked — the same rule as the web and the server (/kra_kpi/task/complete
  // accepts >= 1). The app used to demand all five AND then discard what was
  // ticked in favour of an all-true map, so a task finished with three of five
  // done was both refused and, once forced through, recorded as fully done. The
  // manager approves against this list, so it has to be what the developer said.
  async function submitFinish() {
    const task = finishFor;
    // Errors show INSIDE the dialog rather than as an OS alert. Both of these
    // are "you missed a field" — the answer is three inches away on the same
    // screen, so throwing a system dialog over it made the fix harder to reach
    // than the mistake was. Stacking the board's own popup would be worse still:
    // two RN Modals at once are unreliable on Android. Same treatment the web's
    // Partial Finish dialog already uses.
    if (!finishSummary.trim()) {
      H.err();
      return setFinishErr('Describe what you did before finishing — this is what your manager reads.');
    }
    if (!finishPartial) {
      const ticked = CHECKLIST_ITEMS.filter((c) => checklist[c.key]);
      if (!ticked.length) {
        H.err();
        return setFinishErr('Tick everything that applies — at least one — or use "Partial Finish" to submit a summary only.');
      }
    }
    setFinishErr('');
    setFinishFor(null);
    setBusyId(task.id);
    try {
      // 1) submit the required progress summary
      const pr = await createProgress(task.id, finishSummary.trim());
      if (pr && pr.status === false) { say('Cannot save summary', pr.message || 'Failed', 'warn'); return; }
      // 2) complete (full) or partial-finish. Send exactly what was ticked.
      const checklistObj = finishPartial
        ? {}
        : CHECKLIST_ITEMS.reduce((o, c) => ({ ...o, [c.key]: !!checklist[c.key] }), {});
      const res = await completeTask(task.id, checklistObj, finishPartial);
      if (res && res.status === false) say('Cannot finish', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Failed', 'warn'); }
    finally { setBusyId(null); }
  }

  // Pending Review → accept into the official flow, categorised as REQ/UPT/BUG.
  async function submitAcceptSelf() {
    const task = acceptFor;
    const docType = acceptType;
    const priority = acceptPriority;
    setAcceptFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      await acceptSelfCreated(task.id, docType, priority);
      await load({ silent: true });
    } catch (e) { say('Cannot accept', e.message || 'Failed', 'warn'); }
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
    } catch (e) { say('Cannot send back', e.message || 'Failed', 'warn'); }
    finally { setBusyId(null); }
  }

  // Admin approves the developer's completed work → all QA boxes required → task
  // goes to the client for sign-off (the client is notified server-side).
  async function submitApproveDone() {
    const task = approveFor;
    const missing = MGR_CHECKLIST_ITEMS.filter((c) => !mgrChecklist[c.key]);
    if (missing.length) {
      return say('Checklist incomplete', 'Please tick every QA item before approving.', 'warn');
    }
    setApproveFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      const checklistObj = MGR_CHECKLIST_ITEMS.reduce((o, c) => ({ ...o, [c.key]: true }), {});
      const res = await approveTask(task.id, checklistObj);
      if (res && res.status === false) say('Cannot approve', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Approve failed', 'warn'); }
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
      if (res && res.status === false) say('Cannot reject', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Reject failed', 'warn'); }
    finally { setBusyId(null); }
  }

  async function submitReassign() {
    if (!reassignUser || !reassignReason.trim()) { setReassignTried(true); return; }
    const task = reassignFor;
    setReassignFor(null);
    setBusyId(task.id);
    try {
      const res = await reassignTask(task.id, reassignUser.id, reassignReason.trim());
      if (res && res.status === false) say('Cannot reassign', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Failed', 'warn'); }
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
        {/* Only RESUME in the header. Pause lives inside the End Workday dialog,
            where the stop-for-now vs stop-for-good choice is made. Resume has to
            be out here: when the day is frozen it is the one thing you need, and
            burying it behind "End Workday" would mean opening an end-my-day
            dialog in order to carry on working. */}
        {workdayOpen === true && workdayPaused && (
          <TouchableOpacity
            style={[s.pauseDayBtn, s.pauseDayBtnOn, workdayPauseBusy && { opacity: 0.6 }]}
            onPress={toggleWorkdayPause}
            disabled={workdayPauseBusy}
            activeOpacity={0.85}
          >
            <Ionicons name="play-circle" size={16} color="#fff" />
            <Text style={[s.pauseDayTxt, { color: '#fff' }]}>Resume</Text>
          </TouchableOpacity>
        )}
        {/* Label + action come from the shared decision helper so this button and
            the Home read-only bar can never disagree: End / Continue / Start /
            "Workday ended for today" (disabled). */}
        {(() => {
          const showSpinner = !readOnly && (workdayBusy || workdayOpen === null);
          const wd = workdayButtonState({ workdayOpen: workdayOpen === true, dayDone });
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

      {/* An admin reopened this day. Directly under the workday button, because that
          is where someone stands when they wonder why their day is open again. */}
      {reopenInfo.reason ? (
        <View style={s.reopenBanner}>
          <Ionicons name="lock-open-outline" size={13} color={COLORS.amber} />
          <Text style={s.reopenBannerTxt}>
            Workday reopened{reopenInfo.by ? ` by ${reopenInfo.by}` : ''}: {reopenInfo.reason}
          </Text>
        </View>
      ) : null}

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

      {/* Paused: the board looks normal but nothing will start, so say so.
          Without this the refused Start buttons read as a bug. */}
      {workdayPaused ? (
        <View style={s.pausedBar}>
          <Ionicons name="pause-circle" size={18} color="#475569" />
          <Text style={s.pausedBarTxt}>
            <Text style={{ fontWeight: '800' }}>Your workday is paused.</Text>{' '}
            Tasks can't be started, and paused time won't count as worked time. Tap Resume when you're back.
          </Text>
        </View>
      ) : null}

      {/* Live activity strip + idle warning (when a workday is open) */}
      {live?.workday_open ? (
        <>
          <View style={s.liveStrip}>
            {/* Row 1: LIVE badge + working/idle */}
            <View style={s.liveRow}>
              <View style={s.liveBadge}>
                <PulseDot size={6} color="#fff" />
                <Text style={s.liveBadgeTxt}>LIVE</Text>
              </View>
              {live.active_task ? (
                // EVERY running timer, not just the first. A developer with
                // multitask enabled can have two going at once, and showing one
                // made the other look stopped. active_tasks is the full list
                // (earliest first); active_task is kept for older servers.
                <View style={s.liveWorking}>
                  <Ionicons name={(live.active_tasks?.length || 1) > 1 ? 'flash' : 'play'} size={13} color={COLORS.green} />
                  <View style={{ flex: 1 }}>
                    {(live.active_tasks?.length || 0) > 1 ? (
                      <Text style={s.liveWorkingTxt} numberOfLines={1}>
                        Multi-tasking {live.active_tasks.length} tasks
                      </Text>
                    ) : null}
                    {(live.active_tasks?.length ? live.active_tasks : [live.active_task]).map((at) => (
                      <Text key={at.id} style={s.liveWorkingTxt} numberOfLines={1}>
                        Working: "{at.name}"  {fmtHMS(liveFromAnchor(at.timer_start, at.timer_total_seconds, nowMs))}
                      </Text>
                    ))}
                  </View>
                  {/* Stop every timer at once, one reason for all of them. Only
                      with 2+ running: with a single task the card's own Pause is
                      the same thing and says which task it is. Switch is NOT here
                      — it is per-card, because it hands over one task and leaves
                      the rest ticking. */}
                  {!readOnly && (live.active_tasks?.length || 0) > 1 ? (
                    <TouchableOpacity
                      style={s.pauseAllBtn}
                      onPress={() => {
                        setPauseAllCode('break'); setPauseAllNote(''); setPauseAllErr('');
                        setMeetingWith([]); setPeopleQuery('');
                        setPauseAllOpen(true);
                      }}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="pause" size={12} color="#92400E" />
                      <Text style={s.pauseAllTxt}>Pause all ({live.active_tasks.length})</Text>
                    </TouchableOpacity>
                  ) : null}
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
              <>
                <View style={s.breakPill}>
                  <Text style={s.breakPillTxt}>
                    ☕ {live.active_break.type_label}{live.active_break.source_task_name ? ` (from "${live.active_break.source_task_name}")` : ''} · started {live.active_break.start_display} · {fmtHMS(secsSince(live.active_break.start_raw, nowMs))}
                  </Text>
                </View>
                {/* The same one-tap switching the non-task block above already
                    offers, for the case a task is PAUSED behind the break: a
                    break that turns into a meeting used to mean Resume then
                    Pause again, which is two chances to half-apply and banks a
                    few seconds of task time nobody worked. The reason in force
                    is filtered out — switching to it is a server-side no-op and
                    a button that does nothing is worse than no button. */}
                {!readOnly ? (
                  <View style={s.breakSwitchRow}>
                    {BREAK_SWITCH_REASONS.filter((r) => r.code !== live.active_break.type).map((r) => (
                      <TouchableOpacity
                        key={r.code}
                        style={s.nontaskSwitch}
                        onPress={() => doSwitchBreak(r.code)}
                        disabled={!!breakSwitchBusy}
                        activeOpacity={0.85}
                      >
                        {breakSwitchBusy === r.code
                          ? <ActivityIndicator size="small" color={COLORS.primary} />
                          : <Text style={s.nontaskSwitchTxt}>{r.emoji} {r.label}</Text>}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            {/* Row 3: Presence · Productive */}
            <Text style={s.livePresence}>
              Presence {fmtHMS(presenceLive(live, nowMs))} · Productive <Text style={s.liveProductive}>{fmtHMS(productiveLive(live, nowMs))}</Text>
              {live.is_paused ? <Text style={s.livePausedNote}>  · paused</Text> : null}
            </Text>
          </View>
          {/* The red "if you go idle it auto-pauses after 5 min" warning used to
              sit here, unconditionally, whenever a workday was open. Idle
              auto-pause is retired — away_after_minutes is 0 and both crons are
              inactive — so it described a thing that can no longer happen, and
              told developers their time was at risk when it was not. A warning
              nobody can act on is worse than no warning: it trains people to
              ignore the strip. Removed rather than reworded; there is nothing
              left to warn about. */}
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
                stagger={!laneIntroDone.current}
                style={s.lane}
                onLayout={(e) => { laneX.current[l.key] = e.nativeEvent.layout.x; }}
              >
                {/* Colored lane header */}
                <View style={[s.laneHead, { backgroundColor: l.color }]}>
                  <Text style={s.laneTitle} numberOfLines={1}>{l.label}</Text>
                  <View style={s.laneCount}><Text style={s.laneCountTxt}>{items.length}</Text></View>
                </View>
                {/* Lane body — a FlatList, not a ScrollView + map.
                    There is no cap on the task list (an admin's server-side domain
                    is []), so mapping built every card in every lane on every
                    switch — hundreds of TaskCards, each with its own meta rows and
                    button set, in one synchronous commit. Virtualised, a lane
                    mounts about a screenful and the toggle stops being a stall.
                    nestedScrollEnabled lets it scroll inside the horizontal board
                    ScrollView (required on Android). No getItemLayout: card height
                    varies with description, buttons and the paused/gate pills, and
                    a wrong one breaks scrolling worse than not having it.

                    onMeasure below is passed by the task's OWN status lane only. A
                    task worked today renders in TWO lanes and cardY is keyed by task
                    id, so letting both report would leave the Today copy's y in the
                    map — and notification focus, which scrolls laneForTask's lane,
                    would then scroll it to the wrong offset. */}
                <FlatList
                  ref={(r) => { laneRefs.current[l.key] = r; }}
                  style={s.laneBody}
                  contentContainerStyle={laneContentStyle}
                  data={items}
                  keyExtractor={laneKeyExtractor}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                  initialNumToRender={8}
                  maxToRenderPerBatch={8}
                  windowSize={5}
                  removeClippedSubviews
                  ListEmptyComponent={(
                    <View style={s.laneEmpty}>
                      <MaterialCommunityIcons name="tray" size={28} color={COLORS.faint} />
                      <Text style={s.laneEmptyTxt}>Nothing here yet</Text>
                    </View>
                  )}
                  renderItem={({ item: t }) => (
                    <TaskCard
                      task={t}
                      onAction={runAction}
                      busyId={busyId}
                      nowMs={t.task_state === 'in_progress' ? nowMs : 0}
                      isAdmin={isAdmin}
                      reminder={reminders[String(t.id)]}
                      pulse={pulseId === t.id}
                      onMeasure={l.key === 'today' ? undefined : onCardMeasure}
                      onOpenDetail={openDetail}
                      readOnly={readOnly}
                    />
                  )}
                />
              </AnimatedLane>
            );
          })}
        </ScrollView>
        </Animated.View>
      ) : (
        /* List view — vertical accordion, grouped by status. Same filtered data,
           same actions; each row expands to reveal the shared TaskDetailBody. */
        <Animated.View style={bodyStyle}>
        <FlatList
          ref={listScrollRef}
          style={s.listScroll}
          contentContainerStyle={listContentStyle}
          showsVerticalScrollIndicator={false}
          data={listData}
          keyExtractor={listKeyExtractor}
          // Only about a screenful is built up front, so opening a 200-task lane
          // — or landing on the board at all — costs a screenful rather than the
          // whole set.
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          // A tick per "notch" of travel. scrollEventThrottle is the frame rate
          // of the events; the real rate-limiting is inside scrollTick, which
          // needs both a minimum distance and a minimum gap — without the
          // distance test a slow drag buzzes continuously, which is the version
          // people turn off.
          scrollEventThrottle={32}
          onScroll={(e) => H.scrollTick(e.nativeEvent.contentOffset.y)}
          ListEmptyComponent={(
            <View style={s.center}>
              <MaterialCommunityIcons name="tray" size={40} color={COLORS.faint} />
              <Text style={s.centerTxt}>No tasks match.</Text>
            </View>
          )}
          renderItem={({ item }) => (item.kind === 'head' ? (
            /* Level 1: status heading — tap to reveal its tasks. */
            <TouchableOpacity
              style={[s.listSection, { backgroundColor: item.lane.color }, s.listSectionSpaced]}
              onPress={() => onLaneToggle(item.lane.key)}
              activeOpacity={0.85}
            >
              <Ionicons name={item.open ? 'chevron-down' : 'chevron-forward'} size={18} color="#fff" />
              <Text style={s.listSectionTxt} numberOfLines={1}>{item.lane.label}</Text>
              <View style={s.laneCount}><Text style={s.laneCountTxt}>{item.count}</Text></View>
            </TouchableOpacity>
          ) : (
            /* Level 2: task rows — tap the row for details, the arrow for the
               action buttons. */
            <TaskListRow
              task={item.task}
              expanded={expandedRow === item.key}
              rowKey={item.key}
              onToggle={onRowToggle}
              onAction={runAction}
              busyId={busyId}
              nowMs={item.task.task_state === 'in_progress' ? nowMs : 0}
              isAdmin={isAdmin}
              reminder={reminders[String(item.task.id)]}
              pulse={pulseId === item.task.id}
              onRowRef={onRowRef}
              onOpenDetail={openDetail}
              readOnly={readOnly}
            />
          ))}
        />
        </Animated.View>
      )}
      </Animated.View>

      {/* Add time to the estimate, in place. Shared with KPI Details so the
          required reason is enforced identically in both. A silent reload keeps
          the reader's scroll position and open lanes — the point of doing this
          here rather than on another screen. */}
      <AddTimeModal
        visible={!!addTimeFor}
        task={addTimeFor}
        onClose={() => setAddTimeFor(null)}
        onDone={(msg) => { say('Estimate extended', msg, 'ok'); load({ silent: true }); }}
      />

      {/* The app's own alert/confirm. One at a time, which is all a screen should
          ever be asking. */}
      <AppDialog
        visible={!!dlg}
        tone={dlg?.tone}
        title={dlg?.title}
        message={dlg?.message}
        confirmLabel={dlg?.confirmLabel}
        destructive={dlg?.destructive}
        busy={dlg?.busy}
        onConfirm={dlg?.onConfirm}
        onClose={() => setDlg(null)}
      />

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

            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
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
                      <TouchableOpacity key={r.code} style={[s.quick, on && s.quickOn]} onPress={() => { H.select(); pickPauseCode(r.code); }}>
                        <Text style={s.quickEmoji}>{r.emoji}</Text>
                        <Text style={[s.quickTxt, on && { color: COLORS.primary }]}>{r.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity style={[s.quickUrgent, pauseCode === 'urgent' && s.quickUrgentOn]} onPress={() => { H.warn(); pickPauseCode('urgent'); }}>
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
                        <TouchableOpacity key={r.code} style={[s.dropdownItem, on && s.dropdownItemOn]} onPress={() => { H.select(); pickPauseCode(r.code); setPauseDropdown(false); }}>
                          <Text style={[s.dropdownItemTxt, on && { color: COLORS.primary, fontWeight: '800' }]}>{r.label}</Text>
                          {on && <Ionicons name="checkmark" size={17} color={COLORS.primary} />}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Inline, above the box it is about. This was an OS alert thrown
                  over the dialog — the field it complains about is an inch away,
                  so the complaint sat further from the fix than the mistake did. */}
              {pauseErr ? (
                <View style={s.inlineErr}>
                  <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                  <Text style={s.inlineErrTxt}>{pauseErr}</Text>
                </View>
              ) : null}

              {pauseCode === 'meeting' ? (
                <>
                  <MeetingPicker
                    people={people} busy={peopleBusy}
                    query={peopleQuery} setQuery={setPeopleQuery}
                    picked={meetingWith} setPicked={setMeetingWith}
                  />
                  <Text style={s.fieldLabel}>What is it about?</Text>
                  <TextInput
                    style={s.pauseNote}
                    placeholder="Short — e.g. sprint planning"
                    placeholderTextColor={COLORS.faint}
                    value={pauseNote}
                    onChangeText={(t) => { setPauseNote(t); if (pauseErr) setPauseErr(''); }}
                    maxLength={IDLE_NOTE_MAX}
                    multiline
                  />
                  <Text style={s.idleNoteHint}>
                    Keep it short — this shows on your Workday Map. {pauseNote.length}/{IDLE_NOTE_MAX}
                  </Text>
                </>
              ) : null}

              {/* Only Other and Urgent ask for words. The rest ARE the explanation
                  — a box next to a button already labelled Break just taught people
                  to type "break" into it. Urgent keeps it because that text is the
                  body of the alert the owner receives.
                  Capped: this is drawn inside a Workday Map chip, and the Map is
                  what gets frozen into the saved End Workday image. */}
              {/* Meeting is excluded: it has its own note box above, under the
                  people list, so "who" then "what about" read in that order. */}
              {noteRequiredFor(pauseCode) && pauseCode !== 'meeting' ? (
                <>
                  <TextInput
                    style={s.pauseNote}
                    placeholder={pauseCode === 'urgent'
                      ? 'What is urgent? This is sent to the owner now…'
                      : 'Why? (required)'}
                    placeholderTextColor={COLORS.faint}
                    value={pauseNote}
                    onChangeText={(t) => { setPauseNote(t); if (pauseErr) setPauseErr(''); }}
                    maxLength={IDLE_NOTE_MAX}
                    multiline
                  />
                  <Text style={s.idleNoteHint}>
                    Keep it short — this shows on your Workday Map. {pauseNote.length}/{IDLE_NOTE_MAX}
                  </Text>
                </>
              ) : null}

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

      {/* Switch — pick what to work on next. The list is filtered on can_start,
          the SERVER's own answer, so the picker never offers something the switch
          would then refuse. Tasks already running are excluded: switching to what
          you are already doing is a no-op worth not offering. */}
      <Modal visible={switchFrom !== false} transparent animationType="fade" onRequestClose={() => setSwitchFrom(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headBlueSoft]}>
              <Text style={s.headBlueSoftTitle}>⇄  Switch to another task</Text>
              <TouchableOpacity onPress={() => setSwitchFrom(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#1E3A8A" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.switchIntro}>
                {switchFrom
                  ? <><Text style={{ fontWeight: '800' }}>{switchFrom.external_ref || switchFrom.name}</Text> pauses as <Text style={{ fontWeight: '800' }}>Another Priority Task</Text> and the one you pick starts straight away. Anything else you have running is left alone. Time already logged is kept.</>
                  : 'Your current task pauses as Another Priority Task and the one you pick starts straight away. Time already logged is kept.'}
              </Text>
              {/* Search. The list is built from `raw`, not the board's filtered
                  set, so the board's own search box does not narrow it — this is
                  the only filter here. */}
              <View style={s.switchSearch}>
                <Ionicons name="search" size={16} color={COLORS.muted} />
                <TextInput
                  style={s.switchSearchInput}
                  placeholder="Search by ref, name or developer…"
                  placeholderTextColor={COLORS.faint}
                  value={switchQuery}
                  onChangeText={setSwitchQuery}
                  autoCorrect={false}
                />
                {switchQuery ? (
                  <TouchableOpacity onPress={() => setSwitchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={16} color={COLORS.faint} />
                  </TouchableOpacity>
                ) : null}
              </View>
              {(() => {
                const runningIds = new Set(
                  (live?.active_tasks?.length ? live.active_tasks : (live?.active_task ? [live.active_task] : []))
                    .map((t) => t.id));
                const q = switchQuery.trim().toLowerCase();
                // Same predicate as the board's own search, so the two behave
                // identically rather than a third rule appearing here.
                const matches = (t) => !q
                  || String(t.external_ref || '').toLowerCase().includes(q)
                  || String(t.name || '').toLowerCase().includes(q)
                  || String(t.user_name || '').toLowerCase().includes(q);
                // can_start stays in the filter: it is the server's _start_block
                // answer, and a PAUSED task can still be blocked by a paused
                // workday or an unapproved client.
                const avail = (raw || [])
                  .filter((t) => !runningIds.has(t.id) && t.can_start !== false && matches(t))
                  .sort((a, b) => String(a.external_ref || '').localeCompare(String(b.external_ref || '')));
                // Work already begun comes first — switching is nearly always
                // "back to the thing I paused", and that used to be buried among
                // every never-started task in the list.
                const paused = avail.filter((t) => PAUSED_STATES.includes(t.task_state));
                const fresh = avail.filter((t) => !PAUSED_STATES.includes(t.task_state));
                if (!avail.length) {
                  return (
                    <Text style={[s.centerTxt, { paddingVertical: 20 }]}>
                      {q
                        ? `Nothing matches "${switchQuery.trim()}".`
                        : 'Nothing else is ready to start. A task has to be accepted and approved before you can switch to it.'}
                    </Text>
                  );
                }
                const card = (t) => (
                  <TouchableOpacity
                    key={t.id} style={s.switchCard} activeOpacity={0.85}
                    disabled={switchBusy}
                    onPress={() => submitSwitch(t)}
                  >
                    <View style={s.switchCardTop}>
                      <Text style={s.switchRef}>{t.external_ref || ''}</Text>
                      <Text style={s.switchPrio}>
                        {PRIORITIES.find((p) => p.code === t.priority)?.label || t.priority || 'Regular'}
                      </Text>
                    </View>
                    <Text style={s.switchName} numberOfLines={2}>{t.name}</Text>
                    <Text style={s.switchMeta} numberOfLines={1}>
                      {t.user_name || 'Unassigned'} · Time {fmtHMS(t.timer_total_seconds || 0)} · Est {t.estimate_display || '—'}
                    </Text>
                    {t.paused_reason && PAUSED_STATES.includes(t.task_state) ? (
                      <Text style={s.switchPaused} numberOfLines={1}>⏸ {t.paused_reason}</Text>
                    ) : null}
                  </TouchableOpacity>
                );
                return (
                  <ScrollView style={{ maxHeight: 380 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {paused.length ? (
                      <>
                        <Text style={s.switchGroup}>Paused — pick back up ({paused.length})</Text>
                        {paused.map(card)}
                      </>
                    ) : null}
                    {fresh.length ? (
                      <>
                        <Text style={s.switchGroup}>Not started yet ({fresh.length})</Text>
                        {fresh.map(card)}
                      </>
                    ) : null}
                  </ScrollView>
                );
              })()}
            </View>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setSwitchFrom(false)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Pause all — every running timer, one shared reason. */}
      <Modal visible={pauseAllOpen} transparent animationType="fade" onRequestClose={() => setPauseAllOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>⏸  Pause all running tasks</Text>
              <TouchableOpacity onPress={() => setPauseAllOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.pauseHelp}>One reason for all of them. Time logged so far is kept.</Text>
              {(live?.active_tasks || []).map((at) => (
                <Text key={at.id} style={s.pauseAllItem} numberOfLines={1}>•  {at.name}</Text>
              ))}
              <Text style={[s.whyTitle, { marginTop: 12 }]}>Why are you pausing?</Text>
              <View style={s.typeRow}>
                {PAUSE_REASONS.filter((r) => r.quick).map((r) => {
                  const on = pauseAllCode === r.code;
                  return (
                    <TouchableOpacity
                      key={r.code} style={[s.typeChip, on && s.typeChipOn]}
                      onPress={() => {
                        H.select();
                        // Same helper the single Pause uses, so picking Meeting
                        // loads the people list here too and switching away
                        // clears both the note and the attendees.
                        pickPauseCode(r.code, { forAll: true });
                        setPauseAllErr('');
                      }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.typeChipTxt, on && s.typeChipTxtOn]}>{r.emoji} {r.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {pauseAllErr ? (
                <View style={s.inlineErr}>
                  <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                  <Text style={s.inlineErrTxt}>{pauseAllErr}</Text>
                </View>
              ) : null}
              {/* Meeting asks who, exactly as the single Pause does. One break row
                  is opened however many timers stop, so the names land once. */}
              {pauseAllCode === 'meeting' ? (
                <MeetingPicker
                  people={people} busy={peopleBusy}
                  query={peopleQuery} setQuery={setPeopleQuery}
                  picked={meetingWith} setPicked={setMeetingWith}
                />
              ) : null}
              {/* Same rule as the single Pause — Other, Urgent and Meeting ask. */}
              {noteRequiredFor(pauseAllCode) ? (
                <>
                  {pauseAllCode === 'meeting' ? (
                    <Text style={s.fieldLabel}>What is it about?</Text>
                  ) : null}
                  <TextInput
                    style={s.pauseNote}
                    placeholder={pauseAllCode === 'urgent'
                      ? 'What is urgent? This is sent to the owner now…'
                      : pauseAllCode === 'meeting'
                        ? 'Short — e.g. sprint planning'
                        : 'Why? (required)'}
                    placeholderTextColor={COLORS.faint}
                    value={pauseAllNote}
                    onChangeText={(t) => { setPauseAllNote(t); if (pauseAllErr) setPauseAllErr(''); }}
                    maxLength={IDLE_NOTE_MAX}
                    multiline
                  />
                  <Text style={s.idleNoteHint}>
                    Keep it short — this shows on your Workday Map. {pauseAllNote.length}/{IDLE_NOTE_MAX}
                  </Text>
                </>
              ) : null}
            </View>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setPauseAllOpen(false)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.amber }, pauseAllBusy && { opacity: 0.6 }]}
                disabled={pauseAllBusy}
                onPress={submitPauseAll}
              >
                <Text style={s.footConfirmTxt}>{pauseAllBusy ? 'Pausing…' : 'Pause all'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Admin revert from Awaiting Client Sign-off. */}
      <Modal visible={!!revertFor} transparent animationType="fade" onRequestClose={() => setRevertFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>↩  Revert from client sign-off?</Text>
              <TouchableOpacity onPress={() => setRevertFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdName} numberOfLines={2}>
                {revertFor?.external_ref ? `${revertFor.external_ref} ` : ''}{revertFor?.name}
              </Text>
              <View style={s.revertBox}>
                <Text style={s.revertBoxTxt}>This goes back to the developer:</Text>
                <Text style={s.revertBullet}>•  The client stops seeing it straight away.</Text>
                <Text style={s.revertBullet}>•  It returns to Paused with your reason on the card.</Text>
                <Text style={s.revertBullet}>•  The developer is notified. Time already logged is kept.</Text>
                <Text style={s.revertBullet}>•  Completing it again goes through admin review, then the client.</Text>
              </View>
              <Text style={s.modalLabel}>Why is it going back?</Text>
              <TextInput
                style={s.pauseNote}
                placeholder="e.g. Client reported the export is still wrong"
                placeholderTextColor={COLORS.faint}
                value={revertReason}
                onChangeText={setRevertReason}
                multiline
              />
            </View>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setRevertFor(null)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.amber }, revertBusy && { opacity: 0.6 }]}
                disabled={revertBusy}
                onPress={submitRevert}
              >
                <Text style={s.footConfirmTxt}>{revertBusy ? 'Reverting…' : 'Revert'}</Text>
              </TouchableOpacity>
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

            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                <Text style={s.kv}>Task: <Text style={s.kvStrong}>{finishFor?.name}</Text></Text>

                {finishPartial ? (
                  <View style={s.bannerYellow}>
                    <Text style={s.bannerYellowTxt}>
                      ⓘ  This finishes the task <Text style={{ fontWeight: '900' }}>as-is</Text> and sends it for review with just your summary — no full checklist. Use <Text style={{ fontWeight: '900' }}>Complete</Text> for fully-done work.
                    </Text>
                  </View>
                ) : null}

                {/* Inline, above the fields it is about — this used to be an OS
                    alert thrown over the dialog, which put the complaint further
                    from the fix than the mistake was. */}
                {finishErr ? (
                  <View style={s.inlineErr}>
                    <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                    <Text style={s.inlineErrTxt}>{finishErr}</Text>
                  </View>
                ) : null}

                <Text style={s.fieldLabel}>Progress Summary *</Text>
                <TextInput
                  style={[s.reasonInput, { minHeight: 100 }, finishErr && !finishSummary.trim() && s.inputErr]}
                  placeholder={finishPartial ? "What was done, what's left, why you're finishing now…" : 'What did you do on this task?'}
                  placeholderTextColor={COLORS.faint}
                  value={finishSummary}
                  onChangeText={(t) => { setFinishSummary(t); if (finishErr) setFinishErr(''); }}
                  multiline
                />

                {!finishPartial && (
                  <>
                    <Text style={s.fieldLabel}>Checklist — tick everything that applies</Text>
                    <Text style={s.fieldHint}>
                      At least one. Your manager sees exactly which you ticked.
                    </Text>
                    {CHECKLIST_ITEMS.map((c) => {
                      const on = !!checklist[c.key];
                      return (
                        <TouchableOpacity key={c.key} style={s.checkRow} onPress={() => { H.select(); if (finishErr) setFinishErr(''); setChecklist((p) => ({ ...p, [c.key]: !p[c.key] })); }}>
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

            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
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

                {/* Admins file work for other people, so they choose who it is
                    for; a developer is always the assignee of their own task and
                    gets no picker at all. Same list the web uses
                    (/kra_kpi/get_users) — developers and admins, never clients,
                    because a client cannot open the board to work it. */}
                {isAdmin ? (
                  <>
                    <Text style={s.fieldLabel}>Developer *</Text>
                    <TouchableOpacity style={s.dropdown} onPress={() => { setNtUserOpen((o) => !o); setNtClientOpen(false); setNtProjectOpen(false); }} activeOpacity={0.8}>
                      <Text style={s.dropdownTxt} numberOfLines={1}>
                        {ntUser ? ntUser.name : 'Me'}
                      </Text>
                      <Ionicons name={ntUserOpen ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                    </TouchableOpacity>
                    <Text style={s.fieldHint}>Who this task is for. Defaults to you.</Text>
                    {ntUserOpen && (
                      <View style={s.dropdownList}>
                        <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                          <TouchableOpacity style={[s.dropdownItem, !ntUser && s.dropdownItemOn]}
                            onPress={() => { H.select(); setNtUser(null); setNtUserOpen(false); }}>
                            <Text style={[s.dropdownItemTxt, !ntUser && { color: COLORS.primary, fontWeight: '800' }]}>Me</Text>
                          </TouchableOpacity>
                          {assignees.length === 0 ? (
                            <Text style={[s.centerTxt, { padding: 12 }]}>Loading people…</Text>
                          ) : null}
                          {assignees.map((u) => (
                            <TouchableOpacity key={u.id} style={[s.dropdownItem, ntUser?.id === u.id && s.dropdownItemOn]}
                              onPress={() => { H.select(); setNtUser(u); setNtUserOpen(false); }}>
                              <Text style={[s.dropdownItemTxt, ntUser?.id === u.id && { color: COLORS.primary, fontWeight: '800' }]}>{u.name}</Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </>
                ) : null}

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
                  Starting your workday unlocks your tasks. You can end it whenever you're done — once per day.
                </Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setStartPrompt(false)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.green }]}
                onPress={() => { setStartPrompt(false); toggleWorkday(); }}
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
              {/* What the requester wrote. This is where the admin decides whether to
                  accept at all, and it showed only the title and the requested type. */}
              {plainText(acceptFor?.description) ? (
                <View style={s.descBlock}>
                  <View style={s.descHead}>
                    <Ionicons name="document-text-outline" size={13} color={COLORS.muted} />
                    <Text style={s.descLabel}>Description</Text>
                  </View>
                  <Text style={s.descTxt} numberOfLines={6}>{plainText(acceptFor.description)}</Text>
                </View>
              ) : null}
              <Text style={s.modalLabel}>Task type</Text>
              {/* What the developer filed it as. The chips below are pre-selected
                  to it, so accepting untouched keeps a bug report a bug report. */}
              {acceptFor?.requested_doc_type ? (
                <Text style={s.askedLine}>
                  The developer said this is a{' '}
                  {{ requirement: 'Requirement', update: 'Update', bug: 'Bug Report' }[acceptFor.requested_doc_type]
                    || acceptFor.requested_doc_type}.
                </Text>
              ) : null}
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
              <Text style={s.modalLabel}>Priority</Text>
              {/* What the developer asked for, stated plainly so the admin decides
                  against it rather than blind. The chips below are pre-selected to
                  it, so accepting untouched honours the request. */}
              {acceptFor?.requested_priority ? (
                <Text style={s.askedLine}>
                  Developer asked for {PRIORITIES.find((p) => p.code === acceptFor.requested_priority)?.label || acceptFor.requested_priority}
                </Text>
              ) : null}
              <View style={s.typeRow}>
                {PRIORITIES.map((p) => {
                  const on = acceptPriority === p.code;
                  return (
                    <TouchableOpacity
                      key={p.code} style={[s.typeChip, on && s.typeChipOn]}
                      onPress={() => setAcceptPriority(p.code)} activeOpacity={0.85}
                    >
                      <Text style={[s.typeChipTxt, on && s.typeChipTxtOn]}>{p.label}</Text>
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
            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
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
            {/* SCROLLABLE. Four reason cards, a note box and a hint make this the
                tallest dialog on the screen: on a phone it did not fit, and as a
                plain View there was nothing to scroll — the card grew past the
                viewport and pushed its own header off the top, so you could not
                read the title or reach the buttons at the bottom. */}
            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }}
                        contentContainerStyle={{ padding: 18 }}
                        keyboardShouldPersistTaps="handled">
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
              {/* returnKeyType 'done' + onSubmitEditing: pressing Enter used to do
                  nothing visible, because the note alone cannot submit — a reason has
                  to be chosen and only the buttons above say which. What it actually
                  did was leave the keyboard up, covering those buttons, so the popup
                  looked stuck. Enter now closes the keyboard and hands the screen back. */}
              <View style={s.idleNoteRow}>
                <TextInput
                  style={[s.idleNote, { flex: 1 }]}
                  placeholder="Optional note (e.g. sprint planning)…"
                  placeholderTextColor={COLORS.faint}
                  value={idleNote}
                  onChangeText={setIdleNote}
                  maxLength={IDLE_NOTE_MAX}
                  editable={!idleBusy}
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                />
                {/* The on-screen twin of the keyboard's Enter. Both just close the
                    keyboard: the note alone cannot submit, because only the reason
                    buttons say WHICH reason it belongs to. Without this the keyboard
                    covers those buttons and the popup looks stuck. */}
                <TouchableOpacity
                  style={[s.idleNoteDone, !idleNote.trim() && s.idleNoteDoneOff]}
                  onPress={Keyboard.dismiss}
                  disabled={!idleNote.trim() || !!idleBusy}
                  activeOpacity={0.85}
                >
                  <Ionicons name="return-down-back" size={18}
                    color={idleNote.trim() ? '#fff' : COLORS.faint} />
                </TouchableOpacity>
              </View>
              <Text style={s.idleNoteHint}>
                Keep it short — this shows on your Workday Map. {idleNote.length}/{IDLE_NOTE_MAX}
              </Text>
              {/* Says what to do next. Without it, someone who has typed a note is
                  looking at a text box with no obvious way forward. */}
              {idleNote.trim() ? (
                <Text style={s.idleNoteNext}>
                  Now pick a reason above to save it. ↑
                </Text>
              ) : null}

              {/* Closable on purpose: this popup covers the board, so a modal you
                  couldn't close would make reaching a task's Start button — the
                  very thing that answers this — impossible. It asks again shortly. */}
              <TouchableOpacity onPress={snoozeIdle} disabled={!!idleBusy}>
                <Text style={s.idleLater}>I have a task — let me start it</Text>
              </TouchableOpacity>
            </ScrollView>
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

            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
              <View style={s.modalPad}>
                {/* Three stat tiles */}
                <View style={s.statTiles}>
                  <View style={s.statTile}>
                    <Text style={s.statTileLbl}>Login</Text>
                    {/* On a phone the tile is ~114dp of content and the server's
                        '%Y-%m-%d %H:%M:%S' is ~124dp, so the full stamp clipped.
                        The date is redundant here anyway — this is a summary of
                        today — so drop it and keep the part that carries meaning. */}
                    <Text style={s.statTileVal} numberOfLines={1}>
                      {IS_NARROW
                        ? ((endSummary?.login_at || '—').split(' ')[1] || endSummary?.login_at || '—')
                        : (endSummary?.login_at || '—')}
                    </Text>
                  </View>
                  <View style={s.statTile}>
                    {/* The parenthetical is what tips these two labels over the
                        line on a phone. It is implied by the figure itself, and
                        the tablet keeps the fuller wording. */}
                    <Text style={s.statTileLbl}>{IS_NARROW ? 'Productive' : 'Productive (task time)'}</Text>
                    <Text style={[s.statTileBig, { color: COLORS.green }]}>{endSummary?.productive_display || '0m'}</Text>
                  </View>
                  {/* Presence and Accounted share ONE box, split by a rule.
                      They are the pair that has to be read together: Presence is
                      time at work (the pause is OFF it), Accounted is the whole
                      day explained (the pause is IN it), so the gap between the
                      two IS the pause. As two free-standing tiles the wrapping
                      row was allowed to put them on different lines, which is
                      precisely when that comparison stops being visible. */}
                  <View style={s.pairTile}>
                    <View style={s.pairHalf}>
                      <Text style={s.statTileLbl}>{IS_NARROW ? 'Presence' : 'Presence (at work)'}</Text>
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
                      {presenceFootnote(endSummary) ? (
                        <Text style={s.pairFoot} numberOfLines={1}>
                          {presenceFootnote(endSummary)}
                        </Text>
                      ) : null}
                    </View>
                    <View style={s.pairRule} />
                    {/* One figure for the whole day's accounted time, so "is my day
                        explained?" doesn't mean adding five boxes up by eye.
                        Accounted + Other/Idle = the clock, always — the clock,
                        not Presence, now that the pause sits outside Presence. */}
                    <View style={s.pairHalf}>
                      <Text style={s.statTileLbl}>Accounted</Text>
                      <Text style={[s.statTileBig, { color: COLORS.blue || '#2563EB' }]}>
                        {endSummary?.accounted_display || '0m'}
                      </Text>
                      {/* 48 chars wraps to three lines in a 114dp tile. The full
                          breakdown is a nicety; on a phone the one term a reader
                          would not have guessed is the one worth keeping. */}
                      <Text style={s.statTileFoot}>
                        {IS_NARROW ? '+ paused' : 'task + meeting + lunch + break + no-tasks + paused'}
                      </Text>
                    </View>
                  </View>
                  {/* Only when the day was actually frozen. Reported on its own
                      line rather than dropped, because a six-hour hole with no
                      explanation reads as a tracking failure to whoever reviews
                      the day. It sits OUTSIDE Presence — Presence stops while
                      the day is frozen — and INSIDE Accounted, so this figure is
                      exactly the gap between those two numbers. */}
                  {(endSummary?.paused_seconds || 0) > 0 ? (
                    <View style={s.statTile}>
                      <Text style={s.statTileLbl}>Workday paused</Text>
                      <Text style={[s.statTileBig, { color: '#B45309' }]}>
                        {endSummary?.paused_display || '0m'}
                      </Text>
                      <Text style={s.statTileFoot}>
                        {IS_NARROW ? 'not in Presence' : 'outside Presence, not worked time'}
                      </Text>
                    </View>
                  ) : null}
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
                      // Not idle auto-detection (retired) — time a task was stopped by
                      // the system: Pause Workday, or the midnight close.
                      ['Away (system)', endSummary?.away_display],
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
                    // NOTE the payload key is `note`, not `reason` — this test read
                    // e.reason, which away_events has never carried, so an urgent
                    // pause was only ever caught by its label.
                    const urgent = /urgent/i.test(e.label || '') || /urgent/i.test(e.note || '') || e.is_urgent === true;
                    return (
                      <View key={i} style={s.awayEvent}>
                        <View style={[s.awayTag, urgent && s.awayTagUrgent]}>
                          <Text style={[s.awayTagTxt, urgent && s.awayTagTxtUrgent]}>{e.label}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.awayEventTxt} numberOfLines={1}>
                            {e.start}–{e.end} ({e.duration_display}){e.from ? ` from "${e.from}"` : ''}
                          </Text>
                          {/* The typed note and, for a meeting, who it was with.
                              Neither was rendered here at all: the web away list
                              and the frozen PNG both printed the note, so the app
                              was the one surface that silently dropped it. */}
                          {(e.with || e.note) ? (
                            <Text style={s.awayEventNote} numberOfLines={2}>
                              {e.with ? `with ${e.with}` : ''}
                              {e.with && e.note ? ' — ' : ''}
                              {e.note || ''}
                            </Text>
                          ) : null}
                        </View>
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
                    <Text style={s.tdRef}>{t.concurrent ? '⚡ ' : ''}{t.ref}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.tdTitle} numberOfLines={1}>{t.name}</Text>
                      {/* Spelled out only when a task was worked BOTH alone and
                          alongside another. That is the case a single total gets
                          wrong: 20 minutes solo in the morning plus 2 hours shared
                          in the afternoon is not "2h20m of multitasking". */}
                      {t.concurrent && (t.solo_seconds || 0) > 0 ? (
                        <Text style={[s.tdTitle, { fontSize: 11, opacity: 0.7 }]} numberOfLines={1}>
                          {t.solo_display} alone · {t.shared_display} shared
                        </Text>
                      ) : null}
                    </View>
                    <Text style={s.tdTime}>{t.duration_display}</Text>
                  </View>
                ))}

                {/* Still optional — just big enough to actually write in, and it now says
                    where the note goes. "Anything to add…" in a 60pt box got 3 notes out of
                    213 sessions. */}
                <Text style={s.fieldLabel}>What did you work on today? (optional)</Text>
                <TextInput
                  style={[s.textInput, { minHeight: 120, textAlignVertical: 'top' }]}
                  multiline
                  maxLength={NOTE_MAX}
                  value={endNote}
                  onChangeText={(v) => { setEndNote(v); setEndNoteHint(validateWorkdayNote(v).hint); }}
                  // A real note from this team, in their own shorthand (-> bullets, + to
                  // chain items). People copy the shape of the example they are shown.
                  placeholder={'Module documents\n->Signage scan module doc\n\nApp documents\n->Van sale doc\n->Price checker doc(Need to add screenshots)\n\nChats server connecting issue + Dark/light mode switch bug + Build taken for testing'}
                  placeholderTextColor={COLORS.faint}
                />
                {/* Say where the note actually goes. It is posted to the team's
                    WhatsApp group verbatim, and ending a day cannot be undone —
                    finding that out afterwards is not a fair way to learn it.
                    Driven by the server so it only claims what is configured. */}
                <Text style={s.fieldHint}>
                  Saved with your workday snapshot and sent in the daily summary.
                  {endSummary?.wa_group_end_posts
                    ? ` It is also posted to the team's WhatsApp group${endSummary?.wa_group_name ? ` (${endSummary.wa_group_name})` : ''}.`
                    : ''}
                </Text>
                {/* Muted, not red. The box is optional and a thin note still ends
                    the day, so this is a suggestion while typing — nothing here is
                    a problem to be corrected before you can leave. */}
                {endNoteHint ? <Text style={s.fieldTip}>{endNoteHint}</Text> : null}
              </View>
            </ScrollView>

            {/* Pause sits HERE, next to End, because this is where the choice is
                actually made: stop for now, or stop for good. Ending is final for
                the date (one start + one end); pausing is not — which is what a
                4am finish needs. Not the same as "Pause all" on the tasks, which
                stops the TIMERS and leaves the workday running. */}
            {/* Gone once the day is ALREADY paused: the offer makes no sense
                (the server answers "your workday is already paused") and the
                button would toggle straight back to Resume, which is not what
                a control labelled Pause should do. It returns on resume. */}
            {workdayPaused ? null : (
            <View style={s.pauseInstead}>
              <Ionicons name="pause-circle-outline" size={18} color="#92400E" />
              <Text style={s.pauseInsteadTxt}>
                Coming back later today? <Text style={{ fontWeight: '800' }}>Pause</Text> instead —
                your day stays open, and the time away won't count as worked time.
              </Text>
              <TouchableOpacity
                style={[s.pauseInsteadBtn, workdayPauseBusy && { opacity: 0.6 }]}
                disabled={workdayPauseBusy}
                onPress={async () => { setEndSummary(null); await toggleWorkdayPause(); }}
                activeOpacity={0.85}
              >
                <Text style={s.pauseInsteadBtnTxt}>Pause</Text>
              </TouchableOpacity>
            </View>
            )}

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
  // MUST WRAP, for the third time in this file — same fault as modalFoot and
  // statTiles. This row holds the All/My segment, the role badge, a flex spacer,
  // New Task and Start/End Workday: about 482dp of content against ~332dp on a
  // 360dp phone. Without wrapping the spacer collapsed to nothing and the two
  // buttons pushed off the right edge — "New Task" was clipped mid-word and the
  // workday button, the single most important control on the screen, was
  // completely unreachable.
  //
  // The flex spacer has flexBasis 0, so it never triggers the wrap itself; it
  // just fills whatever is left of the line it lands on. Tablet: everything fits
  // one line and the spacer still right-aligns the buttons, exactly as now.
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 8, paddingHorizontal: 14, marginTop: 6 },
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
  // The gap that used to come from each lane's wrapper View. Flattening the list
  // for virtualisation removed the wrapper, so the heading carries it itself.
  listSectionSpaced: { marginTop: 8 },
  listSectionTxt: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  listRow: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, marginBottom: 8, overflow: 'hidden' },
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
  // Capped at half the row: past that a long name pushes the Live pill and the
  // arrow off a phone. flexShrink (not flex) so a SHORT name takes only what it
  // needs and the empty middle still falls through to the dropdown.
  listNameHit: { flexShrink: 1, maxWidth: '50%', paddingVertical: 15 },
  // Sits over the last few characters, fading them into the card. Only visible
  // when the text actually reaches the edge; over a short name it lies on white
  // and shows nothing.
  listNameFade: { position: 'absolute', right: 0, top: 0, bottom: 0 },
  listFullName: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy, lineHeight: 20, marginBottom: 8 },
  // Eats the leftover width for the OUTER (dropdown) touchable.
  listSpacer: { flex: 1, alignSelf: 'stretch', minWidth: 8 },
  listBody: { paddingHorizontal: 14, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#F0F3F8', paddingTop: 10 },
  listPill: { alignSelf: 'flex-start', marginBottom: 4 },
  listRowOpen: { borderColor: COLORS.primary },

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
  // Same chips as nontaskBtnRow, but this row follows the break pill directly
  // rather than sitting inside nontaskBox, so it carries its own top gap.
  breakSwitchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },

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
  idleNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  idleNoteDone: {
    marginTop: 4, width: 46, height: 44, borderRadius: 10,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  idleNoteDoneOff: { backgroundColor: COLORS.line },
  // Red on purpose: the length limit is a real constraint (it has to fit the Map
  // chip), not a suggestion, so it should read as one.
  idleNoteHint: { fontSize: 11.5, color: COLORS.red, marginTop: 6, marginBottom: 4 },
  idleNoteNext: { fontSize: 12, fontWeight: '800', color: COLORS.primary, marginBottom: 6 },
  idleLater: { fontSize: 13, fontWeight: '700', color: COLORS.faint, textAlign: 'center', paddingVertical: 8 },
  livePresence: { fontSize: 12, color: COLORS.muted, fontWeight: '600' },
  liveProductive: { color: COLORS.green, fontWeight: '800' },
  // Marks the live strip while the workday is frozen, so a Presence clock that
  // has deliberately stopped doesn't read as a stuck display.
  livePausedNote: { fontSize: 12, fontWeight: '800', color: '#B45309' },

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
  descBlock: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.line, borderRadius: 9,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 12, gap: 4,
  },
  descHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  descLabel: { fontSize: 11, fontWeight: '800', color: COLORS.muted, letterSpacing: 0.3 },
  descTxt: { fontSize: 12.5, color: COLORS.ink, lineHeight: 18 },
  metaBlock: { gap: 8, marginBottom: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Estimate extension. Same amber as KpiTaskDetail's estExtend, so the board and
  // the detail screen describe one state in one colour.
  extBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: '#FEF3C7', borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2 },
  extBadgeTxt: { fontSize: 10.5, fontWeight: '800', color: '#B45309' },
  extReason: { fontSize: 11.5, color: '#B45309', fontStyle: 'italic', lineHeight: 16, marginTop: -2 },
  metaLabel: { fontSize: 12.5, color: COLORS.muted, width: 66 },
  metaValue: { flex: 1, fontSize: 13, color: COLORS.ink, fontWeight: '700' },
  avatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontSize: 9, fontWeight: '800' },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 2 },
  btnBusy: { height: 36, justifyContent: 'center', paddingLeft: 6 },
  // overflow:hidden is what makes the gradient fill the whole pill. Without it the
  // SVG rect paints past the rounded corners and is not clipped to them, which
  // reads as a button only half coloured.
  // flexShrink:0 so a button keeps the width its label needs and WRAPS to the next
  // line instead of being squeezed. btnRow already wraps; without this the last
  // button on a line was compressed and — now that overflow is hidden for the
  // gradient — its label was clipped mid-word rather than spilling visibly.
  // overflow:hidden is what makes the gradient fill the whole pill: without it the
  // SVG rect paints past the rounded corners instead of being clipped to them.
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 36, paddingHorizontal: 13, borderRadius: 10, overflow: 'hidden', flexShrink: 0 },
  // flexShrink:0 here too — a Text that shrinks lets the button shrink with it,
  // which is the other half of a label getting clipped instead of wrapping.
  btnTxt: { fontSize: 12.5, fontWeight: '800', flexShrink: 0 },
  btn_primary: { backgroundColor: COLORS.primary }, btnTxt_primary: { color: '#fff' },
  btn_green: { backgroundColor: COLORS.green }, btnTxt_green: { color: '#fff' },
  btn_amber: { backgroundColor: COLORS.amber }, btnTxt_amber: { color: '#fff' },
  btn_red: { backgroundColor: COLORS.red }, btnTxt_red: { color: '#fff' },
  // Filled, not outlined — the web's btn-secondary and btn-outline-danger are both
  // gradient-filled with white text. The flat colour here is the gradient's dark
  // end, so the frame before the button has measured itself (and the blocked
  // state, which paints no gradient) still reads as the same button.
  btn_ghost: { backgroundColor: '#5b6b82' }, btnTxt_ghost: { color: '#fff' },
  btn_ghostRed: { backgroundColor: '#ff2d55' }, btnTxt_ghostRed: { color: '#fff' },
  // Their own colours, matching kpi-btn-partial and kpi-btn-addtime on the web.
  // The flat fill is the blocked/fallback state; BTN_GRAD paints the rest.
  btn_teal: { backgroundColor: '#00a99d' }, btnTxt_teal: { color: '#fff' },
  btn_purple: { backgroundColor: '#4b32e0' }, btnTxt_purple: { color: '#fff' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  centerTxt: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 60 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, backgroundColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 22, height: 44 },
  retryTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // A blocked action button: dimmed, but still pressable so the tap can explain
  // itself (see Btn). Not `disabled` — that would refuse in silence.
  btnBlocked: { opacity: 0.45 },
  // "Waiting on X" badge under a card whose Start the server won't allow yet.
  gatePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A',
    borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, marginTop: 8,
  },
  gatePillTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: '#92400E', lineHeight: 15 },

  // "Pause all (N)" — only in the live strip, only with 2+ timers running.
  pauseAllBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, marginLeft: 8,
  },
  pauseAllTxt: { fontSize: 11, fontWeight: '800', color: '#92400E' },
  pauseAllItem: { fontSize: 12.5, color: COLORS.muted, marginTop: 3 },

  // Switch picker.
  headBlueSoft: { backgroundColor: '#DBEAFE' },
  headBlueSoftTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#1E3A8A' },
  switchIntro: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18, marginBottom: 12 },
  // A full card per option, not a bare title: you are choosing what to work on
  // next, and a name alone is not enough to choose on. Read-only detail plus the
  // one tap that selects it — nothing here can start or pause anything else.
  switchCard: {
    borderWidth: 1, borderColor: '#E7ECF3', borderRadius: 12,
    padding: 12, marginBottom: 8, backgroundColor: '#FBFCFE',
  },
  switchCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 },
  switchRef: { fontSize: 12, fontWeight: '900', color: COLORS.primary },
  switchPrio: { fontSize: 10.5, fontWeight: '800', color: COLORS.muted, textTransform: 'uppercase' },
  switchName: { fontSize: 14, fontWeight: '700', color: COLORS.navy, lineHeight: 19, marginBottom: 4 },
  switchMeta: { fontSize: 11.5, color: COLORS.muted },
  switchPaused: { fontSize: 11.5, color: COLORS.amber, fontWeight: '700', marginTop: 4 },

  // Meeting participants picker.
  peopleSearch: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 7, marginBottom: 6, backgroundColor: '#fff',
  },
  peopleSearchInput: { flex: 1, fontSize: 13.5, color: COLORS.ink, padding: 0 },
  peopleList: {
    maxHeight: 190, borderWidth: 1, borderColor: COLORS.line,
    borderRadius: 10, paddingHorizontal: 8, backgroundColor: '#FBFCFE',
  },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
  personName: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '600' },
  personRole: { fontSize: 9.5, fontWeight: '900', color: COLORS.muted, letterSpacing: 0.4 },
  switchGroup: {
    fontSize: 11.5, fontWeight: '900', color: COLORS.muted,
    textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4, marginBottom: 6,
  },
  switchSearch: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10,
    backgroundColor: '#fff',
  },
  switchSearchInput: { flex: 1, fontSize: 13.5, color: COLORS.ink, padding: 0 },

  // Revert confirmation.
  revertBox: {
    backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E7ECF3',
    borderRadius: 12, padding: 12, marginTop: 10, marginBottom: 14,
  },
  revertBoxTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginBottom: 6 },
  revertBullet: { fontSize: 12, color: COLORS.muted, lineHeight: 18 },

  // Pause/Resume Workday, sat beside End Workday in the header.
  pauseDayBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A', marginRight: 8,
  },
  pauseDayBtnOn: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  pauseDayTxt: { fontSize: 12.5, fontWeight: '800', color: '#92400E' },
  // "Pause instead" row inside the End Workday dialog.
  pauseInstead: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#FEF3C7', borderTopWidth: 1, borderTopColor: '#FDE68A',
    paddingHorizontal: 16, paddingVertical: 10,
  },
  pauseInsteadTxt: { flex: 1, fontSize: 12, color: '#78350F', lineHeight: 16.5 },
  pauseInsteadBtn: {
    backgroundColor: '#F59E0B', paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 9,
  },
  pauseInsteadBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
  // Paused banner — the board looks normal but nothing will start, so say why.
  pausedBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#F1F5F9', borderLeftWidth: 4, borderLeftColor: '#94A3B8',
    paddingHorizontal: 12, paddingVertical: 9, marginHorizontal: 12, marginBottom: 8,
    borderRadius: 10,
  },
  pausedBarTxt: { flex: 1, fontSize: 12.5, color: COLORS.navy, lineHeight: 17 },

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
  reopenBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    marginHorizontal: 14, marginBottom: 4, paddingVertical: 8, paddingHorizontal: 11,
    backgroundColor: COLORS.amberBg, borderRadius: 10,
    borderLeftWidth: 3, borderLeftColor: COLORS.amber,
  },
  reopenBannerTxt: { flex: 1, fontSize: 12, color: '#8a5a00', fontWeight: '700' },
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
  modalBtn: { flex: 1, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalCancel: { backgroundColor: '#EEF2F8' }, modalCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  modalOk: { backgroundColor: COLORS.primary }, modalOkTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // Web-style dialog (Pause Task)
  // maxHeight so a card can never be taller than the screen. modalWrap centres
  // it, so an over-tall card pushed its own HEADER off the top of the viewport —
  // you could not see what the dialog even was. Only the modals that already had
  // a capped ScrollView body were safe; the rest (11 of them) relied on their
  // content happening to be short enough, which is true on a tablet and false on
  // a phone. This bounds all of them at once.
  modalCard: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', maxHeight: '92%' },
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

  // MUST WRAP. These are two intrinsically-sized buttons, and the longest pair
  // ("← Continue Working" + "Logout & Send Summary") comes to ~474dp with gaps
  // and padding — against ~312dp of phone width. With justifyContent:'flex-end'
  // the overflow spilled off the LEFT, which is why Continue Working was the
  // half-hidden one. Wrapping stacks them, still right-aligned, on a phone and
  // leaves them side by side on a tablet.
  //
  // Deliberately no flexGrow: growing would stretch both to full width on the
  // tablet, changing a layout that is already correct.
  modalFoot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10, paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 6 },
  footCancel: { flexShrink: 1, paddingHorizontal: 18, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F8' },
  footCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 14.5 },
  footConfirm: { flexShrink: 1, paddingHorizontal: 20, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5A623' },
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
  // Same look, WITHOUT flex:1. createdInfoTxt lives inside a row (s.createdInfo)
  // where flex makes it fill the line; reused standalone in a column it collapses
  // to nothing, which is why the "developer asked for…" lines rendered blank.
  askedLine: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18, marginBottom: 6 },

  // End Workday summary
  // The End Workday summary tiles. MUST WRAP: this row holds up to five tiles
  // (Login, Productive, Presence, Accounted, and Workday paused when the day was
  // frozen), and as a fixed `flexDirection: row` of flex:1 children they simply
  // divided whatever width existed. On a tablet that is ~220px each and looks
  // right; on a phone it is ~58px, minus 20px of padding — too narrow for a
  // 19px figure, let alone the label above it. It was the fifth tile added for
  // Pause Workday that pushed it past readable on small screens.
  //
  // flexBasis is the wrap threshold, not a fixed width: flexGrow lets tiles
  // fill the row they land on. 128 puts two per row on a 320dp phone and still
  // fits all five across a tablet, so the layout that already looked right is
  // unchanged and only narrow screens reflow.
  statTiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },

  // Workday Map (End Workday popup) — flowing chips: start → task → break → … → end.
  mapBox: { marginTop: 12, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 },
  mapTitle: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginBottom: 8 },
  mapFlow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  mapArrow: { color: '#9CA3AF', fontSize: 15, fontWeight: '700' },
  mapChip: { borderWidth: 1, borderTopWidth: 3, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: '#fff', minWidth: 92, maxWidth: 152 },
  mapChipLabel: { fontSize: 12, fontWeight: '700', color: COLORS.ink },
  mapChipTime: { fontSize: 10.5, color: COLORS.muted, marginTop: 1 },
  mapChipNote: { fontSize: 10.5, color: '#374151', fontStyle: 'italic', marginTop: 1 },
  // flexBasis is the WRAP THRESHOLD, not a fixed width — flexGrow still lets a
  // tile fill whatever row it lands on, so nothing looks half-empty. `flex: 1`
  // could not do this: it sets flexBasis to 0, so five tiles always "fit" and
  // the row never wrapped no matter how narrow the screen got.
  statTile: { flexGrow: 1, flexBasis: 128, minWidth: 128, backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 10 },
  // Presence + Accounted in one box, divided by a rule. Sized as TWO statTiles
  // (128 + 128 + the 8 gap between them) so it flows inline beside Login and
  // Productive instead of claiming a row. '100%' did claim one, which dropped the
  // pair below the fold and put the day's two headline figures under the two
  // least interesting ones. It still cannot be split across lines whatever the
  // width, because it is a single element - which is the property that mattered.
  pairTile: { flexGrow: 1, flexBasis: 264, minWidth: 240, flexDirection: 'row', backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line },
  pairHalf: { flex: 1, padding: 10 },
  // The dividing line. Inset vertically so it reads as a separator between two
  // readings rather than as the border of two boxes pushed together.
  pairRule: { width: 1, backgroundColor: COLORS.line, marginVertical: 8 },
  // login–logout · paused, under Presence. Muted and lighter than
  // statTileFoot: it explains the figure, it is not a verdict on it.
  pairFoot: { fontSize: 10, color: COLORS.muted, fontWeight: '700', marginTop: 3 },
  statTileLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  statTileVal: { fontSize: 13, color: COLORS.ink, fontWeight: '800', marginTop: 4 },
  // 19 is right in a ~220dp tablet tile; in a ~134dp phone tile it crowds the
  // label above it. Two points back is enough and keeps the figure dominant.
  statTileBig: { fontSize: IS_NARROW ? 17 : 19, fontWeight: '900', marginTop: 4 },
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
  // No longer flex:1 — it sits inside a flexed column now, and keeping flex here
  // fought the note underneath it for the same space.
  awayEventTxt: { fontSize: 11.5, color: COLORS.muted },
  awayEventNote: { fontSize: 11, color: COLORS.faint, fontStyle: 'italic', marginTop: 1 },
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
  fieldHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 6, lineHeight: 16 },
  fieldErr: { fontSize: 12, color: COLORS.red, fontWeight: '700', marginTop: 6 },
  // Advice, not a fault — deliberately not red. Used for the End Workday note,
  // which is optional and must never look like something blocking the button.
  fieldTip: { fontSize: 11.5, color: COLORS.amber, fontWeight: '600', marginTop: 6, lineHeight: 16 },
  fieldHint: { fontSize: 12, color: COLORS.muted, marginTop: 5 },
  // Inline validation inside a dialog. Clears itself as soon as the user starts
  // fixing the thing it complains about.
  inlineErr: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 12,
  },
  inlineErrTxt: { flex: 1, fontSize: 12.5, color: COLORS.red, fontWeight: '600', lineHeight: 17 },
  inputErr: { borderColor: COLORS.red },

  // "Completed by / date / review started" — mirrors the web card's block.
  doneBlock: { marginTop: 8, gap: 3 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  doneTxt: { flex: 1, fontSize: 12, color: COLORS.green, fontWeight: '600' },
  doneStrong: { fontWeight: '900' },
  doneMuted: { flex: 1, fontSize: 12, color: COLORS.muted },
  doneInfo: { flex: 1, fontSize: 12, color: COLORS.primary, lineHeight: 16 },
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
