// AttendanceBubble — the floating button bottom-right of Home, like a website's
// chat widget. Tapping it opens the Attendance screen.
//
// Purely presentational: Home decides whether it exists at all (the admin's
// company-wide switch, read through /kpi_attendance/status) and what colour
// the dot is. The dot is the day's status at a glance — green present, amber
// late / half day, red absent, grey not checked in — and the ring breathes
// while the day is still open, the same 650ms pulse PulseDot and AlarmScreen
// use, so "it's beating" reads as "you're on the clock" everywhere.
//
// Transform + opacity only, useNativeDriver: true, like every other animation
// here. Sits ABOVE TabBar (which is ~84px tall with its padding) so it never
// covers the Home / Profile / Logout pills.

import React, { useEffect, useRef } from 'react';
import { View, TouchableOpacity, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';

// TabBar: 8 top padding + 67 bar + max(inset, 8) + 8 bottom. 92 clears it
// with a little air; the safe-area inset is added on top, as TabBar does.
const TAB_BAR_CLEARANCE = 92;

export default function AttendanceBubble({ dotColor = '#9CA3AF', pulsing = false, onPress, bottom }) {
  const insets = useSafeAreaInsets();
  const offset = bottom ?? (TAB_BAR_CLEARANCE + Math.max(insets.bottom, 8));
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulsing) { pulse.setValue(0); return undefined; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulsing, pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: offset }]}>
      {pulsing ? (
        <Animated.View pointerEvents="none" style={[s.ring, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
      ) : null}
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={s.btn}
        accessibilityRole="button"
        accessibilityLabel="Attendance"
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <MaterialCommunityIcons name="calendar-check" size={26} color="#fff" />
        <View style={[s.dot, { backgroundColor: dotColor }]} />
      </TouchableOpacity>
    </View>
  );
}

const SIZE = 56;

const s = StyleSheet.create({
  wrap: { position: 'absolute', right: 18, width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: COLORS.primary },
  btn: {
    width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.primary, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  // On the rim, ringed in white so it reads against the blue whatever colour it is.
  dot: { position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: 7, borderWidth: 2.5, borderColor: '#fff' },
});
