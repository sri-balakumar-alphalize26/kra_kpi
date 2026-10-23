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
  LANES, groupIntoLanes, byRecency, laneForTask, isTodayTask, isWithinFreshWindow, taskMatchesQuery, fetchTasks, fetchTaskById, fetchUsers, fetchPeople,
  startTask, pauseTask, resumeTask, resumeTaskWithReason, completeTask, reassignTask, adminDeleteTask, createProgress,
  undoTaskStart, fetchTaskDetails,
  switchTask, pauseAllTasks, revertSignoff,
  approveTask, rejectTask, getTaskChecklists, markReviewStarted,
  MGR_CHECKLIST_ITEMS, PAUSE_REASONS, PRIORITIES,
  getWorkdayStatus, startWorkday, endWorkday, pauseWorkday, resumeWorkday, sendHeartbeat,
  selfCreateTask, adminCreateDoneTask, fetchProjects, fetchClientTree, getTodaySummary, getLiveStatus,
  acceptSelfCreated, rejectSelfCreated,
  IDLE_REASONS, setIdleReason, endNonTask, IDLE_NOTE_MAX,
  sinceResume, BREAK_SWITCH_REASONS, switchBreak,
} from '../services/kpiActions';
import { createLogger } from '../api/logger';
import { serverNow } from '../api/odooApi';
import { scheduleTaskReminder, cancelTaskReminder } from '../services/reminders';
import { scheduleTaskAlarm, stopAlarm, alarmAvailable } from '../services/alarm';
import { getReminders, setReminder, removeReminder, getReminderPresets, setReminderPresets, getBoardPrefs, saveBoardPrefs } from '../api/session';
import DurationTimePicker from '../components/DurationTimePicker';
import AlarmModePicker from '../components/AlarmModePicker';
import PulseDot from '../components/PulseDot';
import * as H from '../utils/haptics';
import { publishWidgetState, clearWidgetState } from '../utils/taskWidget';
import { workdayButtonState } from '../utils/workdayState';
import { validateWorkdayNote, NOTE_MAX } from '../utils/workdayNote';
// Why a blocked task is blocked, in the server's words. Pure + unit-tested
// against real payloads (utils/__tests__/taskGate.test.js).
import { gateLabel } from '../utils/taskGate';
import MeetingPicker from '../components/MeetingPicker';
import WorkdaySummaryBody from '../components/WorkdaySummaryBody';
import {
  DELIVERABLE_TYPES, deliverableLabel, taskDeliverableLabel, hasDeliverable, toggleDeliverable, needsOtherText, missingOtherText,
  DELIVERABLE_OTHER_MAX, DELIVERABLE_OTHER_PLACEHOLDER, DELIVERABLE_OTHER_REQUIRED_MSG,
} from '../utils/deliverableType';
import { estimateFromWorked } from '../utils/doneTaskEstimate';
import DateGridModal from '../components/DateGridModal';
import { fmtYMD } from '../utils/dateGrid';
import { completeMissing, completeExtras } from '../utils/completeMissing';
import CompleteRules from '../components/CompleteRules';
import { canOfferUndoStart, undoStartConfirm } from '../utils/undoStart';
import { noteRequired, pauseReasonText, meetingIds, idleMeetingNote } from '../utils/meetingPick';
import useBackHandler from '../components/useBackHandler';
// Shared with HomeScreen's running-task card. Were local functions here until
// Home needed the same three -- a second copy is how two screens start
// disagreeing about what time it is.
import { secsSince, liveFromAnchor, fmtHMS, productiveLive, presenceLive } from '../utils/liveTime';

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
// Heartbeat cadence. The server's "working right now" cutoff is at least a
// minute wide (max(1, away_after_minutes), default 5), so 30s stays comfortably
// inside even the tightest setting while costing a fraction of the traffic the
// 15s live-strip poll already carries.
const HEARTBEAT_MS = 30000;
const { width: SW, height: SH } = Dimensions.get('window');
const LANE_MAX_H = Math.round(SH * 0.78); // lane card-scroll height, adapts to screen

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

// productiveLive / presenceLive now live in utils/liveTime.js: the home-screen
// widget (utils/taskWidgetState.js) needs the same two definitions, and a second
// copy is how the board and the widget would start disagreeing about the same
// day. Re-exported so nothing that imported them from here changes.
export { productiveLive, presenceLive };

// presenceFootnote moved to components/WorkdaySummaryBody.js with the summary
// it explains. Re-exported so nothing that imported it from here changes.
export { presenceFootnote } from '../components/WorkdaySummaryBody';

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

