// SPLASH / INTRO — matches the 369 ai.Biz hero mockup. Floating feature cards,
// the 369 logo, a "Track. Analyze. Improve. Grow." headline, the full SMART/KPI
// wheel (spins then settles), and the alphalize logo on a wave. Built for a
// polished intro-video feel, then fades into the login screen.
import React, { useEffect, useRef } from 'react';
import { View, Text, Image, Animated, Easing, StyleSheet, Dimensions, StatusBar as RNStatusBar } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path } from 'react-native-svg';
import { COLORS } from '../theme';

const { width: SW } = Dimensions.get('window');
const TOP = (RNStatusBar.currentHeight || 0);

// SMART segments: colour, label, in-segment icon, centre angle.
const SEG = [
  { label: 'Specific', color: '#F5A623', icon: '⚙️', a: -90 },
  { label: 'Time-bound', color: '#3F3F46', icon: '⏱️', a: -30 },
  { label: 'Relevant', color: '#EC407A', icon: '💡', a: 30 },
  { label: 'Key Performance\nIndicator', color: '#7E57C2', icon: '📊', a: 90, wide: true },
  { label: 'Attainable', color: '#26C6DA', icon: '🎯', a: 150 },
  { label: 'Measurable', color: '#8BC34A', icon: '📏', a: 210 },
];

const WSIZE = Math.min(300, SW - 40);   // wheel container
const C = WSIZE / 2;
const WHEEL = WSIZE * 0.62;             // coloured disc box
const WC = WHEEL / 2;
const R = WC - 4;
const rad = (d) => (Math.PI / 180) * d;

function sector(center) {
  const s = rad(center - 30), e = rad(center + 30);
  const x1 = WC + R * Math.cos(s), y1 = WC + R * Math.sin(s);
  const x2 = WC + R * Math.cos(e), y2 = WC + R * Math.sin(e);
  return `M${WC},${WC} L${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} Z`;
}

// Top floating feature cards (icon + corner position).
const CARDS = [
  { icon: '📈', x: 0.10, y: 0.02 },
  { icon: '📋', x: 0.74, y: 0.10 },
  { icon: '🎯', x: 0.06, y: 0.24 },
  { icon: '👥', x: 0.78, y: 0.30 },
];

