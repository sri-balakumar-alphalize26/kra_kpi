// CONFIGURATION — mobile port of the Odoo web "Configuration" screen
// (kpi_configuration.js). All sections auto-save:
//   1. Timers — admin accept, client approval, queue/urgent nudge, standard day
//   2. Daily Task Report & Retention
//   3. Developers — Multi-task toggle; the WhatsApp number shown read-only
//      (it follows the login mobile, which is changed in Login Management)
//   4. 🏁 Finish & client review, 🧾 Billing (link), Approval chain
//   5. WhatsApp Group Reports — which updates get posted, and in what words
// Admin-only (opened from a Home Quick Action tile).
//
// The destination GROUP is deliberately not chosen here — that stays on the web.
// Picking the wrong group posts to it, which has happened, and doing it safely
// needs the group list, naming and confirmation flow.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch,
  ActivityIndicator, Modal, FlatList, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import GradientButton, { GRAD_SEND } from '../components/GradientButton';
import { renderWaTemplate, splitBold } from '../utils/waPreview';
import { createLogger } from '../api/logger';
// setDevWa is gone on purpose: /kpi_multitask/set_wa is retired (kra_api.py) and
// always answers "The WhatsApp number follows the login mobile". setUserCountry
// went with the per-developer country picker: changing the country clears the
// login mobile server-side, which is Login Management's business, not this card's.
import {
  fetchConfig, setUrgentNudge, setMultitask,
  setClientApproval, setQueueNudge, setStandardHours, setAdminAccept, setBreakAlerts,
  setSnapshotRetention, setReportRetention, setDailyReport, setAttendanceInApp,
} from '../services/config';
import { fetchGroupEvents, setGroupEvent, testGroupEvent } from '../services/waGroup';
import {
  fetchCeoNumbers, setCeoNumbers, fetchFinishConfig, setFinishConfig,
  fetchApprovalChain, writeTier, createTier, deleteTier,
} from '../services/adminExtras';
import useAppDialog from '../components/useAppDialog';

const log = createLogger('ConfigurationScreen');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const UNIT_OPTS = [
  { value: 'days', label: 'Days' },
  { value: 'months', label: 'Months' },
  { value: 'years', label: 'Years' },
];
const COVERAGE_OPTS = [
  { value: 'yesterday', label: 'Previous day' },
  { value: 'today', label: 'Same day' },
];

// Keep only digits, strip a leading dial code, cap to the country length.
function toLocal(value, dial, length) {
  let d = String(value || '').replace(/[^\d]/g, '');
  if (dial && d.length > length && d.startsWith(dial)) d = d.slice(dial.length);
  return d.slice(0, length);
}

function Card({ color, icon, iconLib, title, children }) {
  return (
    <View style={[s.card, { borderLeftColor: color }]}>
      <View style={s.cardHead}>
        {iconLib === 'mc'
          ? <MaterialCommunityIcons name={icon} size={18} color={color} />
          : <Ionicons name={icon} size={18} color={color} />}
        <Text style={s.cardTitle}>{title}</Text>
      </View>
      <View style={s.cardBody}>{children}</View>
    </View>
  );
}

