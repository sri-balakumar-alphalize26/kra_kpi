// HOME — 369 ai.Biz dashboard. Matches the mockup exactly:
// header (menu / 369 logo / bell+badge), "Hello, <name> 👋", Quick Actions grid,
// Select View role cards, "Focus. Measure. Grow." banner, and a bottom tab bar.
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
  Alert, Modal, ActivityIndicator, Animated, Easing, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import TabBar from '../components/TabBar';
import { createLogger } from '../api/logger';
import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { fetchUnreadCount } from '../services/notifications';

// 369-brand colors (sampled from the logo): steel blue letters + orange arrow.
const BRAND_BLUE = '#2E86C7';
const BRAND_ORANGE = '#F7941E';

const log = createLogger('Home');

const { width: SW, height: SH } = Dimensions.get('window');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const PAD = 20;
const QW = (SW - PAD * 2 - 30) / 4;   // quick-action card width (4 per row, 10 gaps)

// Each tile → { label, icon, dest (appScreen value), adminOnly }.
// adminOnly tiles are hidden from regular users (only admin/owner/system see
// them); the KPI Action Board is the one tile everyone gets.
const QUICK = [
  { label: 'Owner Dashboard',    lib: 'mc',  name: 'view-dashboard',   dest: 'owner',              adminOnly: true },
  { label: 'KRA / KPI Master',   lib: 'mc',  name: 'file-tree',        dest: 'dashboard',          adminOnly: true },
  { label: 'KPI Action Board',   lib: 'mc',  name: 'clipboard-check',  dest: 'actionboard',        adminOnly: false },
  { label: 'Upload Requirements', lib: 'mc', name: 'file-document',    dest: 'upload:requirement', adminOnly: true },
  { label: 'Upload Updates',     lib: 'mc',  name: 'cloud-upload',     dest: 'upload:update',      adminOnly: true },
  { label: 'Upload Bug Reports', lib: 'mc',  name: 'bug',              dest: 'upload:bug',         adminOnly: true },
];

function Icon({ lib, name, size, color }) {
  return lib === 'mc'
    ? <MaterialCommunityIcons name={name} size={size} color={color} />
    : <Ionicons name={name} size={size} color={color} />;
}

// A Quick Action tile that cascades in (fade + slide-up, staggered by index)
// and scales down while pressed (springs back on release).
function AnimatedTile({ q, index, onPress }) {
  const anim = useRef(new Animated.Value(0)).current;   // 0 → 1 entrance
  const press = useRef(new Animated.Value(1)).current;  // press scale
  useEffect(() => {
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1, duration: 380, delay: index * 55,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [anim, index]);

  const pressIn = () => Animated.spring(press, { toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const pressOut = () => Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }).start();

  const style = {
    opacity: anim,
    transform: [
      { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
      { scale: press },
    ],
  };
  return (
    <Animated.View style={style}>
      <TouchableOpacity
        style={s.qCard} activeOpacity={0.9}
        onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}
      >
        <Icon lib={q.lib} name={q.name} size={26} color={COLORS.primary} />
        <Text style={s.qLabel} numberOfLines={2}>{q.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// 👋 that waves — rotates back and forth in a gentle loop.
function WavingHand() {
  const rot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const wave = Animated.sequence([
      Animated.timing(rot, { toValue: 1,  duration: 150, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: -1, duration: 300, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: 1,  duration: 300, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: 0,  duration: 150, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(1200),
    ]);
    const loop = Animated.loop(wave);
    loop.start();
    return () => loop.stop();
  }, [rot]);
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-18deg', '18deg'] });
  return (
    <Animated.Text style={{ fontSize: 26, transform: [{ rotate }] }}>👋</Animated.Text>
  );
}

// "Hello, <name>" that slides in from the left + fades in, slightly delayed so
// it visibly animates AFTER the greeting block has settled into place.
function Greeting({ name }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [tw, setTw] = useState(0); // measured text width → arrow scales to it
  useEffect(() => {
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1, duration: 600, delay: 320,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [anim, name]);
  const style = {
    opacity: anim,
    transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }],
  };
  // Arrow width tracks the text width (a bit wider so the head clears the last letter).
  const arrowW = tw ? tw + 16 : 0;
  const arrowH = arrowW * (44 / 230); // keep the viewBox aspect ratio
  return (
    <Animated.View style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }, style]}>
      <View style={{ justifyContent: 'center' }}>
        {/* Orange 369-style arrow BEHIND the name: swoops down into a V dip,
            then up to the arrowhead. Rendered first + absolute → sits behind.
            Sized from the measured text width so it fits any name length. */}
        {arrowW > 0 && (
          <Svg width={arrowW} height={arrowH} viewBox="0 0 230 44" style={[s.helloArrow, { top: -arrowH * 0.28 }]} pointerEvents="none">
            <Path d="M8 12 C 48 40, 82 42, 116 26 C 150 10, 178 10, 206 8"
              fill="none" stroke={BRAND_ORANGE} strokeWidth={5} strokeLinecap="round" opacity={0.9} />
            <Path d="M192 3 L210 6 L204 22"
              fill="none" stroke={BRAND_ORANGE} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
          </Svg>
        )}
        <Text style={s.hello} onLayout={(e) => setTw(e.nativeEvent.layout.width)}>Hello, {name}</Text>
      </View>
      <WavingHand />
    </Animated.View>
  );
}

