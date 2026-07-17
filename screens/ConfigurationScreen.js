// CONFIGURATION — mobile port of the Odoo web "Configuration" screen
// (kpi_configuration.js). Four sections, all auto-save:
//   1. Country & Mobile Format — country picker → dial code + digit length
//   2. Timers & Away — away-after minutes
//   3. Urgent-pause recipients — extra WhatsApp numbers (local, dial added)
//   4. Developers — Multi-task toggle + per-dev WhatsApp number
// Admin-only (opened from a Home Quick Action tile).
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch,
  ActivityIndicator, Modal, FlatList, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import {
  fetchConfig, setAway, setUrgentNudge, setUserCountry, setMultitask, setDevWa,
  setClientApproval, setQueueNudge, setStandardHours,
  setSnapshotRetention, setReportRetention, setDailyReport,
} from '../services/config';

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

export default function ConfigurationScreen({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);
  const [away, setAwayVal] = useState('5');
  const [clientApproval, setClientApprovalVal] = useState('5');
  const [queueNudge, setQueueNudgeVal] = useState('30');
  const [standardHours, setStandardHoursVal] = useState('9');
  const [urgentNudge, setUrgentNudgeVal] = useState('5');
  const [countryId, setCountryId] = useState(false);
  const [dial, setDial] = useState('91');
  const [mobileLength, setMobileLength] = useState(10);
  const [countries, setCountries] = useState([]);
  const [developers, setDevelopers] = useState([]);
  const [pickCountryForDev, setPickCountryForDev] = useState(null); // developer whose country is being picked
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

  const flash = useCallback((key) => {
    setSavedFlash(key);
    setTimeout(() => setSavedFlash((k) => (k === key ? '' : k)), 1400);
  }, []);

  const load = useCallback(async () => {
    try {
      const c = await fetchConfig();
      setIsMock(c.isMock);
      setAwayVal(String(c.away_after_minutes));
      setClientApprovalVal(String(c.client_approval_minutes));
      setQueueNudgeVal(String(c.queue_nudge_minutes));
      setStandardHoursVal(String(c.standard_workday_hours ?? 9));
      setUrgentNudgeVal(String(c.urgent_nudge_minutes));
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
    } catch (e) {
      log.warn('load failed', e?.message);
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  // ── Savers ────────────────────────────────────────────────────────────────
  const saveAway = async () => {
    const v = Math.max(1, parseInt(away) || 5);
    setAwayVal(String(v));
    try { await setAway(v); flash('away'); } catch (e) { log.warn('saveAway', e?.message); }
  };
  const saveClientApproval = async () => {
    const v = Math.max(1, parseInt(clientApproval) || 5);
    setClientApprovalVal(String(v));
    try { await setClientApproval(v); flash('clientApproval'); }
    catch (e) { log.warn('saveClientApproval', e?.message); }
  };
  const saveQueueNudge = async () => {
    const v = Math.max(1, parseInt(queueNudge) || 30);
    setQueueNudgeVal(String(v));
    try { await setQueueNudge(v); flash('queueNudge'); }
    catch (e) { log.warn('saveQueueNudge', e?.message); }
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
    try { await setStandardHours(v); flash('standardHours'); }
    catch (e) { log.warn('saveStandardHours', e?.message); }
  };
  const saveUrgentNudge = async () => {
    const v = Math.max(1, parseInt(urgentNudge) || 5);
    setUrgentNudgeVal(String(v));
    try { await setUrgentNudge(v); flash('urgentNudge'); }
    catch (e) { log.warn('saveUrgentNudge', e?.message); }
  };
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
    try { await setSnapshotRetention({ number: n, unit: u }); flash('snapRet'); }
    catch (e) { log.warn('saveSnapRetention', e?.message); }
  };
  const saveRepRetention = async (unitOverride) => {
    const n = Math.max(0, parseInt(repNum) || 0);
    const u = unitOverride || repUnit;
    setRepNum(String(n));
    try { await setReportRetention({ number: n, unit: u }); flash('repRet'); }
    catch (e) { log.warn('saveRepRetention', e?.message); }
  };
  const saveDaily = async (over = {}) => {
    const enabled = over.enabled != null ? over.enabled : dailyEnabled;
    const coverage = over.coverage || dailyCoverage;
    const hour = timeToHour(dailyHH, dailyMM);
    const H = Math.floor(hour);
    setDailyHH(String(H));
    setDailyMM(String(Math.round((hour - H) * 60)).padStart(2, '0'));
    try { await setDailyReport({ enabled, hour, coverage }); flash('daily'); }
    catch (e) { log.warn('saveDaily', e?.message); }
  };
  // Set ONE developer's country (dial + local length). Empty co (id false) clears
  // it back to the company default. The backend re-keys their stored WhatsApp
  // number and may clear it if the old number can't fit the new length.
  const chooseDevCountry = async (dev, co) => {
    setPickCountryForDev(null);
    const cid = co && co.id ? co.id : false;
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, country_id: cid } : d)));
    try {
      const res = await setUserCountry(dev.id, cid);
      if (res?.status) {
        const nd = String(res.dial || dial || '91');
        const nl = Number(res.mobile_length) || mobileLength || 10;
        const wa = res.wa_number != null ? res.wa_number : dev.wa_number;
        setDevelopers((list) => list.map((d) => (d.id === dev.id ? {
          ...d, country_id: res.country_id || false, dial: nd, mobile_length: nl,
          wa_number: wa, _wa: toLocal(wa, nd, nl), _saved: true,
        } : d)));
        setTimeout(() => setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _saved: false } : d))), 1400);
      }
    } catch (e) { log.warn('setDevCountry', e?.message); }
  };
  const toggleDev = async (dev) => {
    const next = !dev.allow_multitask;
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, allow_multitask: next } : d)));
    try { await setMultitask(dev.id, next); } catch (e) { log.warn('toggleDev', e?.message); }
  };
  const saveDevWa = async (dev, text) => {
    const dd = dev.dial || dial, dl = dev.mobile_length || mobileLength;
    const local = toLocal(text, dd, dl);
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _wa: local } : d)));
    try {
      const res = await setDevWa(dev.id, local);
      const stored = res?.wa_number != null ? res.wa_number : (local ? dd + local : '');
      setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, wa_number: stored, _saved: true } : d)));
      setTimeout(() => setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _saved: false } : d))), 1400);
    } catch (e) { log.warn('saveDevWa', e?.message); }
  };

  // Country label for a developer's picker button (their own, or the default).
  const devCountryLabel = (dev) => {
    const c = countries.find((x) => x.id === dev.country_id);
    return c ? `+${c.phone_code}` : `+${dial}`;
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

          {/* 2. Timers & Away */}
          <Card color="#0ea5e9" iconLib="mc" icon="clock-outline" title="Timers & Away">
            <Text style={s.label}>Away after (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={away} onChangeText={setAwayVal} onEndEditing={saveAway}
              />
              <Text style={s.unit}>min</Text>
              {savedFlash === 'away' && <Text style={s.savedTick}>✓</Text>}
            </View>
            <Text style={s.hint}>Minutes with no heartbeat (app closed / device asleep) before a running
              task auto-pauses as "Away". Used by the app and the server.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Client approval window (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={clientApproval} onChangeText={setClientApprovalVal}
                onEndEditing={saveClientApproval}
              />
              <Text style={s.unit}>min</Text>
              {savedFlash === 'clientApproval' && <Text style={s.savedTick}>✓</Text>}
            </View>
            <Text style={s.hint}>How long a client has to approve the developer assigned to their task.
              If they don't respond in time it is approved automatically.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Queue re-nudge gap (minutes)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="number-pad"
                value={queueNudge} onChangeText={setQueueNudgeVal}
                onEndEditing={saveQueueNudge}
              />
              <Text style={s.unit}>min</Text>
              {savedFlash === 'queueNudge' && <Text style={s.savedTick}>✓</Text>}
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
              {savedFlash === 'urgentNudge' && <Text style={s.savedTick}>✓</Text>}
            </View>
            <Text style={s.hint}>When a developer taps 🚨 Urgent while pausing, the owner and admins are
              notified in the app and reminded this often until one of them reads it.</Text>

            <Text style={[s.label, { marginTop: 16 }]}>Standard workday (hours)</Text>
            <View style={s.inlineRow}>
              <TextInput
                style={[s.input, { width: 90 }]} keyboardType="decimal-pad"
                value={standardHours} onChangeText={setStandardHoursVal}
                onEndEditing={saveStandardHours}
              />
              <Text style={s.unit}>h</Text>
              {savedFlash === 'standardHours' && <Text style={s.savedTick}>✓</Text>}
            </View>
            <Text style={s.hint}>A normal working day. The End Workday summary compares it against
              <Text style={{ fontWeight: '800' }}> Presence</Text> (login → logout): at or over reads
              green, under reads red. Presence is wall-clock, so it counts breaks and meetings too —
              the summary shows Productive next to it.</Text>
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
              {savedFlash === 'daily' && <Text style={s.savedTick}>✓</Text>}
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
              {savedFlash === 'snapRet' && <Text style={s.savedTick}>✓</Text>}
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
              {savedFlash === 'repRet' && <Text style={s.savedTick}>✓</Text>}
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
              The WhatsApp number identifies them in Urgent / auto-away messages.</Text>
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
                {/* Line 2: tap the +code to set this developer's country, then the number */}
                <View style={s.devWaRow}>
                  <TouchableOpacity style={s.dialBadgeSm} onPress={() => setPickCountryForDev(dev)} activeOpacity={0.7}>
                    <Text style={s.dialBadgeSmTxt}>{devCountryLabel(dev)}</Text>
                    <Ionicons name="chevron-down" size={12} color={COLORS.muted} style={{ marginLeft: 2 }} />
                  </TouchableOpacity>
                  <TextInput
                    style={s.devWaInput} keyboardType="phone-pad" maxLength={dev.mobile_length || mobileLength}
                    placeholder={`WhatsApp — ${dev.mobile_length || mobileLength} digits`} placeholderTextColor={COLORS.faint}
                    value={dev._wa != null ? dev._wa : toLocal(dev.wa_number, dev.dial || dial, dev.mobile_length || mobileLength)}
                    onChangeText={(t) => setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _wa: toLocal(t, d.dial || dial, d.mobile_length || mobileLength) } : d)))}
                    onEndEditing={(e) => saveDevWa(dev, e.nativeEvent.text)}
                  />
                  {dev._saved && <Text style={s.devSavedInline}>✓</Text>}
                </View>
              </View>
            ))}
          </Card>
        </ScrollView>
      )}

      {/* Per-developer country picker */}
      <Modal visible={!!pickCountryForDev} transparent animationType="fade" onRequestClose={() => setPickCountryForDev(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPickCountryForDev(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle} numberOfLines={1}>Country — {pickCountryForDev?.name || ''}</Text>
              <TouchableOpacity onPress={() => setPickCountryForDev(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={[{ id: false, name: `Default (+${dial})`, phone_code: dial, _default: true }, ...countries]}
              keyExtractor={(c) => String(c.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const cur = pickCountryForDev ? (pickCountryForDev.country_id || false) : false;
                const on = (item.id || false) === cur;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} onPress={() => chooseDevCountry(pickCountryForDev, item)} activeOpacity={0.8}>
                    <Text style={s.ccRowName}>{item.name}</Text>
                    {!item._default && <Text style={s.ccRowMeta}>+{item.phone_code}</Text>}
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
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
});
