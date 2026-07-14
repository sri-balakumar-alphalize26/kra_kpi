// Flat "pair your phone to your computer" illustration (SVG): a phone on the
// left, a monitor on the right, joined by a dotted connector with a key badge
// (the PIN pairing). Navy/blue palette; crisp at any size.
import React from 'react';
import Svg, { Circle, Rect, Path } from 'react-native-svg';

const NAVY = '#1F3B57';
const BLUE = '#2E6FE0';
const LIGHT = '#DCE7F5';

export default function PairArt({ width = 240, height = 152 }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 300 190" fill="none">
      {/* backdrop */}
      <Circle cx="150" cy="96" r="86" fill={NAVY} opacity="0.06" />
      <Circle cx="266" cy="40" r="9" fill={BLUE} opacity="0.3" />
      <Circle cx="32" cy="150" r="12" fill={BLUE} opacity="0.14" />

      {/* phone (left) */}
      <Rect x="30" y="46" width="62" height="108" rx="13" fill="#ffffff" stroke={NAVY} strokeWidth="3" />
      <Rect x="38" y="60" width="46" height="80" rx="6" fill={LIGHT} />
      <Circle cx="61" cy="150" r="3" fill={NAVY} opacity="0.5" />
      {/* shield on the phone screen */}
      <Path d="M61 78 l12 4 v9 c0 9 -6 14 -12 17 c-6 -3 -12 -8 -12 -17 v-9 z" fill={BLUE} />

      {/* monitor (right) */}
      <Rect x="176" y="44" width="104" height="72" rx="8" fill="#ffffff" stroke={NAVY} strokeWidth="3" />
      <Rect x="186" y="54" width="84" height="52" rx="4" fill={LIGHT} />
      <Rect x="221" y="116" width="14" height="13" fill={NAVY} opacity="0.85" />
      <Rect x="201" y="129" width="54" height="6" rx="3" fill={NAVY} />
      {/* PIN cells on the monitor screen */}
      <Rect x="198" y="72" width="14" height="18" rx="3" fill="#ffffff" stroke={BLUE} strokeWidth="2" />
      <Rect x="216" y="72" width="14" height="18" rx="3" fill="#ffffff" stroke={BLUE} strokeWidth="2" />
      <Rect x="234" y="72" width="14" height="18" rx="3" fill="#ffffff" stroke={BLUE} strokeWidth="2" />
      <Rect x="252" y="72" width="14" height="18" rx="3" fill="#ffffff" stroke={BLUE} strokeWidth="2" />

      {/* dotted connector phone → monitor with a key badge */}
      <Path d="M96 92 C 128 70, 150 70, 172 84" stroke={BLUE} strokeWidth="2.4" strokeDasharray="3 5" fill="none" strokeLinecap="round" />
      <Circle cx="134" cy="70" r="16" fill={BLUE} />
      <Circle cx="130" cy="70" r="4.5" fill="none" stroke="#ffffff" strokeWidth="2.4" />
      <Path d="M134 70 h9 M141 70 v5" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}
