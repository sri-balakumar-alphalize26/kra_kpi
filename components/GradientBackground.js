// Shared app background — the light-blue gradient from the KRA/KPI Master screen.
// Drop <GradientBackground/> as the FIRST child of a screen's root View (which
// should be transparent), so every page shares one consistent backdrop.
import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';

// The two brand background stops (top → bottom).
export const BG_TOP = '#EAF2FF';
export const BG_BOTTOM = '#C7DDF7';

export default function GradientBackground() {
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <LinearGradient id="appBg" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor={BG_TOP} />
          <Stop offset="1" stopColor={BG_BOTTOM} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#appBg)" />
    </Svg>
  );
}
