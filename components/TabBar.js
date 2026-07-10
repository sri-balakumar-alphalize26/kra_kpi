// Bottom tab bar — Home | Profile | Logout. Each tab paints its OWN background
// pill (no floating absolute pill), so labels are children of the colored pill
// and can never be hidden by z-fighting on Android. The active tab is blue;
// Logout turns red (with white text) while its confirm popup is open.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const TABS = [
  { key: 'home',    label: 'Home',    on: 'home',   off: 'home-outline' },
  { key: 'profile', label: 'Profile', on: 'person', off: 'person-outline' },
];

export default function TabBar({ active, onChange, onLogout }) {
  const insets = useSafeAreaInsets();
  const [logoutHot, setLogoutHot] = useState(false); // Logout pressed → red

  const pressLogout = () => {
    setLogoutHot(true);
    onLogout && onLogout();
    // Cool off shortly after (the confirm popup shows on top meanwhile).
    setTimeout(() => setLogoutHot(false), 800);
  };

  return (
    <View style={[s.wrap, { paddingBottom: Math.max(insets.bottom, 8) + 8 }]}>
      <View style={s.bar}>
        {TABS.map((t) => {
          const isOn = active === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[s.tab, isOn && s.tabActive]}
              onPress={() => onChange(t.key)}
              activeOpacity={0.85}
            >
              <Ionicons name={isOn ? t.on : t.off} size={21} color={isOn ? '#fff' : COLORS.muted} />
              <Text style={[s.label, { color: isOn ? '#fff' : COLORS.muted }]} numberOfLines={1}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
        {onLogout && (
          <TouchableOpacity
            style={[s.tab, logoutHot && s.tabLogoutHot]}
            onPress={pressLogout}
            activeOpacity={0.85}
          >
            <Ionicons name="log-out-outline" size={21} color={logoutHot ? '#fff' : COLORS.red} />
            <Text style={[s.label, { color: logoutHot ? '#fff' : COLORS.red }]} numberOfLines={1}>Logout</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: 'transparent', paddingHorizontal: 16, paddingTop: 8 },
  bar: {
    flexDirection: 'row', backgroundColor: '#fff', borderRadius: 26,
    borderWidth: 1.5, borderColor: COLORS.primary, padding: 6, gap: 4,
    shadowColor: COLORS.primary, shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 12,
  },
  // Each tab is its own pill — the label is a child, so it's always on top.
  tab: {
    flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 3, height: 52, borderRadius: 20, paddingHorizontal: 2,
  },
  tabActive: { backgroundColor: COLORS.primary },
  tabLogoutHot: { backgroundColor: COLORS.red },
  label: { fontSize: 11.5, fontWeight: '800' },
});