export default function SplashScreen({ onDone }) {
  const spin = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const up = useRef(new Animated.Value(0)).current;     // labels/heading rise-in
  const float = useRef(new Animated.Value(0)).current;  // cards gentle float

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    Animated.timing(spin, { toValue: 1, duration: 2600, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    Animated.timing(up, { toValue: 1, delay: 900, duration: 800, useNativeDriver: true }).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    ).start();
    const t = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 500, useNativeDriver: true }).start(() => onDone && onDone());
    }, 4600);
    return () => clearTimeout(t);
  }, [onDone]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '1080deg'] });
  const rise = up.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });

  return (
    <Animated.View style={[s.root, { opacity: fade }]}>
      <StatusBar style="dark" />

      {/* ---------- TOP: floating cards + 369 logo ---------- */}
      <View style={s.top}>
        {CARDS.map((c, i) => (
          <Animated.View
            key={i}
            style={[s.card, { left: c.x * SW, top: TOP + 10 + c.y * 360, transform: [{ translateY: floatY }], opacity: fade }]}
          >
            <Text style={s.cardIcon}>{c.icon}</Text>
          </Animated.View>
        ))}
        <Image source={require('../assets/logo369.png')} style={s.logo369} resizeMode="contain" />
      </View>

      {/* soft wave under the top */}
      <Svg width="100%" height="46" viewBox="0 0 400 46" preserveAspectRatio="none">
        <Path d="M0,20 C90,46 150,4 220,20 C300,40 340,10 400,24 L400,46 L0,46 Z" fill="#DCE6FA" />
      </Svg>

      {/* ---------- HEADLINE ---------- */}
      <Animated.View style={{ alignItems: 'center', opacity: up, transform: [{ translateY: rise }] }}>
        <Text style={s.h1}>Track. Analyze.</Text>
        <Text style={s.h1}>
          <Text style={{ color: '#17A2C4' }}>Improve. </Text>
          <Text style={{ color: '#F5931E' }}>Grow.</Text>
        </Text>
        <View style={s.hUnderline} />
      </Animated.View>

      {/* ---------- KPI WHEEL ---------- */}
      <View style={{ width: WSIZE, height: WSIZE, alignSelf: 'center', marginTop: 8 }}>
        {/* labels with a colour dot */}
        {SEG.map((g) => {
          const lx = C + (WC + 30) * Math.cos(rad(g.a));
          const ly = C + (WC + 30) * Math.sin(rad(g.a));
          const w = g.wide ? 150 : 110;
          return (
            <Animated.View key={g.label} style={[s.labelWrap, { width: w, left: lx - w / 2, top: ly - 16, opacity: up }]}>
              <View style={[s.dot, { backgroundColor: g.color }]} />
              <Text style={[s.label, { color: g.color }]}>{g.label}</Text>
            </Animated.View>
          );
        })}

        {/* spinning disc + icons */}
        <Animated.View style={[s.wheel, { transform: [{ rotate }] }]}>
          <Svg width={WHEEL} height={WHEEL} viewBox={`0 0 ${WHEEL} ${WHEEL}`}>
            {/* soft base shadow so the wheel reads as raised */}
            <Path d={`M${WC},${WC} m-${R},0 a${R},${R} 0 1,0 ${R * 2},0 a${R},${R} 0 1,0 -${R * 2},0`} fill="#C9D6EE" opacity={0.5} />
            {SEG.map((g) => (
              <Path key={g.label} d={sector(g.a)} fill={g.color} stroke="#EEF3FC" strokeWidth={5} strokeLinejoin="round" />
            ))}
          </Svg>
          {SEG.map((g) => {
            const ix = WC + (WC * 0.6) * Math.cos(rad(g.a));
            const iy = WC + (WC * 0.6) * Math.sin(rad(g.a));
            return <Text key={g.label} style={[s.wIcon, { left: ix - 14, top: iy - 15 }]}>{g.icon}</Text>;
          })}
        </Animated.View>

        {/* KPI centre */}
        <View style={s.center} pointerEvents="none">
          <View style={s.centerCircle}><Text style={s.kpi}>KPI</Text></View>
        </View>
      </View>

      {/* ---------- BOTTOM: wave + alphalize ---------- */}
      <View style={s.bottom}>
        <Svg width="100%" height="70" viewBox="0 0 400 70" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
          <Path d="M0,30 C90,70 150,6 220,30 C300,58 340,18 400,34 L400,70 L0,70 Z" fill="#DCE6FA" />
        </Svg>
        <Image source={require('../assets/alphalize.png')} style={s.alpha} resizeMode="contain" />
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EBF1FC' },
  top: { alignItems: 'center', paddingTop: TOP + 18, height: 300, justifyContent: 'center' },
  card: {
    position: 'absolute', width: 54, height: 54, borderRadius: 16, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#334155', shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 4,
  },
  cardIcon: { fontSize: 24 },
  logo369: { width: Math.min(250, SW - 90), height: 175 },

  h1: { fontSize: 25, fontWeight: '900', color: COLORS.navy, textAlign: 'center', lineHeight: 32 },
  hUnderline: { width: 70, height: 4, borderRadius: 2, backgroundColor: '#17A2C4', marginTop: 8 },

  wheel: { position: 'absolute', left: (WSIZE - WHEEL) / 2, top: (WSIZE - WHEEL) / 2, width: WHEEL, height: WHEEL },
  wIcon: { position: 'absolute', fontSize: 22, width: 28, textAlign: 'center' },
  labelWrap: { position: 'absolute', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontSize: 12, fontWeight: '800', textAlign: 'center', lineHeight: 15 },
  center: { position: 'absolute', left: C - WC * 0.42, top: C - WC * 0.42, width: WC * 0.84, height: WC * 0.84, alignItems: 'center', justifyContent: 'center' },
  centerCircle: {
    width: '100%', height: '100%', borderRadius: 999, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#1e293b', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  kpi: { fontSize: 24, fontWeight: '900', color: COLORS.navy, letterSpacing: 1 },

  bottom: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', minHeight: 90 },
  alpha: { width: 180, height: 50, marginBottom: 20 },
});
