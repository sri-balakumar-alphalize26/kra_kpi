// ScreenTransition — a subtle fade + slide-in played whenever the visible screen
// changes. App.js renders one of these around the current screen and passes the
// route name as `screenKey`; each time it changes the new screen animates in.
// Uses the built-in Animated (native driver) — no extra dependency — so it works
// the same for every screen and every role.
import React, { useRef, useEffect } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

export default function ScreenTransition({ screenKey, children, style }) {
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    anim.setValue(0);
    const a = Animated.timing(anim, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [screenKey, anim]);

  const animatedStyle = {
    opacity: anim,
    transform: [
      { translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) },
    ],
  };

  return (
    <Animated.View style={[styles.fill, animatedStyle, style]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Base colour matches the app shell so the fade-in never flashes white.
  fill: { flex: 1, backgroundColor: '#EEF2FB' },
});
