// KPI Action Board — the module's task kanban, mirroring the web layout:
// horizontally-scrolling colored lane columns (Pending Review, Regular,
// Important, Urgent, In Progress, Paused, …), each with a count badge and its
// cards stacked vertically. Each card exposes the state-appropriate actions
// (Start / Resume / Complete / Pause / Reassign).
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Dimensions,
  ActivityIndicator, Alert, Modal, StatusBar as RNStatusBar, Animated, Easing,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import {
  LANES, groupIntoLanes, laneForTask, fetchTasks, fetchUsers,
  startTask, pauseTask, resumeTask, completeTask, reassignTask, createProgress,
  CHECKLIST_ITEMS, PAUSE_REASONS, PRIORITIES,
  getWorkdayStatus, startWorkday, endWorkday, selfCreateTask, fetchProjects, getTodaySummary, getLiveStatus,
} from '../services/kpiActions';
import { createLogger } from '../api/logger';

const log = createLogger('ActionBoard');

const TOP = (RNStatusBar.currentHeight || 0) + 12;
const POLL_MS = 20000;   // silent live refresh interval
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
function TaskDetailBody({ task, onAction, busyId, nowMs, isAdmin }) {
  const st = task.task_state;
  const running = st === 'in_progress';
  const busy = busyId === task.id;
  const canStart = ['assigned', 'urgent', 'important', 'regular', 'queue_waiting',
    'pre_approval_approved', 'pre_approval_partial'].includes(st);
  const canResume = ['paused', 'hold', 'rework'].includes(st);
  const canComplete = ['in_progress', 'paused', 'hold', 'rework'].includes(st);
  const canPause = st === 'in_progress';
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

      {/* Actions */}
      <View style={s.btnRow}>
        {busy ? (
          <View style={s.btnBusy}><ActivityIndicator color={COLORS.primary} /></View>
        ) : (
          <>
            {canStart && <Btn label="Start" icon="play" kind="primary" onPress={() => onAction('start', task)} />}
            {canResume && <Btn label="Resume" icon="play" kind="green" onPress={() => onAction('resume', task)} />}
            {canPause && <Btn label="Pause" icon="pause" kind="amber" onPress={() => onAction('pause', task)} />}
            {canComplete && <Btn label="Complete" icon="checkmark-circle" kind="red" onPress={() => onAction('complete', task)} />}
            {canComplete && <Btn label="Partial Finish" icon="flag-outline" kind="ghostRed" onPress={() => onAction('partial', task)} />}
            {isAdmin && <Btn label="Reassign" icon="swap-horizontal" kind="ghost" onPress={() => onAction('reassign', task)} />}
          </>
        )}
      </View>
    </>
  );
}

// One row of the list view: an "Odoo attendance"-style accordion — task name +
// priority dot + chevron; tapping expands to reveal the shared TaskDetailBody.
// Mirrors the chevron-forward/down conditional-render pattern used by KraNode /
// OwnerDashboard's ClientCard.
function TaskListRow({ task, expanded, onToggle, onAction, busyId, nowMs, isAdmin }) {
  const p = PRIORITY[task.priority] || PRIORITY.regular;
  const running = task.task_state === 'in_progress';
  return (
    <View style={[s.listRow, expanded && s.listRowOpen]}>
      <TouchableOpacity style={s.listHead} onPress={onToggle} activeOpacity={0.7}>
        <View style={[s.listDot, { backgroundColor: p.fg }]} />
        <Text style={s.listName} numberOfLines={1}>{task.name}</Text>
        {running && (
          <View style={s.livePill}>
            <View style={s.liveDot} />
            <Text style={s.liveTxt}>Live</Text>
          </View>
        )}
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={18} color={COLORS.muted} />
      </TouchableOpacity>
      {expanded && (
        <View style={s.listBody}>
          <View style={[s.pill, s.listPill, { backgroundColor: p.bg }]}>
            <View style={[s.pillDot, { backgroundColor: p.fg }]} />
            <Text style={[s.pillTxt, { color: p.fg }]}>{p.label}</Text>
          </View>
          <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} />
        </View>
      )}
    </View>
  );
}