function HomeTab({ name, onOpen }) {
  // Fetch the user's role so admin-only tiles can be hidden from regular users.
  // Default to admin=true optimistically until the role resolves, then correct —
  // but hold tile render until we know, to avoid a flash of admin tiles.
  const [isAdmin, setIsAdmin] = useState(null); // null = still resolving

  useEffect(() => {
    (async () => {
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) { setIsAdmin(true); return; } // offline demo → show all
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        const admin = !!(info && (info.is_system || info.is_owner || info.is_admin));
        log.info('home role', { admin, login: info?.login });
        setIsAdmin(admin);
      } catch (e) {
        log.warn('role check failed, defaulting to non-admin', e?.message);
        setIsAdmin(false);
      }
    })();
  }, []);

  // Unread notification count for the bell badge. Refetched every time Home
  // mounts (it re-mounts on return from a sub-screen), so opening the feed and
  // coming back reflects the newly-read state.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const n = await fetchUnreadCount();
        if (alive) setUnread(n || 0);
      } catch (e) {
        log.warn('unread count failed', e?.message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false); // keep Modal up during close anim
  const drawerAnim = useRef(new Animated.Value(0)).current;   // 0 closed → 1 open

  // Slide the drawer in from the left (+ fade the blurred backdrop) on open,
  // and reverse on close before unmounting the Modal.
  const openDrawer = () => {
    setDrawerMounted(true);
    setDrawerOpen(true);
    Animated.timing(drawerAnim, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    Animated.timing(drawerAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => setDrawerMounted(false));
  };
  const drawerSlide = { transform: [{ translateX: drawerAnim.interpolate({ inputRange: [0, 1], outputRange: [-Math.min(300, SW * 0.82) - 20, 0] }) }] };

  // Entrance transition: fade in + slide up when the Home page mounts (replays
  // every time you return to Home from a sub-screen, since it re-mounts).
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [enter]);
  const enterStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
  };

  const tiles = QUICK.filter((q) => isAdmin || !q.adminOnly);

  const onTile = (q) => {
    log.info('tile tapped', q.label, { dest: q.dest });
    if (drawerOpen) closeDrawer();
    if (q.dest) onOpen(q.dest);
    else Alert.alert(q.label, 'Coming soon');
  };

  return (
    <>
    {/* Light-blue gradient background — same as the KRA/KPI Master screen */}
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <LinearGradient id="homeBg" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor="#EAF2FF" />
          <Stop offset="1" stopColor="#C7DDF7" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#homeBg)" />
    </Svg>
    <ScrollView style={{ backgroundColor: 'transparent' }} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={openDrawer} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="menu" size={28} color={COLORS.navy} />
        </TouchableOpacity>
        <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />
        <TouchableOpacity onPress={() => onOpen('notifications')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="notifications-outline" size={26} color={COLORS.navy} />
          {unread > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeTxt}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Greeting + Quick Actions animate in together on entry */}
      <Animated.View style={enterStyle}>
      <View style={{ paddingHorizontal: PAD, marginTop: 4 }}>
        <Greeting name={name} />
        <Text style={s.helloSub}>Track, Analyze & Improve your KPIs</Text>
      </View>

      {/* Quick Actions — wait for the role to resolve so we never flash the
          wrong tile set (admin vs non-admin). */}
      <Text style={s.section}>Quick Actions</Text>
      {isAdmin === null ? (
        <View style={s.quickLoading}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : (
        <View style={s.grid}>
          {tiles.map((q, i) => (
            <AnimatedTile key={q.label} q={q} index={i} onPress={() => onTile(q)} />
          ))}
        </View>
      )}
      </Animated.View>
    </ScrollView>

    {/* Side drawer — background (Home behind) blurs; the panel slides in from
        the left. The Modal stays mounted through the close animation. */}
    <Modal visible={drawerMounted} transparent onRequestClose={closeDrawer}>
      <View style={s.drawerRoot}>
        {/* Blurred, tappable backdrop = frosted Home screen behind. Fades with
            the drawer. Android needs experimentalBlurMethod for a real blur. */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: drawerAnim }]}>
          <BlurView intensity={55} tint="light" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill}>
            <TouchableOpacity style={s.drawerBackdrop} activeOpacity={1} onPress={closeDrawer} />
          </BlurView>
        </Animated.View>
        {/* Solid, clear drawer panel — slides in from the left */}
        <Animated.View style={[s.drawer, { paddingTop: TOP + 8 }, drawerSlide]}>
          {/* Centered 369 logo, close button pinned top-right */}
          <View style={s.drawerHead}>
            <Image source={require('../assets/logo369.png')} style={s.drawerLogo} resizeMode="contain" />
            <TouchableOpacity onPress={closeDrawer} style={s.drawerClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={COLORS.navy} />
            </TouchableOpacity>
          </View>
          <Text style={s.drawerLabel}>MENU</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {isAdmin === null && <ActivityIndicator color={COLORS.primary} style={{ marginTop: 20 }} />}
            {isAdmin !== null && tiles.map((q) => (
              <TouchableOpacity key={q.label} style={s.drawerItem} onPress={() => onTile(q)} activeOpacity={0.6}>
                <View style={s.drawerIcon}>
                  <Icon lib={q.lib} name={q.name} size={20} color={COLORS.primary} />
                </View>
                <Text style={s.drawerItemTxt}>{q.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
    </>
  );
}

// PROFILE — user + Odoo connection details (like a rental-app account page) + logout.
function ProfileTab({ user, onLogout }) {
  const rows = [
    { icon: 'person-outline',   label: 'Name',     value: user?.name || '—' },
    { icon: 'at-outline',       label: 'Username', value: user?.username || user?.login || '—' },
    { icon: 'server-outline',   label: 'Database', value: user?.db || '—' },
    { icon: 'globe-outline',    label: 'Server',   value: user?.serverUrl || '—' },
    { icon: 'finger-print-outline', label: 'User ID', value: user?.uid != null ? String(user.uid) : '—' },
  ];
  const initials = (user?.name || 'U').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  const [logoutOpen, setLogoutOpen] = useState(false);

  const online = !!user?.serverUrl;

  // Log the redesigned Profile page each time it mounts, with the data it shows,
  // so it's easy to confirm in the console that the new UI is rendering.
  useEffect(() => {
    log.info('ProfileTab mounted (redesigned UI)', {
      name: user?.name, username: user?.username || user?.login,
      db: user?.db, server: user?.serverUrl, uid: user?.uid,
      initials, online,
    });
  }, [user, initials, online]);

  return (
    <>
    <View style={s.profRoot}>
      {/* 369 logo watermark — tinted to a faint brand blue so it reads as a real
          watermark (the PNG has a baked white background, so tintColor is what
          makes it transparent-looking rather than a white box). */}
      <Image source={require('../assets/logo369.png')} style={s.profWatermark} resizeMode="contain" tintColor={COLORS.primary} pointerEvents="none" />

      <ScrollView contentContainerStyle={{ paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        {/* Solid single-color header with avatar */}
        <View style={[s.profHead, { paddingTop: TOP + 12 }]}>
          <View style={s.profAvatar}><Text style={s.profAvatarTxt}>{initials}</Text></View>
          <Text style={s.profName}>{user?.name || 'User'}</Text>
          <Text style={s.profSub}>{user?.username || user?.login || ''}</Text>
          <View style={[s.profPill, online ? s.profPillOn : s.profPillOff]}>
            <View style={[s.profDot, { backgroundColor: online ? '#4ADE80' : '#F59E0B' }]} />
            <Text style={s.profPillTxt}>{online ? 'Connected' : 'Offline'}</Text>
          </View>
        </View>

        {/* Connection details card — icon chip per row */}
        <Text style={s.profSection}>Connection Details</Text>
        <View style={s.profCard}>
          {rows.map((r, i) => (
            <View key={r.label} style={[s.profRow, i < rows.length - 1 && s.profRowDivider]}>
              <View style={s.profRowIcon}>
                <Ionicons name={r.icon} size={18} color={COLORS.primary} />
              </View>
              <Text style={s.profRowLabel}>{r.label}</Text>
              <Text style={s.profRowValue} numberOfLines={1}>{r.value}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity style={s.profLogout} onPress={() => setLogoutOpen(true)} activeOpacity={0.9}>
          <Ionicons name="log-out-outline" size={20} color="#fff" />
          <Text style={s.logoutTxt}>Log Out</Text>
        </TouchableOpacity>

        <Text style={s.profFooter}>Alphalize KRA & KPI · v1.0</Text>
      </ScrollView>
    </View>

    {/* Styled logout confirm popup */}
    <Modal visible={logoutOpen} transparent animationType="fade" onRequestClose={() => setLogoutOpen(false)}>
      <View style={s.logoutWrap}>
        <View style={s.logoutCard}>
          <View style={s.logoutIconWrap}>
            <Ionicons name="log-out-outline" size={34} color={COLORS.red} />
          </View>
          <Text style={s.logoutTitle}>Log out?</Text>
          <Text style={s.logoutMsg}>You'll need to sign in again with your username and password.</Text>
          <View style={s.logoutBtns}>
            <TouchableOpacity style={[s.logoutBtn, s.logoutCancel]} onPress={() => setLogoutOpen(false)} activeOpacity={0.85}>
              <Text style={s.logoutCancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.logoutBtn, s.logoutConfirm]} onPress={() => { setLogoutOpen(false); onLogout(); }} activeOpacity={0.85}>
              <Ionicons name="log-out-outline" size={18} color="#fff" />
              <Text style={s.logoutConfirmTxt}>Log Out</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </>
  );
}

export default function HomeScreen({ user, onLogout, onOpen }) {
  const [tab, setTab] = useState('home');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const name = (user && user.name) ? user.name.split(' ')[0] : 'Sonia';

  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
        {tab === 'home'    && <HomeTab name={name} onOpen={onOpen} />}
        {tab === 'profile' && <ProfileTab user={user} onLogout={onLogout} />}
      </View>
      <TabBar active={tab} onChange={(t) => { log.info('tab switch', { from: tab, to: t }); setTab(t); }} onLogout={() => setLogoutOpen(true)} />

      {/* Logout confirm — blurred background */}
      <Modal visible={logoutOpen} transparent animationType="fade" onRequestClose={() => setLogoutOpen(false)}>
        <BlurView intensity={30} tint="dark" style={s.logoutBlur}>
          <View style={s.logoutCard}>
            <View style={s.logoutIconWrap}>
              <Ionicons name="log-out-outline" size={34} color={COLORS.red} />
            </View>
            <Text style={s.logoutTitle}>Log out?</Text>
            <Text style={s.logoutMsg}>You'll need to sign in again with your username and password.</Text>
            <View style={s.logoutBtns}>
              <TouchableOpacity style={[s.logoutBtn, s.logoutCancel]} onPress={() => setLogoutOpen(false)} activeOpacity={0.85}>
                <Text style={s.logoutCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.logoutBtn, s.logoutConfirm]} onPress={() => { setLogoutOpen(false); onLogout(); }} activeOpacity={0.85}>
                <Ionicons name="log-out-outline" size={18} color="#fff" />
                <Text style={s.logoutConfirmTxt}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>
        </BlurView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // matches the light-blue gradient top

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD, paddingBottom: 6 },
  logo: { width: 150, height: 92, marginTop: -6 },
  badge: {
    position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: '#E5352B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { color: '#fff', fontSize: 10.5, fontWeight: '800' },

  hello: { fontSize: 27, fontWeight: '900', color: BRAND_BLUE, letterSpacing: 0.3 }, // 369 steel blue
  helloArrow: { position: 'absolute', left: 0 },
  helloSub: { fontSize: 14.5, color: COLORS.muted, marginTop: 4 },

  section: { fontSize: 18, fontWeight: '900', color: COLORS.navy, paddingHorizontal: PAD, marginTop: 26, marginBottom: 14 },

  quickLoading: { paddingVertical: 30, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, gap: 10 },
  qCard: {
    width: QW, height: QW + 6, backgroundColor: '#fff', borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: '#334155', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  qLabel: { fontSize: 11, fontWeight: '700', color: COLORS.ink, textAlign: 'center' },

  // Profile tab
  profRoot: { flex: 1, backgroundColor: COLORS.bg },
  // 369 watermark low on the screen, below the logout button (tinted brand blue).
  profWatermark: { position: 'absolute', alignSelf: 'center', top: SH * 0.66, width: '62%', height: SH * 0.20, opacity: 0.08 },

  profHead: {
    alignItems: 'center', paddingHorizontal: 24, paddingBottom: 30, overflow: 'hidden',
    backgroundColor: COLORS.primary,   // single solid brand blue (no two-tone)
    borderBottomLeftRadius: 30, borderBottomRightRadius: 30,
  },
  profAvatar: {
    width: 92, height: 92, borderRadius: 46, backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  profAvatarTxt: { color: '#fff', fontSize: 32, fontWeight: '900' },
  profName: { color: '#fff', fontSize: 23, fontWeight: '900', marginTop: 16, textAlign: 'center' },
  profSub: { color: '#C7D8F7', fontSize: 14, marginTop: 4, textAlign: 'center' },
  profPill: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 14, paddingHorizontal: 14, height: 30, borderRadius: 15, borderWidth: 1 },
  profPillOn: { backgroundColor: 'rgba(74,222,128,0.2)', borderColor: 'rgba(74,222,128,0.6)' },
  profPillOff: { backgroundColor: 'rgba(245,158,11,0.2)', borderColor: 'rgba(245,158,11,0.6)' },
  profDot: { width: 8, height: 8, borderRadius: 4 },
  profPillTxt: { color: '#fff', fontSize: 12.5, fontWeight: '800' },

  profSection: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: PAD, marginTop: 26, marginBottom: 12 },
  profCard: { marginHorizontal: PAD, backgroundColor: '#fff', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 4, shadowColor: '#334155', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  profRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, gap: 12 },
  profRowDivider: { borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  profRowIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#EAF1FE', alignItems: 'center', justifyContent: 'center' },
  profRowLabel: { fontSize: 13.5, color: COLORS.muted, fontWeight: '600' },
  profRowValue: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '800', textAlign: 'right' },

  profLogout: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: PAD, marginTop: 28, backgroundColor: COLORS.red, borderRadius: 15, height: 54,
    shadowColor: COLORS.red, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  logoutTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  profFooter: { textAlign: 'center', color: COLORS.faint, fontSize: 12, fontWeight: '600', marginTop: 20 },

  // Side drawer — frosted-glass ("mirror") panel: the BlurView blurs whatever is
  // behind it, so the content shows through softly and the option pills stay crisp.
  drawerRoot: { flex: 1, flexDirection: 'row' },
  // Solid, clear panel — the menu stays crisp; only the background blurs.
  drawer: {
    width: Math.min(300, SW * 0.82), paddingHorizontal: 16, paddingBottom: 20,
    backgroundColor: '#fff', borderTopRightRadius: 22, borderBottomRightRadius: 22,
    shadowColor: '#0B2A6B', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 4, height: 0 }, elevation: 12,
  },
  drawerBackdrop: { flex: 1 },
  // Logo centered; close button pinned top-right so it doesn't offset the logo.
  drawerHead: { alignItems: 'center', justifyContent: 'center', marginBottom: 4, minHeight: 60 },
  drawerClose: { position: 'absolute', right: 0, top: 6, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center' },
  drawerLogo: { width: 130, height: 60, alignSelf: 'center' },
  drawerLabel: { fontSize: 12, fontWeight: '900', color: COLORS.muted, letterSpacing: 1.5, marginBottom: 12, marginTop: 6 },
  drawerItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 12, marginBottom: 10, borderRadius: 14, backgroundColor: '#F5F8FD', borderWidth: 1, borderColor: '#EAF1FE' },
  drawerIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#EAF1FE', alignItems: 'center', justifyContent: 'center' },
  drawerItemTxt: { flex: 1, fontSize: 14.5, fontWeight: '800', color: COLORS.navy },

  // Logout confirm popup
  logoutWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 30 },
  logoutBlur: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  logoutCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 22, alignItems: 'center', paddingTop: 24, paddingBottom: 18, paddingHorizontal: 22 },
  logoutIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  logoutTitle: { fontSize: 20, fontWeight: '900', color: COLORS.navy },
  logoutMsg: { fontSize: 14, color: COLORS.muted, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  logoutBtns: { flexDirection: 'row', gap: 12, marginTop: 22, width: '100%' },
  logoutBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 50, borderRadius: 14 },
  logoutCancel: { backgroundColor: '#EEF2F8' },
  logoutCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  logoutConfirm: { backgroundColor: COLORS.red },
  logoutConfirmTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
