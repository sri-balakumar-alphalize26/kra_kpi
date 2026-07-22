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
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image, ScrollView, Dimensions,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import PairArt from '../components/PairArt';
import { createLogger } from '../api/logger';
import { generatePin, pairingStatus } from '../services/pairing';

const log = createLogger('StartWorking');
const { width: SW } = Dimensions.get('window');
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
  // "Not now — keep browsing" is the last thing on the page, so the content has
  // to clear the phone's nav/gesture bar or it sits under it. SafeAreaProvider is
  // already set up in App.js for exactly this (see components/TabBar.js).
  const insets = useSafeAreaInsets();
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('start');   // 'start' | 'resume'
  const [done, setDone] = useState(false);      // developer already ended today → no PIN
  const [expiresAt, setExpiresAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => 0);
  const [cooldownUntil, setCooldownUntil] = useState(0); // regen cooldown end (ms)
  const pollRef = useRef(null);
  const genSeq = useRef(0);                               // latest-generate-wins guard
  const onPairedRef = useRef(onPaired);
  useEffect(() => { onPairedRef.current = onPaired; }, [onPaired]);

  // Generate a PIN. Race-safe: if a newer makePin() call started while this one
  // was in flight, its (older, now server-expired) result is discarded so the
  // displayed PIN is always the current server one.
  const makePin = useCallback(async () => {
    const seq = ++genSeq.current;
    setLoading(true);
    try {
      const res = await generatePin();
      if (seq !== genSeq.current) return;   // superseded → ignore stale result
      // done = developer already ended their workday today (one start + one end
      // per day). No PIN is issued; show the "ended for today" state instead.
      if (res.done) { setDone(true); setPin(''); setExpiresAt(null); return; }
      setDone(false);
      setPin(res.pin);
      setMode(res.mode || 'start');
      setExpiresAt(res.expires_at);
    } catch (e) {
      log.warn('generatePin failed', e?.message);
    } finally {
      if (seq === genSeq.current) setLoading(false);
    }
  }, []);

  // Manual "Regenerate" → 10s cooldown so it can't be spammed.
  const onRegen = useCallback(() => {
    if (Date.now() < cooldownUntil) return;
    setCooldownUntil(Date.now() + 10000);
    makePin();
  }, [cooldownUntil, makePin]);

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
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));

  const left = secondsLeft(expiresAt, nowMs);
  const expired = left === 0;
  const mm = left != null ? String(Math.floor(left / 60)).padStart(1, '0') : null;
  const ss = left != null ? String(left % 60).padStart(2, '0') : null;

  // Auto-regenerate the moment the PIN expires (once per cycle) so the user
  // never has to tap Regenerate. The race guard in makePin keeps it consistent.
  const autoRegenRef = useRef(false);
  useEffect(() => {
    if (done) return;                 // ended for today → nothing to regenerate
    if (expired && expiresAt && !loading) {
      if (!autoRegenRef.current) { autoRegenRef.current = true; makePin(); }
    } else if (!expired) {
      autoRegenRef.current = false;   // fresh PIN → arm for the next expiry
    }
  }, [done, expired, expiresAt, loading, makePin]);

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
        ) : null}
        <View style={{ flex: 1 }} />
        {onLogout ? (
          <TouchableOpacity onPress={onLogout} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="log-out-outline" size={22} color={COLORS.muted} />
          </TouchableOpacity>
        ) : <View style={s.iconBtn} />}
      </View>

      {/* Math.max(insets.bottom, 12): devices with hardware buttons report a
          bottom inset of 0, and the button still needs breathing room there. */}
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingBottom: 28 + Math.max(insets.bottom, 12) }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Brand header */}
        <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />
        <Text style={s.brandTitle}>{done ? 'Workday ended for today' : resume ? 'Continue Working' : 'Start Working'}</Text>
        <Text style={s.brandSub}>
          {done
            ? "You've finished your workday today. Come back tomorrow to start a new one."
            : resume
              ? 'Pair your phone to your computer to resume your paused task.'
              : 'Pair your phone to your computer to start timing.'}
        </Text>

        {/* Phone → computer pairing illustration (hidden once the day is done) */}
        {!done && <PairArt width={SW * 0.6} height={SW * 0.6 * (190 / 300)} />}

        {/* PIN card — or the "ended for today" card once the day is done */}
        <View style={s.card}>
          {done ? (
            <>
              <View style={[s.iconCircle, { backgroundColor: '#E9F7EF' }]}>
                <Ionicons name="checkmark-done" size={40} color="#12B76A" />
              </View>
              <Text style={s.cardTitle}>Workday ended for today</Text>
              <Text style={s.cardSub}>
                You already started and ended your workday today. It's one workday
                per day — you can start a fresh one tomorrow.
              </Text>
            </>
          ) : (
            <>
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
                    <Text style={[s.expiry, { color: COLORS.amber }]}>Refreshing PIN…</Text>
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

              <TouchableOpacity
                style={[s.regenBtn, cooldownLeft > 0 && { opacity: 0.5 }]}
                onPress={onRegen}
                disabled={cooldownLeft > 0}
                activeOpacity={0.85}
              >
                <Ionicons name="refresh" size={16} color={COLORS.muted} />
                <Text style={s.regenTxt}>
                  {cooldownLeft > 0 ? `Regenerate in ${cooldownLeft}s` : 'Regenerate PIN'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* How it works (hidden once the day is done) */}
        {!done && <View style={s.steps}>
          <View style={s.stepRow}>
            <View style={s.stepNum}><Text style={s.stepNumTxt}>1</Text></View>
            <Text style={s.stepTxt}>Open the KPI Action Board on your computer's browser.</Text>
          </View>
          <View style={s.stepRow}>
            <View style={s.stepNum}><Text style={s.stepNumTxt}>2</Text></View>
            <Text style={s.stepTxt}>Type this PIN there to pair your phone.</Text>
          </View>
          <View style={s.stepRow}>
            <View style={s.stepNum}><Text style={s.stepNumTxt}>3</Text></View>
            <Text style={s.stepTxt}>You're working — timing runs on the computer.</Text>
          </View>
        </View>}

        {/* A way out. Someone who tapped Start Workday by mistake — or who isn't
            at their computer yet — must not be stranded here. Nothing has started:
            only a verified PIN opens the workday, so leaving costs nothing. */}
        {onBack ? (
          <TouchableOpacity style={s.notNowBtn} onPress={onBack} activeOpacity={0.85}>
            <Ionicons name="eye-outline" size={16} color={COLORS.muted} />
            <Text style={s.notNowTxt}>Not now — keep browsing</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  notNowBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    alignSelf: 'center', marginTop: 18, paddingVertical: 11, paddingHorizontal: 18,
    borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E2E8F0',
  },
  notNowTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 13.5 },
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  scroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 30 },
  logo: { width: 168, height: 90, alignSelf: 'center', marginTop: 2, marginBottom: 4 },
  brandTitle: { fontSize: 22, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  brandSub: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', marginTop: 6, marginBottom: 6, paddingHorizontal: 16, lineHeight: 19 },

  card: { width: '100%', backgroundColor: '#fff', borderRadius: 18, padding: 24, alignItems: 'center', marginTop: 6, ...SHADOW },

  steps: { alignSelf: 'stretch', marginTop: 22, gap: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  stepNumTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  stepTxt: { flex: 1, fontSize: 13, color: COLORS.navy, lineHeight: 18 },
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
