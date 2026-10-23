// Flat "secure login" illustration (SVG) — a phone with a shield + check, a lock
// badge and decorative circles, in the app's navy/blue palette. Crisp at any
// size; no image asset needed. Swap for a supplied illustration later if wanted.
import React from 'react';
import Svg, { Circle, Ellipse, Rect, Path } from 'react-native-svg';

const NAVY = '#1F3B57';
const BLUE = '#2E6FE0';
const LIGHT = '#DCE7F5';

export default function LoginArt({ width = 240, height = 176 }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 300 220" fill="none">
      {/* backdrop circles */}
      <Circle cx="150" cy="104" r="94" fill={NAVY} opacity="0.06" />
      <Circle cx="250" cy="44" r="12" fill={BLUE} opacity="0.35" />
      <Circle cx="46" cy="58" r="8" fill={NAVY} opacity="0.3" />
      <Circle cx="40" cy="166" r="15" fill={BLUE} opacity="0.14" />
      <Circle cx="262" cy="172" r="9" fill={NAVY} opacity="0.22" />

      {/* soft shadow under the phone */}
      <Ellipse cx="150" cy="198" rx="72" ry="10" fill={NAVY} opacity="0.08" />

      {/* phone */}
      <Rect x="112" y="28" width="76" height="160" rx="16" fill="#ffffff" stroke={NAVY} strokeWidth="3" />
      <Rect x="122" y="45" width="56" height="120" rx="8" fill={LIGHT} />
      <Rect x="139" y="36" width="22" height="5" rx="2.5" fill={NAVY} opacity="0.35" />

      {/* shield + check on the screen */}
      <Path d="M150 64 l22 8 v18 c0 17 -11 27 -22 32 c-11 -5 -22 -15 -22 -32 v-18 z" fill={BLUE} />
      <Path d="M140 96 l7 7 l14 -15" stroke="#ffffff" strokeWidth="3.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />

      {/* password dots */}
      <Circle cx="138" cy="140" r="4" fill={NAVY} opacity="0.4" />
      <Circle cx="150" cy="140" r="4" fill={NAVY} opacity="0.4" />
      <Circle cx="162" cy="140" r="4" fill={NAVY} opacity="0.4" />

      {/* floating lock badge */}
      <Circle cx="214" cy="92" r="21" fill={BLUE} />
      <Rect x="205" y="91" width="18" height="14" rx="3" fill="#ffffff" />
      <Path d="M208 91 v-3.5 a6 6 0 0 1 12 0 v3.5" stroke="#ffffff" strokeWidth="2.6" fill="none" />
      <Circle cx="214" cy="98" r="2.2" fill={BLUE} />
    </Svg>
  );
}
