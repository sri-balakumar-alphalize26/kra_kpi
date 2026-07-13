// START WORKING — the phone is the "key" that unlocks task-timing on the web.
// The app generates a fresh PIN; the developer opens the KPI Action Board on
// their computer and types this PIN to pair + start their workday. The app
// polls until the web confirms, then shows the "you're working" state.
//
// Why this exists: a phone can't reliably tell if someone is actually working
// (they can lock/off it anytime). The WEB board can (tab open + heartbeat), so
// timing runs there; the phone is the key + the away notifier.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { generatePin, pairingStatus } from '../services/pairing';

const log = createLogger('StartWorking');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const POLL_MS = 3000;

// Seconds left until `expiresAtIso` (server string), or null if unknown.
function secondsLeft(expiresAtIso, nowMs) {
  if (!expiresAtIso) return null;
  const t = Date.parse(String(expiresAtIso).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((t - nowMs) / 1000));
}

export default function StartWorkingScreen({ onBack, onLogout, onPaired }) {
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('start');   // 'start' | 'resume'
  const [expiresAt, setExpiresAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => 0);
  const pollRef = useRef(null);
  const onPairedRef = useRef(onPaired);
  useEffect(() => { onPairedRef.current = onPaired; }, [onPaired]);

  const makePin = useCallback(async () => {
    setLoading(true);
    try {
      const res = await generatePin();
      setPin(res.pin);
      setMode(res.mode || 'start');
      setExpiresAt(res.expires_at);
    } catch (e) {
      log.warn('generatePin failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: generate the first PIN.
  useEffect(() => {
    makePin();
  }, [makePin]);

  // Clock tick (for the expiry countdown).
  useEffect(() => {
    setNowMs(new Date().getTime());
    const id = setInterval(() => setNowMs(new Date().getTime()), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll pairing status until paired → then hand off to the board.
  useEffect(() => {
    const tick = async () => {
      try {
        const st = await pairingStatus();
        if (st.paired) {
          if (pollRef.current) clearInterval(pollRef.current);
          if (onPairedRef.current) onPairedRef.current();
        }
      } catch (e) { /* keep polling */ }
    };
    pollRef.current = setInterval(tick, POLL_MS);
    tick();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const resume = mode === 'resume';

  const left = secondsLeft(expiresAt, nowMs);
  const expired = left === 0;
  const mm = left != null ? String(Math.floor(left / 60)).padStart(1, '0') : null;
  const ss = left != null ? String(left % 60).padStart(2, '0') : null;

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      {/* Header — back button only when allowed (not for a locked developer). */}
      <View style={[s.header, { paddingTop: TOP }]}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
        ) : <View style={s.iconBtn} />}
        <Text style={s.hTitle} numberOfLines={1}>{resume ? 'Continue Working' : 'Start Working'}</Text>
        {onLogout ? (
          <TouchableOpacity onPress={onLogout} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="log-out-outline" size={22} color={COLORS.muted} />
          </TouchableOpacity>
        ) : <View style={s.iconBtn} />}
      </View>

      <View style={s.body}>
        <View style={s.card}>
          <View style={[s.iconCircle, { backgroundColor: resume ? COLORS.amberBg : '#EAF2FF' }]}>
            <MaterialCommunityIcons name="cellphone-key" size={40} color={resume ? COLORS.amber : COLORS.primary} />
          </View>
          <Text style={s.cardTitle}>
            {resume ? 'Enter this PIN to continue working' : 'Enter this PIN on your computer'}
          </Text>
          <Text style={s.cardSub}>
            {resume
              ? 'You went away and your task was paused. Open the KPI Action Board on your computer and type this PIN to resume.'
              : 'Open the KPI Action Board on your computer\'s web browser and type this PIN to start working.'}
          </Text>

          {loading ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 24 }} />
          ) : (
            <>
              <View style={[s.pinBox, expired && s.pinBoxExpired]}>
                {(pin || '----').split('').map((d, i) => (
                  <View key={i} style={s.pinCell}><Text style={s.pinDigit}>{d}</Text></View>
                ))}
              </View>
              {left != null && !expired && (
                <Text style={s.expiry}>Expires in {mm}:{ss}</Text>
              )}
              {expired && (
                <Text style={[s.expiry, { color: COLORS.red }]}>PIN expired — regenerate below</Text>
              )}
            </>
          )}

          <View style={s.waitRow}>
            <ActivityIndicator size="small" color={COLORS.muted} />
            <Text style={s.waitTxt}>Waiting for you to enter it on the computer…</Text>
          </View>

          {/* Computer-only note — NOT a tap-to-open button. The board must be
              opened on the computer's browser; opening it on the phone is blocked. */}
          <View style={s.noteBox}>
            <MaterialCommunityIcons name="monitor" size={18} color={COLORS.amber} />
            <Text style={s.noteTxt}>Open the KPI Action Board on your <Text style={{ fontWeight: '800' }}>computer's</Text>
              {' '}web browser and enter this PIN. It won't work if opened on this phone.</Text>
          </View>

          <TouchableOpacity style={s.regenBtn} onPress={makePin} activeOpacity={0.85}>
            <Ionicons name="refresh" size={16} color={COLORS.muted} />
            <Text style={s.regenTxt}>Regenerate PIN</Text>
          </TouchableOpacity>
        </View>
      </View>
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

  body: { flex: 1, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 24, alignItems: 'center', ...SHADOW },
  iconCircle: { width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },

  cardTitle: { fontSize: 18, fontWeight: '800', color: COLORS.navy, textAlign: 'center' },
  cardSub: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', marginTop: 8, lineHeight: 19 },

  pinBox: { flexDirection: 'row', gap: 10, marginTop: 22 },
  pinBoxExpired: { opacity: 0.4 },
  pinCell: {
    width: 52, height: 64, borderRadius: 12, backgroundColor: '#F0F5FF',
    borderWidth: 2, borderColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  pinDigit: { fontSize: 34, fontWeight: '900', color: COLORS.navy },
  expiry: { fontSize: 12.5, color: COLORS.muted, marginTop: 10, fontWeight: '600' },

  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20 },
  waitTxt: { fontSize: 12.5, color: COLORS.muted },

  noteBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 20,
    backgroundColor: COLORS.amberBg, borderRadius: 12, padding: 12, alignSelf: 'stretch',
  },
  noteTxt: { flex: 1, fontSize: 12.5, color: COLORS.amber, lineHeight: 18 },

  regenBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, paddingVertical: 6 },
  regenTxt: { fontSize: 13, color: COLORS.muted, fontWeight: '600' },
});
