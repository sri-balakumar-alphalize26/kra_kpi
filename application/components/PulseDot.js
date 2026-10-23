// PulseDot — the "this is live right now" indicator.
//
// Every live marker in the app used to be a plain <View>: a static coloured
// circle that looked identical whether the data behind it was ticking or three
// hours stale. This gives them one shared heartbeat, so "it's beating" reads as
// "it's live" everywhere without each screen inventing its own animation.
//
// The curve is the breathing pulse from AlarmScreen (650ms in, 650ms out,
// ease-in-out) — this codebase already had exactly one pulse and there was no
// reason for a second. Transform + opacity only, useNativeDriver: true, matching
// every other animation here; no colour is animated, because the native driver
// cannot and dropping to the JS driver would make it stutter under a list.
//
// Renders a static dot when `active` is false, so an offline row costs nothing
// and a stopped heartbeat is itself the signal.

import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, StyleSheet } from 'react-native';

export default function PulseDot({
  size = 9,
  color = '#16A34A',
  idleColor = '#CBD5E1',
  active = true,
  style,
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    // Stopping on unmount matters more than usual here: these live inside a
    // FlatList that recycles rows, so a leaked loop would keep running for a
    // row that is no longer on screen.
    return () => loop.stop();
  }, [pulse, active]);

  const dot = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: active ? color : idleColor,
  };

  if (!active) return <View style={[dot, style]} />;

  // The halo is a second circle behind the dot, scaled and faded by the same
  // value — a ring spreading out rather than the dot itself swelling, which at
  // 9px would just read as a wobble.
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  const dotScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });

  return (
    <View style={[styles.wrap, { width: size, height: size }, style]}>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size / 2, backgroundColor: color },
          { transform: [{ scale: haloScale }], opacity: haloOpacity },
        ]}
      />
      <Animated.View style={[dot, { transform: [{ scale: dotScale }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
