// EMPLOYEE POPUP (admin) — one person from Live Tracking, the way the web and
// Odoo dashboards show them (web/components/admin/EmployeePopup.jsx):
//   header    name + role; ONE status line (what they are doing right now, from
//             the live row the board already polls — the paused task's reason
//             and time, break / lunch timers turning amber then red); Call /
//             WhatsApp / Nudge / Reopen workday
//   Overview  workload in numbers, top tasks, the contact & login card
//             (Reset PIN — the same /kpi_user_access/reset_password Login
//             Management uses)
//   Today     today's End Workday summary, live (WorkdaySummaryBody)
//   Workload  every open task (⏪ Reduce yesterday on each), questions waiting
//             on a manager, today's meetings
//   History   the last 30 days' attendance; tap a day to see it
// Data: the live row (props), /kpi_owner/employee_profile once per open, and
// /kpi_owner/employee_day only while Today / History shows it. The PIN is
// never shown — only whether it is still the default.
//
// ⏪ Reduce yesterday lives here because the web only has it on the task card,
// and the phone's task card (KpiActionBoard / KpiTaskDetail) is out of scope for
// this screen. Same routes and rules: yesterday only, decrease only, a reason.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, TextInput,
  ScrollView, Linking, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';

import { COLORS, SHADOW } from '../theme';
import PulseDot from '../components/PulseDot';
import WorkdaySummaryBody from '../components/WorkdaySummaryBody';
import useAppDialog from '../components/useAppDialog';
import { fetchEmployeeDay } from '../services/liveTracking';
import { resetPassword } from '../services/loginManagement';
import { fetchEmployeeProfile, nudgeUser, fetchPrevDayTime, reducePrevDay } from '../services/adminExtras';
import { getConnection } from '../api/session';
import * as H from '../utils/haptics';
import { createLogger } from '../api/logger';

const log = createLogger('EmployeePopup');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const DAY_POLL_MS = 30000;

// ── How a person is described right now (web employeeStatus.js) ───────────
const pad = (n) => String(n).padStart(2, '0');
export const hm = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const mins = (secs) => { const m = Math.round((secs || 0) / 60); return m < 60 ? `${m} min` : hm(secs); };
// "14:10" → "2:10 PM"
export const clock = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (!isFinite(h) || !isFinite(m)) return String(t);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const ST = { working: 'Working', break: 'On break', lunch: 'Lunch', absent: 'Absent' };
const TS = { running: 'Running', paused: 'Paused', todo: 'To do', done: 'Done', approval: 'Approval', hold: 'On hold' };
const TS_COLOR = {
  running: { bg: '#E0ECFF', fg: '#2563EB' }, paused: { bg: '#FEF3C7', fg: '#B45309' },
  todo: { bg: '#F1F5F9', fg: '#475569' }, hold: { bg: '#FEE2E2', fg: '#DC2626' },
  approval: { bg: '#EDE9FE', fg: '#6D28D9' }, done: { bg: '#DCFCE7', fg: '#16A34A' },
};

export function statusOf(p) {
  if (p.activity_kind === 'break') return 'break';
  if (p.activity_kind === 'lunch') return 'lunch';
  if (p.started) return 'working';
  return 'absent';
}
// "Reason: emergency outing · at 7:29 PM" for a paused task.
export const pauseWhy = (t) => [t?.reason ? `Reason: ${t.reason}` : '', t?.at ? `at ${clock(t.at)}` : ''].filter(Boolean).join(' · ');

// [headline, detail]. `extra` = seconds since the poll, so timers count up.
export function cardText(p, extra = 0, s = statusOf(p)) {
  const t = p.active_tasks?.[0];
  const el = (p.elapsed_seconds || 0) + extra;
  if (s === 'working') {
    if (t) return [`Working on ${t.ref || t.name} · ${hm((t.elapsed_seconds || 0) + extra)}`, t.start ? `Started ${clock(t.start)}` : t.name];
    if (p.activity_kind === 'meeting') return [`In a meeting · ${mins(el)}`, p.activity_note || ''];
    if (p.activity_kind === 'no_tasks') return ['No task to work on', p.activity_note || ''];
    const pt = p.paused_task;
    if (pt) return [`Idle · paused ${pt.ref || pt.name}`, pauseWhy(pt) || (p.active ? 'At the desk' : 'Away from the desk')];
    return ['Idle · no task running', p.active ? 'At the desk' : 'Away from the desk'];
  }
  if (s === 'break' || s === 'lunch') {
    const head = `${s === 'lunch' ? 'At lunch' : 'On break'} · ${mins(el)}`;
    const pt = p.paused_task;
    const at = p.break_start || pt?.at;
    return [head, pt ? `Paused ${pt.ref || pt.name}${at ? ` at ${clock(at)}` : ''}${pt.reason ? ` — ${pt.reason}` : ''}` : p.activity_note || ''];
  }
  if (p.day_done) return ['Workday ended', p.arrival ? `Was in from ${clock(p.arrival)}` : ''];
  return ['Absent', p.attendance === 'pending' ? 'Not checked in yet' : 'No workday started today'];
}