// onOpen (optional): App.js's navigator — the read-only WhatsApp number links to
// Login Management, and the Billing card to Settings › Billing.
export default function ConfigurationScreen({ onBack, onOpen }) {
  const [loading, setLoading] = useState(true);
  // CEO daily summary: comma-separated WhatsApp numbers (empty = off).
  const [ceoNumbers, setCeoNumbersVal] = useState('');
  // 🏁 Finish & client review. null = not loaded (the card is then left out,
  // like the web, rather than showing defaults that look saved).
  const [fin, setFin] = useState(null);
  const [reviewDays, setReviewDays] = useState('');
  const [isMock, setIsMock] = useState(false);
  const [clientApproval, setClientApprovalVal] = useState('5');
  const [queueNudge, setQueueNudgeVal] = useState('30');
  const [standardHours, setStandardHoursVal] = useState('9');
  const [urgentNudge, setUrgentNudgeVal] = useState('5');
  // Developer-only break / lunch / meeting over-run reminders. 0 = that one off.
  const [breakAlert, setBreakAlertVal] = useState('15');
  const [lunchAlert, setLunchAlertVal] = useState('30');
  const [meetingAlert, setMeetingAlertVal] = useState('30');
  const [breakBudget, setBreakBudgetVal] = useState('60');
  const [countryId, setCountryId] = useState(false);
  const [dial, setDial] = useState('91');
  const [mobileLength, setMobileLength] = useState(10);
  const [countries, setCountries] = useState([]);
  const [developers, setDevelopers] = useState([]);
  const [savedFlash, setSavedFlash] = useState('');
  // Daily task report schedule + snapshot/report retention.
  const [snapNum, setSnapNum] = useState('3');
  const [snapUnit, setSnapUnit] = useState('months');
  const [repNum, setRepNum] = useState('3');
  const [repUnit, setRepUnit] = useState('months');
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [dailyHH, setDailyHH] = useState('10');
  const [dailyMM, setDailyMM] = useState('00');
  const [dailyCoverage, setDailyCoverage] = useState('yesterday');
  const [optPicker, setOptPicker] = useState(null);   // { title, options, current, onPick }
  const [adminAccept, setAdminAcceptVal] = useState('5');
  // Attendance in the app. `available` is whether the server has the
  // attendance bridge at all — without it the card is not rendered, so a
  // database that never installed HR looks exactly as it did before.
  const [attAvailable, setAttAvailable] = useState(false);
  const [attEnabled, setAttEnabled] = useState(false);
  // A failed load used to leave the defaults on screen looking like saved
  // settings. Say so instead — a wrong number here changes how the team works.
  const [loadError, setLoadError] = useState('');
  // { key, message } — which field was refused, and why. Rendered in the field's
  // own tick slot as well as in a banner, because a banner at the top of the
  // screen is no use to somebody who just tapped a field at the bottom.
  const [saveErr, setSaveErr] = useState(null);
  // WhatsApp group reporting. Destination is read-only here (web chooses it).
  const [waGroupJid, setWaGroupJid] = useState('');
  const [waGroupName, setWaGroupName] = useState('');
  const [waEvents, setWaEvents] = useState([]);
  const [waSamples, setWaSamples] = useState({});
  const [waMsg, setWaMsg] = useState('');
  const [waConfirm, setWaConfirm] = useState(null);   // { event, label }
  const [waBusy, setWaBusy] = useState(false);

  const flash = useCallback((key) => {
    setSavedFlash(key);
    setTimeout(() => setSavedFlash((k) => (k === key ? '' : k)), 1400);
  }, []);

  // ONE place that decides whether a save actually happened, so no saver can
  // drift back to assuming it did. Every /kpi_config/set_* route RETURNS
  // {status: false, message} for a caller without rights rather than raising
  // (_is_kra_admin in kra_api.py), so the promise resolves and a bare `await`
  // is indistinguishable from success. This screen used to flash its green tick
  // on exactly that: a coordinator who had lost the admin group could change
  // "Client approval window", see ✓, and have nothing saved.
  const saveGuard = useCallback(async (key, fn) => {
    try {
      const res = await fn();
      if (res && res.status === false) {
        setSaveErr({ key, message: res.message || 'Not authorized — that change was not saved.' });
        return false;
      }
      setSaveErr(null);
      flash(key);
      return true;
    } catch (e) {
      log.warn('save ' + key, e?.message);
      setSaveErr({ key, message: 'Could not reach the server — that change was not saved.' });
      return false;
    }
  }, [flash]);

  const load = useCallback(async () => {
    try {
      const c = await fetchConfig();
      setIsMock(c.isMock);
      setClientApprovalVal(String(c.client_approval_minutes));
      setQueueNudgeVal(String(c.queue_nudge_minutes));
      setStandardHoursVal(String(c.standard_workday_hours ?? 9));
      setUrgentNudgeVal(String(c.urgent_nudge_minutes));
      setBreakAlertVal(String(c.break_alert_minutes));
      setLunchAlertVal(String(c.lunch_alert_minutes));
      setMeetingAlertVal(String(c.meeting_alert_minutes));
      setBreakBudgetVal(String(c.break_budget_minutes));
      setDial(c.country_dial_code);
      setMobileLength(c.mobile_length);
      setCountryId(c.country_id);
      setCountries(c.countries);
      setDevelopers(c.developers);
      setSnapNum(String(c.snapshot_retention_number ?? 3));
      setSnapUnit(c.snapshot_retention_unit || 'months');
      setRepNum(String(c.report_retention_number ?? 3));
      setRepUnit(c.report_retention_unit || 'months');
      setDailyEnabled(c.daily_report_enabled !== false);
      const dh = Number(c.daily_report_hour ?? 10);
      const dH = Math.floor(dh);
      setDailyHH(String(dH));
      setDailyMM(String(Math.round((dh - dH) * 60)).padStart(2, '0'));
      setDailyCoverage(c.daily_report_coverage || 'yesterday');
      setAdminAcceptVal(String(c.admin_accept_minutes ?? 5));
      setWaGroupJid(c.wa_group_jid || '');
      setWaGroupName(c.wa_group_name || '');
      setAttAvailable(!!c.attendance_available);
      setAttEnabled(!!c.attendance_in_app);
      setLoadError('');
      // Which updates get posted. Pure configuration — no gateway involved — so
      // it must load even with the phone's WhatsApp offline. Its own try/catch:
      // failing to read the group events should not blank the whole screen.
      try {
        const g = await fetchGroupEvents();
        if (g?.status) { setWaEvents(g.events || []); setWaSamples(g.samples || {}); }
      } catch (e) {
        log.warn('fetchGroupEvents', e?.message);
      }
      // CEO numbers and the Finish card, each on its own for the same reason.
      try {
        const ceo = await fetchCeoNumbers();
        if (ceo?.status) setCeoNumbersVal(String(ceo.numbers || '').split(',').filter(Boolean).join(', '));
      } catch (e) { log.warn('fetchCeoNumbers', e?.message); }
      try {
        const f = await fetchFinishConfig();
        if (f?.status) { setFin(f); setReviewDays(String(f.review_days ?? '')); }
      } catch (e) { log.warn('fetchFinishConfig', e?.message); }
    } catch (e) {
      log.warn('load failed', e?.message);
      setLoadError('Could not load settings — the values below are defaults, not what is saved.');
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  // ── Savers ────────────────────────────────────────────────────────────────
  const saveAdminAccept = async () => {
    // max(0, …), NOT max(1, …): 0 is the documented kill switch that turns
    // auto-accept off entirely, and clamping it up to 1 would silently re-enable
    // a behaviour someone deliberately disabled. Matches kra_api.py:2556.
    const parsed = parseInt(adminAccept, 10);
    const v = Math.max(0, isNaN(parsed) ? 5 : parsed);
    setAdminAcceptVal(String(v));
    await saveGuard('adminAccept', () => setAdminAccept(v));
  };
  const saveClientApproval = async () => {
    const v = Math.max(1, parseInt(clientApproval) || 5);
    setClientApprovalVal(String(v));
    await saveGuard('clientApproval', () => setClientApproval(v));
  };
  const saveQueueNudge = async () => {
    const v = Math.max(1, parseInt(queueNudge) || 30);
    setQueueNudgeVal(String(v));
    await saveGuard('queueNudge', () => setQueueNudge(v));
  };
  const saveStandardHours = async () => {
    // Hours, not minutes — and fractional (7.5) is a real workday, so parseFloat.
    // Clamped to a sane day: 0 makes every day green, >24 makes every day red,
    // and either way the green/red signal stops meaning anything. The server
    // clamps to the same range.
    let v = parseFloat(standardHours);
    if (!isFinite(v) || v <= 0) v = 9;
    v = Math.max(0.5, Math.min(24, v));
    setStandardHoursVal(String(v));
    await saveGuard('standardHours', () => setStandardHours(v));
  };
  const saveUrgentNudge = async () => {
    const v = Math.max(1, parseInt(urgentNudge) || 5);
    setUrgentNudgeVal(String(v));
    await saveGuard('urgentNudge', () => setUrgentNudge(v));
  };
  // The four break reminders. Math.max(0, ...) not (1, ...): 0 is a real value
  // here and means "switch this reminder off". `parseInt(x) || d` would turn a
  // typed 0 back into the default, so the fallback is applied only when the field
  // is genuinely not a number.
  const saveBreakField = async (key, raw, setter, fallback) => {
    const n = parseInt(raw);
    const v = Math.max(0, isFinite(n) ? n : fallback);
    setter(String(v));
    await saveGuard(key, () => setBreakAlerts({ [key]: v }));
  };
  const saveBreakAlert = () =>
    saveBreakField('break_alert_minutes', breakAlert, setBreakAlertVal, 15);
  const saveLunchAlert = () =>
    saveBreakField('lunch_alert_minutes', lunchAlert, setLunchAlertVal, 30);
  const saveMeetingAlert = () =>
    saveBreakField('meeting_alert_minutes', meetingAlert, setMeetingAlertVal, 30);
  const saveBreakBudget = () =>
    saveBreakField('break_budget_minutes', breakBudget, setBreakBudgetVal, 60);
  // HH + MM inputs → the backend's float hour (10.5 = 10:30). Clamp to a real time.
  const timeToHour = (hh, mm) => {
    let H = parseInt(hh); if (!isFinite(H)) H = 0; H = Math.max(0, Math.min(23, H));
    let M = parseInt(mm); if (!isFinite(M)) M = 0; M = Math.max(0, Math.min(59, M));
    return H + M / 60;
  };
  // Unit is passed explicitly from the picker (state may not have flushed yet).
  const saveSnapRetention = async (unitOverride) => {
    const n = Math.max(0, parseInt(snapNum) || 0);
    const u = unitOverride || snapUnit;
    setSnapNum(String(n));
    await saveGuard('snapRet', () => setSnapshotRetention({ number: n, unit: u }));
  };
  const saveRepRetention = async (unitOverride) => {
    const n = Math.max(0, parseInt(repNum) || 0);
    const u = unitOverride || repUnit;
    setRepNum(String(n));
    await saveGuard('repRet', () => setReportRetention({ number: n, unit: u }));
  };
  const saveDaily = async (over = {}) => {
    const enabled = over.enabled != null ? over.enabled : dailyEnabled;
    const coverage = over.coverage || dailyCoverage;
    const hour = timeToHour(dailyHH, dailyMM);
    const H = Math.floor(hour);
    setDailyHH(String(H));
    setDailyMM(String(Math.round((hour - H) * 60)).padStart(2, '0'));
    await saveGuard('daily', () => setDailyReport({ enabled, hour, coverage }));
  };
  // CEO daily summary numbers. The server cleans each one (adds the company dial
  // code to a bare local number) and refuses one that is not a number at all —
  // the box then shows what it actually stored.
  const saveCeoNumbers = async () => {
    await saveGuard('ceo', async () => {
      const res = await setCeoNumbers(ceoNumbers);
      if (res && res.status !== false && res.numbers != null) {
        setCeoNumbersVal(String(res.numbers).split(',').filter(Boolean).join(', '));
      }
      return res;
    });
  };
  // 🏁 Finish & client review. The route answers the SAVED values; those win.
  const saveFinish = async (key, vals) => {
    await saveGuard(key, async () => {
      const res = await setFinishConfig(vals);
      if (res && res.status !== false) { setFin(res); setReviewDays(String(res.review_days ?? '')); }
      return res;
    });
  };
  const saveReviewDays = async () => {
    const n = parseInt(reviewDays, 10);
    // 1-60, the server's own range; out of range puts the stored value back.
    if (!isFinite(n) || n < 1 || n > 60) {
      setReviewDays(String(fin?.review_days ?? ''));
      setSaveErr({ key: 'reviewDays', message: 'Pick between 1 and 60 days.' });
      return;
    }
    if (n === fin?.review_days) return;
    await saveFinish('reviewDays', { review_days: n });
  };

  // ── WhatsApp group reports ────────────────────────────────────────────────
  const waPreviewOf = useCallback(
    (tpl) => renderWaTemplate(tpl, waSamples), [waSamples]);

  const saveWaEvent = async (ev, vals) => {
    // Optimistic, then reconciled with what the server actually stored — the
    // server owns "empty template means use the default", so the text that comes
    // back may not be the text we sent.
    setWaEvents((list) => list.map((e) => (e.event === ev.event ? { ...e, ...vals } : e)));
    try {
      const res = await setGroupEvent({ event: ev.event, ...vals });
      if (res && res.status === false) { setWaMsg(res.message || 'Could not save.'); await load(); return; }
      setWaEvents((list) => list.map((e) => (e.event === ev.event
        ? { ...e, enabled: res?.enabled ?? e.enabled, template: res?.template ?? e.template, _saved: true }
        : e)));
      setTimeout(() => setWaEvents((list) => list.map((e) => (
        e.event === ev.event ? { ...e, _saved: false } : e))), 1400);
    } catch (e) { log.warn('saveWaEvent', e?.message); }
  };

  // The new value is passed explicitly: RN state has not flushed when a Switch
  // fires. Same reason as saveDaily(over).
  const toggleWaEvent = (ev) => saveWaEvent(ev, { enabled: !ev.enabled });
  const saveWaTemplate = (ev) => saveWaEvent(ev, { template: ev.template || '' });
  // '' means "use the built-in default" server-side, so Reset never needs to
  // know what the default text is.
  const resetWaTemplate = (ev) => saveWaEvent(ev, { template: '' });

  // Tapping a token has to SAVE, not just type. The template is written on the
  // textarea's onEndEditing, and inserting a token never touches the textarea —
  // so an admin tapped {deadline}, watched it appear in the box and in the
  // preview, went back, and found it gone. The web's equivalent ends with the
  // same save call (kpi_configuration.js waInsertToken).
  const insertWaToken = (ev, tok) => {
    const next = `${ev.template || ''}{${tok}}`;
    setWaEvents((list) => list.map((e) => (e.event === ev.event ? { ...e, template: next } : e)));
    return saveWaEvent(ev, { template: next });
  };

  const runWaTest = async () => {
    const ev = waConfirm;
    setWaConfirm(null);
    if (!ev) return;
    setWaBusy(true);
    try {
      const res = await testGroupEvent(ev.event, waGroupJid);
      setWaMsg(res?.message || 'No response.');
    } catch (e) {
      setWaMsg(e?.message || 'Could not send the test.');
    } finally { setWaBusy(false); }
  };
  const toggleDev = async (dev) => {
    const next = !dev.allow_multitask;
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, allow_multitask: next } : d)));
    try {
      const res = await setMultitask(dev.id, next);
      // Roll back a refused change. Leaving the switch flipped made an
      // unauthorised toggle look saved until the next reload.
      if (res && res.status === false) {
        setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, allow_multitask: !next } : d)));
        setWaMsg(res.message || 'Not allowed to change that.');
      }
    } catch (e) {
      setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, allow_multitask: !next } : d)));
      log.warn('toggleDev', e?.message);
    }
  };

  // The new value is passed in, not read from state: RN state has not flushed
  // when a Switch fires (same reason as saveDaily). The server echoes what it
  // saved, and that echo wins over what was tapped.
  const saveAttendance = async (next) => {
    setAttEnabled(next);
    const ok = await saveGuard('attendance', async () => {
      const res = await setAttendanceInApp(next);
      if (res && res.status !== false && typeof res.attendance_in_app === 'boolean') setAttEnabled(res.attendance_in_app);
      return res;
    });
    if (!ok) setAttEnabled(!next);
  };

  // The tick, or the reason there is no tick — in the same slot, so the answer
  // is where the eye already is. Never both: a refused save must not also flash ✓.
  const SaveMark = ({ k }) => {
    if (saveErr && saveErr.key === k) return <Text style={s.saveMarkErr}>✕ not saved</Text>;
    if (savedFlash === k) return <Text style={s.savedTick}>✓</Text>;
    return null;
  };

  // A developer's own dial code (from /kpi_multitask/list), else the company's.
  const devDial = (dev) => {
    const c = countries.find((x) => x.id === dev.country_id);
    return String(dev.dial || (c && c.phone_code) || dial || '91').replace(/\D/g, '');
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      {/* Header */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.hTitle} numberOfLines={1}>Configuration</Text>
        <View style={s.iconBtn} />
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to load live config</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

          {/* 2. Timers — the "Away after (minutes)" field used to lead this card.
              Idle auto-pause is retired: a sleeping device is not evidence that
              somebody stopped working, and pausing on it cost people their board
              several times a day. There is nothing left to configure. */}
          {!!loadError && (
            <View style={s.mockBar}>
              <Ionicons name="alert-circle-outline" size={14} color={COLORS.amber} />
              <Text style={s.mockTxt}>{loadError}</Text>
            </View>
          )}

          {/* The reason a save was refused. The ✕ in the field's own tick slot
              says WHICH setting; this says why, in the server's own words. */}
          {!!saveErr && (
            <TouchableOpacity style={s.saveErrBar} onPress={() => setSaveErr(null)} activeOpacity={0.8}>
              <Ionicons name="close-circle-outline" size={14} color="#B91C1C" />
              <Text style={s.saveErrTxt}>{saveErr.message}  ✕</Text>
            </TouchableOpacity>
          )}

          <Card color="#0ea5e9" iconLib="mc" icon="clock-outline" title="Timers">
            <Text style={s.label}>Admin accept window (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={adminAccept} onChangeText={setAdminAcceptVal}
                onEndEditing={saveAdminAccept}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="adminAccept" />}
            </View>
            <Text style={s.hint}>How long an admin has to accept a submitted task before it is
              accepted automatically. <Text style={{ fontWeight: '800' }}>0 turns auto-accept off</Text> —
              tasks then wait for a person.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Client approval window (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={clientApproval} onChangeText={setClientApprovalVal}
                onEndEditing={saveClientApproval}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="clientApproval" />}
            </View>
            <Text style={s.hint}>How long a client has to approve the developer assigned to their task.
              If they don't respond in time it is approved automatically. Only for tasks the team
              creates: a request the client raised themselves starts once an admin accepts it.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Queue re-nudge gap (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={queueNudge} onChangeText={setQueueNudgeVal}
                onEndEditing={saveQueueNudge}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="queueNudge" />}
            </View>
            <Text style={s.hint}>How often admins are re-notified about a client task still waiting for a
              developer. Stops once an admin opens the notification.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Urgent re-nudge gap (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={urgentNudge} onChangeText={setUrgentNudgeVal}
                onEndEditing={saveUrgentNudge}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="urgentNudge" />}
            </View>
            <Text style={s.hint}>When a developer taps 🚨 Urgent while pausing, the owner and admins are
              notified in the app and reminded this often until one of them reads it.</Text>

            <Text style={[s.label, { marginTop: 22 }]}>Break reminder (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={breakAlert} onChangeText={setBreakAlertVal}
                onEndEditing={saveBreakAlert}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="break_alert_minutes" />}
            </View>
            <Text style={s.hint}>How long a break runs before the developer is reminded, and the gap
              between repeats. Stops after 4 reminders. Only the developer is told — admins are not
              notified. 0 turns it off.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Lunch reminder (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={lunchAlert} onChangeText={setLunchAlertVal}
                onEndEditing={saveLunchAlert}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="lunch_alert_minutes" />}
            </View>
            <Text style={s.hint}>How long lunch runs before the developer is reminded. Sent once, not
              repeated. 0 turns it off.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Meeting reminder (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={meetingAlert} onChangeText={setMeetingAlertVal}
                onEndEditing={saveMeetingAlert}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="meeting_alert_minutes" />}
            </View>
            <Text style={s.hint}>How long a meeting runs before the developer is reminded it is still
              counting. Sent once. 0 turns it off.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Daily break budget (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={breakBudget} onChangeText={setBreakBudgetVal}
                onEndEditing={saveBreakBudget}
              />
              <Text style={s.unit}>min</Text>
              {<SaveMark k="break_budget_minutes" />}
            </View>
            <Text style={s.hint}>Break and lunch added together for the whole day. Catches several short
              breaks that never individually hit the limit above. Meetings are not counted. Sent once a
              day, to the developer only. 0 turns it off.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Standard workday (hours)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="decimal-pad"
                value={standardHours} onChangeText={setStandardHoursVal}
                onEndEditing={saveStandardHours}
              />
              <Text style={s.unit}>h</Text>
              {<SaveMark k="standardHours" />}
            </View>
            <Text style={s.hint}>A normal working day. The End Workday summary compares it against
              <Text style={{ fontWeight: '800' }}> Presence</Text> (login → logout): at or over reads
              green, under reads red. Presence is wall-clock, so it counts breaks and meetings too —
              the summary shows Productive next to it.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>CEO daily summary (WhatsApp)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { flex: 1 }]} keyboardType="phone-pad" autoCorrect={false}
                placeholder="9876543210, 971501234567" placeholderTextColor={COLORS.faint}
                value={ceoNumbers} onChangeText={setCeoNumbersVal}
                onEndEditing={saveCeoNumbers}
              />
              {<SaveMark k="ceo" />}
            </View>
            <Text style={s.hint}>When anyone ends their workday, their Workday Snapshot image with the
              summary ("What did you work on today?") goes to these WhatsApp numbers only.
              Separate several with commas. <Text style={{ fontWeight: '800' }}>Empty = off.</Text></Text>
          </Card>

          {/* 3. Daily Task Report & Retention */}
          <Card color="#f59e0b" iconLib="mc" icon="file-document-outline" title="Daily Task Report & Retention">
            <View style={s.switchRow}>
              <Text style={[s.label, { marginBottom: 0, flex: 1 }]}>Send daily employee task report (PDF)</Text>
              <Switch
                value={dailyEnabled}
                onValueChange={() => { const n = !dailyEnabled; setDailyEnabled(n); saveDaily({ enabled: n }); }}
                trackColor={{ true: COLORS.primary }}
              />
              {<SaveMark k="daily" />}
            </View>

            {dailyEnabled && (
              <>
                <Text style={[s.label, { marginTop: 16 }]}>Send time (IST)</Text>
                <View style={s.inlineRow}>
                  <TextInput
                    style={[s.input, { width: 58, textAlign: 'center' }]} keyboardType="number-pad" maxLength={2}
                    value={dailyHH} onChangeText={setDailyHH} onEndEditing={() => saveDaily()}
                  />
                  <Text style={[s.unit, { fontWeight: '800' }]}>:</Text>
                  <TextInput
                    style={[s.input, { width: 58, textAlign: 'center' }]} keyboardType="number-pad" maxLength={2}
                    value={dailyMM} onChangeText={setDailyMM} onEndEditing={() => saveDaily()}
                  />
                  <Text style={s.unit}>HH : MM</Text>
                </View>

                <Text style={[s.label, { marginTop: 16 }]}>Report covers</Text>
                <TouchableOpacity
                  style={s.select} activeOpacity={0.8}
                  onPress={() => setOptPicker({
                    title: 'Report covers', current: dailyCoverage, options: COVERAGE_OPTS,
                    onPick: (v) => { setDailyCoverage(v); saveDaily({ coverage: v }); },
                  })}
                >
                  <Text style={s.selectTxt}>{COVERAGE_OPTS.find((o) => o.value === dailyCoverage)?.label || dailyCoverage}</Text>
                  <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
                </TouchableOpacity>
              </>
            )}
            <Text style={s.hint}>One PDF with every employee's task details, delivered to admins in-app at the
              time above. Previous day suits a morning send (everyone has ended their workday).</Text>

            <View style={s.divider} />

            <Text style={s.label}>Keep workday snapshot images for</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 70 }]} keyboardType="number-pad"
                value={snapNum} onChangeText={setSnapNum} onEndEditing={() => saveSnapRetention()}
              />
              <TouchableOpacity
                style={[s.select, { flex: 1 }]} activeOpacity={0.8}
                onPress={() => setOptPicker({
                  title: 'Retention unit', current: snapUnit, options: UNIT_OPTS,
                  onPick: (v) => { setSnapUnit(v); saveSnapRetention(v); },
                })}
              >
                <Text style={s.selectTxt}>{UNIT_OPTS.find((o) => o.value === snapUnit)?.label || snapUnit}</Text>
                <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
              </TouchableOpacity>
              {<SaveMark k="snapRet" />}
            </View>
            <Text style={s.hint}>Old End-Workday summary images are cleared automatically (the day's stats
              are kept). <Text style={{ fontWeight: '800' }}>0 = keep forever.</Text></Text>

            <Text style={[s.label, { marginTop: 16 }]}>Keep generated report PDFs for</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 70 }]} keyboardType="number-pad"
                value={repNum} onChangeText={setRepNum} onEndEditing={() => saveRepRetention()}
              />
              <TouchableOpacity
                style={[s.select, { flex: 1 }]} activeOpacity={0.8}
                onPress={() => setOptPicker({
                  title: 'Retention unit', current: repUnit, options: UNIT_OPTS,
                  onPick: (v) => { setRepUnit(v); saveRepRetention(v); },
                })}
              >
                <Text style={s.selectTxt}>{UNIT_OPTS.find((o) => o.value === repUnit)?.label || repUnit}</Text>
                <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
              </TouchableOpacity>
              {<SaveMark k="repRet" />}
            </View>
            <Text style={s.hint}>Reports stay viewable and downloadable until deleted.
              <Text style={{ fontWeight: '800' }}> 0 = keep forever.</Text></Text>
          </Card>

          {/* The "Urgent-pause recipients" card (extra WhatsApp numbers) was removed:
              those numbers had no login, so they could only be reached over WhatsApp —
              which is now off for task notifications. Urgent goes to the owner +
              admins in the app instead, repeating until read. */}

          {/* 4. Developers */}
          <Card color="#6366f1" iconLib="mc" icon="account-group" title="Developers — Multi-task & WhatsApp">
            <Text style={s.hint}>Multi-task ON lets a developer run more than one task at once (default OFF).
              The WhatsApp number identifies them in Urgent / auto-away messages. It follows the
              login mobile — <Text style={{ fontWeight: '800' }}>change it in Login Management</Text>.</Text>
            {developers.length === 0 ? (
              <Text style={[s.hint, { marginTop: 10 }]}>No developers found.</Text>
            ) : developers.map((dev) => (
              <View key={dev.id} style={s.devRow}>
                {/* Line 1: name + multi-task switch */}
                <View style={s.devTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.devName}>{dev.name}</Text>
                    <Text style={s.devLogin}>{dev.login}</Text>
                  </View>
                  <View style={s.devMulti}>
                    <Text style={s.devSmall}>Multi-task</Text>
                    <Switch
                      value={!!dev.allow_multitask}
                      onValueChange={() => toggleDev(dev)}
                      trackColor={{ true: COLORS.primary }}
                    />
                  </View>
                </View>
                {/* Line 2: the WhatsApp number, READ-ONLY. It always equals the
                    login mobile (Odoo keeps them the same), and the old editor's
                    route /kpi_multitask/set_wa is retired — it refused every save
                    with "change it in Login Management". So the row says that,
                    and taps through to Login Management when it can. */}
                {(() => {
                  const dd = devDial(dev);
                  const shown = toLocal(dev.wa_number, dd, dev.mobile_length || mobileLength);
                  return (
                    <TouchableOpacity
                      style={s.devWaRow} activeOpacity={onOpen ? 0.7 : 1} disabled={!onOpen}
                      onPress={() => onOpen && onOpen('loginmgmt')}
                    >
                      <View style={s.dialBadgeSm}><Text style={s.dialBadgeSmTxt}>+{dd}</Text></View>
                      <View style={[s.devWaInput, s.devWaRead]}>
                        <Text style={[s.devWaReadTxt, !shown && { color: COLORS.faint }]} numberOfLines={1}>
                          {shown || 'no login mobile'}
                        </Text>
                      </View>
                      {onOpen ? <Text style={s.devWaEdit}>edit ›</Text> : null}
                    </TouchableOpacity>
                  );
                })()}
                <Text style={s.devWaHint}>The WhatsApp number follows the login mobile. Change it in Login Management.</Text>
              </View>
            ))}
          </Card>

          {/* 🏁 Finish & client review (models/kpi_finish.py). Left out until it
              loads, as on the web — defaults here would look like saved values. */}
          {fin && (
            <Card color="#16A34A" iconLib="mc" icon="flag-checkered" title="Finish & client review">
              <Text style={s.label}>Client review (days)</Text>
              <View style={s.inlineRow}>
                <TextInput
                  style={[s.input, { width: 90 }]} keyboardType="number-pad" maxLength={2}
                  value={reviewDays} onChangeText={setReviewDays}
                  onEndEditing={saveReviewDays}
                />
                <Text style={s.unit}>days</Text>
                {<SaveMark k="reviewDays" />}
              </View>
              <Text style={s.hint}>Days the client has to check finished work (1-60). No answer in time: it
                closes on its own, the developer is told and 🏁 Full Complete unlocks for them.</Text>

              <View style={[s.switchRow, { marginTop: 16 }]}>
                <Text style={[s.label, { marginBottom: 0, flex: 1 }]}>Admin check first</Text>
                {/* The setting is skip_admin; the switch reads the way people
                    think about it ("an admin checks it"), so it is inverted. */}
                <Switch
                  value={!fin.skip_admin}
                  onValueChange={(v) => saveFinish('skipAdmin', { skip_admin: !v })}
                  trackColor={{ true: COLORS.primary }}
                />
                {<SaveMark k="skipAdmin" />}
              </View>
              <Text style={s.hint}>An admin checks finished work before the client. Off: the developer's
                Partial Complete goes straight to the client.</Text>
            </Card>
          )}

          {/* Billing has its own screen (Settings › Billing), as on the web. */}
          <Card color="#CA8A04" iconLib="mc" icon="receipt" title="Billing">
            <Text style={[s.hint, { marginTop: 0 }]}>The price list a bill is made from (per client and work
              type), and each client's invoice WhatsApp group, are in <Text style={{ fontWeight: '800' }}>Settings ›
              Billing</Text>.</Text>
            {onOpen ? (
              <TouchableOpacity style={s.linkBtn} onPress={() => onOpen('billing')} activeOpacity={0.85}>
                <MaterialCommunityIcons name="receipt" size={15} color={COLORS.primary} />
                <Text style={s.linkBtnTxt}>Open billing</Text>
              </TouchableOpacity>
            ) : null}
          </Card>

          {/* Who decides a new client request, in order (kpi.escalation.tier). */}
          <ApprovalChainCard />

          {/* 4. WhatsApp Group Reports — which updates get posted and in what
              words. The destination group is NOT chosen here: picking the wrong
              one posts to it, and doing that safely needs the group list, naming
              and confirmation that only the web screen has. */}
          {/* 3b. Attendance — only when the attendance bridge is on the server.
              One company-wide switch: it puts the floating Attendance button
              on everyone's Home (developers and admins; never clients). */}
          {attAvailable && (
            <Card color="#0D9488" iconLib="mc" icon="calendar-check" title="Attendance">
              <View style={s.switchRow}>
                <Text style={[s.label, { marginBottom: 0, flex: 1 }]}>Show attendance in the app</Text>
                <Switch
                  value={attEnabled}
                  onValueChange={() => saveAttendance(!attEnabled)}
                  trackColor={{ true: COLORS.primary }}
                />
                {<SaveMark k="attendance" />}
              </View>
              <Text style={s.hint}>Users see their HR attendance — today, this week, the month and a
                day-by-day history — behind a floating button on Home; admins also see the whole
                team for a day. Check-in and check-out still come from Start / End Workday.
                Clients never see it.</Text>
            </Card>
          )}

          <Card color="#25D366" iconLib="mc" icon="whatsapp" title="WhatsApp Group Reports">
            {waGroupJid ? (
              <View style={s.waDest}>
                <Ionicons name="checkmark-circle" size={16} color={COLORS.green} />
                <View style={{ flex: 1 }}>
                  <Text style={s.waDestName}>{waGroupName || waGroupJid}</Text>
                  <Text style={s.waDestHint}>Change the group on the web Configuration screen.</Text>
                </View>
              </View>
            ) : (
              <View style={s.waDestOff}>
                <Ionicons name="information-circle-outline" size={16} color={COLORS.muted} />
                <Text style={s.waDestHint}>No group set — nothing is posted. Choose one on the web.</Text>
              </View>
            )}

            {!!waMsg && (
              <TouchableOpacity onPress={() => setWaMsg('')} activeOpacity={0.8}>
                <Text style={s.waMsg}>{waMsg}  ✕</Text>
              </TouchableOpacity>
            )}

            {waEvents.length === 0 && (
              <Text style={s.hint}>No reportable updates loaded.</Text>
            )}

            {waEvents.map((ev) => (
              <View key={ev.event} style={s.waEvent}>
                <View style={s.switchRow}>
                  <Text style={[s.label, { marginBottom: 0, flex: 1 }]}>{ev.label}</Text>
                  <Switch
                    value={!!ev.enabled}
                    onValueChange={() => toggleWaEvent(ev)}
                    trackColor={{ true: COLORS.primary }}
                  />
                  {ev._saved && <Text style={s.savedTick}>✓</Text>}
                </View>
                <Text style={s.hint}>{ev.help}</Text>

                {/* Hidden while off: a live preview of something that will never
                    be sent is just noise. */}
                {!!ev.enabled && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={s.label}>Preview — what the group sees</Text>
                    <View style={s.previewBubble}>
                      <Text style={s.previewTxt}>
                        {splitBold(waPreviewOf(ev.template)).map((p, i) => (
                          <Text key={i} style={p.bold ? { fontWeight: '800' } : null}>{p.text}</Text>
                        ))}
                      </Text>
                    </View>

                    <View style={s.tokenRow}>
                      <Text style={s.tokenLead}>Insert:</Text>
                      {(ev.tokens || []).map((tok) => (
                        <TouchableOpacity key={tok} style={s.tokenChip}
                          onPress={() => insertWaToken(ev, tok)} activeOpacity={0.7}>
                          <Text style={s.tokenChipTxt}>{tok}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <TextInput
                      style={s.tplInput} multiline value={ev.template || ''}
                      placeholder="Message…" placeholderTextColor={COLORS.faint}
                      onChangeText={(t) => setWaEvents((list) => list.map((e) => (
                        e.event === ev.event ? { ...e, template: t } : e)))}
                      onEndEditing={() => saveWaTemplate(ev)}
                    />
                    <Text style={s.hint}>Write it in plain English. The name, times and task
                      details are filled in automatically — the preview above shows exactly what
                      the group gets.</Text>

                    <View style={s.waBtnRow}>
                      <TouchableOpacity onPress={() => resetWaTemplate(ev)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={s.tplReset}>↺ Reset to default</Text>
                      </TouchableOpacity>
                      <GradientButton
                        label="Send test" colors={GRAD_SEND}
                        disabled={!waGroupJid || waBusy}
                        onPress={() => setWaConfirm(ev)}
                        icon={<Ionicons name="paper-plane-outline" size={15} color="#fff" />}
                        style={{ minWidth: 130 }}
                      />
                    </View>
                  </View>
                )}
              </View>
            ))}
          </Card>
        </ScrollView>
      )}

      {/* Send-test confirmation. Blurred centre card, the same shape this app
          already uses for logging out — its idiom for "this one is irreversible".
          The route also refuses unless the group id is echoed back, so this is a
          real guard, not decoration. */}
      <Modal visible={!!waConfirm} transparent animationType="fade" onRequestClose={() => setWaConfirm(null)}>
        <BlurView intensity={30} tint="dark" experimentalBlurMethod="dimezisBlurView" style={s.confirmBlur}>
          <View style={s.confirmCard}>
            <View style={s.confirmIconWrap}>
              <Ionicons name="logo-whatsapp" size={30} color={COLORS.green} />
            </View>
            <Text style={s.confirmTitle}>Send a test message?</Text>
            <Text style={s.confirmBody}>
              A sample “{waConfirm?.label}” message will be posted to{' '}
              <Text style={{ fontWeight: '800' }}>{waGroupName || waGroupJid}</Text>.
              {'\n\n'}Everyone in that group will see it. It is marked as a test.
            </Text>
            <View style={s.confirmBtns}>
              <TouchableOpacity style={s.confirmCancel} onPress={() => setWaConfirm(null)}>
                <Text style={s.confirmCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <GradientButton label="Send test" colors={GRAD_SEND} onPress={runWaTest}
                style={{ flex: 1 }} />
            </View>
          </View>
        </BlurView>
      </Modal>

      {/* Generic option picker (retention unit / report coverage) */}
      <Modal visible={!!optPicker} transparent animationType="fade" onRequestClose={() => setOptPicker(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setOptPicker(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>{optPicker?.title || 'Select'}</Text>
              <TouchableOpacity onPress={() => setOptPicker(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {(optPicker?.options || []).map((o) => {
              const on = o.value === optPicker.current;
              return (
                <TouchableOpacity
                  key={o.value} style={[s.ccRow, on && s.ccRowOn]} activeOpacity={0.8}
                  onPress={() => { const f = optPicker.onPick; setOptPicker(null); if (f) f(o.value); }}
                >
                  <Text style={s.ccRowName}>{o.label}</Text>
                  {on && <Text style={s.ccRowTick}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 16, borderLeftWidth: 4, overflow: 'hidden', ...SHADOW },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  cardBody: { padding: 14 },

  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 8, lineHeight: 17 },

  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 46, backgroundColor: '#fff' },
  selectTxt: { fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  row2: { flexDirection: 'row', gap: 12, marginTop: 12, alignItems: 'flex-end' },
  readBox: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: '#F7F9FC' },
  readTxt: { fontSize: 15, fontWeight: '700', color: COLORS.navy },

  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  divider: { height: 1, backgroundColor: COLORS.line, marginVertical: 16 },
  input: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  unit: { fontSize: 14, color: COLORS.muted, fontWeight: '600' },
  savedTick: { color: COLORS.green, fontSize: 18, fontWeight: '900', marginLeft: 6 },
  // Sits in the tick's slot, so it reads as the answer to the same question.
  saveMarkErr: { color: '#B91C1C', fontSize: 11.5, fontWeight: '800', marginLeft: 6 },
  saveErrBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FEE2E2',
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12,
  },
  saveErrTxt: { color: '#B91C1C', fontSize: 11.5, fontWeight: '700', flex: 1 },

  dialBadge: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: '#F7F9FC' },
  dialBadgeTxt: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },

  devRow: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#F1F4F9' },
  devTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  devMulti: { alignItems: 'center' },
  devName: { fontSize: 14, fontWeight: '700', color: COLORS.ink },
  devLogin: { fontSize: 12, color: COLORS.muted },
  devSmall: { fontSize: 10, color: COLORS.muted, marginBottom: 2 },
  devWaRow: { flexDirection: 'row', alignItems: 'center' },
  dialBadgeSm: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F4F9', borderWidth: 1, borderColor: COLORS.line, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, paddingHorizontal: 10, height: 44, justifyContent: 'center' },
  dialBadgeSmTxt: { fontSize: 14, fontWeight: '800', color: COLORS.navy },
  devWaInput: { flex: 1, borderWidth: 1, borderColor: COLORS.line, borderLeftWidth: 0, borderTopRightRadius: 10, borderBottomRightRadius: 10, height: 44, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  devSavedInline: { fontSize: 16, color: COLORS.green, fontWeight: '900', marginLeft: 8 },
  devInvalid: { fontSize: 11.5, color: COLORS.red, marginTop: 5, fontWeight: '700' },

  // ── WhatsApp group reports ───────────────────────────────────────────────
  waDest: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10,
    borderRadius: 10, backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#A7F3D0',
  },
  waDestOff: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10,
    borderRadius: 10, backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: COLORS.line,
  },
  waDestName: { fontSize: 14, fontWeight: '800', color: COLORS.ink },
  waDestHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 1 },
  waMsg: {
    marginTop: 10, padding: 9, borderRadius: 9, backgroundColor: '#FEF3C7',
    color: '#78350F', fontSize: 12.5, fontWeight: '600', overflow: 'hidden',
  },
  waEvent: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: COLORS.line },
  // #DCF8C6 is the WhatsApp bubble green — identical to the web preview and to
  // the OTP preview on Login Management, so all three read as the same thing.
  previewBubble: {
    backgroundColor: '#DCF8C6', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#C5EBB0', marginTop: 4,
  },
  previewTxt: { fontSize: 13.5, color: '#0B3D0B', lineHeight: 20 },
  tokenRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
  tokenLead: { fontSize: 11.5, color: COLORS.muted, fontWeight: '700' },
  tokenChip: {
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  tokenChipTxt: { fontSize: 11.5, fontWeight: '700', color: COLORS.primary },
  tplInput: {
    borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, padding: 12,
    minHeight: 110, fontSize: 14, color: COLORS.ink, backgroundColor: '#fff',
    textAlignVertical: 'top', marginTop: 8,
  },
  tplReset: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  waBtnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 },

  // Confirm dialog — mirrors the logout dialog's blurred centre card.
  confirmBlur: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  confirmCard: {
    width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 18,
    padding: 20, alignItems: 'center', ...SHADOW,
  },
  confirmIconWrap: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: '#ECFDF5',
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  confirmTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },
  confirmBody: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', lineHeight: 20 },
  confirmBtns: { flexDirection: 'row', gap: 10, marginTop: 18, alignSelf: 'stretch' },
  confirmCancel: {
    flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  confirmCancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },

  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 26,
  },
  modalSheet: {
    width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20,
    maxHeight: '70%', paddingBottom: 12, overflow: 'hidden',
  },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  ccRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowMeta: { fontSize: 13, color: COLORS.muted, marginRight: 8 },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },

  // Developers: the read-only WhatsApp number
  devWaRead: { justifyContent: 'center', backgroundColor: '#F7F9FC' },
  devWaReadTxt: { fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  devWaEdit: { fontSize: 12.5, color: COLORS.primary, fontWeight: '800', marginLeft: 8 },
  devWaHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 5 },

  linkBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12,
    paddingHorizontal: 12, height: 38, borderRadius: 10, borderWidth: 1.5, borderColor: '#C7D8F7', backgroundColor: '#F0F5FF',
  },
  linkBtnTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.primary },

  // Approval chain
  acHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acAdd: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 34, borderRadius: 9, backgroundColor: COLORS.primary },
  acAddTxt: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
  acWarn: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 10, padding: 10, marginTop: 10 },
  acWarnTxt: { color: '#B91C1C', fontSize: 12.5, fontWeight: '700', lineHeight: 17 },
  acTier: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, padding: 10, marginTop: 12, backgroundColor: '#FBFCFE' },
  acTierDup: { borderColor: '#F87171' },
  acTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  acNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#E0ECFF', alignItems: 'center', justifyContent: 'center' },
  acNumTxt: { fontSize: 12.5, fontWeight: '900', color: COLORS.primary },
  acIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  acRow2: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  acDupTxt: { fontSize: 11.5, color: '#B91C1C', fontWeight: '700', marginTop: 4 },
  acPeople: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  acPerson: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, borderWidth: 1, borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: '#fff', maxWidth: '100%' },
  acPersonDup: { borderColor: '#F87171', backgroundColor: '#FEE2E2' },
  acPersonName: { fontSize: 13, fontWeight: '800', color: COLORS.ink },
  acPersonNum: { fontSize: 11.5, color: COLORS.muted },
  acMgr: { borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5 },
  acMgrTxt: { fontSize: 11.5, color: COLORS.muted, lineHeight: 16 },
  acAddPerson: { borderWidth: 1.5, borderColor: '#C7D8F7', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#F0F5FF', alignSelf: 'center' },
  acAddPersonTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
});

