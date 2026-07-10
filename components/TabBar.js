// Bottom tab bar — Home | KPIs | Reports | Profile (like the parking app footer).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const TABS = [
  { key: 'home',    label: 'Home',    lib: 'ion', on: 'home',           off: 'home-outline' },
  { key: 'kpis',    label: 'KPIs',    lib: 'mc',  on: 'target',         off: 'target' },
  { key: 'reports', label: 'Reports', lib: 'ion', on: 'document-text',  off: 'document-text-outline' },
  { key: 'profile', label: 'Profile', lib: 'ion', on: 'person',         off: 'person-outline' },
];

export default function TabBar({ active, onChange }) {
  return (
    <View style={s.bar}>
      {TABS.map((t) => {
        const isOn = active === t.key;
        const color = isOn ? COLORS.primary : '#9AA6B8';
        const name = isOn ? t.on : t.off;
        return (
          <TouchableOpacity key={t.key} style={s.tab} onPress={() => onChange(t.key)} activeOpacity={0.8}>
            {t.lib === 'mc'
              ? <MaterialCommunityIcons name={name} size={24} color={color} />
              : <Ionicons name={name} size={23} color={color} />}
            <Text style={[s.label, { color }]}>{t.label}</Text>
            {isOn && <View style={s.underline} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row', backgroundColor: '#fff',
    borderTopWidth: 1, borderTopColor: '#EDF1F7',
    paddingTop: 10, paddingBottom: Platform.OS === 'ios' ? 26 : 14,
    shadowColor: '#334155', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: -3 }, elevation: 10,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 11.5, fontWeight: '700', marginTop: 4 },
  underline: { width: 20, height: 3, borderRadius: 2, backgroundColor: COLORS.primary, marginTop: 4 },
});
