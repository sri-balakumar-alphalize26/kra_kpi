// Two mild arrows on the top connector line: both START at the centre-top and
// diverge — one flows LEFT (toward KRA), one flows RIGHT (toward KPI).
import React, { useRef, useEffect } from 'react';
import { Animated, Easing, StyleSheet, View, Dimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const { width: SW } = Dimensions.get('window');
const k = SW / 1283;                 // image-px → screen-px
const FLOW = '#2BB673';
const SZ = 15;

// Both START at centre-top, ride the dotted bracket to KRA / KPI, then curve IN
// and END at the person (KRA → person, KPI → person):
const A1 = [
  { x: 640, y: 378, r: 180, t: 0.00 },  // centre-top
  { x: 452, y: 378, r: 180, t: 0.18 },  // left across the top
  { x: 210, y: 378, r: 90,  t: 0.40 },  // top-left corner
  { x: 210, y: 600, r: 90,  t: 0.62 },  // down left rail → KRA
  { x: 270, y: 700, r: 40,  t: 0.80 },  // turn in toward the person
  { x: 450, y: 730, r: 5,   t: 1.00 },  // into the person (pointing right)
];
const A2 = [
  { x: 640,  y: 378, r: 0,   t: 0.00 }, // centre-top
  { x: 795,  y: 378, r: 0,   t: 0.18 }, // right across the top
  { x: 1090, y: 378, r: 90,  t: 0.40 }, // top-right corner
  { x: 1090, y: 600, r: 90,  t: 0.62 }, // down right rail → KPI
  { x: 1000, y: 660, r: 140, t: 0.80 }, // turn in toward the person
  { x: 760,  y: 610, r: 178, t: 1.00 }, // into the person (pointing left)
];

const build = (A) => ({
  ts: A.map((p) => p.t),
  xs: A.map((p) => p.x * k - SZ / 2),
  ys: A.map((p) => p.y * k - SZ / 2),
  rs: A.map((p) => `${p.r}deg`),
});
const a1 = build(A1), a2 = build(A2);

function Chevron() {
  return (
    <Svg width={SZ} height={SZ} viewBox="0 0 16 16">
      <Path d="M4 3 L11 8 L4 13" stroke={FLOW} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function FlowOverlay() {
  const flow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.timing(flow, { toValue: 1, duration: 3400, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
    ).start();
  }, []);

  const fade = { inputRange: [0, 0.12, 0.82, 1], outputRange: [0, 0.55, 0.55, 0] };
  const arrow = (a) => ({
    opacity: flow.interpolate(fade),
    transform: [
      { translateX: flow.interpolate({ inputRange: a.ts, outputRange: a.xs }) },
      { translateY: flow.interpolate({ inputRange: a.ts, outputRange: a.ys }) },
      { rotate: flow.interpolate({ inputRange: a.ts, outputRange: a.rs }) },
    ],
  });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[st.a, arrow(a1)]}><Chevron /></Animated.View>
      <Animated.View style={[st.a, arrow(a2)]}><Chevron /></Animated.View>
    </View>
  );
}

const st = StyleSheet.create({ a: { position: 'absolute' } });