// ── Approval chain (kpi.escalation.tier) ────────────────────────────────────
// Who decides a new client request, in order — edited in place: step name,
// minutes, "task's manager", the people on the step (with the WhatsApp number
// their link goes to), order, add / delete. Same reads and writes as the web
// card (web/components/settings/ApprovalChainCard.jsx) and the Odoo
// Configuration card. Every write reloads, so what is shown is what is stored.
function ApprovalChainCard() {
  const { dialog, confirm, showError } = useAppDialog();
  const [tiers, setTiers] = useState(null);     // null = loading
  const [staff, setStaff] = useState([]);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(0);        // tier id that just saved
  const [addFor, setAddFor] = useState(null);   // tier whose person picker is open
  const [busy, setBusy] = useState(false);
  // Local edits of the name / minutes boxes, keyed by tier id, saved on blur.
  const [draft, setDraft] = useState({});

  const load = useCallback(async () => {
    try {
      const r = await fetchApprovalChain();
      setTiers(r.tiers || []);
      setStaff(r.staff || []);
      setDraft({});
      setErr('');
    } catch (e) {
      log.warn('approval chain load', e?.message);
      setErr(e?.message || 'Could not load the approval chain.');
      setTiers((t) => t || []);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, savedId) => {
    setBusy(true);
    try {
      await fn();
      if (savedId) { setSaved(savedId); setTimeout(() => setSaved((v) => (v === savedId ? 0 : v)), 1500); }
      await load();
    } catch (e) {
      showError("Couldn't save", e?.message || 'Please try again.');
      await load();
    } finally { setBusy(false); }
  };
  const write = (id, vals) => run(() => writeTier(id, vals), id);
  const move = (i, dir) => {
    const list = [...tiers]; const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    run(() => Promise.all(list.map((t, k) => writeTier(t.id, { sequence: (k + 1) * 10 }))));
  };
  const add = () => {
    const last = tiers?.[tiers.length - 1];
    run(() => createTier({ name: 'New step', minutes: 5, sequence: (last?.sequence || 0) + 10 }));
  };
  const del = (t) => confirm({
    title: 'Delete this step?', message: `"${t.name}" is removed from the approval chain.`,
    confirmLabel: 'Delete', destructive: true, tone: 'danger',
    // Not returned: the dialog closes at once, so an error from run() is not
    // wiped by the dialog closing on settle (useAppDialog).
    onConfirm: () => { run(() => deleteTier(t.id)); },
  });
  const removePerson = (t, u) => confirm({
    title: 'Remove this person?', message: `${u.name} will no longer be asked at step "${t.name}".`,
    confirmLabel: 'Remove', destructive: true, tone: 'danger',
    onConfirm: () => { write(t.id, { user_ids: [[3, u.id]] }); },
  });

  const person = (id) => staff.find((u) => u.id === id) || { id, name: `#${id}`, number: '', canDecide: false };
  // ⚠ The same person (or the task's manager) on two steps asks the same person
  // twice: the later step adds nothing. Shown in red, not blocked — as the web.
  const list = tiers || [];
  const label = (j) => `step ${j + 1} · ${list[j].name}`;
  const personDup = (i, id) => { const j = list.findIndex((t, k) => k !== i && (t.user_ids || []).includes(id)); return j < 0 ? '' : label(j); };
  const mgrDup = (i) => { if (!list[i].use_task_manager) return ''; const j = list.findIndex((t, k) => k < i && t.use_task_manager); return j < 0 ? '' : label(j); };
  const nameDup = (i) => { const n = (list[i].name || '').trim().toLowerCase(); const j = list.findIndex((t, k) => k !== i && (t.name || '').trim().toLowerCase() === n); return j < 0 ? '' : label(j); };
  const anyDup = list.some((t, i) => mgrDup(i) || nameDup(i) || (t.user_ids || []).some((id) => personDup(i, id)));
  const addIdx = addFor ? list.findIndex((t) => t.id === addFor.id) : -1;

  return (
    <View style={[s.card, { borderLeftColor: '#7C3AED' }]}>
      <View style={s.cardHead}>
        <MaterialCommunityIcons name="account-arrow-right" size={18} color="#7C3AED" />
        <Text style={[s.cardTitle, { flex: 1 }]}>Approval chain</Text>
        {busy ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
        <TouchableOpacity style={s.acAdd} onPress={add} disabled={busy || tiers === null} activeOpacity={0.85}>
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={s.acAddTxt}>Add step</Text>
        </TouchableOpacity>
      </View>
      <View style={s.cardBody}>
        <Text style={[s.hint, { marginTop: 0 }]}>A new client request goes to step 1. If nobody there decides
          within its minutes, the next step is asked, and so on. After the last step it keeps waiting and
          the last step is reminded every 30 minutes. <Text style={{ fontWeight: '800' }}>Nothing is accepted
          automatically.</Text> Each person gets a private WhatsApp link on the number under their name.</Text>

        {tiers === null && <ActivityIndicator style={{ marginTop: 12 }} color={COLORS.primary} />}
        {!!err && <Text style={[s.devInvalid, { marginTop: 10 }]}>{err}</Text>}
        {tiers && !tiers.length && !err && <Text style={[s.hint, { marginTop: 10 }]}>No steps — every manager is asked at once.</Text>}
        {anyDup && (
          <View style={s.acWarn}>
            <Text style={s.acWarnTxt}>⚠ Some people are used on more than one step (marked in red). The same
              person asked twice adds nothing — put someone else on the later step.</Text>
          </View>
        )}

        {list.map((t, i) => {
          const d = draft[t.id] || {};
          const nameVal = d.name != null ? d.name : (t.name || '');
          const minVal = d.minutes != null ? d.minutes : String(t.minutes ?? '');
          return (
            <View key={t.id} style={[s.acTier, (mgrDup(i) || nameDup(i)) && s.acTierDup]}>
              <View style={s.acTop}>
                <View style={s.acNum}><Text style={s.acNumTxt}>{i + 1}</Text></View>
                <TextInput
                  style={[s.input, { flex: 1, height: 40, fontWeight: '800' }]} value={nameVal}
                  onChangeText={(v) => setDraft((x) => ({ ...x, [t.id]: { ...x[t.id], name: v } }))}
                  onEndEditing={() => { const v = nameVal.trim(); if (v && v !== t.name) write(t.id, { name: v }); }}
                />
                <TouchableOpacity style={s.acIcon} disabled={i === 0 || busy} onPress={() => move(i, -1)}>
                  <Ionicons name="arrow-up" size={16} color={i === 0 ? COLORS.faint : COLORS.navy} />
                </TouchableOpacity>
                <TouchableOpacity style={s.acIcon} disabled={i === list.length - 1 || busy} onPress={() => move(i, 1)}>
                  <Ionicons name="arrow-down" size={16} color={i === list.length - 1 ? COLORS.faint : COLORS.navy} />
                </TouchableOpacity>
                <TouchableOpacity style={s.acIcon} disabled={busy} onPress={() => del(t)}>
                  <Ionicons name="trash-outline" size={16} color={COLORS.red} />
                </TouchableOpacity>
              </View>
              {!!nameDup(i) && <Text style={s.acDupTxt}>⚠ Name already used for {nameDup(i)}</Text>}

              <View style={s.acRow2}>
                <TextInput
                  style={[s.input, { width: 70, height: 40 }]} keyboardType="number-pad" value={minVal}
                  onChangeText={(v) => setDraft((x) => ({ ...x, [t.id]: { ...x[t.id], minutes: v.replace(/[^0-9]/g, '') } }))}
                  onEndEditing={() => { const v = Math.max(1, parseInt(minVal, 10) || 1); if (v !== t.minutes) write(t.id, { minutes: v }); else setDraft((x) => ({ ...x, [t.id]: { ...x[t.id], minutes: undefined } })); }}
                />
                <Text style={s.unit}>min</Text>
                <View style={{ flex: 1 }} />
                <Text style={[s.devSmall, { marginRight: 4 }]}>Task's manager</Text>
                <Switch
                  value={!!t.use_task_manager}
                  onValueChange={(v) => write(t.id, { use_task_manager: v })}
                  trackColor={{ true: COLORS.primary }}
                />
                {saved === t.id && <Text style={s.savedTick}>✓</Text>}
              </View>

              <View style={s.acPeople}>
                {(t.user_ids || []).map((id) => {
                  const u = person(id);
                  const dup = personDup(i, id);
                  return (
                    <View key={id} style={[s.acPerson, dup && s.acPersonDup]}>
                      <View style={{ flexShrink: 1 }}>
                        <Text style={s.acPersonName} numberOfLines={1}>{u.name}</Text>
                        <Text style={s.acPersonNum}>{u.number || 'no WhatsApp number'}</Text>
                        {!!dup && <Text style={s.acDupTxt}>⚠ Already used for {dup}</Text>}
                      </View>
                      <TouchableOpacity onPress={() => removePerson(t, u)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close" size={15} color={COLORS.muted} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
                {(t.use_task_manager || !(t.user_ids || []).length) && (
                  <View style={[s.acMgr, mgrDup(i) && s.acPersonDup]}>
                    <Text style={s.acMgrTxt}>
                      {t.use_task_manager ? "the task's manager\nfrom the task"
                        : "Nobody yet — add a person\nuntil then it asks the task's manager"}
                    </Text>
                    {!!mgrDup(i) && <Text style={s.acDupTxt}>⚠ Already used for {mgrDup(i)}</Text>}
                  </View>
                )}
                <TouchableOpacity style={s.acAddPerson} onPress={() => setAddFor(t)} disabled={busy} activeOpacity={0.85}>
                  <Text style={s.acAddPersonTxt}>+ Add person</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </View>

      {/* Person picker for one step. Only admins / coordinators can decide, so
          they are listed first; anyone already on another step is marked. */}
      <Modal visible={!!addFor} transparent animationType="fade" onRequestClose={() => setAddFor(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setAddFor(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle} numberOfLines={1}>Add to “{addFor?.name || ''}”</Text>
              <TouchableOpacity onPress={() => setAddFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={staff
                .filter((u) => addFor && !(addFor.user_ids || []).includes(u.id))
                .sort((a, b) => (b.canDecide - a.canDecide) || a.name.localeCompare(b.name))}
              keyExtractor={(u) => String(u.id)}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={[s.hint, { padding: 20 }]}>Everyone is already on this step.</Text>}
              renderItem={({ item: u }) => {
                const dup = addIdx >= 0 ? personDup(addIdx, u.id) : '';
                return (
                  <TouchableOpacity
                    style={s.ccRow} activeOpacity={0.8}
                    onPress={() => { const t = addFor; setAddFor(null); write(t.id, { user_ids: [[4, u.id]] }); }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[s.ccRowName, dup && { color: '#DC2626' }]}>{u.name}</Text>
                      <Text style={s.ccRowMeta}>
                        {u.number || 'no WhatsApp number'}{u.canDecide ? '' : ' · cannot decide'}
                        {dup ? ` — ⚠ already used for ${dup}` : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      {dialog}
    </View>
  );
}