// Amber past 15 min break / 45 min lunch, red past 30 / 60 — the web's limits.
const LIMITS = { break: [15, 30], lunch: [45, 60] };
export function timerLevel(p, extra = 0, s = statusOf(p)) {
  const lim = LIMITS[s];
  if (!lim) return '';
  const m = ((p.elapsed_seconds || 0) + extra) / 60;
  return m >= lim[1] ? 'late' : m >= lim[0] ? 'warn' : '';
}
export const LEVEL_COLOR = {
  warn: { bg: '#FEF3C7', fg: '#B45309', border: '#F59E0B' },
  late: { bg: '#FEE2E2', fg: '#DC2626', border: '#EF4444' },
};

const ATT = {
  on_time: { label: 'On time', bg: '#DCFCE7', fg: '#16A34A' },
  late: { label: 'Late', bg: '#FEF3C7', fg: '#B45309' },
  absent: { label: 'Absent', bg: '#FEE2E2', fg: '#DC2626' },
  off: { label: 'Weekend', bg: '#F1F5F9', fg: '#94A3B8' },
  holiday: { label: 'Holiday', bg: '#E0F2FE', fg: '#0369A1' },
  before_join: { label: 'Before joining', bg: '#F8FAFC', fg: '#CBD5E1' },
  pending: { label: 'Not yet', bg: '#F8FAFC', fg: '#94A3B8' },
};
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (s, o = { day: 'numeric', month: 'short' }) => {
  if (!s) return '';
  try { return new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', o); } catch (_) { return s; }
};

async function openUrl(url) {
  if (!url) return;
  let full = url;
  if (full.startsWith('/')) {
    const { serverUrl } = await getConnection();
    full = `${(serverUrl || '').replace(/\/+$/, '')}${full}`;
  }
  try { await WebBrowser.openBrowserAsync(full); } catch (_) { Linking.openURL(full).catch(() => {}); }
}

// ───────────────────────────────────────────────────────────────────────────
export default function EmployeePopup({ person: p, visible, onClose, onReopen, nowMs, fetchedAt, frozen }) {
  const { dialog, say, showError, confirm } = useAppDialog();
  const [tab, setTab] = useState('overview');
  const [prof, setProf] = useState(null);
  const [profErr, setProfErr] = useState('');
  const [reduceFor, setReduceFor] = useState(null);   // task whose yesterday is being cut

  const loadProfile = useCallback(async () => {
    if (!p) return;
    try {
      const r = await fetchEmployeeProfile(p.user_id);
      if (r?.status === false) setProfErr(r.message || 'Could not load.');
      else { setProf(r); setProfErr(''); }
    } catch (e) {
      log.warn('profile', e?.message);
      setProfErr(e?.message || 'Could not load.');
    }
  }, [p?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh each time someone is opened: last person's numbers must never show
  // under this person's name.
  useEffect(() => {
    if (!visible || !p) return;
    setTab('overview'); setProf(null); setProfErr('');
    loadProfile();
  }, [visible, p?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return null;

  const extra = frozen ? 0 : Math.max(0, Math.floor(((nowMs || Date.now()) - (fetchedAt || Date.now())) / 1000));
  const s = statusOf(p);
  const [line, sub] = cardText(p, extra, s);
  const level = timerLevel(p, extra, s);
  const c = prof?.contact;
  const absent = s === 'absent' && !p.day_done;
  const detail = line.replace(new RegExp(`^${ST[s]}\\s*`, 'i'), '').replace(/^·\s*/, '');
  const head = s === 'absent'
    ? `${p.day_done ? 'Workday ended' : 'Absent'} · ${(p.day_done ? sub : sub || 'no workday started today').toLowerCase()}`
    : `${ST[s]} · ${detail || line}`;
  const second = s === 'absent' ? '' : sub;
  const lv = LEVEL_COLOR[level];

  const nudge = () => confirm({
    title: absent ? `Ask ${p.name} to start their workday` : `Nudge ${p.name}`,
    message: absent ? 'They get a notification asking them to start their workday.'
      : 'They get a notification that you are checking in.',
    tone: 'info', confirmLabel: 'Send nudge',
    input: { label: 'Note (optional)', placeholder: 'e.g. call me when you are free', required: false },
    // Not returned, so an error below is not wiped by the dialog closing.
    onConfirm: (note) => {
      (async () => {
        try {
          const r = await nudgeUser(p.user_id, note);
          if (!r || r.status === false) { showError("Couldn't nudge", r?.message || 'Could not nudge.'); return; }
          say('Nudged', r.message || `Nudged ${p.name}.`, 'ok');
        } catch (e) { showError("Couldn't nudge", e?.message || 'Please try again.'); }
      })();
    },
  });
  const resetPin = () => confirm({
    title: `Reset ${p.name}'s PIN?`,
    message: 'Their app PIN goes back to the default and they must choose a new one the next time they sign in.',
    confirmLabel: 'Reset PIN', destructive: true, tone: 'danger',
    onConfirm: () => {
      (async () => {
        try {
          const r = await resetPassword(p.user_id);
          if (!r || r.status === false) { showError("Couldn't reset the PIN", r?.message || 'Could not reset the PIN.'); return; }
          say('PIN reset', `${p.name}'s PIN was reset — they set a new one at next sign-in.`, 'ok');
          loadProfile();
        } catch (e) { showError("Couldn't reset the PIN", e?.message || 'Please try again.'); }
      })();
    },
  });

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'today', label: 'Today' },
    { key: 'workload', label: 'Workload', count: prof?.workload?.open },
    { key: 'history', label: 'History' },
  ];

  return (
    <Modal visible={!!visible} animationType="slide" onRequestClose={onClose}>
      <View style={st.root}>
        {/* Title bar */}
        <View style={st.head}>
          <TouchableOpacity onPress={onClose} style={st.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-down" size={24} color={COLORS.navy} />
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 10 }}>
            <Text style={st.title} numberOfLines={1}>{p.name}</Text>
            <Text style={st.sub} numberOfLines={1}>{c?.role || p.role || 'Developer'}</Text>
          </View>
          <TouchableOpacity onPress={loadProfile} style={st.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="refresh" size={20} color={COLORS.navy} />
          </TouchableOpacity>
        </View>

        {/* One status line, then the actions */}
        <View style={[st.status, lv && { backgroundColor: lv.bg, borderLeftColor: lv.border }]}>
          <View style={st.statusTop}>
            <PulseDot active={!!p.active} />
            <Text style={[st.statusHead, lv && { color: lv.fg }]}>{head}</Text>
          </View>
          {!!second && <Text style={st.statusSub}>{second}</Text>}
          {!!p.activity_note && s === 'working' && <Text style={st.statusSub}>“{p.activity_note}”</Text>}
          {(p.active_tasks || []).length > 1 && <Text style={st.statusSub}>{p.active_tasks.length} tasks running at once</Text>}
          {!!level && (
            <Text style={[st.statusSub, { color: lv.fg, fontWeight: '800' }]}>
              {level === 'late' ? 'Well over' : 'Over'} the usual {s === 'lunch' ? 'lunch' : 'break'} time
            </Text>
          )}
          {!!p.reopened_reason && (
            <Text style={st.warnTxt}>Reopened{p.reopened_by ? ` by ${p.reopened_by}` : ''}: {p.reopened_reason}</Text>
          )}
          <View style={st.acts}>
            {!!c?.mobile && (
              <Act icon="call-outline" label="Call" onPress={() => Linking.openURL(`tel:+${c.dial}${c.mobile}`).catch(() => {})} />
            )}
            {!!c?.whatsapp && (
              <Act icon="logo-whatsapp" label="WhatsApp" onPress={() => Linking.openURL(`https://wa.me/${c.whatsapp}`).catch(() => {})} />
            )}
            <Act icon="notifications-outline" label={absent ? 'Nudge: start workday' : 'Nudge'} onPress={nudge} />
            {p.day_done && onReopen ? (
              <Act icon="arrow-undo" label="Reopen workday" primary onPress={() => onReopen(p)} />
            ) : null}
          </View>
        </View>

        {/* Tabs */}
        <View style={st.tabs}>
          {TABS.map((t) => (
            <TouchableOpacity key={t.key} style={[st.tab, tab === t.key && st.tabOn]} onPress={() => { H.tap(); setTab(t.key); }} activeOpacity={0.85}>
              <Text style={[st.tabTxt, tab === t.key && st.tabTxtOn]} numberOfLines={1}>
                {t.label}{t.count ? ` ${t.count}` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'today' ? (
          <DayView userId={p.user_id} name={p.name} nowMs={nowMs} onNudge={nudge} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
            {!!profErr && (tab === 'overview' || tab === 'workload') && (
              <View style={st.errBox}><Ionicons name="alert-circle" size={15} color={COLORS.red} /><Text style={st.errTxt}>{profErr}</Text></View>
            )}
            {tab === 'overview' && <Overview p={p} prof={prof} onResetPin={resetPin} />}
            {tab === 'workload' && <Workload prof={prof} onReduce={setReduceFor} />}
            {tab === 'history' && <History p={p} prof={prof} nowMs={nowMs} />}
          </ScrollView>
        )}

        <ReduceYesterday
          task={reduceFor} onClose={() => setReduceFor(null)}
          onDone={(msg) => { setReduceFor(null); say("Yesterday's time reduced", msg, 'ok'); loadProfile(); }}
        />
        {dialog}
      </View>
    </Modal>
  );
}

function Act({ icon, label, onPress, primary }) {
  return (
    <TouchableOpacity style={[st.act, primary && st.actPrimary]} onPress={onPress} activeOpacity={0.85}>
      <Ionicons name={icon} size={15} color={primary ? '#fff' : COLORS.primary} />
      <Text style={[st.actTxt, primary && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Tile({ t, v, n, bad, good }) {
  return (
    <View style={st.tile}>
      <Text style={st.tileT}>{t}</Text>
      <Text style={[st.tileV, bad && { color: COLORS.red }, good && { color: COLORS.green }]}>{v}</Text>
      {!!n && <Text style={[st.tileN, bad && { color: COLORS.red }]}>{n}</Text>}
    </View>
  );
}

function Box({ title, children }) {
  return (
    <View style={st.box}>
      <Text style={st.boxTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Kv({ k, children }) {
  return (
    <View style={st.kv}>
      <Text style={st.kvK}>{k}</Text>
      <View style={{ flex: 1 }}>{typeof children === 'string' ? <Text style={st.kvV}>{children}</Text> : children}</View>
    </View>
  );
}

function Loading() {
  return <View style={{ paddingVertical: 40 }}><ActivityIndicator color={COLORS.primary} /></View>;
}

// ── Overview ───────────────────────────────────────────────────────────────
function Overview({ p, prof, onResetPin }) {
  if (!prof) return <Loading />;
  const w = prof.workload || { counts: {} };
  const c = prof.contact || {};
  const att = prof.attendance?.totals || {};
  const top = p.top_tasks || [];
  return (
    <>
      <View style={st.tiles}>
        <Tile t="Done" v={`${w.done_today ?? 0} today`} n={`${w.done_week ?? 0} this week · ${w.done_month ?? 0} this month`} good={!!w.done_today} />
        <Tile t="Open tasks" v={String(w.open ?? 0)}
          n={`${w.counts?.running || 0} running · ${w.counts?.paused || 0} paused · ${w.counts?.todo || 0} to do · ${w.counts?.approval || 0} approval`} />
        <Tile t="Deadlines" v={String(w.overdue ?? 0)} n={`overdue · ${w.due_week ?? 0} due this week`} bad={!!w.overdue} />
        <Tile t="Estimate vs spent" v={`${w.spent_total ?? 0}h / ${w.est_total ?? 0}h`} n="on open tasks"
          bad={!!w.est_total && w.spent_total > w.est_total} />
        <Tile t="Attendance · 30 days" v={`${att.on_time || 0} on time`}
          n={`${att.late || 0} late · ${att.absent || 0} absent · of ${att.working_days || 0} working day${att.working_days === 1 ? '' : 's'}`} />
      </View>

      {/* What the live board knows about their tasks right now — the paused
          one with its reason and time first, as Odoo's dashboard shows it. */}
      {top.length > 0 && (
        <Box title="Top tasks">
          {top.map((t) => {
            const col = TS_COLOR[t.state] || TS_COLOR.todo;
            return (
              <View key={t.id} style={st.taskRow}>
                <Text style={st.ref}>{t.ref || `#${t.id}`}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={st.taskName} numberOfLines={2}>{t.name}</Text>
                  {t.state === 'paused' && (t.reason || t.at) ? (
                    <Text style={st.taskMeta}>{pauseWhy(t)}</Text>
                  ) : null}
                </View>
                <View style={[st.lozenge, { backgroundColor: col.bg }]}><Text style={[st.lozengeTxt, { color: col.fg }]}>{TS[t.state] || t.state}</Text></View>
              </View>
            );
          })}
        </Box>
      )}

      <Box title="Contact & login">
        <Kv k="Login mobile">{c.mobile ? `+${c.dial} ${c.mobile}${c.country ? ` · ${c.country}` : ''}` : '—'}</Kv>
        <Kv k="WhatsApp">
          {c.whatsapp ? <Text style={st.kvV}>+{c.whatsapp}</Text>
            : <Text style={[st.kvV, { color: COLORS.red }]}>no number — they can't be messaged</Text>}
        </Kv>
        <Kv k="App login">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {c.app_login_enabled ? <Text style={st.kvV}>On</Text> : <Text style={[st.kvV, { color: COLORS.red }]}>Off</Text>}
            {c.pin_is_default ? <View style={st.amberTag}><Text style={st.amberTagTxt}>Default PIN – not changed</Text></View> : null}
          </View>
          {/* Offered always, not only while the PIN is the default: a person who
              forgot theirs is exactly who needs it. Same route as Login
              Management; the server decides who may. */}
          <TouchableOpacity style={st.pinBtn} onPress={onResetPin} activeOpacity={0.85}>
            <Ionicons name="key-outline" size={14} color={COLORS.red} />
            <Text style={st.pinBtnTxt}>Reset PIN</Text>
          </TouchableOpacity>
        </Kv>
        <Kv k="Last sign-in">{c.last_app_login ? `${c.last_app_login}${c.last_device ? ` · ${c.last_device}` : ''}` : 'never'}</Kv>
        <Kv k="ERP login">{c.login || '—'}</Kv>
        <Kv k="Multitask">{c.allow_multitask ? 'May run several tasks at once' : 'One task at a time'}</Kv>
      </Box>

      {((prof.questions || []).length > 0 || (prof.meetings_today || []).length > 0) && (
        <Box title="Waiting on">
          {(prof.questions || []).length > 0 && (
            <Text style={st.mini}>
              {prof.questions.length} question{prof.questions.length === 1 ? '' : 's'} to a manager, oldest{' '}
              {Math.max(...prof.questions.map((q) => q.days || 0))} day(s)
            </Text>
          )}
          {(prof.meetings_today || []).map((m) => (
            <Text key={m.id} style={st.mini}>{m.time} {m.name} · {m.state}</Text>
          ))}
        </Box>
      )}
    </>
  );
}

// ── Today / any day ────────────────────────────────────────────────────────
function DayView({ userId, name, date, nowMs, onNudge, embedded }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const isToday = !date;
  const load = useCallback(async (silent) => {
    const my = ++seq.current;
    try {
      const r = await fetchEmployeeDay(userId, date || undefined);
      if (my !== seq.current) return;
      if (r && r.status === false) { if (!silent) setErr(r.message || 'Could not load that day.'); return; }
      setD(r); setErr('');
    } catch (e) {
      if (my !== seq.current) return;
      if (!silent) setErr(e?.message || 'Could not load that day.');
    }
  }, [userId, date]);
  useEffect(() => {
    setD(null); setErr('');
    load(false);
    if (!isToday) return () => { seq.current += 1; };
    const id = setInterval(() => load(true), DAY_POLL_MS);
    return () => { clearInterval(id); seq.current += 1; };
  }, [load, isToday]);

  let body;
  if (err && !d) body = <View style={st.errBox}><Ionicons name="alert-circle" size={15} color={COLORS.red} /><Text style={st.errTxt}>{err}</Text></View>;
  else if (!d) body = <Loading />;
  else if (d.started === false) {
    body = (
      <View style={st.empty}>
        <MaterialCommunityIcons name="calendar-blank-outline" size={40} color={COLORS.faint} />
        <Text style={st.emptyB}>{isToday ? 'Not started yet' : 'No workday'}</Text>
        <Text style={st.emptyT}>
          {isToday ? `${name} hasn't started a workday today.`
            : `${name} didn't start a workday on ${dmy(date, { weekday: 'short', day: 'numeric', month: 'short' })}.`}
        </Text>
        {isToday && onNudge ? (
          <TouchableOpacity style={[st.act, st.actPrimary, { marginTop: 12 }]} onPress={onNudge}>
            <Ionicons name="notifications-outline" size={15} color="#fff" />
            <Text style={[st.actTxt, { color: '#fff' }]}>Nudge to start workday</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  } else {
    body = (
      <>
        {isToday && <Text style={[st.mini, { marginBottom: 8 }]}>Today so far · updates every 30 s</Text>}
        <WorkdaySummaryBody summary={d} viewer="admin" now={nowMs || Date.now()} />
      </>
    );
  }
  if (embedded) return body;
  return <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>{body}</ScrollView>;
}

// ── Workload ───────────────────────────────────────────────────────────────
function Workload({ prof, onReduce }) {
  if (!prof) return <Loading />;
  const w = prof.workload || { counts: {}, tasks: [] };
  return (
    <>
      <View style={st.chips}>
        {['running', 'paused', 'todo', 'hold', 'approval'].map((k) => {
          const n = w.counts?.[k] || 0;
          const col = n ? (TS_COLOR[k] || TS_COLOR.todo) : { bg: '#F8FAFC', fg: '#CBD5E1' };
          return <View key={k} style={[st.lozenge, { backgroundColor: col.bg }]}><Text style={[st.lozengeTxt, { color: col.fg }]}>{TS[k]} {n}</Text></View>;
        })}
        <View style={[st.lozenge, { backgroundColor: w.done_month ? '#DCFCE7' : '#F8FAFC' }]}>
          <Text style={[st.lozengeTxt, { color: w.done_month ? '#16A34A' : '#CBD5E1' }]}>
            Done {w.done_today || 0} today · {w.done_week || 0} this week · {w.done_month || 0} this month
          </Text>
        </View>
        {w.overdue > 0 && <View style={[st.lozenge, { backgroundColor: '#FEE2E2' }]}><Text style={[st.lozengeTxt, { color: '#DC2626' }]}>{w.overdue} overdue</Text></View>}
      </View>

      <Box title={`Open tasks (${w.open || 0})`}>
        {(w.tasks || []).length ? w.tasks.map((t) => {
          const col = TS_COLOR[t.state] || TS_COLOR.todo;
          const over = !!t.estimate_h && t.spent_h > t.estimate_h;
          return (
            <View key={t.id} style={st.taskBlock}>
              <View style={st.taskRow}>
                <Text style={st.ref}>{t.ref || `#${t.id}`}</Text>
                <Text style={[st.taskName, { flex: 1 }]} numberOfLines={2}>{t.name}</Text>
                <View style={[st.lozenge, { backgroundColor: col.bg }]}><Text style={[st.lozengeTxt, { color: col.fg }]}>{TS[t.state] || t.state_label}</Text></View>
              </View>
              <View style={st.taskFoot}>
                <Text style={st.taskMeta} numberOfLines={1}>
                  {t.client || '—'}
                  {t.deadline ? ` · due ${dmy(t.deadline)}${t.overdue ? ' · overdue' : ''}` : ''}
                </Text>
                <Text style={[st.taskMeta, over && { color: COLORS.red, fontWeight: '800' }]}>
                  {t.spent_h}h / {t.estimate_h ? `${t.estimate_h}h` : '—'}
                </Text>
              </View>
              <TouchableOpacity style={st.reduceLink} onPress={() => onReduce(t)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Ionicons name="time-outline" size={13} color={COLORS.amber} />
                <Text style={st.reduceLinkTxt}>Reduce yesterday</Text>
              </TouchableOpacity>
            </View>
          );
        }) : <Text style={st.mini}>No open tasks.</Text>}
      </Box>

      <Box title={`Questions waiting on a manager (${(prof.questions || []).length})`}>
        {(prof.questions || []).length ? prof.questions.map((q) => (
          <Text key={q.id} style={st.qRow}>
            <Text style={st.refInline}>{q.ref || '—'}</Text>  {q.question}
            <Text style={st.mini}>  · {q.days ? `${q.days} day${q.days === 1 ? '' : 's'}` : 'today'}</Text>
          </Text>
        )) : <Text style={st.mini}>None.</Text>}
      </Box>

      <Box title={`Meetings today (${(prof.meetings_today || []).length})`}>
        {(prof.meetings_today || []).length ? prof.meetings_today.map((m) => (
          <View key={m.id} style={st.taskRow}>
            <Text style={[st.taskName, { flex: 1 }]}><Text style={{ fontWeight: '900' }}>{m.time}</Text> {m.name} <Text style={st.mini}>· {m.state}</Text></Text>
            {m.join_url ? (
              <TouchableOpacity style={st.act} onPress={() => openUrl(m.join_url)}>
                <Ionicons name="videocam-outline" size={14} color={COLORS.primary} />
                <Text style={st.actTxt}>Join</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )) : <Text style={st.mini}>None.</Text>}
      </Box>
    </>
  );
}

// ── History ────────────────────────────────────────────────────────────────
function History({ p, prof, nowMs }) {
  const today = ymd(new Date());
  const [date, setDate] = useState(() => { const y = new Date(); y.setDate(y.getDate() - 1); return ymd(y); });
  const att = prof?.attendance;
  return (
    <>
      <Box title="Attendance · last 30 days">
        {!att ? <Loading /> : (
          <>
            <Text style={st.mini}>
              Working days only · late after {clock(att.cutoff)}{att.joined ? ` · joined ${dmy(att.joined)}` : ''}
            </Text>
            <View style={st.attGrid}>
              {(att.days || []).map((d) => {
                const a = ATT[d.status] || ATT.pending;
                const past = d.date < today;
                return (
                  <TouchableOpacity
                    key={d.date} disabled={!past} onPress={() => setDate(d.date)} activeOpacity={0.8}
                    style={[st.attDay, { backgroundColor: a.bg }, d.date === date && st.attDayOn]}
                  >
                    <Text style={[st.attDayTxt, { color: a.fg }]}>{new Date(`${d.date}T00:00:00`).getDate()}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={st.chips}>
              {['on_time', 'late', 'absent'].map((k) => (
                <View key={k} style={[st.lozenge, { backgroundColor: ATT[k].bg }]}>
                  <Text style={[st.lozengeTxt, { color: ATT[k].fg }]}>{ATT[k].label} {att.totals?.[k] || 0}</Text>
                </View>
              ))}
              <Text style={st.mini}>of {att.totals?.working_days || 0} working days · tap a day to see it below</Text>
            </View>
          </>
        )}
      </Box>
      <Box title={dmy(date, { weekday: 'long', day: 'numeric', month: 'long' })}>
        <DayView key={date} userId={p.user_id} name={p.name} date={date} nowMs={nowMs} embedded />
      </Box>
    </>
  );
}

// ── ⏪ Reduce yesterday ────────────────────────────────────────────────────
// Admin takes forgotten time off the END of yesterday on one task (a laptop
// left running, a missed pause). Yesterday only, decrease only, with a reason
// saved in the task log — kra.kpi.action_reduce_prev_day holds every rule.
function ReduceYesterday({ task, onClose, onDone }) {
  const [d, setD] = useState(null);
  const [h, setH] = useState('0');
  const [m, setM] = useState('0');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!task) return;
    let alive = true;
    setD(null); setH('0'); setM('0'); setCode(''); setText(''); setErr('');
    (async () => {
      try {
        const r = await fetchPrevDayTime(task.id);
        if (alive) setD(r || { status: false, message: "Could not load yesterday's time." });
      } catch (e) {
        if (alive) setD({ status: false, message: e?.message || "Could not load yesterday's time." });
      }
    })();
    return () => { alive = false; };
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevMin = Math.round((d?.seconds || 0) / 60);
  const cut = Math.max(0, parseInt(h, 10) || 0) * 60 + Math.max(0, parseInt(m, 10) || 0);
  const live = cut <= 0 ? ['Enter how much to take off.', COLORS.faint]
    : cut > prevMin ? [`Yesterday has only ${hm(prevMin * 60)} — you can take off at most that.`, COLORS.red]
      : [`Yesterday becomes ${hm((prevMin - cut) * 60)} (was ${hm(prevMin * 60)})`, COLORS.green];
  const ok = d?.status && cut > 0 && cut <= prevMin && code && (code !== 'other' || text.trim());
  const people = (d?.people || []).map((x) => `${x.name} ${x.display}`).join(', ');

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await reducePrevDay(task.id, {
        hours: parseInt(h, 10) || 0, minutes: parseInt(m, 10) || 0,
        reasonCode: code, reasonText: code === 'other' ? text.trim() : '',
      });
      if (!r || r.status === false) { H.err(); setErr(r?.message || "Could not reduce yesterday's time."); return; }
      H.ok();
      onDone(r.message || `${task.ref || task.name}: yesterday's time reduced.`);
    } catch (e) {
      setErr(e?.message || "Could not reduce yesterday's time.");
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={!!task} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={st.mWrap}>
        <View style={st.mCard}>
          <View style={st.mHead}>
            <Text style={st.mTitle} numberOfLines={2}>Reduce yesterday's time{task ? ` — ${task.ref || task.name}` : ''}</Text>
            <TouchableOpacity onPress={onClose} disabled={busy} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color="#7a5200" />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 14 }} keyboardShouldPersistTaps="handled">
            {!d ? <Loading /> : d.status === false ? (
              <View style={st.errBox}><Ionicons name="alert-circle" size={15} color={COLORS.red} /><Text style={st.errTxt}>{d.message}</Text></View>
            ) : (
              <>
                <Kv k="Day">{d.date_display || d.date}</Kv>
                <Kv k="This task">{people ? `${d.display} (${people})` : d.display}</Kv>
                {(d.day_totals || []).map((x) => (
                  <Kv key={x.name} k={`${x.name} — whole day`}>{`${x.display} on ${x.tasks} task(s)`}</Kv>
                ))}
                <Kv k="Task total so far">{d.task_total_display}</Kv>
                {(d.intervals || []).length > 0 && (
                  <View style={{ marginTop: 6 }}>
                    {d.intervals.map((i, n) => (
                      <Text key={n} style={st.interval}>
                        {i.start} → {i.end}  <Text style={{ fontWeight: '900' }}>{i.display}</Text>
                        {(d.people || []).length > 1 ? `  ${i.who}` : ''}
                      </Text>
                    ))}
                  </View>
                )}
                {prevMin <= 0 ? (
                  <Text style={[st.mini, { marginTop: 10 }]}>No time was recorded on this task yesterday — there is nothing to take off.</Text>
                ) : (
                  <>
                    <Text style={[st.mini, { marginTop: 10 }]}>Takes the forgotten time off the <Text style={{ fontWeight: '900' }}>end</Text> of
                      yesterday. Only yesterday, only less — it cannot add time.</Text>
                    <View style={st.hmRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={st.fLabel}>Hours</Text>
                        <TextInput style={st.fInput} keyboardType="number-pad" value={h} onChangeText={(v) => setH(v.replace(/[^0-9]/g, ''))} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={st.fLabel}>Minutes</Text>
                        <TextInput style={st.fInput} keyboardType="number-pad" maxLength={2} value={m}
                          onChangeText={(v) => { let n = parseInt(v.replace(/[^0-9]/g, ''), 10); if (!isFinite(n)) n = 0; setM(String(Math.min(59, n))); }} />
                      </View>
                    </View>
                    <Text style={{ fontSize: 12.5, fontWeight: '800', color: live[1], marginTop: 8 }}>{live[0]}</Text>
                    <Text style={st.fLabel}>Reason *</Text>
                    {(d.reasons || []).map((r) => (
                      <TouchableOpacity key={r.key} style={st.radio} onPress={() => setCode(r.key)} activeOpacity={0.8}>
                        <Ionicons name={code === r.key ? 'radio-button-on' : 'radio-button-off'} size={18} color={code === r.key ? COLORS.primary : COLORS.faint} />
                        <Text style={st.radioTxt}>{r.label}</Text>
                      </TouchableOpacity>
                    ))}
                    {code === 'other' && (
                      <TextInput style={[st.fInput, { marginTop: 6 }]} value={text} onChangeText={setText}
                        placeholder="What happened? e.g. system restarted for updates" placeholderTextColor={COLORS.faint} />
                    )}
                    <Text style={st.mini}>Saved in the task log.</Text>
                  </>
                )}
                {!!err && <View style={[st.errBox, { marginTop: 10 }]}><Ionicons name="alert-circle" size={15} color={COLORS.red} /><Text style={st.errTxt}>{err}</Text></View>}
              </>
            )}
          </ScrollView>
          <View style={st.mFoot}>
            <TouchableOpacity style={st.footCancel} onPress={onClose} disabled={busy}>
              <Text style={st.footCancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[st.footDanger, !ok && { opacity: 0.45 }]} onPress={submit} disabled={!ok || busy}>
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={st.footDangerTxt}>Reduce time</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F4F7FB' },
  head: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: TOP, paddingBottom: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  sub: { fontSize: 12, color: COLORS.muted, fontWeight: '600', marginTop: 1 },

  status: { backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 12, borderLeftWidth: 4, borderLeftColor: COLORS.primary, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  statusTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusHead: { flex: 1, fontSize: 14.5, fontWeight: '900', color: COLORS.ink },
  statusSub: { fontSize: 12.5, color: COLORS.muted, marginTop: 4, lineHeight: 17 },
  warnTxt: { fontSize: 12, color: COLORS.amber, fontWeight: '700', marginTop: 4 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  act: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 34, borderRadius: 9, borderWidth: 1.5, borderColor: '#C7D8F7', backgroundColor: '#F0F5FF' },
  actPrimary: { backgroundColor: COLORS.amber, borderColor: COLORS.amber },
  actTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },

  tabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: COLORS.line },
  tab: { flex: 1, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F5FB' },
  tabOn: { backgroundColor: COLORS.primary },
  tabTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted },
  tabTxtOn: { color: '#fff' },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: '47.5%', flexGrow: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, ...SHADOW },
  tileT: { fontSize: 11.5, color: COLORS.muted, fontWeight: '700' },
  tileV: { fontSize: 18, fontWeight: '900', color: COLORS.navy, marginTop: 4 },
  tileN: { fontSize: 11, color: COLORS.muted, marginTop: 3, lineHeight: 15 },

  box: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginTop: 12, ...SHADOW },
  boxTitle: { fontSize: 13.5, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },
  kv: { flexDirection: 'row', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  kvK: { width: 110, fontSize: 12, color: COLORS.muted, fontWeight: '700' },
  kvV: { fontSize: 13, color: COLORS.ink, fontWeight: '600' },
  amberTag: { backgroundColor: COLORS.amberBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  amberTagTxt: { fontSize: 11, fontWeight: '800', color: '#92400E' },
  pinBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 10, height: 30, borderRadius: 8, borderWidth: 1.5, borderColor: '#FECACA', backgroundColor: '#fff' },
  pinBtnTxt: { fontSize: 12, fontWeight: '800', color: COLORS.red },
  mini: { fontSize: 11.5, color: COLORS.muted, lineHeight: 16, marginTop: 2 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 },
  lozenge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  lozengeTxt: { fontSize: 11.5, fontWeight: '800' },

  taskBlock: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9', paddingVertical: 8 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  taskFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 2 },
  ref: { fontSize: 11.5, fontWeight: '900', color: COLORS.navy, backgroundColor: '#EEF3FF', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  refInline: { fontSize: 11.5, fontWeight: '900', color: COLORS.navy },
  taskName: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  taskMeta: { fontSize: 11.5, color: COLORS.muted, flexShrink: 1 },
  reduceLink: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 6 },
  reduceLinkTxt: { fontSize: 12, fontWeight: '800', color: COLORS.amber },
  qRow: { fontSize: 13, color: COLORS.ink, paddingVertical: 4, lineHeight: 18 },

  attGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginVertical: 10 },
  attDay: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  attDayOn: { borderWidth: 2, borderColor: COLORS.navy },
  attDayTxt: { fontSize: 12.5, fontWeight: '900' },

  empty: { alignItems: 'center', paddingVertical: 30, gap: 4 },
  emptyB: { fontSize: 15, fontWeight: '900', color: COLORS.navy, marginTop: 6 },
  emptyT: { fontSize: 13, color: COLORS.muted, textAlign: 'center' },

  errBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
  },
  errTxt: { flex: 1, fontSize: 12.5, color: COLORS.red, fontWeight: '600', lineHeight: 17 },

  // Reduce yesterday
  mWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 18 },
  mCard: { width: '100%', maxWidth: 480, backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', ...SHADOW },
  mHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: COLORS.amberBg, paddingHorizontal: 14, paddingVertical: 12 },
  mTitle: { flex: 1, fontSize: 15, fontWeight: '900', color: '#7a5200' },
  interval: { fontSize: 12.5, color: COLORS.ink, paddingVertical: 2 },
  hmRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  fLabel: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginTop: 12, marginBottom: 5 },
  fInput: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 42, paddingHorizontal: 11, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff' },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  radioTxt: { fontSize: 13.5, color: COLORS.ink },
  mFoot: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: COLORS.line },
  footCancel: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line },
  footCancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  footDanger: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 11, backgroundColor: COLORS.red },
  footDangerTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