// Module / App / EXE / Other as checkboxes — a task can build more than one.
// `value` is the 'module,app' string the server stores. Ticking Other opens a
// box for what it is (`other`), required while Other stays ticked. Used by New
// Task and Done Task.
function DeliverableChecks({ value, onToggle, other, onOther }) {
  return (
    <>
      <View style={s.segFull}>
        {DELIVERABLE_TYPES.map((d) => {
          const on = hasDeliverable(value, d.code);
          return (
            <TouchableOpacity key={d.code} style={[s.segFullItem, s.checkItem, on && s.segFullItemOn]}
              onPress={() => { H.select(); onToggle(d.code); }} activeOpacity={0.8}>
              <Ionicons name={on ? 'checkbox' : 'square-outline'} size={16} color={on ? '#fff' : COLORS.muted} />
              <Text style={[s.segFullTxt, on && { color: '#fff' }]} numberOfLines={1} adjustsFontSizeToFit>{d.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {needsOtherText(value) && (
        <TextInput style={[s.textInput, { marginTop: 8 }, !String(other || '').trim() && s.inputErr]} value={other || ''} onChangeText={onOther}
          maxLength={DELIVERABLE_OTHER_MAX} placeholder={DELIVERABLE_OTHER_PLACEHOLDER} placeholderTextColor={COLORS.muted} />
      )}
    </>
  );
}

function TaskDetailBody({ task, onAction, busyId, nowMs, isAdmin, currentUserId, reminder, readOnly = false }) {
  const st = task.task_state;
  const running = st === 'in_progress';
  const busy = busyId === task.id;
  const canStart = ['assigned', 'urgent', 'important', 'regular', 'queue_waiting',
    'pre_approval_approved', 'pre_approval_partial'].includes(st);
  // 'hold' is kept here on purpose even though it is not in the server's
  // _RESUMABLE_STATES: that constant is the "already underway, skip the approval
  // checks" shortcut, not a refusal, and can_start below is the server's actual
  // answer for this task. Dropping it would remove a path that works.
  const canResume = ['paused', 'hold', 'rework'].includes(st);
  // Deliberately NOT narrowed to the web board's in_progress/paused. The server
  // states the rule itself — can_complete in /kra_kpi/task/details is
  // "task_state in (in_progress, paused, hold, rework) AND assignee-or-admin" —
  // so these four are permitted and the web's own detail panel offers them too.
  // Its board button list is the stale side; matching it here would have taken a
  // working path away.
  const canComplete = ['in_progress', 'paused', 'hold', 'rework'].includes(st);
  const canPause = st === 'in_progress';
  // Offer Add time only once the work is at or past the number it was given.
  // Mirrors canAddTime in kpi_action.js:1989 — same states, same 80% threshold,
  // and the same "no estimate means offer it immediately", since any time spent
  // overruns an estimate of zero. The server still has the final say (it refuses
  // once the client owns the number, and for someone else's task); this only
  // decides whether the button is worth showing.
  const canAddTime = (() => {
    // The ownership half of the rule, which this comment has always claimed to
    // mirror and did not: kpi_action.js gates on admin-or-assignee first. Without
    // it the board offered Add time on somebody else's overrunning task, for the
    // server to refuse. A payload with no user_id (older server) is left alone.
    if (task.user_id && currentUserId && task.user_id !== currentUserId && !isAdmin) return false;
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
              {/* Started the wrong task? can_undo_start is the SERVER's answer
                  (your own start today, or any start today for an admin;
                  running or paused); the route
                  re-checks it, and the tap asks before anything changes. */}
              {canOfferUndoStart(task) && (
                <Btn label="Undo start" icon="arrow-undo-outline" kind="ghostRed" onPress={() => onAction('undoStart', task)} />
              )}
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
              {/* Not on a completed task, matching the web: moving finished work
                  to a different developer rewrites history rather than changing
                  who does something. */}
              {isAdmin && st !== 'completed' && (
                <Btn label="Reassign" icon="swap-horizontal" kind="ghost" onPress={() => onAction('reassign', task)} />
              )}
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
                // Date.now(), not nowMs: whenIso was written from the DEVICE
                // clock when the reminder was set, so it is compared on the
                // device clock. nowMs is server time, and on a device 5 minutes
                // behind the server a 3-minute reminder read as already fired.
                const active = reminder && Date.parse(reminder.whenIso) > Date.now();
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
// Two ways in, and they are deliberately different targets: tapping the ROW
// opens the task; tapping the ARROW expands the actions in place. Splitting them
// by area is what makes both reachable — the old version put the accordion on
// the whole row and the details on the name alone, so which one you got depended
// on hitting a word.
function TaskListRowBase({ task, expanded, rowKey: myRowKey, onToggle, onAction, busyId, nowMs, isAdmin, currentUserId,
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
          <View style={s.chipRow}>
            <View style={[s.pill, s.listPill, { backgroundColor: p.bg }]}>
              <View style={[s.pillDot, { backgroundColor: p.fg }]} />
              <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
            </View>
            {!!taskDeliverableLabel(task) && (
              <View style={[s.refPill, s.listPill]}>
                <Text style={s.refPillTxt} numberOfLines={1}>{taskDeliverableLabel(task)}</Text>
              </View>
            )}
          </View>
          <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} currentUserId={currentUserId} reminder={reminder} readOnly={readOnly} />
        </View>
      )}
    </Animated.View>
  );
}

// Memoised for the same reason as TaskCard — an expanded lane can hold hundreds
// of rows, and each one mounts two Animated.Values and its own SVG gradient.
const TaskListRow = React.memo(TaskListRowBase);

function TaskCardBase({ task, onAction, busyId, nowMs, isAdmin, currentUserId, fresh = false, reminder, pulse, onMeasure, onOpenDetail, readOnly = false }) {
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
    <View style={[s.card, fresh && s.cardFresh]}>
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
          <Text style={[s.cardTitle, !!canOpen && s.cardTitleLink, fresh && s.cardTitleFresh]} numberOfLines={2}>{task.name}</Text>
          {canOpen && <Ionicons name="information-circle-outline" size={16} color={COLORS.primary} style={{ marginLeft: 6, marginTop: 2 }} />}
        </TouchableOpacity>
        <View style={s.chipRow}>
          <View style={[s.pill, { backgroundColor: p.bg }]}>
            <View style={[s.pillDot, { backgroundColor: p.fg }]} />
            <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
          </View>
          {/* The task's own reference, so a card can be quoted and searched for
              by number. Shares the priority row rather than taking a line of its
              own, and matches the ref badge the switch sheet already shows. */}
          {!!task.external_ref && (
            <View style={s.refPill}>
              <Text style={s.refPillTxt} numberOfLines={1}>{task.external_ref}</Text>
            </View>
          )}
          {/* Module / App / EXE / Other — what is being built. */}
          {!!taskDeliverableLabel(task) && (
            <View style={s.refPill}>
              <Text style={s.refPillTxt} numberOfLines={1}>{taskDeliverableLabel(task)}</Text>
            </View>
          )}
          {running && (
            <View style={s.livePill}>
              <PulseDot size={7} color={COLORS.green} />
              <Text style={s.liveTxt}>Live</Text>
            </View>
          )}
        </View>

        {/* Meta + actions (shared with the list view) */}
        <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} currentUserId={currentUserId} reminder={reminder} readOnly={readOnly} />
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
  const [currentUserId, setCurrentUserId] = useState(null);
  // A session for today was closed by the cron rather than by the developer.
  const [todayClosed, setTodayClosed] = useState(false);
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
  const laneRefs = useRef({});                     // laneKey → lane FlatList ref (scrollToOffset, not scrollTo)
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
  // "Team meeting" instead of naming people: no note needed, no attendees sent.
  // Shared by all four meeting dialogs, like meetingWith, and reset with it.
  const [teamMeeting, setTeamMeeting] = useState(false);
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
    if (code !== 'meeting') { setMeetingWith([]); setTeamMeeting(false); setPeopleQuery(''); }
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
  // When the error is a full Complete's missing-items list, the error box also
  // offers a one-tap switch to Partial Finish (summary only).
  const [finishOfferPartial, setFinishOfferPartial] = useState(false);
  // What this task's type needs to be completed (server rules, loaded when the
  // popup opens) and what the popup filled in for it.
  const [finishRules, setFinishRules] = useState([]);
  const [finishFilled, setFinishFilled] = useState({});

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
  // Respond & Resume: a self-created task an admin sent back owes an answer
  // before its timer may run again.
  const [resumeFor, setResumeFor] = useState(null);
  const [resumeNote, setResumeNote] = useState('');
  // Admin review of a developer-completed task: Approve (with QA checklist) → client; Reject → same dev.
  const [approveFor, setApproveFor] = useState(null);
  const [mgrChecklist, setMgrChecklist] = useState({});
  const [empRules, setEmpRules] = useState(null);   // what the task's type needed (read-only)
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

  // Remembered per user, on this device (api/session.js): the view and the
  // All / My toggle come back the way they were left, instead of snapping to
  // the defaults on every visit. Restored once the server has said who is
  // looking (currentUserId), saved on every change after that.
  const prefsRestoredFor = useRef(null);
  useEffect(() => {
    if (!currentUserId || prefsRestoredFor.current === currentUserId) return;
    prefsRestoredFor.current = currentUserId;
    getBoardPrefs(currentUserId).then((p) => {
      if (p.viewMode === 'board' || p.viewMode === 'list') setViewMode(p.viewMode);
      if (typeof p.myOnly === 'boolean') setMyOnly(p.myOnly);
    }).catch(() => {});
  }, [currentUserId]);
  useEffect(() => {
    if (!currentUserId || prefsRestoredFor.current !== currentUserId) return;
    saveBoardPrefs(currentUserId, { viewMode, myOnly });
  }, [currentUserId, viewMode, myOnly]);

  // When opened focused on a status (from a Home stat card), that lane's heading
  // starts expanded so its tasks show immediately.
  const [expandedLanes, setExpandedLanes] = useState(() => (focusStatus ? new Set([focusStatus]) : new Set()));
  const [expandedRow, setExpandedRow] = useState(null);

  // KPI Details — a full screen that REPLACES the board, exactly as the web pane
  // replaces its list. Its own component owns the loading/writes; the board just
  // says which task and takes it back on Back.
  const [detailTask, setDetailTask] = useState(null);
  // Back closes an open filter list (not a Modal, so Android would otherwise
  // leave the board), then the task detail. KpiTaskDetail normally takes the
  // press first; this is the fallback.
  useBackHandler(() => {
    if (openFilter) { setOpenFilter(null); return true; }
    if (detailTask) { setDetailTask(null); return true; }
    return false;
  });
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
  // The chosen alarm sound and the global { ringMins, snoozeMins } now belong to
  // components/AlarmModePicker, which loads and saves them itself — this screen no
  // longer needs to hold them just to draw three rows.
  //
  // The open wheel-picker request { field, mode, initial, title } (null = closed).
  // Only 'customTime' reaches it now; ring and snooze are the picker's own.
  const [durPicker, setDurPicker] = useState(null);
  useEffect(() => {
    getReminders().then((m) => { setReminders(m || {}); log.info('reminders restored', { count: Object.keys(m || {}).length }); }).catch(() => {});
    // null = never customised (keep defaults); an array (even empty) = the user's
    // saved list, honoured as-is so deletions stick across relaunches.
    getReminderPresets().then((arr) => { if (Array.isArray(arr)) { setPresetMins(arr); log.info('reminder presets restored', { count: arr.length }); } }).catch(() => {});
  }, []);

  // Wheel-picker confirm → a wall-clock time turned into "remind me in N seconds".
  // Ring and snooze used to be routed here too; they now belong to
  // components/AlarmModePicker, which owns its own picker.
  const onDurConfirm = async (result) => {
    const dp = durPicker;
    setDurPicker(null);
    if (!dp) return;
    if (dp.field === 'customTime') {
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
    const canRing = alarmAvailable();
    const wantAlarm = reminderMode === 'alarm' && Platform.OS === 'android' && canRing;
    // The user asked for an alarm and is not getting one. Worth saying out loud:
    // a failed SCHEDULE already reports itself below, but a failed CAPABILITY
    // check used to just take the other branch — so the dialog said Alarm, the
    // user picked Alarm, and a quiet notification arrived with nothing anywhere
    // explaining why. warn(), not info(), because info is stripped from release
    // builds and this is exactly the line worth having when it happens.
    const degraded = reminderMode === 'alarm' && !wantAlarm;
    if (degraded) {
      log.warn('reminder: alarm downgraded to a notification',
        { id: task.id, platform: Platform.OS, alarmAvail: canRing });
    }
    log.info('reminder: apply', { id: task.id, mins: Math.round((secs / 60) * 10) / 10, mode: wantAlarm ? 'alarm' : 'notify', alarmAvail: canRing });
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
    // Told AFTER the reminder is safely set, so the message reports what happened
    // rather than reading like a failure to set one.
    if (degraded) {
      showError('Reminder set, but it will not ring',
        Platform.OS !== 'android'
          ? 'Full-screen alarms are Android only. This was set as a notification instead.'
          : 'The alarm engine is not available right now, so this was set as a notification instead. Reopen the app and set it again if you need it to ring.');
    }
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
  // { ref, name, kind } after a New Task ('new') or Done Task ('done') is created
  const [createdPopup, setCreatedPopup] = useState(null);

  // New Task modal
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [ntName, setNtName] = useState('');
  const [ntProject, setNtProject] = useState(null);
  const [ntHours, setNtHours] = useState('1');
  const [ntMinutes, setNtMinutes] = useState('0');
  const [ntPriority, setNtPriority] = useState('regular');
  const [ntDeliverable, setNtDeliverable] = useState('');   // Module / App / EXE / Other, required
  const [ntDeliverableOther, setNtDeliverableOther] = useState('');   // Other's text, required with Other
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

  // Admin "Done Task" modal — work already finished off-system. One object, null
  // while closed. Shares clientTree and assignees with New Task.
  //   { name, client, project, user, deliverable, workedH, workedM, workDate,
  //     estH, estM, estTouched, priority, desc, open: 'client'|'project'|'user'|'date'|null }
  const [doneTask, setDoneTask] = useState(null);
  const [doneBusy, setDoneBusy] = useState(false);

  // The newest load wins. The 20s silent poll and an All ↔ My toggle overlap,
  // and on a large board the slower "All" answer landed after "My" and
  // overwrote it: the toggle read My while every task was on screen.
  const loadSeq = useRef(0);
  const load = useCallback(async (opts = {}) => {
    const seq = ++loadSeq.current;
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      log.info(opts.silent ? 'poll refresh' : 'load board', { myOnly });
      const res = await fetchTasks({ myTasksOnly: myOnly });
      if (seq !== loadSeq.current) return;   // an older answer; a newer one is coming
      setRaw(res.tasks);
      setIsAdmin(res.isAdmin);
      // Already in the payload and, until now, thrown away. Add time needs it:
      // that button is the assignee's or an admin's, and without knowing who is
      // looking the board offered it on other people's tasks for the server to
      // refuse.
      setCurrentUserId(res.currentUserId);
      setIsMock(res.isMock);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      log.error('load failed', e?.message);
      // Don't clobber a working board on a silent poll failure.
      if (!opts.silent) setError(e.message || 'Failed to load tasks');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [myOnly]);

  useEffect(() => { load(); }, [load]);

  // Live-timer tick: re-render every second so in-progress cards count up.
  useEffect(() => {
    // serverNow(), not Date.now(): every anchor these timers count from
    // (timer_start_datetime, a break's start_raw, login_raw) was written by the
    // server, so the subtraction has to happen on the server's clock. A device
    // running fast otherwise shows time that has not passed yet — most visibly on
    // a break that has only just started and should read zero.
    setNowMs(serverNow());
    const id = setInterval(() => setNowMs(serverNow()), TICK_MS);
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
      // Fetched all along and kept nowhere. Without it a midnight auto-close is
      // indistinguishable from a day that has not started.
      setTodayClosed(!!r?.today_closed);
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

  // Keep today's session marked alive, so the admin's Live Tracking board does
  // not report this developer as away while they are working. That board reads
  // heartbeat freshness and nothing else; the app sent no heartbeat at all, so a
  // phone-only developer went grey — and dropped out of the "Active now" count —
  // a few minutes after starting their day. Gated on an open workday because the
  // stamp only means anything on an open session: with none, the route no-ops.
  useEffect(() => {
    if (!workdayOpen) return undefined;
    let alive = true;
    const beat = async () => {
      try {
        const r = await sendHeartbeat();
        // The old auto-away cron is off by default, but a session it paused still
        // carries awayed_task_id and the heartbeat is what clears it. Pull the
        // board back into line rather than leaving a card that says it is running.
        if (alive && r?.was_away) { await refreshLive(); load({ silent: true }); }
      } catch (e) { /* offline: the next beat covers it */ }
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    log.info('heartbeat started', { everyMs: HEARTBEAT_MS });
    return () => { alive = false; clearInterval(id); };
  }, [workdayOpen, refreshLive, load]);

  // "In a meeting" on the idle popup: reveal the attendee picker rather than
  // filing the block straight away, and pull the people list in on first open —
  // same lazy fetch the Pause dialog does, so the list is not loaded for the
  // three reasons that never need it.
  const [idleMeetingPick, setIdleMeetingPick] = useState(false);
  const openIdleMeeting = () => {
    H.tap();
    setIdleMeetingPick(true);
    if (!people.length && !peopleBusy) {
      setPeopleBusy(true);
      fetchPeople()
        .then((list) => setPeople(list || []))
        .catch((e) => log.warn('people load failed', e?.message))
        .finally(() => setPeopleBusy(false));
    }
  };

  async function chooseIdleReason(code) {
    log.info('idle reason', { code, hasNote: !!idleNote.trim() });
    setIdleBusy(code);
    try {
      // Attendees only travel with a meeting; the service drops them otherwise.
      const res = await setIdleReason(
        code,
        code === 'meeting' ? idleMeetingNote(idleNote, teamMeeting) : idleNote,
        meetingIds(code, teamMeeting, meetingWith),
      );
      if (res && res.status === false) {
        showError("Couldn't save that", res.message || 'Failed');
        return;
      }
      setIdlePopup(false);
      setSwitchTo(null);
      setIdleNote('');
      // Reset the picker too, or reopening the popup shows the last meeting's
      // people already ticked and a second meeting silently inherits them.
      setIdleMeetingPick(false);
      setMeetingWith([]); setTeamMeeting(false);
      setPeopleQuery('');
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
    log.info('switch break', { code, withCount: code === 'meeting' ? meetingWith.length : 0 });
    setBreakSwitchBusy(code);
    try {
      // A meeting carries who and what-about, exactly as pausing a task for one
      // does. The route has always accepted both; only the app was dropping them.
      const res = await switchBreak(
        code,
        code === 'meeting' ? idleMeetingNote(idleNote, teamMeeting) : '',
        meetingIds(code, teamMeeting, meetingWith),
      );
      if (res && res.status === false) {
        showError("Couldn't switch that", res.message || 'Failed');
        return;
      }
      setSwitchTo(null);
      setIdleMeetingPick(false);
      setMeetingWith([]); setTeamMeeting(false);
      setPeopleQuery('');
      setIdleNote('');
      await refreshLive();
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setBreakSwitchBusy(null); }
  }

  // Back to the task the break was taken from. Goes through runAction rather than
  // resumeTask directly, so the can_start gate and the sent-back "Respond &
  // Resume" branch both still apply — this is a shortcut to the button, not a way
  // round it. The board may not be showing that task (a filter, a search, the
  // wrong lane collapsed), so fall back to fetching it by id.
  async function resumeAwayTask(taskId) {
    const known = raw.find((t) => t.id === taskId);
    if (known) { runAction('resume', known); return; }
    setBreakSwitchBusy('resume');
    try {
      const t = await fetchTaskById(taskId);
      if (t) runAction('resume', t);
      else showError("Couldn't resume", 'That task could not be loaded.');
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setBreakSwitchBusy(null); }
  }

  // "I have no tasks", said while a task sits paused behind a break. Not a
  // switchBreak: no_tasks is not a break type, only a non-task block reason — and
  // it is the one reason that reaches admins, which is the whole point of saying
  // it. Ends the break, opens the block, leaves the task paused.
  async function declareNoTasks() {
    if (breakSwitchBusy) return;
    log.info('declare no tasks (from break pill)');
    setBreakSwitchBusy('no_tasks');
    try {
      const res = await setIdleReason('no_tasks', '');
      if (res && res.status === false) {
        showError("Couldn't save that", res.message || 'Failed');
        return;
      }
      say('Your admins have been told', 'They know you have no tasks and can assign you work.', 'ok');
      await refreshLive();
      await load({ silent: true });
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setBreakSwitchBusy(null); }
  }

  // Filter by search + assignee + priority + status, then group into lanes.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return raw.filter((t) => {
      // Name, assignee OR task ref — the ref matched however it is typed, so
      // "task014" finds TASK-014. Same predicate the switch sheet already used.
      if (!taskMatchesQuery(t, q)) return false;
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

  // Search that lands on ONE task opens it and beats once, instead of leaving a
  // collapsed "Paused 1" heading to tap. Someone typing a ref already knows which
  // task they want — making them tap twice more to see it is the search not
  // finishing its job.
  //
  // ONLY on exactly one match, deliberately. Two results are a choice and the
  // person should see both headings; sixty would expand half the board. And only
  // while something is actually typed, so clearing the box does not leave a lane
  // hanging open.
  //
  // Keyed on the found task's id, not on the search text: that way it fires once
  // when the result settles, not on every keystroke that happens to still match,
  // and re-collapsing the lane by hand is not undone by the next render.
  const soloMatchId = (search.trim() && filtered.length === 1) ? filtered[0].id : null;
  useEffect(() => {
    if (!soloMatchId) return undefined;
    const task = filtered[0];
    const laneKey = laneForTask(task);
    log.info('search: single match, opening it', { id: soloMatchId, ref: task.external_ref, laneKey });
    setExpandedLanes((prev) => (prev.has(laneKey) ? prev : new Set([...prev, laneKey])));
    // Same heartbeat the notification focus uses, and the same release window, so
    // a found card behaves identically however you arrived at it.
    const t = setTimeout(() => setPulseId(soloMatchId), 260);
    const t2 = setTimeout(() => setPulseId(null), 3200);
    return () => { clearTimeout(t); clearTimeout(t2); };
    // filtered is intentionally not a dep — soloMatchId already captures the only
    // thing that should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soloMatchId]);

  // Whether anything is narrowing the board right now. "Most tasks first" is for
  // searching only — applied unfiltered it would reorder the lanes by how full
  // they are, so the pipeline would rearrange itself every time a task moved.
  const filtering = !!(search.trim() || filterAssignee != null || filterPriority || filterStatus);

  // Lanes holding work first, empty ones last — always, not only under a search.
  // Eleven lanes at ~265px meant scrolling past "Nothing here yet" columns to
  // reach the work. Pipeline position survives as the tie-break, so the familiar
  // order still holds among the lanes that have tasks.
  const orderedLanes = useMemo(() => {
    const counts = new Map(LANES.map((l) => [l.key, (lanes[l.key] || []).length]));
    const order = new Map(LANES.map((l, i) => [l.key, i]));
    return [...LANES].sort((a, b) => {
      const ca = counts.get(a.key), cb = counts.get(b.key);
      if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1;   // work before emptiness
      if (filtering && ca !== cb) return cb - ca;          // most matches first, searching only
      return order.get(a.key) - order.get(b.key);
    });
  }, [lanes, filtering]);

  // A to-do card nobody has started, and only for its first day. Only in the
  // three to-do lanes: zero time in Queued or Awaiting Client is normal, and
  // marking it there would drown the signal. Matches isFreshTask in kpi_action.js.
  //
  // The age term is the newest part. Without it the red never expired, so a task
  // nobody had touched in a month looked exactly as urgent as one filed this
  // morning — and a colour that is always on says nothing. Starting the task
  // still clears the red immediately; age only puts a floor under how long the
  // shout can last.
  //
  // serverNow(), not Date.now(): the offset is re-measured from every Odoo
  // response's Date header, so a device with the wrong clock cannot decide that
  // a card is a day old when it is not.
  const isFreshTask = useCallback((t, laneKey) => (
    ['regular', 'important', 'urgent'].includes(laneKey)
    && !(t.timer_total_seconds > 0)
    && isWithinFreshWindow(t, serverNow())
  ), []);

  // Never-started work sits at the top of its lane: a card added to the bottom of
  // a long Regular lane is a card nobody sees. Stable otherwise — the server's
  // order is preserved within each group.
  const laneItems = useCallback((laneKey) => {
    const items = lanes[laneKey] || [];
    if (!['regular', 'important', 'urgent'].includes(laneKey)) return items;
    const fresh = [], rest = [];
    for (const t of items) (isFreshTask(t, laneKey) ? fresh : rest).push(t);
    return fresh.concat(rest);
  }, [lanes, isFreshTask]);

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
    for (const l of orderedLanes) {
      const items = laneItems(l.key);
      if (!items.length) continue;
      const open = expandedLanes.has(l.key);
      out.push({ kind: 'head', key: `h:${l.key}`, lane: l, count: items.length, open });
      // Keyed by LANE + id, not id alone. A task worked today is in Today and in
      // its status lane, so with both open a bare `t:${id}` is emitted twice and
      // FlatList drops one of the rows.
      if (open) for (const t of items) out.push({ kind: 'row', key: rowKey(l.key, t.id), task: t });
    }
    return out;
  }, [orderedLanes, laneItems, expandedLanes]);
  const listKeyExtractor = useCallback((it) => it.key, []);
  // Read by the focus effect's retry loop. It runs inside setTimeout, so it holds
  // the listData from the render that scheduled it — and that render is the one
  // BEFORE expandedLanes opened the group, i.e. the one where the row does not
  // exist yet. Closing over the array would make the retry re-check the same
  // stale copy forever and always give up; a ref always reads the current one.
  const listDataRef = useRef(listData);
  listDataRef.current = listData;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
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
        }).catch((e) => {
          // Offline, or the server did not answer. Not "removed": say so, and
          // let the same notification be tried again once there is signal —
          // the fetch guard is released so the next tap fetches afresh.
          log.warn('noti focus: fetch-by-id failed', { focusTaskId, error: e?.message });
          fetchedFocusRef.current = null;
          handledFocusRef.current = focusTaskId;
          showError("Couldn't reach the server", 'Check your connection and open the notification again.');
          onFocusHandled && onFocusHandled();
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

    // Stay in whatever view the user is in. This used to force setViewMode('board')
    // on the grounds that kanban gave a more reliable scroll-to-card — but viewMode
    // defaults to 'list' and is never persisted, so in practice every tap yanked
    // people out of the list they had chosen and into a grid they had not. The
    // scroll it was buying was not even working: it called scrollTo on a lane that
    // is a FlatList, which threw before it could scroll anything.
    //
    // Both views reveal the task the same way now: open its status group, expand
    // its row, scroll it into view, then heartbeat.
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

      // LIST view: the row lives in listData, so scroll the list to its index.
      // Waits for expandedLanes to have opened the group — until it does the row
      // is not in the data at all and there is no index to scroll to.
      if (viewModeRef.current !== 'board') {
        const key = rowKey(laneKey, focusTaskId);
        const idx = listDataRef.current.findIndex((it) => it.key === key);
        if (idx >= 0 && listScrollRef.current) {
          // viewPosition 0.3 puts it just below the top rather than flush
          // against it, so the status heading above stays visible for context.
          listScrollRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
          log.info('noti focus: scrolled list', { laneKey, idx, tries });
          return;
        }
        if (tries < 10) { t1 = setTimeout(tryScroll, 160); }
        else { log.info('noti focus: list scroll gave up (row not in data)', { laneKey, tries }); }
        return;
      }

      const x = laneX.current[laneKey];
      const y = cardY.current[focusTaskId];
      if (boardRef.current && typeof x === 'number') {
        boardRef.current.scrollTo({ x: Math.max(0, x - 8), animated: true });
        // scrollToOffset, NOT scrollTo: the lane is a FlatList (see its ref
        // assignment below), and FlatList has no scrollTo. This threw
        // "laneRef.scrollTo is not a function" on every notification tap,
        // which killed tryScroll before it could log success — so the card
        // never scrolled into view and only the heartbeat on the next timer
        // gave any sign the tap had worked. The lane was a ScrollView once;
        // the call was left behind when it became a FlatList.
        const laneRef = laneRefs.current[laneKey];
        if (laneRef && typeof y === 'number') {
          if (typeof laneRef.scrollToOffset === 'function') {
            laneRef.scrollToOffset({ offset: Math.max(0, y - 8), animated: true });
          } else if (typeof laneRef.scrollTo === 'function') {
            laneRef.scrollTo({ y: Math.max(0, y - 8), animated: true });
          }
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
  const ntValid = !!ntName.trim() && !!ntProject && !!ntDeliverable && !missingOtherText(ntDeliverable, ntDeliverableOther);

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
    setNtDeliverable(''); setNtDeliverableOther('');
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
    if (!ntDeliverable) return say('Type required', 'Tick at least one — Module, App, EXE or Other.', 'warn');
    if (missingOtherText(ntDeliverable, ntDeliverableOther)) return say('Type required', DELIVERABLE_OTHER_REQUIRED_MSG, 'warn');
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
        priority: ntPriority, description: ntDesc.trim(), deliverableType: ntDeliverable,
        deliverableOther: needsOtherText(ntDeliverable) ? ntDeliverableOther.trim() : '',
        // Admin-only; the route ignores it from anyone else and falls back to
        // the caller, so a developer's task can never be filed against someone.
        userId: isAdmin ? (ntUser?.id || 0) : 0,
      });
      if (res && res.status === false) { say('Cannot create', res.message || 'Failed', 'warn'); return; }
      setNewTaskOpen(false);
      await load({ silent: true });
      setCreatedPopup({ ref: (res && res.external_ref) || '', name: ntName.trim(), kind: 'new' });
    } catch (e) { say('Error', e.message || 'Failed', 'warn'); }
    finally { setNtBusy(false); }
  }

  // ── Admin: Done Task ──────────────────────────────────────────────────────
  // Work that already happened off-system goes straight to Pending Approvals
  // with its worked time filed on the chosen day. Mirrors the web board's
  // "Add Done Task".
  function openDoneTask() {
    setDoneTask({
      name: '', client: null, project: null, user: null, deliverable: '', deliverableOther: '',
      workedH: '', workedM: '', workDate: fmtYMD(new Date()),
      estH: '', estM: '', estTouched: false,
      priority: 'regular', desc: '', open: null,
    });
    if (clientTree.length === 0) fetchClientTree().then(setClientTree).catch(() => {});
    if (!assignees.length) {
      fetchUsers().then((list) => setAssignees(list || [])).catch((e) => log.warn('users load failed', e?.message));
    }
  }

  const doneWorkedSecs = (d) =>
    (parseInt(d.workedH, 10) || 0) * 3600 + (parseInt(d.workedM, 10) || 0) * 60;

  // Merge a change in. The estimate follows the time worked and the type until
  // the admin types one of their own.
  function patchDone(patch) {
    setDoneTask((d) => {
      if (!d) return d;
      const next = { ...d, ...patch };
      const drivesEstimate = 'workedH' in patch || 'workedM' in patch || 'deliverable' in patch;
      if (drivesEstimate && !next.estTouched) {
        const worked = doneWorkedSecs(next);
        if (worked > 0) {
          const est = estimateFromWorked(worked, next.deliverable);
          next.estH = String(Math.floor(est / 3600));
          next.estM = String(Math.floor((est % 3600) / 60));
        } else {
          next.estH = ''; next.estM = '';
        }
      }
      return next;
    });
  }

  async function submitDoneTask() {
    const d = doneTask;
    if (!d) return;
    const worked = doneWorkedSecs(d);
    if (!d.name.trim()) return say('Task name required', 'Enter a task name.', 'warn');
    if (!d.project) return say('Project required', 'Choose a project (KRA).', 'warn');
    if (!d.deliverable) return say('Type required', 'Tick at least one — Module, App, EXE or Other.', 'warn');
    if (missingOtherText(d.deliverable, d.deliverableOther)) return say('Type required', DELIVERABLE_OTHER_REQUIRED_MSG, 'warn');
    if (worked <= 0) return say('Time worked required', 'Enter the hours and/or minutes already spent.', 'warn');
    if ((parseInt(d.workedM, 10) || 0) > 59) return say('Check the time', 'Minutes worked must be 0–59.', 'warn');
    if ((parseInt(d.estM, 10) || 0) > 59) return say('Check the estimate', 'Estimate minutes must be 0–59.', 'warn');
    const blankEst = d.estH === '' && d.estM === '';
    const est = blankEst
      ? estimateFromWorked(worked, d.deliverable)
      : (parseInt(d.estH, 10) || 0) * 3600 + (parseInt(d.estM, 10) || 0) * 60;
    if (est <= worked) return say('Estimate too low', 'The estimate must be more than the time worked.', 'warn');
    log.info('done task submit', { name: d.name.trim(), kraId: d.project.id, worked, workDate: d.workDate });
    setDoneBusy(true);
    try {
      const res = await adminCreateDoneTask({
        name: d.name.trim(), kraId: d.project.id, userId: d.user?.id || 0,
        workedSeconds: worked, workDate: d.workDate,
        estimateHours: Math.floor(est / 3600), estimateMinutes: Math.floor((est % 3600) / 60),
        deliverableType: d.deliverable, deliverableOther: needsOtherText(d.deliverable) ? (d.deliverableOther || '').trim() : '',
        priority: d.priority, description: d.desc.trim(),
      });
      if (res && res.status === false) { say('Cannot add', res.message || 'Failed', 'warn'); return; }
      setDoneTask(null);
      await load({ silent: true });
      setCreatedPopup({ ref: (res && res.external_ref) || '', name: d.name.trim(), kind: 'done' });
    } catch (e) { say('Error', e.message || 'Failed', 'warn'); }
    finally { setDoneBusy(false); }
  }

  // Record that a coordinator has opened this task to review it. Fire-and-forget:
  // never awaited, so the dialog opens at the same speed it always did, and a
  // failure is invisible — the review matters, the timestamp is only metadata.
  //
  // Guarded on partially_completed because that is the only state the server will
  // stamp; without the guard every approve/reject on any task would post a request
  // the route exists to refuse.
  //
  // On a first stamp the task is patched in place rather than triggering a reload:
  // the card already renders these two fields, so this is what makes
  // "Review started: … by …" appear without costing a full board fetch.
  function stampReviewStarted(task) {
    if (!task?.id || task.task_state !== 'partially_completed') return;
    if (task.coordinator_review_started_at) return;   // already stamped; nothing to do
    markReviewStarted(task.id).then((res) => {
      if (!res?.status || res.already_started || !res.started_at) return;
      setRaw((prev) => prev.map((t) => (String(t.id) === String(task.id)
        ? { ...t, coordinator_review_started_at: res.started_at,
            coordinator_review_started_by_name: res.by || '' }
        : t)));
    });
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
    if (kind === 'undoStart') {
      // Deletes today's time on the task, which cannot be put back — so it asks,
      // and says what goes and where the task lands.
      confirm({
        tone: 'danger',
        destructive: true,
        ...undoStartConfirm(task, fmtHMS),
        onConfirm: async () => {
          setDlg((d) => (d ? { ...d, busy: true } : d));
          setBusyId(task.id);
          try {
            const res = await undoTaskStart(task.id);
            setDlg(null);
            if (res && res.status === false) {
              say("Can't undo", res.message || 'Failed', 'warn');
              return;
            }
            H.warn();
            setDetailTask(null);
            await load({ silent: true });
            await refreshLive();
          } catch (e) {
            setDlg(null);
            say('Something went wrong', e.message || 'Failed', 'warn');
          } finally { setBusyId(null); }
        },
      });
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
        // The reason is not paperwork: the developer and the client who raised
        // the task are both told this task is gone, and without a reason they
        // are told only that. The service has always accepted one; nothing sent
        // it. Required, because "deleted, no reason given" is the outcome this
        // is meant to prevent.
        input: {
          label: 'Why is it being deleted? (required)',
          placeholder: 'e.g. Raised twice — REQ-041 covers this',
          required: true,
        },
        onConfirm: async (reason) => {
          setDlg((d) => (d ? { ...d, busy: true } : d));
          setBusyId(task.id);
          try {
            const res = await adminDeleteTask(task.id, reason);
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
      // Opens on "Moved to another task", as the web's select does. Opening on
      // Break made Break the path of least resistance for a developer who had
      // simply switched tasks, which files real work time under a break.
      setPauseCode('priority_task');
      setPauseNote('');
      setPauseDropdown(false);
      // Never carry a previous meeting's attendees — or a stale error — into a
      // new pause.
      setMeetingWith([]); setTeamMeeting(false);
      setPeopleQuery('');
      setPauseErr('');
      return;
    }
    if (kind === 'complete' || kind === 'partial') {
      setFinishFor(task);
      setFinishPartial(kind === 'partial');
      setFinishSummary('');
      setFinishErr('');
      setFinishRules([]);
      setFinishFilled({});
      if (kind === 'complete') {
        fetchTaskDetails(task.id).then((det) => {
          if (det?.ok) setFinishRules(det.meta?.completion_rules || []);
        }).catch(() => {});
      }
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
      setEmpRules(null);
      stampReviewStarted(task);
      // What this task's type needed, and whether it is all in.
      getTaskChecklists(task.id).then((r) => { if (r && r.completion_rules) setEmpRules(r.completion_rules); }).catch(() => {});
      return;
    }
    if (kind === 'rejectDone') {
      setRejectDoneFor(task);
      setRejectDoneNote('');
      // Both paths stamp, exactly as the web does from openApproveModal AND
      // openRejectModal: opening either is a coordinator starting a review, and
      // sending work back is still having reviewed it.
      stampReviewStarted(task);
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

    // An admin sent this self-created task back. It owes a "what I changed"
    // answer before the timer runs again, and /task/resume neither asks for one
    // nor enforces it — resuming down that route left self_needs_resume_reason
    // stuck on and the admin-accept clock un-armed, so the task waited on nobody
    // for good. Only /task/resume_with_reason clears both. Checked AFTER the
    // can_start gate above so a genuinely blocked task still says why.
    if (kind === 'resume' && task.is_self_created && task.self_needs_resume_reason) {
      setResumeFor(task);
      setResumeNote('');
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
    if (noteRequired(pauseAllCode, teamMeeting) && !pauseAllNote.trim()) {
      H.err();
      return setPauseAllErr(pauseAllCode === 'meeting'
        ? '"Meeting" on its own does not explain the time — say what it is about.'
        : "Please say what you're pausing for.");
    }
    setPauseAllErr('');
    const label = (PAUSE_REASONS.find((r) => r.code === pauseAllCode) || {}).label || 'Paused';
    const reason = pauseReasonText(pauseAllNote, pauseAllCode, teamMeeting, label, IDLE_NOTE_MAX);
    const withIds = meetingIds(pauseAllCode, teamMeeting, meetingWith);
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
    if (noteRequired(pauseCode, teamMeeting) && !pauseNote.trim()) {
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
    const reason = pauseReasonText(pauseNote, pauseCode, teamMeeting, label, IDLE_NOTE_MAX);
    const withIds = meetingIds(pauseCode, teamMeeting, meetingWith);
    setPauseFor(null);
    setBusyId(task.id);
    try {
      const res = await pauseTask(task.id, reason, pauseCode, withIds);
      if (res && res.status === false) say('Cannot pause', res.message || 'Failed', 'warn');
      await load({ silent: true });
    } catch (e) { say('Error', e.message || 'Pause failed', 'warn'); }
    finally { setBusyId(null); }
  }

  // Finish: Partial needs only a summary; a full Complete needs what the task's
  // type needs (server rules — the same list Odoo, the web and the WhatsApp task
  // page show): a Module the manual + GitHub, a Database task the four database
  // details, a Bug fix only the summary.
  async function submitFinish() {
    const task = finishFor;
    // Errors show INSIDE the dialog rather than as an OS alert. Both of these
    // are "you missed a field" — the answer is three inches away on the same
    // screen, so throwing a system dialog over it made the fix harder to reach
    // than the mistake was. Stacking the board's own popup would be worse still:
    // two RN Modals at once are unreliable on Android. Same treatment the web's
    // Partial Finish dialog already uses.
    setFinishOfferPartial(false);
    if (finishPartial && !finishSummary.trim()) {
      H.err();
      return setFinishErr('Describe what you did before finishing — this is what your manager reads.');
    }
    if (!finishPartial) {
      // All gaps are listed together, so nobody fixes one only to be told about
      // the next. Asked BEFORE the summary is saved, so a refusal does not leave
      // a stray progress note behind. Re-read here so what was added elsewhere
      // since the popup opened counts; a failed lookup leaves the rest to the
      // server rather than blocking on a network blip.
      const det = await fetchTaskDetails(task.id);
      const rules = det?.ok ? (det.meta?.completion_rules || []) : [];
      const missing = completeMissing(rules, { hasSummary: !!finishSummary.trim(), filled: finishFilled });
      if (missing.length) {
        H.err();
        setFinishOfferPartial(true);
        return setFinishErr(`Before completing, you still need:\n${missing.map((m) => `• ${m}`).join('\n')}`);
      }
    }
    setFinishErr('');
    setFinishFor(null);
    setBusyId(task.id);
    try {
      // 1) save the progress summary (optional on a Database task)
      if (finishSummary.trim()) {
        const pr = await createProgress(task.id, finishSummary.trim());
        if (pr && pr.status === false) { say('Cannot save summary', pr.message || 'Failed', 'warn'); return; }
      }
      // 2) complete (full, with what the type needs) or partial-finish.
      const res = await completeTask(task.id, finishPartial ? {} : completeExtras(finishFilled), finishPartial);
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
    // Say why nothing happened. A bare `return` left the Confirm button looking
    // broken: tapped, nothing moved, no message. The button is also dimmed while
    // the box is empty, so this is the belt to that braces.
    if (!rejectNote.trim()) {
      return say('A note is required', 'Say what needs to change — it is the only thing the developer gets.', 'warn');
    }
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

  // Developer answers a send-back and resumes in one call. The note is required
  // on both sides: the server refuses an empty one, and a blank "response" would
  // clear the flag while telling the admin nothing about what changed.
  async function submitResumeWithReason() {
    if (!resumeNote.trim()) return;
    const task = resumeFor;
    const note = resumeNote.trim();
    setResumeFor(null);
    if (!task) return;
    setBusyId(task.id);
    try {
      const res = await resumeTaskWithReason(task.id, note);
      if (res && res.status === false) {
        showError("Can't resume this task", res.message || 'Action failed');
      } else {
        H.ok();
        await refreshLive();
      }
      await load({ silent: true });
    } catch (e) { say('Cannot resume', e.message || 'Failed', 'warn'); }
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
    // The web asks for at least ten characters here and says so; a one-word
    // rejection tells the developer nothing about what to change. Same length
    // rule, and — unlike the old bare `return` — an answer either way.
    if (rejectDoneNote.trim().length < 10) {
      return say('Say a little more', 'Please give a reason of at least 10 characters — this is what the developer works from.', 'warn');
    }
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
        {/* Admin: record work already finished off-system. Not gated on the
            workday — filing someone else's past work is not the admin working. */}
        {isAdmin && (
          <TouchableOpacity style={[s.newTaskBtn, s.doneTaskBtn]} onPress={openDoneTask} activeOpacity={0.85}>
            <Ionicons name="checkmark-done" size={16} color={COLORS.amber} />
            <Text style={[s.newTaskTxt, { color: COLORS.amber }]}>Done Task</Text>
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
            the Home read-only bar can never disagree: End / "Reopen and Continue
            Workday" / "Start New Workday Session" / Start / "Workday ended for
            today" (disabled).

            reopenInfo.reason is what separates the last two: an admin reopening
            an ended day and the cron closing one both leave todayClosed true, so
            without it the button tells a developer whose day was just reopened
            that nothing has happened yet. It is the same value the banner below
            renders, so the two cannot drift. */}
        {(() => {
          const showSpinner = !readOnly && (workdayBusy || workdayOpen === null);
          const wd = workdayButtonState({
            workdayOpen: workdayOpen === true, dayDone, todayClosed, reopened: !!reopenInfo.reason,
          });
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
                        setPauseAllCode('priority_task'); setPauseAllNote(''); setPauseAllErr('');
                        setMeetingWith([]); setTeamMeeting(false); setPeopleQuery('');
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
                          // Switching to a meeting needs the people list loaded
                          // before the confirm dialog renders its picker.
                          onPress={() => { setSwitchTo(r); if (r.code === 'meeting') openIdleMeeting(); }}
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
                    {/* Straight back to the task the break came from. Without it,
                        coming off lunch meant finding that task again down a
                        board of eleven lanes — and the pill has been naming it
                        this whole time without offering a way to it. Resuming
                        closes the break by itself (resume_task stops the break
                        log), so there is nothing to end first. Routed through
                        runAction so every guard still applies, including the
                        sent-back "Respond & Resume" branch. */}
                    {live.active_break.source_task_id ? (
                      <TouchableOpacity
                        style={[s.nontaskSwitch, s.breakResume]}
                        onPress={() => resumeAwayTask(live.active_break.source_task_id)}
                        disabled={!!breakSwitchBusy}
                        activeOpacity={0.85}
                      >
                        <Text style={[s.nontaskSwitchTxt, { color: '#fff' }]}>▶ Resume</Text>
                      </TouchableOpacity>
                    ) : null}
                    {BREAK_SWITCH_REASONS.filter((r) => r.code !== live.active_break.type).map((r) => (
                      <TouchableOpacity
                        key={r.code}
                        style={s.nontaskSwitch}
                        // Confirm first, like the non-task row beside it — these
                        // two look identical and used to behave differently, one
                        // asking and one firing on the tap. `kind` tells the shared
                        // dialog which switch it is confirming.
                        onPress={() => { setSwitchTo({ ...r, kind: 'break' }); if (r.code === 'meeting') openIdleMeeting(); }}
                        disabled={!!breakSwitchBusy}
                        activeOpacity={0.85}
                      >
                        {breakSwitchBusy === r.code
                          ? <ActivityIndicator size="small" color={COLORS.primary} />
                          : <Text style={s.nontaskSwitchTxt}>{r.emoji} {r.label}</Text>}
                      </TouchableOpacity>
                    ))}
                    {/* "I have no tasks" cannot go through switchBreak: no_tasks
                        is not a break type, it exists only as a non-task block
                        reason — and it is the ONE reason admins are told about.
                        So it ends the break and opens that block instead, leaving
                        the task paused. That is what the developer means: what
                        they paused is not something they can carry on with, and
                        the point of saying so is that someone assigns them work. */}
                    <TouchableOpacity
                      style={[s.nontaskSwitch, s.nontaskSwitchAlert]}
                      onPress={declareNoTasks}
                      disabled={!!breakSwitchBusy}
                      activeOpacity={0.85}
                    >
                      {breakSwitchBusy === 'no_tasks'
                        ? <ActivityIndicator size="small" color={COLORS.primary} />
                        : <Text style={s.nontaskSwitchTxt}>📭 I have no tasks</Text>}
                    </TouchableOpacity>
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
          placeholder="Search by ref, name or developer…"
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
          {orderedLanes.map((l, i) => {
            const items = laneItems(l.key);
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
                      currentUserId={currentUserId}
                      fresh={isFreshTask(t, l.key)}
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
          // Required whenever scrollToIndex can target a row that has not been
          // rendered yet — without it RN throws "scrollToIndex should be used in
          // conjunction with getItemLayout or onScrollToIndexFailed". Rows are
          // variable height (an expanded row carries the whole detail body), so
          // getItemLayout is not available to us: jump to an estimate, let the
          // rows render, then land the real scroll.
          onScrollToIndexFailed={(info) => {
            const offset = Math.max(0, info.averageItemLength * info.index);
            listScrollRef.current?.scrollToOffset({ offset, animated: false });
            setTimeout(() => {
              listScrollRef.current?.scrollToIndex({
                index: info.index, animated: true, viewPosition: 0.3,
              });
            }, 80);
          }}
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
              currentUserId={currentUserId}
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
        input={dlg?.input}
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

            {/* Scrolls, like every other modal body on this screen. Without it the
                dialog was taller than the phone it was on: picking Meeting adds a
                190px attendee list, a search box, a label, a note field and two
                hint lines to a card capped at 92% of screen height with
                overflow:'hidden', and RN children do not shrink — so the tail was
                cut off, taking the Confirm button in the footer with it.

                Reported as "the attendee list cannot be scrolled", which is why it
                went unfixed: the list scrolls perfectly well. What could not move
                was the dialog around it. It is fine on a tablet and broken on a
                phone, which is the tell — the cap is a PERCENTAGE of screen height,
                so a tall screen happens to fit the content.

                The footer stays OUTSIDE this scroller on purpose; that is the whole
                point. keyboardShouldPersistTaps because the note field below means
                Confirm is often tapped with the keyboard still up, and without it
                that first tap is eaten dismissing it. */}
            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
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
                    team={teamMeeting}
                    setTeam={(v) => { setTeamMeeting(v); if (v) setPauseErr(''); }}
                  />
                  <Text style={s.fieldLabel}>What is it about?{teamMeeting ? ' (optional)' : ''}</Text>
                  <TextInput
                    style={s.pauseNote}
                    placeholder={teamMeeting ? 'Optional — saved as “Team meeting”' : 'Short — e.g. sprint planning'}
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
            </ScrollView>

            {/* Footer — deliberately outside the scroller above, so Confirm is
                always on screen no matter how long the body grows. */}
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
                // Last worked first. Sorting by reference is creation order in
                // practice, so the task you were just on — the one you are almost
                // always coming back to — sat buried under every task nobody has
                // touched. Same comparator the lanes use, and the same one the web
                // module's picker uses.
                //
                // The ref stays as a TIE-BREAK: two never-started tasks compare
                // equal under byRecency, and without a second key they would fall
                // back to the server's order rather than the predictable
                // alphabetical one this picker has always had.
                const avail = (raw || [])
                  .filter((t) => !runningIds.has(t.id) && t.can_start !== false && matches(t))
                  .sort((a, b) => byRecency(a, b)
                    || String(a.external_ref || '').localeCompare(String(b.external_ref || '')));
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
            {/* Same scroller, same reason as the single Pause dialog above — this
                one is worse if anything, because the body also lists every running
                task by name before the reason chips even start. */}
            <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
            <View style={s.modalPad}>
              <Text style={s.pauseHelp}>One reason for all of them. Time logged so far is kept.</Text>
              {(live?.active_tasks || []).map((at) => (
                <Text key={at.id} style={s.pauseAllItem} numberOfLines={1}>•  {at.name}</Text>
              ))}
              <Text style={[s.whyTitle, { marginTop: 12 }]}>Why are you pausing?</Text>
              <View style={s.typeRow}>
                {/* ALL ten reasons, not just the quick chips. Stopping two timers
                    for a technical issue or for leave is not a rarer thing to do
                    than stopping one, and the six-chip version left no way to say
                    either — so those pauses were filed as something they were not. */}
                {PAUSE_REASONS.map((r) => {
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
                      {/* Three of the ten carry no emoji; without this they render
                          with a leading space where one would have been. */}
                      <Text style={[s.typeChipTxt, on && s.typeChipTxtOn]}>
                        {r.emoji ? `${r.emoji} ` : ''}{r.label}
                      </Text>
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
                  team={teamMeeting}
                  setTeam={(v) => { setTeamMeeting(v); if (v) setPauseAllErr(''); }}
                />
              ) : null}
              {/* Same rule as the single Pause — Other, Urgent and Meeting ask. */}
              {noteRequiredFor(pauseAllCode) ? (
                <>
                  {pauseAllCode === 'meeting' ? (
                    <Text style={s.fieldLabel}>What is it about?{teamMeeting ? ' (optional)' : ''}</Text>
                  ) : null}
                  <TextInput
                    style={s.pauseNote}
                    placeholder={pauseAllCode === 'urgent'
                      ? 'What is urgent? This is sent to the owner now…'
                      : pauseAllCode === 'meeting'
                        ? (teamMeeting ? 'Optional — saved as “Team meeting”' : 'Short — e.g. sprint planning')
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
            </ScrollView>
            {/* Outside the scroller, so Confirm stays reachable. */}
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

      {/* Finish modal — Partial Finish (amber, summary) or Complete (green, what the task type needs) */}
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
                      ⓘ  This finishes the task <Text style={{ fontWeight: '900' }}>as-is</Text> and sends it for review with just your summary. Use <Text style={{ fontWeight: '900' }}>Complete</Text> for fully-done work.
                    </Text>
                  </View>
                ) : null}

                {/* Inline, above the fields it is about — this used to be an OS
                    alert thrown over the dialog, which put the complaint further
                    from the fix than the mistake was. */}
                {finishErr ? (
                  <View style={s.inlineErr}>
                    <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                    <View style={{ flex: 1 }}>
                      <Text style={[s.inlineErrTxt, { flex: 0 }]}>{finishErr}</Text>
                      {finishOfferPartial && !finishPartial ? (
                        <TouchableOpacity
                          onPress={() => { H.select(); setFinishPartial(true); setFinishErr(''); setFinishOfferPartial(false); }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ marginTop: 8 }}
                        >
                          <Text style={[s.inlineErrTxt, { flex: 0, fontWeight: '800', textDecorationLine: 'underline' }]}>
                            Switch to Partial Finish (summary only) →
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                ) : null}

                <Text style={s.fieldLabel}>
                  {finishPartial || !finishRules.some((r) => r.key === 'summary' && !r.required)
                    ? 'Progress Summary *' : 'Progress Summary (optional)'}
                </Text>
                <TextInput
                  style={[s.reasonInput, { minHeight: 100 }, finishErr && !finishSummary.trim() && s.inputErr]}
                  placeholder={finishPartial ? "What was done, what's left, why you're finishing now…" : 'What did you do on this task?'}
                  placeholderTextColor={COLORS.faint}
                  value={finishSummary}
                  onChangeText={(t) => { setFinishSummary(t); if (finishErr) setFinishErr(''); }}
                  multiline
                />

                {!finishPartial && finishRules.length > 0 && (
                  <>
                    <Text style={s.fieldLabel}>What this task needs</Text>
                    <Text style={s.fieldHint}>
                      The user manual file and the GitHub link are added in KPI Details.
                    </Text>
                    <CompleteRules
                      rules={finishRules} filled={finishFilled} hasSummary={!!finishSummary.trim()}
                      onChange={(v) => { if (finishErr) setFinishErr(''); setFinishFilled(v); }} />
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

                <Text style={s.fieldLabel}>Type (Module / App / EXE / Other) *</Text>
                <DeliverableChecks value={ntDeliverable} onToggle={(code) => setNtDeliverable((v) => toggleDeliverable(v, code))}
                  other={ntDeliverableOther} onOther={setNtDeliverableOther} />
                <Text style={s.fieldHint}>
                  {ntDeliverable ? deliverableLabel(ntDeliverable, ntDeliverableOther) : 'Required — tick one or more.'}
                </Text>

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

      {/* Admin Done Task modal — mirrors web "Add Done Task" */}
      <Modal visible={!!doneTask} transparent animationType="fade" onRequestClose={() => setDoneTask(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>✓  Add Done Task</Text>
              <TouchableOpacity onPress={() => setDoneTask(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#3d2c00" />
              </TouchableOpacity>
            </View>

            {doneTask ? (
              <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
                <View style={s.modalPad}>
                  <Text style={s.fieldLabel}>Task Name *</Text>
                  <TextInput style={[s.textInput, !doneTask.name.trim() && s.inputErr]} placeholder="What was done?"
                    placeholderTextColor={COLORS.faint} value={doneTask.name} onChangeText={(v) => patchDone({ name: v })} />

                  <Text style={s.fieldLabel}>Client *</Text>
                  <TouchableOpacity style={[s.dropdown, !doneTask.client && s.inputErr]} activeOpacity={0.8}
                    onPress={() => patchDone({ open: doneTask.open === 'client' ? null : 'client' })}>
                    <Text style={[s.dropdownTxt, !doneTask.client && { color: COLORS.faint }]} numberOfLines={1}>
                      {doneTask.client ? doneTask.client.name : '— choose a client —'}
                    </Text>
                    <Ionicons name={doneTask.open === 'client' ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                  {doneTask.open === 'client' && (
                    <View style={s.dropdownList}>
                      <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {clientTree.length === 0 && <Text style={[s.centerTxt, { padding: 12 }]}>Loading clients…</Text>}
                        {clientTree.map((c) => (
                          <TouchableOpacity key={c.id} style={[s.dropdownItem, doneTask.client?.id === c.id && s.dropdownItemOn]}
                            onPress={() => patchDone({ client: c, project: null, open: null })}>
                            <Text style={[s.dropdownItemTxt, doneTask.client?.id === c.id && { color: COLORS.primary, fontWeight: '800' }]}>{c.name}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  <Text style={s.fieldLabel}>Project *</Text>
                  <TouchableOpacity style={[s.dropdown, !doneTask.project && s.inputErr]} disabled={!doneTask.client} activeOpacity={0.8}
                    onPress={() => patchDone({ open: doneTask.open === 'project' ? null : 'project' })}>
                    <Text style={[s.dropdownTxt, !doneTask.project && { color: COLORS.faint }]} numberOfLines={1}>
                      {doneTask.project ? doneTask.project.display : (doneTask.client ? '— choose a project —' : 'Select a client first')}
                    </Text>
                    <Ionicons name={doneTask.open === 'project' ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                  {doneTask.open === 'project' && doneTask.client && (
                    <View style={s.dropdownList}>
                      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {(doneTask.client.projects || []).map((p) => (
                          <TouchableOpacity key={p.id} style={[s.dropdownItem, doneTask.project?.id === p.id && s.dropdownItemOn]}
                            onPress={() => patchDone({ project: p, open: null })}>
                            <Text style={[s.dropdownItemTxt, doneTask.project?.id === p.id && { color: COLORS.primary, fontWeight: '800' }]}>{p.display}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  <Text style={s.fieldLabel}>Developer *</Text>
                  <TouchableOpacity style={s.dropdown} activeOpacity={0.8}
                    onPress={() => patchDone({ open: doneTask.open === 'user' ? null : 'user' })}>
                    <Text style={s.dropdownTxt} numberOfLines={1}>{doneTask.user ? doneTask.user.name : 'Me'}</Text>
                    <Ionicons name={doneTask.open === 'user' ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                  <Text style={s.fieldHint}>Who did the work. The time is recorded against them.</Text>
                  {doneTask.open === 'user' && (
                    <View style={s.dropdownList}>
                      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        <TouchableOpacity style={[s.dropdownItem, !doneTask.user && s.dropdownItemOn]}
                          onPress={() => { H.select(); patchDone({ user: null, open: null }); }}>
                          <Text style={[s.dropdownItemTxt, !doneTask.user && { color: COLORS.primary, fontWeight: '800' }]}>Me</Text>
                        </TouchableOpacity>
                        {assignees.length === 0 ? <Text style={[s.centerTxt, { padding: 12 }]}>Loading people…</Text> : null}
                        {assignees.map((u) => (
                          <TouchableOpacity key={u.id} style={[s.dropdownItem, doneTask.user?.id === u.id && s.dropdownItemOn]}
                            onPress={() => { H.select(); patchDone({ user: u, open: null }); }}>
                            <Text style={[s.dropdownItemTxt, doneTask.user?.id === u.id && { color: COLORS.primary, fontWeight: '800' }]}>{u.name}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  <Text style={s.fieldLabel}>Type (Module / App / EXE / Other) *</Text>
                  <DeliverableChecks value={doneTask.deliverable}
                    onToggle={(code) => patchDone({ deliverable: toggleDeliverable(doneTask.deliverable, code) })}
                    other={doneTask.deliverableOther} onOther={(v) => patchDone({ deliverableOther: v })} />
                  <Text style={s.fieldHint}>
                    {doneTask.deliverable ? deliverableLabel(doneTask.deliverable, doneTask.deliverableOther) : 'Required — tick one or more.'}
                  </Text>

                  <View style={s.twoCol}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fieldLabel}>Worked Hours *</Text>
                      <TextInput style={[s.textInput, !doneWorkedSecs(doneTask) && s.inputErr]} keyboardType="number-pad" selectTextOnFocus
                        placeholder="0" placeholderTextColor={COLORS.faint}
                        value={doneTask.workedH} onChangeText={(v) => patchDone({ workedH: v })} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fieldLabel}>Minutes</Text>
                      <TextInput style={s.textInput} keyboardType="number-pad" selectTextOnFocus
                        placeholder="0" placeholderTextColor={COLORS.faint}
                        value={doneTask.workedM} onChangeText={(v) => patchDone({ workedM: v })} />
                    </View>
                  </View>

                  <Text style={s.fieldLabel}>Work Date *</Text>
                  <TouchableOpacity style={s.dropdown} activeOpacity={0.8} onPress={() => patchDone({ open: 'date' })}>
                    <Text style={s.dropdownTxt}>
                      {doneTask.workDate}{doneTask.workDate === fmtYMD(new Date()) ? '  (today)' : ''}
                    </Text>
                    <Ionicons name="calendar-outline" size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                  <Text style={s.fieldHint}>The day the work was done — today or earlier.</Text>

                  <View style={s.twoCol}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fieldLabel}>Estimate Hours</Text>
                      <TextInput style={s.textInput} keyboardType="number-pad" selectTextOnFocus
                        value={doneTask.estH} onChangeText={(v) => patchDone({ estH: v, estTouched: true })} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fieldLabel}>Minutes</Text>
                      <TextInput style={s.textInput} keyboardType="number-pad" selectTextOnFocus
                        value={doneTask.estM} onChangeText={(v) => patchDone({ estM: v, estTouched: true })} />
                    </View>
                  </View>
                  <Text style={s.fieldHint}>
                    Fills in from the time worked and the type: 20–40% more, at most +2h for a Module or EXE,
                    +3h if App is ticked. Change it if you like — it must stay above the time worked.
                  </Text>

                  <Text style={s.fieldLabel}>Priority</Text>
                  <View style={s.segFull}>
                    {PRIORITIES.map((p) => {
                      const on = doneTask.priority === p.code;
                      return (
                        <TouchableOpacity key={p.code} style={[s.segFullItem, on && s.segFullItemOn]} onPress={() => patchDone({ priority: p.code })}>
                          <Text style={[s.segFullTxt, on && { color: '#fff' }]}>{p.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={s.fieldLabel}>Description</Text>
                  <TextInput style={[s.textInput, { minHeight: 70, textAlignVertical: 'top' }]} multiline
                    value={doneTask.desc} onChangeText={(v) => patchDone({ desc: v })} />

                  <View style={s.bannerBlue}>
                    <Text style={s.bannerBlueTxt}>
                      This goes straight to <Text style={{ fontWeight: '900' }}>Pending Approvals</Text> as a finished task — it still needs approving. The time counts in the KRA, employee and invoice reports on the work date, but <Text style={{ fontWeight: '900' }}>not as attendance</Text> or productive time for the day.
                    </Text>
                  </View>
                </View>
              </ScrollView>
            ) : null}

            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setDoneTask(null)}><Text style={s.footCancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.amber }, doneBusy && s.footDisabled]}
                onPress={submitDoneTask}
                disabled={doneBusy}
              >
                {doneBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.footConfirmTxt}>Add Done Task</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rendered conditionally, NOT with a visible prop: DateGridModal shows the
          moment it mounts. */}
      {doneTask?.open === 'date' ? (
        <DateGridModal
          title="Work date"
          value={doneTask.workDate}
          maxDate={fmtYMD(new Date())}
          onCancel={() => patchDone({ open: null })}
          onPick={(iso) => patchDone({ workDate: iso, open: null })}
        />
      ) : null}

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
                {createdPopup?.kind === 'done' ? (
                  <Text style={s.createdInfoTxt}>In <Text style={{ fontWeight: '800' }}>Pending Approvals</Text> — approve it to finish. Its time is filed on the work date you chose.</Text>
                ) : (
                  <Text style={s.createdInfoTxt}>In <Text style={{ fontWeight: '800' }}>Pending Review</Text> — an admin will review it, pick the type (Requirement / Update / Bug) and assign it.</Text>
                )}
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

      {/* Developer: answer a send-back, then resume. The admin's note is shown
          above the box — it is the thing being answered, and hunting for it in
          the activity log before you can reply is how a reply ends up vague. */}
      <Modal visible={!!resumeFor} transparent animationType="fade" onRequestClose={() => setResumeFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={[s.modalHead, s.headAmber]}>
              <Text style={s.headAmberTitle}>↩  Respond &amp; Resume</Text>
              <TouchableOpacity onPress={() => setResumeFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#7a5200" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <Text style={s.createdName} numberOfLines={2}>{resumeFor?.name}</Text>
              {!!resumeFor?.self_review_note && (
                <View style={s.sentBackBox}>
                  <Text style={s.sentBackWho}>{resumeFor?.self_review_by || 'Admin'} sent this back:</Text>
                  <Text style={s.sentBackNote}>“{resumeFor.self_review_note}”</Text>
                </View>
              )}
              <Text style={s.modalLabel}>What did you change? (required)</Text>
              <TextInput
                style={s.reasonInput}
                placeholder="e.g. Moved it under Alphalize > Phase 2 and re-estimated to 4h"
                placeholderTextColor={COLORS.faint}
                value={resumeNote} onChangeText={setResumeNote} multiline
              />
              <View style={s.createdInfo}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.createdInfoTxt}>
                  Your answer goes back to the admin and the acceptance clock starts again,
                  so the task cannot sit waiting on nobody.
                </Text>
              </View>
            </View>
            <View style={[s.modalFoot, { justifyContent: 'flex-end' }]}>
              <TouchableOpacity style={s.footCancel} onPress={() => setResumeFor(null)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.footConfirm, { backgroundColor: COLORS.green }, !resumeNote.trim() && { opacity: 0.5 }]}
                onPress={submitResumeWithReason} disabled={!resumeNote.trim()}
              >
                <Text style={s.footConfirmTxt}>Respond &amp; Resume</Text>
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
                {/* Why the task was raised. Approving is the moment that decision is
                    made, and this dialog showed only the name and two checklists —
                    so the one thing that says what the work was FOR lived a screen
                    away. Same block as the Accept dialog above, deliberately. */}
                {plainText(approveFor?.description) ? (
                  <View style={s.descBlock}>
                    <View style={s.descHead}>
                      <Ionicons name="document-text-outline" size={13} color={COLORS.muted} />
                      <Text style={s.descLabel}>Description</Text>
                    </View>
                    <Text style={s.descTxt} numberOfLines={6}>{plainText(approveFor.description)}</Text>
                  </View>
                ) : null}
                {empRules && empRules.length ? (
                  <>
                    <Text style={s.fieldLabel}>📝 What this task needed</Text>
                    <CompleteRules rules={empRules} readOnly />
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
                style={[s.footConfirm, { backgroundColor: COLORS.red }, rejectDoneNote.trim().length < 10 && { opacity: 0.5 }]}
                onPress={submitRejectDone} disabled={rejectDoneNote.trim().length < 10}
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
                  style={[s.idleOpt, r.code === 'no_tasks' && s.idleOptAlert,
                          r.code === 'meeting' && idleMeetingPick && s.idleOptOn]}
                  // Meeting ASKS first; every other reason still files immediately.
                  // Declaring a meeting with no task running used to lose its
                  // attendees entirely, so whether a meeting remembered who was in
                  // it depended on whether a task happened to be running — the
                  // same meeting, recorded two different ways.
                  onPress={() => (r.code === 'meeting' ? openIdleMeeting() : chooseIdleReason(r.code))}
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

              {/* Same picker the Pause dialog uses, so a meeting is recorded the
                  same way whether or not a task was running when it started. */}
              {idleMeetingPick ? (
                <View style={s.idleMeetingBox}>
                  <MeetingPicker
                    people={people} busy={peopleBusy}
                    query={peopleQuery} setQuery={setPeopleQuery}
                    picked={meetingWith} setPicked={setMeetingWith}
                    team={teamMeeting} setTeam={setTeamMeeting}
                  />
                  <TouchableOpacity
                    style={s.idleMeetingGo}
                    onPress={() => chooseIdleReason('meeting')}
                    disabled={!!idleBusy}
                    activeOpacity={0.85}
                  >
                    {idleBusy === 'meeting'
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons name="people" size={16} color="#fff" />}
                    {/* Starting without picking anyone is allowed on purpose: the
                        meeting itself is the fact worth recording, and forcing a
                        name would push people to tap Break instead. */}
                    <Text style={s.idleMeetingGoTxt}>
                      {teamMeeting ? 'Start team meeting'
                        : meetingWith.length ? `Start meeting with ${meetingWith.length}` : 'Start meeting'}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}

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
            {/* Everything that can GROW scrolls; the buttons below stay put. A
                meeting switch adds a people list and a note to this card, and a
                dialog that pushes its own Confirm off the screen is the bug this
                same pattern already fixed on Pause. */}
            <ScrollView style={{ width: '100%' }} keyboardShouldPersistTaps="handled">

            {/* from → to */}
            <View style={s.swFlow}>
              <View style={s.swRow}>
                <Text style={s.swEmoji}>⏸</Text>
                <View style={{ flex: 1 }}>
                  {/* Whichever kind opened this dialog. A task break lives on
                      live.active_break, a non-task block on live.nontask — reading
                      only the latter left this row and the message below blank
                      whenever a break was what was being switched. */}
                  <Text style={s.swName}>
                    {switchTo?.kind === 'break'
                      ? (live?.active_break?.type_label || 'Break')
                      : live?.nontask?.reason_label}
                  </Text>
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
              {switchTo?.kind === 'break'
                ? (live?.active_break?.type_label || 'Your break')
                : live?.nontask?.reason_label} is saved to your Workday Map. Nothing is lost.
            </Text>
            {switchTo?.code === 'no_tasks' ? (
              <Text style={s.swWarn}>Your admins will be told straight away.</Text>
            ) : null}

            {/* Switching INTO a meeting asks who, exactly as declaring one from
                the popup does. Without this the same meeting would remember its
                attendees or not depending on which of the two buttons happened to
                be on screen when it started. */}
            {switchTo?.code === 'meeting' ? (
              <View style={s.idleMeetingBox}>
                <MeetingPicker
                  people={people} busy={peopleBusy}
                  query={peopleQuery} setQuery={setPeopleQuery}
                  picked={meetingWith} setPicked={setMeetingWith}
                  team={teamMeeting} setTeam={setTeamMeeting}
                />
                {/* Same "what is it about" the Pause dialog asks for a meeting, so
                    a meeting reads identically wherever it was declared. */}
                <TextInput
                  style={s.idleNote}
                  placeholder="What is it about? (optional)"
                  placeholderTextColor={COLORS.faint}
                  value={idleNote}
                  onChangeText={setIdleNote}
                  maxLength={IDLE_NOTE_MAX}
                />
              </View>
            ) : null}

            </ScrollView>
            <View style={s.confirmBtns}>
              <TouchableOpacity
                style={[s.confirmBtn, s.confirmCancel]}
                // Clear the picker as well, or cancelling a meeting switch leaves
                // its people ticked and the next one silently inherits them.
                onPress={() => { setSwitchTo(null); setIdleMeetingPick(false); setMeetingWith([]); setTeamMeeting(false); setPeopleQuery(''); setIdleNote(''); }}
                disabled={!!idleBusy}
                activeOpacity={0.85}
              >
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.confirmBtn, s.swDo]}
                // One dialog, two switches. `kind` is set by whichever strip row
                // opened it: a break hanging off a paused TASK goes through
                // switch_break (which keeps the task's badge in step), a non-task
                // block goes through idle_reason.
                onPress={() => (switchTo.kind === 'break'
                  ? doSwitchBreak(switchTo.code)
                  : chooseIdleReason(switchTo.code))}
                disabled={!!idleBusy || !!breakSwitchBusy}
                activeOpacity={0.85}
              >
                {/* Either busy flag — the two switches use different ones, and the
                    button has to spin whichever is running or it looks dead. */}
                {(idleBusy || breakSwitchBusy)
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
            {/* Mode, hint and the alarm's sound/ring/snooze rows all live in the
                shared picker now, so this dialog and the Reminders screen cannot
                drift. The reason field goes through `children` because it has
                always sat between the hint and the sound rows — adopting the
                component must not quietly reorder a working screen. */}
            <AlarmModePicker mode={reminderMode} onModeChange={setReminderMode}>
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
            </AlarmModePicker>
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
                {/* Totals, away time, the Workday Map and the tasks: shared with
                    Live Tracking, where an admin reads the same day for someone else. */}
                <WorkdaySummaryBody summary={endSummary} viewer="self" />

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
              {/* Locked while any task worked today has no summary — REQUIRED
                  (the server refuses as well). Add it from the task, then reopen. */}
              <TouchableOpacity style={[s.footConfirm, { backgroundColor: COLORS.red, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
                ((endSummary?.missing_progress || []).length > 0) && { opacity: 0.45 }]}
                onPress={confirmEndWorkday} disabled={endBusy || (endSummary?.missing_progress || []).length > 0}>
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
  doneTaskBtn: { backgroundColor: COLORS.amberBg, borderColor: COLORS.amber },
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
  // The way back to the paused task — the only green thing in the row, because
  // it is the one that resumes work rather than re-labelling the pause.
  breakResume: { backgroundColor: COLORS.green, borderColor: COLORS.green },

  // Switch confirm — same centered-card idiom as the other confirm popups.
  confirmWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  // maxHeight, because this card now holds a people picker on a meeting switch
  // and without a cap it simply grew past the screen and took its own buttons
  // with it — the same way the Pause dialog did.
  confirmCard: { width: '100%', maxWidth: 380, maxHeight: '90%', backgroundColor: '#fff', borderRadius: 22, alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 22 },
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
  // The chosen row stays highlighted while the picker below it is open, so it is
  // obvious which reason the people list belongs to.
  idleOptOn: { borderColor: COLORS.primary, backgroundColor: '#EAF2FF' },
  idleMeetingBox: { marginTop: 10, gap: 10 },
  idleMeetingGo: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 12,
  },
  idleMeetingGoTxt: { fontSize: 14.5, fontWeight: '800', color: '#fff' },
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
  // Never started, in a to-do lane. The web's `.kpi-task-fresh`: red fill, red
  // border, black text — the text colour matters, because the default link-blue
  // title on this fill is close to unreadable.
  cardFresh: { backgroundColor: '#ffb4b4', borderWidth: 1.5, borderColor: '#dc2626' },
  cardTitleFresh: { color: '#111827' },
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
  // Muted grey, not a priority colour: the ref identifies the card, it does not
  // rank it, and a second coloured pill beside Urgent would compete with it.
  // shrink:1 so a long ref gives way rather than pushing the Live pill off.
  refPill: { flexShrink: 1, backgroundColor: '#EEF1F6', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 4 },
  refPillTxt: { fontSize: 11, fontWeight: '800', color: COLORS.muted },
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

  // Meeting participants picker: components/MeetingPicker owns its styles.
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
  // The admin's send-back note, quoted above the reply box.
  sentBackBox: {
    backgroundColor: COLORS.amberBg, borderRadius: 10, padding: 10, marginBottom: 12,
    borderWidth: 1, borderColor: '#F3DFA8',
  },
  sentBackWho: { fontSize: 12, fontWeight: '800', color: '#7a5200' },
  sentBackNote: { fontSize: 13, fontStyle: 'italic', color: '#7a5200', marginTop: 3, lineHeight: 19 },
  // Same look, WITHOUT flex:1. createdInfoTxt lives inside a row (s.createdInfo)
  // where flex makes it fill the line; reused standalone in a column it collapses
  // to nothing, which is why the "developer asked for…" lines rendered blank.
  askedLine: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18, marginBottom: 6 },

  // The End Workday summary's own styles moved to components/WorkdaySummaryBody.js.

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
  checkItem: { flexDirection: 'row', gap: 4, paddingHorizontal: 4 },
  segFullTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.ink },

  errorMsg: { fontSize: 14.5, color: COLORS.ink, lineHeight: 21, paddingVertical: 10 },
});