function TaskCard({ task, onAction, busyId, nowMs, isAdmin, pulse, onMeasure }) {
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
        {/* Title + priority pill */}
        <View style={s.cardTop}>
          <Text style={s.cardTitle} numberOfLines={2}>{task.name}</Text>
        </View>
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
        <TaskDetailBody task={task} onAction={onAction} busyId={busyId} nowMs={nowMs} isAdmin={isAdmin} />
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

export default function KpiActionBoard({ onBack, focusTaskId, onFocusHandled, focusStatus }) {
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
  const handledFocusRef = useRef(null);            // last focusTaskId acted on (idempotency vs polls)

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

  // Filters
  const [filterAssignee, setFilterAssignee] = useState(null); // user id or null
  const [filterPriority, setFilterPriority] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);     // lane key or null
  const [openFilter, setOpenFilter] = useState(null);         // 'assignee'|'priority'|'status'|null

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

  // Workday
  const [workdayOpen, setWorkdayOpen] = useState(false);
  const [workdayBusy, setWorkdayBusy] = useState(false);
  const [endSummary, setEndSummary] = useState(null); // payload for the End Workday popup
  const [endNote, setEndNote] = useState('');
  const [endBusy, setEndBusy] = useState(false);
  const [live, setLive] = useState(null); // live_status payload for the activity strip

  // Styled error popup ("Can't start this task", etc.)
  const [errorPopup, setErrorPopup] = useState(null); // { title, message } | null
  const showError = (title, message) => setErrorPopup({ title, message });

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

  // Live board refresh: silently re-fetch on an interval so external changes show.
  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), POLL_MS);
    log.info('live polling started', { everyMs: POLL_MS });
    return () => clearInterval(id);
  }, [load]);

  // Check workday state on mount.
  useEffect(() => {
    getWorkdayStatus().then((r) => setWorkdayOpen(!!r?.is_open)).catch(() => {});
  }, []);

  // Poll the live activity strip (running task / active break / anchors).
  useEffect(() => {
    let alive = true;
    const tick = () => getLiveStatus().then((r) => { if (alive) setLive(r); }).catch(() => {});
    tick();
    const id = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

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
    const task = raw.find((t) => t.id === focusTaskId);
    if (!task) {
      // Not on this board (stale/reassigned-away, or still loading). If the
      // load finished and it's genuinely absent, give up so we don't hang.
      if (!loading) { handledFocusRef.current = focusTaskId; onFocusHandled && onFocusHandled(); }
      return;
    }
    handledFocusRef.current = focusTaskId;

    // 1. Clear every filter so the target card can't be hidden, and switch to the
    //    board view (scroll-to-focus + heartbeat target the kanban card refs).
    setSearch('');
    setFilterAssignee(null);
    setFilterPriority(null);
    setFilterStatus(null);
    setOpenFilter(null);
    setViewMode('board');

    const laneKey = laneForTask(task);

    // 2. Scroll after layout settles (filters just changed → re-render + measure).
    const t1 = setTimeout(() => {
      const x = laneX.current[laneKey];
      if (boardRef.current && typeof x === 'number') {
        boardRef.current.scrollTo({ x: Math.max(0, x - 8), animated: true });
      }
      const laneRef = laneRefs.current[laneKey];
      const y = cardY.current[focusTaskId];
      if (laneRef && typeof y === 'number') {
        laneRef.scrollTo({ y: Math.max(0, y - 8), animated: true });
      }
    }, 260);

    // 3. Trigger the heartbeat + highlight on the card, then release.
    const t2 = setTimeout(() => setPulseId(focusTaskId), 420);
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
    log.info('workday toggle', { currentlyOpen: workdayOpen });
    setWorkdayBusy(true);
    try {
      if (workdayOpen) {
        // Don't end yet — open the summary popup first.
        const payload = await getTodaySummary();
        setEndNote('');
        setEndSummary(payload || {});
      } else {
        const res = await startWorkday();
        if (res && res.status === false) showError("Can't start workday", res.message || 'Failed');
        else setWorkdayOpen(true);
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
      setEndSummary(null);
      await load({ silent: true });
    } catch (e) { showError('Something went wrong', e.message || 'Failed'); }
    finally { setEndBusy(false); }
  }

  function openNewTask() {
    setNewTaskOpen(true);
    setNtName(''); setNtProject(null); setNtHours('1'); setNtMinutes('0'); setNtPriority('regular'); setNtDesc('');
    setNtProjectOpen(false);
    if (projects.length === 0) fetchProjects().then(setProjects).catch(() => {});
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
      Alert.alert('Task created', 'Added to your Pending Review lane.');
    } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
    finally { setNtBusy(false); }
  }

  async function runAction(kind, task) {
    log.info('user action', kind, { id: task.id, name: task.name, state: task.task_state });
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

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

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
        <TouchableOpacity style={s.newTaskBtn} onPress={openNewTask} activeOpacity={0.85}>
          <Ionicons name="add" size={16} color={COLORS.primary} />
          <Text style={s.newTaskTxt}>New Task</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.workdayBtn, workdayOpen && s.workdayBtnEnd]} onPress={toggleWorkday} activeOpacity={0.85} disabled={workdayBusy}>
          {workdayBusy ? <ActivityIndicator color="#fff" size="small" /> : (
            <>
              <Ionicons name={workdayOpen ? 'stop-circle' : 'play-circle'} size={16} color="#fff" />
              <Text style={s.workdayTxt}>{workdayOpen ? 'End Workday' : 'Start Workday'}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

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
                </View>
              )}
            </View>

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
                        pulse={pulseId === t.id}
                        onMeasure={(y) => { cardY.current[t.id] = y; }}
                      />
                    ))
                  )}
                </ScrollView>
              </AnimatedLane>
            );
          })}
        </ScrollView>
      ) : (
        /* List view — vertical accordion, grouped by status. Same filtered data,
           same actions; each row expands to reveal the shared TaskDetailBody. */
        <ScrollView
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
                    onPress={() => setExpandedLanes((prev) => {
                      const next = new Set(prev);
                      next.has(l.key) ? next.delete(l.key) : next.add(l.key);
                      return next;
                    })}
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
                      onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                      onAction={runAction}
                      busyId={busyId}
                      nowMs={nowMs}
                      isAdmin={isAdmin}
                    />
                  ))}
                </View>
              );
            })
          )}
        </ScrollView>
      )}

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

              {/* Note */}
              <TextInput
                style={s.pauseNote}
                placeholder="Optional note (required for 'Other' and 'Urgent')…"
                placeholderTextColor={COLORS.faint}
                value={pauseNote}
                onChangeText={setPauseNote}
                multiline
              />

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

                <Text style={s.fieldLabel}>Project (KRA) *</Text>
                <TouchableOpacity style={[s.dropdown, !ntProject && s.inputErr]} onPress={() => setNtProjectOpen((o) => !o)} activeOpacity={0.8}>
                  <Text style={[s.dropdownTxt, !ntProject && { color: COLORS.faint }]} numberOfLines={1}>
                    {ntProject ? ntProject.display : '— choose a project —'}
                  </Text>
                  <Ionicons name={ntProjectOpen ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
                {!ntProject ? <Text style={s.mandatory}>Please choose a project</Text> : null}
                {ntProjectOpen && (
                  <View style={s.dropdownList}>
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {projects.length === 0 && <Text style={[s.centerTxt, { padding: 12 }]}>Loading projects…</Text>}
                      {projects.map((p) => (
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
                    <Text style={[s.statTileBig, { color: COLORS.primary }]}>{endSummary?.presence_display || '0m'}</Text>
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
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52 },
  listDot: { width: 9, height: 9, borderRadius: 5 },
  listName: { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.ink },
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
  cardTop: { marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: COLORS.navy, lineHeight: 20 },

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

  // End Workday summary
  statTiles: { flexDirection: 'row', gap: 8, marginTop: 12 },
  statTile: { flex: 1, backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 10 },
  statTileLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  statTileVal: { fontSize: 13, color: COLORS.ink, fontWeight: '800', marginTop: 4 },
  statTileBig: { fontSize: 19, fontWeight: '900', marginTop: 4 },
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
