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
  fetchConfig, setAway, setUrgentNudge, setCountry, setMultitask, setDevWa,
  setClientApproval, setQueueNudge,
} from '../services/config';

const log = createLogger('ConfigurationScreen');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

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
  const [urgentNudge, setUrgentNudgeVal] = useState('5');
  const [countryId, setCountryId] = useState(false);
  const [dial, setDial] = useState('91');
  const [mobileLength, setMobileLength] = useState(10);
  const [countries, setCountries] = useState([]);
  const [developers, setDevelopers] = useState([]);
  const [pickCountry, setPickCountry] = useState(false);
  const [savedFlash, setSavedFlash] = useState('');

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
      setUrgentNudgeVal(String(c.urgent_nudge_minutes));
      setDial(c.country_dial_code);
      setMobileLength(c.mobile_length);
      setCountryId(c.country_id);
      setCountries(c.countries);
      setDevelopers(c.developers);
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
  const saveUrgentNudge = async () => {
    const v = Math.max(1, parseInt(urgentNudge) || 5);
    setUrgentNudgeVal(String(v));
    try { await setUrgentNudge(v); flash('urgentNudge'); }
    catch (e) { log.warn('saveUrgentNudge', e?.message); }
  };
  const chooseCountry = async (co) => {
    setPickCountry(false);
    setCountryId(co.id);
    try {
      const res = await setCountry(co.id);
      if (res?.status) {
        const nd = String(res.dial || '91');
        const nl = Number(res.mobile_length) || 10;
        setDial(nd); setMobileLength(nl);
        setDevelopers((list) => list.map((d) => ({ ...d, _wa: toLocal(d.wa_number, nd, nl) })));
        flash('country');
      }
    } catch (e) { log.warn('setCountry', e?.message); }
  };
  const toggleDev = async (dev) => {
    const next = !dev.allow_multitask;
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, allow_multitask: next } : d)));
    try { await setMultitask(dev.id, next); } catch (e) { log.warn('toggleDev', e?.message); }
  };
  const saveDevWa = async (dev, text) => {
    const local = toLocal(text, dial, mobileLength);
    setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _wa: local } : d)));
    try {
      const res = await setDevWa(dev.id, local);
      const stored = res?.wa_number != null ? res.wa_number : (local ? dial + local : '');
      setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, wa_number: stored, _saved: true } : d)));
      setTimeout(() => setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _saved: false } : d))), 1400);
    } catch (e) { log.warn('saveDevWa', e?.message); }
  };

  const countryName = (() => {
    const c = countries.find((x) => x.id === countryId);
    return c ? `${c.name} (+${c.phone_code})` : '— Select —';
  })();

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

          {/* 1. Country & Mobile Format */}
          <Card color="#16a34a" iconLib="mc" icon="earth" title="Country & Mobile Format">
            <Text style={s.label}>Country</Text>
            <TouchableOpacity style={s.select} onPress={() => setPickCountry(true)} activeOpacity={0.8}>
              <Text style={s.selectTxt}>{countryName}</Text>
              <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
            </TouchableOpacity>
            <View style={s.row2}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Dial code</Text>
                <View style={s.readBox}><Text style={s.readTxt}>+{dial}</Text></View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Digits</Text>
                <View style={s.readBox}><Text style={s.readTxt}>{mobileLength}</Text></View>
              </View>
              {savedFlash === 'country' && <Text style={s.savedTick}>✓</Text>}
            </View>
            <Text style={s.hint}>Applies to every WhatsApp number below — the +{dial} prefix is added
              automatically and numbers are limited to {mobileLength} digits.</Text>
          </Card>

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
                {/* Line 2: full-width WhatsApp number */}
                <View style={s.devWaRow}>
                  <View style={s.dialBadgeSm}><Text style={s.dialBadgeSmTxt}>+{dial}</Text></View>
                  <TextInput
                    style={s.devWaInput} keyboardType="phone-pad" maxLength={mobileLength}
                    placeholder={`WhatsApp number — ${mobileLength} digits`} placeholderTextColor={COLORS.faint}
                    value={dev._wa != null ? dev._wa : toLocal(dev.wa_number, dial, mobileLength)}
                    onChangeText={(t) => setDevelopers((list) => list.map((d) => (d.id === dev.id ? { ...d, _wa: toLocal(t, dial, mobileLength) } : d)))}
                    onEndEditing={(e) => saveDevWa(dev, e.nativeEvent.text)}
                  />
                  {dev._saved && <Text style={s.devSavedInline}>✓</Text>}
                </View>
              </View>
            ))}
          </Card>
        </ScrollView>
      )}

      {/* Country picker */}
      <Modal visible={pickCountry} transparent animationType="fade" onRequestClose={() => setPickCountry(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPickCountry(false)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Select country</Text>
              <TouchableOpacity onPress={() => setPickCountry(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={countries}
              keyExtractor={(c) => String(c.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = item.id === countryId;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} onPress={() => chooseCountry(item)} activeOpacity={0.8}>
                    <Text style={s.ccRowName}>{item.name}</Text>
                    <Text style={s.ccRowMeta}>+{item.phone_code}</Text>
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
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
  dialBadgeSm: { backgroundColor: '#F1F4F9', borderWidth: 1, borderColor: COLORS.line, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, paddingHorizontal: 10, height: 44, justifyContent: 'center' },
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
