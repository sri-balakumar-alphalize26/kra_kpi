// Full-screen ringing-alarm UI. Shown when a task alarm fires (services/alarm.js
// launches the app full-screen — even on the lock screen — via a full-screen
// intent). Looks like a real alarm clock: a big live time + date, and the task it
// is ringing about (the reason). It keeps ringing/looping in the OS until the user
// taps STOP here, which cancels the notification (stopping the loop) and opens the
// task. Snooze re-rings in 5 minutes. Android-only in practice.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GradientBackground from '../components/GradientBackground';
import { getAlarmSettings } from '../api/session';
import { createLogger } from '../api/logger';

const log = createLogger('AlarmScreen');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "5 min" / "1 hr" / "1 hr 30 min" from a minute count.
export function fmtDur(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

// Live wall clock → { time: "10:45", ap: "AM", date: "Fri, 18 Jul" }. Ticks every
// 15s (a minute clock only needs to be roughly live; a fired alarm rarely stays up).
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);
  const h = now.getHours();
  const hh = ((h + 11) % 12) + 1;
  return {
    time: `${hh}:${String(now.getMinutes()).padStart(2, '0')}`,
    ap: h < 12 ? 'AM' : 'PM',
    date: `${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`,
  };
}

export default function AlarmScreen({ alarm, onStop, onSnooze }) {
  const task = alarm?.task || {};
  const { time, ap, date } = useClock();

  // Alarm behaviour (ring length + snooze) from the user's settings. onStop is kept
  // in a ref so the auto-dismiss timer isn't reset by parent re-renders.
  const [settings, setSettings] = useState({ ringMins: 5, snoozeMins: 5 });
  const onStopRef = useRef(onStop);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);
  useEffect(() => {
    log.info('screen: shown', { taskId: alarm?.task?.id, notifId: alarm?.notifId });
    let alive = true;
    getAlarmSettings().then((s) => { if (alive) { setSettings(s); log.info('screen: settings loaded', s); } }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Auto-dismiss the Stop screen once the ring duration elapses (0 = wait for Stop).
  useEffect(() => {
    if (!settings.ringMins || settings.ringMins <= 0) { log.info('screen: no auto-off (rings until Stop)'); return undefined; }
    log.info('screen: auto-off armed', { ringMins: settings.ringMins });
    const id = setTimeout(() => {
      log.info('screen: auto-off fired — silencing alarm', { ringMins: settings.ringMins });
      if (onStopRef.current) onStopRef.current();
    }, settings.ringMins * 60000);
    return () => clearTimeout(id);
  }, [settings.ringMins]);

  // A slow breathing pulse on the bell — signals "this is live / ringing".
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.16] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.85] });

  return (
    <View style={styles.root}>
      <GradientBackground />
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}>
          {/* Ringing bell */}
          <Animated.View style={[styles.bellWrap, { transform: [{ scale }], opacity: glow }]}>
            <Text style={styles.bell}>⏰</Text>
          </Animated.View>

          {/* Hero time + date — the alarm-clock look */}
          <View style={styles.timeRow}>
            <Text style={styles.time}>{time}</Text>
            <Text style={styles.ap}>{ap}</Text>
          </View>
          <Text style={styles.date}>{date}</Text>

          <Text style={styles.title}>⏰ Time to wrap up</Text>

          {/* The reason it's ringing: this task */}
          <View style={styles.reasonCard}>
            <Text style={styles.reasonLabel}>REMINDER FOR</Text>
            <Text style={styles.taskName} numberOfLines={3}>{task?.name || 'Your task'}</Text>
          </View>
          <Text style={styles.sub}>Your set time for this task is up.</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={onStop}
            style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
            android_ripple={{ color: '#ffffff33', borderless: false }}
          >
            <Text style={styles.stopTxt}>■  STOP</Text>
          </Pressable>
          <Pressable
            onPress={onSnooze}
            style={({ pressed }) => [styles.snoozeBtn, pressed && styles.pressed]}
            android_ripple={{ color: '#1E40AF22', borderless: false }}
          >
            <Text style={styles.snoozeTxt}>Snooze {fmtDur(settings.snoozeMins)}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  safe: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 26, paddingVertical: 22 },
  top: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bellWrap: {
    width: 108, height: 108, borderRadius: 54, backgroundColor: '#1E40AF',
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  bell: { fontSize: 52 },
  // Hero time
  timeRow: { flexDirection: 'row', alignItems: 'flex-start' },
  time: { fontSize: 76, fontWeight: '900', color: '#0F1F4D', letterSpacing: 1, lineHeight: 82 },
  ap: { fontSize: 24, fontWeight: '800', color: '#1E3A8A', marginTop: 12, marginLeft: 6 },
  date: { fontSize: 16, fontWeight: '700', color: '#4B5B7A', marginTop: 2, marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '800', color: '#1E40AF', marginBottom: 14 },
  // Reason card
  reasonCard: {
    width: '100%', backgroundColor: '#FFFFFF', borderRadius: 16, paddingVertical: 16, paddingHorizontal: 18,
    borderWidth: 1.5, borderColor: '#C7DDF7', alignItems: 'center',
  },
  reasonLabel: { fontSize: 11, fontWeight: '800', color: '#7C8DB0', letterSpacing: 1.5, marginBottom: 6 },
  taskName: { fontSize: 21, fontWeight: '800', color: '#0F1F4D', textAlign: 'center' },
  sub: { fontSize: 14.5, color: '#4B5B7A', marginTop: 12, textAlign: 'center' },
  actions: { gap: 14 },
  stopBtn: {
    backgroundColor: '#DC2626', paddingVertical: 20, borderRadius: 20, alignItems: 'center',
    shadowColor: '#DC2626', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  stopTxt: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 1 },
  snoozeBtn: {
    backgroundColor: '#FFFFFF', paddingVertical: 16, borderRadius: 18, alignItems: 'center',
    borderWidth: 1.5, borderColor: '#C7DDF7',
  },
  snoozeTxt: { color: '#1E40AF', fontSize: 17, fontWeight: '700' },
  pressed: { opacity: 0.85 },
});
