// A button with a gradient fill.
//
// Drawn with react-native-svg, the same way every other gradient in this app is
// drawn (GradientBackground.js, the home/dashboard backdrops, the login curve).
// expo-linear-gradient is deliberately NOT used: it is not a dependency here,
// and adding a native module for something the installed SVG library already
// does would make this the odd one out and force a rebuild to see a button.
//
// Each instance needs its own gradient id — SVG ids are document-global, so two
// buttons sharing one id would both paint with whichever mounted last.

import React, { useId } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';

// Brand blues, matching COLORS.primary's family.
export const GRAD_PRIMARY = ['#2563EB', '#1E40AF'];
// WhatsApp green, for actions that actually send a message.
export const GRAD_SEND = ['#34D399', '#059669'];
export const GRAD_MUTED = ['#CBD5E1', '#94A3B8'];

export default function GradientButton({
  label,
  onPress,
  colors = GRAD_PRIMARY,
  disabled = false,
  icon = null,
  height = 44,
  radius = 12,
  style,
  textStyle,
}) {
  const gid = `gb${String(useId()).replace(/[^a-zA-Z0-9]/g, '')}`;
  // Desaturated rather than merely faded: a dimmed gradient still reads as
  // "pressable but busy", which is not what disabled means here.
  const fill = disabled ? GRAD_MUTED : colors;

  return (
    <TouchableOpacity
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[{ height, borderRadius: radius, overflow: 'hidden' }, style]}
    >
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={fill[0]} />
            <Stop offset="1" stopColor={fill[1]} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" rx={radius} ry={radius} fill={`url(#${gid})`} />
      </Svg>
      <View style={s.row}>
        {icon}
        <Text style={[s.label, textStyle]} numberOfLines={1}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  row: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 7, paddingHorizontal: 14,
  },
  label: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
