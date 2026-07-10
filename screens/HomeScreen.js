// HOME — 369 ai.Biz dashboard. Matches the mockup exactly:
// header (menu / 369 logo / bell+badge), "Hello, <name> 👋", Quick Actions grid,
// Select View role cards, "Focus. Measure. Grow." banner, and a bottom tab bar.
import React, { useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { COLORS } from '../theme';
import TabBar from '../components/TabBar';

const { width: SW } = Dimensions.get('window');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const PAD = 20;
const QW = (SW - PAD * 2 - 30) / 4;   // quick-action card width (4 per row, 10 gaps)

const QUICK = [
  { label: 'My KPIs',       lib: 'mc',  name: 'target' },
  { label: 'KPI Dashboard', lib: 'ion', name: 'bar-chart' },
  { label: 'Reports',       lib: 'ion', name: 'document-text' },
  { label: 'Tasks',         lib: 'mc',  name: 'clipboard-check' },
  { label: 'Alerts',        lib: 'ion', name: 'notifications' },
  { label: 'Documents',     lib: 'ion', name: 'folder' },
  { label: 'Team',          lib: 'ion', name: 'people' },
  { label: 'Settings',      lib: 'ion', name: 'settings' },
];

const ROLES = [
  { key: 'client',    label: 'Client',    desc: 'View client related KPIs',    lib: 'ion', name: 'person' },
  { key: 'owner',     label: 'Owner',     desc: 'View all organization KPIs',  lib: 'mc',  name: 'crown' },
  { key: 'admin',     label: 'Admin',     desc: 'Manage users & system',       lib: 'mc',  name: 'shield-account' },
  { key: 'developer', label: 'Developer', desc: 'Configure & integrate system', lib: 'mc', name: 'code-tags' },
  { key: 'manager',   label: 'Manager',   desc: 'Track team & performance',    lib: 'ion', name: 'briefcase' },
];

function Icon({ lib, name, size, color }) {
  return lib === 'mc'
    ? <MaterialCommunityIcons name={name} size={size} color={color} />
    : <Ionicons name={name} size={size} color={color} />;
}

// Rising bar chart + orange arrow (banner artwork).
function BannerArt() {
  return (
    <Svg width={150} height={104} viewBox="0 0 150 104">
      {[{ x: 12, h: 34 }, { x: 42, h: 50 }, { x: 72, h: 66 }, { x: 102, h: 82 }, { x: 132, h: 100 }].map((b, i) => (
        <Rect key={i} x={b.x} y={104 - b.h} width={16} height={b.h} rx={5} fill="#9DBEFB" opacity={0.85} />
      ))}
      <Path d="M8 82 L48 60 L82 68 L142 22" fill="none" stroke="#F7941E" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M128 20 L142 22 L140 36" fill="none" stroke="#F7941E" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function HomeTab({ name }) {
  const [role, setRole] = useState('client');
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="menu" size={28} color={COLORS.navy} />
        </TouchableOpacity>
        <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />
        <TouchableOpacity hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="notifications-outline" size={26} color={COLORS.navy} />
          <View style={s.badge}><Text style={s.badgeTxt}>5</Text></View>
        </TouchableOpacity>
      </View>

      {/* Greeting */}
      <View style={{ paddingHorizontal: PAD, marginTop: 4 }}>
        <Text style={s.hello}>Hello, {name} 👋</Text>
        <Text style={s.helloSub}>Track, Analyze & Improve your KPIs</Text>
      </View>

      {/* Quick Actions */}
      <Text style={s.section}>Quick Actions</Text>
      <View style={s.grid}>
        {QUICK.map((q) => (
          <TouchableOpacity key={q.label} style={s.qCard} activeOpacity={0.85}>
            <Icon lib={q.lib} name={q.name} size={26} color={COLORS.primary} />
            <Text style={s.qLabel} numberOfLines={1}>{q.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Select View */}
      <Text style={s.section}>Select View</Text>
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: PAD, gap: 12, paddingVertical: 4 }}
      >
        {ROLES.map((r) => {
          const on = role === r.key;
          return (
            <TouchableOpacity
              key={r.key} style={[s.roleCard, on && s.roleCardOn]}
              onPress={() => setRole(r.key)} activeOpacity={0.9}
            >
              {on && (
                <View style={s.roleCheck}>
                  <Ionicons name="checkmark-circle" size={22} color={COLORS.primary} />
                </View>
              )}
              <Icon lib={r.lib} name={r.name} size={30} color={on ? COLORS.primary : '#3A4353'} />
              <Text style={[s.roleTitle, on && { color: COLORS.primary }]}>{r.label}</Text>
              <Text style={s.roleDesc}>{r.desc}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Banner */}
      <View style={s.banner}>
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <LinearGradient id="bn" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#2A5BD7" />
              <Stop offset="1" stopColor="#0B2A6B" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" rx="20" fill="url(#bn)" />
        </Svg>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={s.bannerTitle}>Focus. Measure. Grow.</Text>
          <Text style={s.bannerSub}>Monitor your KPIs and drive{'\n'}your business beyond limits.</Text>
        </View>
        <BannerArt />
      </View>
    </ScrollView>
  );
}

function Placeholder({ title, icon, lib, onLogout }) {
  return (
    <View style={s.placeholder}>
      <View style={s.phIconWrap}>
        <Icon lib={lib} name={icon} size={44} color={COLORS.primary} />
      </View>
      <Text style={s.phTitle}>{title}</Text>
      <Text style={s.phSub}>Coming soon</Text>
      {onLogout && (
        <TouchableOpacity style={s.logoutBtn} onPress={onLogout} activeOpacity={0.9}>
          <Ionicons name="log-out-outline" size={20} color="#fff" />
          <Text style={s.logoutTxt}>Log Out</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function HomeScreen({ user, onLogout }) {
  const [tab, setTab] = useState('home');
  const name = (user && user.name) ? user.name.split(' ')[0] : 'Sonia';

  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
        {tab === 'home'    && <HomeTab name={name} />}
        {tab === 'kpis'    && <Placeholder title="KPIs" lib="mc" icon="target" />}
        {tab === 'reports' && <Placeholder title="Reports" lib="ion" icon="document-text" />}
        {tab === 'profile' && <Placeholder title={name} lib="ion" icon="person" onLogout={onLogout} />}
      </View>
      <TabBar active={tab} onChange={setTab} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD, paddingBottom: 6 },
  logo: { width: 150, height: 92, marginTop: -6 },
  badge: {
    position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: '#E5352B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { color: '#fff', fontSize: 10.5, fontWeight: '800' },

  hello: { fontSize: 27, fontWeight: '900', color: COLORS.navy },
  helloSub: { fontSize: 14.5, color: COLORS.muted, marginTop: 4 },

  section: { fontSize: 18, fontWeight: '900', color: COLORS.navy, paddingHorizontal: PAD, marginTop: 26, marginBottom: 14 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, gap: 10 },
  qCard: {
    width: QW, height: QW + 6, backgroundColor: '#fff', borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: '#334155', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  qLabel: { fontSize: 11, fontWeight: '700', color: COLORS.ink, textAlign: 'center' },

  roleCard: {
    width: 128, backgroundColor: '#fff', borderRadius: 16, borderWidth: 1.5, borderColor: '#EDF1F7',
    paddingVertical: 16, paddingHorizontal: 10, alignItems: 'center', gap: 7,
    shadowColor: '#334155', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },
  roleCardOn: { backgroundColor: '#EAF1FE', borderColor: COLORS.primary },
  roleCheck: { position: 'absolute', top: 8, right: 8 },
  roleTitle: { fontSize: 15, fontWeight: '800', color: COLORS.navy, marginTop: 2 },
  roleDesc: { fontSize: 11.5, color: COLORS.muted, textAlign: 'center', lineHeight: 15 },

  banner: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: PAD, marginTop: 26,
    borderRadius: 20, paddingLeft: 20, paddingRight: 8, paddingVertical: 18, overflow: 'hidden',
  },
  bannerTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  bannerSub: { color: '#DCE6FA', fontSize: 13.5, marginTop: 8, lineHeight: 19 },

  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  phIconWrap: {
    width: 96, height: 96, borderRadius: 28, backgroundColor: '#EAF1FE',
    alignItems: 'center', justifyContent: 'center', marginBottom: 18,
  },
  phTitle: { fontSize: 22, fontWeight: '900', color: COLORS.navy },
  phSub: { fontSize: 14, color: COLORS.muted, marginTop: 6 },
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 28,
    backgroundColor: COLORS.primary, borderRadius: 14, paddingHorizontal: 26, height: 50,
  },
  logoutTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
