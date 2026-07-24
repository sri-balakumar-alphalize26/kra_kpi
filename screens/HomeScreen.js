// HOME — 369 ai.Biz dashboard. Matches the mockup exactly:
// header (menu / 369 logo / bell+badge), "Hello, <name> 👋", Quick Actions grid,
// Select View role cards, "Focus. Measure. Grow." banner, and a bottom tab bar.
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
  Alert, Modal, ActivityIndicator, Animated, Easing, StatusBar as RNStatusBar,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import TabBar from '../components/TabBar';
import CameraCaptureModal from '../components/CameraCaptureModal';
import { createLogger } from '../api/logger';
import { getConnection, saveSession, getQuickActions, saveQuickActions, getMenuOrder, saveMenuOrder, getAvatar, saveAvatar, clearAvatar } from '../api/session';
import ReorderableMenu from '../components/ReorderableMenu';
import { jsonRpc } from '../api/odooApi';
import { fetchUnreadCount } from '../services/notifications';
import { fetchTasks, groupIntoLanes } from '../services/kpiActions';
import { workdayButtonState } from '../utils/workdayState';
// Clients aren't served by /kra_kpi/tasks/get (it returns nothing for them), so
// their stats come from the same portal feed My Requests uses.
import { getClientDashboard } from '../services/clientPortal';
import { requestOtp, verifyOtp } from '../services/appAuth';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

// 369-brand colors (sampled from the logo): steel blue letters + orange arrow.
const BRAND_BLUE = '#2E86C7';
const BRAND_ORANGE = '#F7941E';

const log = createLogger('Home');

// In-memory profile-photo cache (uid → uri) so the avatar shows instantly on
// mount/tab-switch instead of flashing initials while AsyncStorage loads.
const AVATAR_CACHE = {};

// The Alphalize logo gets one moment when the app opens: it shows alone briefly,
// settles into a faint watermark, and the tiles fade in over it.
//
// Module scope ON PURPOSE (same trick as AVATAR_CACHE above / WORKDAY_CACHE on the
// board): Home RE-MOUNTS every time you come back from a sub-screen, so a
// component-level flag would replay the intro on every single return. At module
// scope it survives re-mounts and resets on relaunch — exactly the lifetime an
// intro should have.
let INTRO_DONE = false;
const INTRO_HOLD_MS = 700;   // how long the logo has the screen to itself

const { width: SW, height: SH } = Dimensions.get('window');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const PAD = 20;
const QW = (SW - PAD * 2 - 12) / 2;      // quick-action card width (2 per row, 12 gap)
const STAT_W = (SW - PAD * 2 - 12) / 2;  // stat card width (2 per row, 12 gap)

// Each tile → { label, icon, dest (appScreen value), adminOnly }.
// adminOnly tiles are hidden from regular users (only admin/owner/system see
// them); the KPI Action Board is the one tile everyone gets.
const QUICK = [
  { label: 'Owner Dashboard',    lib: 'mc',  name: 'view-dashboard',   dest: 'owner',              adminOnly: true,  section: 'main',     bg: '#E0ECFF', fg: '#2563EB' },
  { label: 'Live Tracking',      lib: 'mc',  name: 'account-eye',      dest: 'livetracking',       adminOnly: true,  section: 'main',     bg: '#DBEAFE', fg: '#1D4ED8' },
  { label: 'KRA / KPI Master',   lib: 'mc',  name: 'file-tree',        dest: 'dashboard',          adminOnly: true,  section: 'main',     bg: '#EDE9FE', fg: '#7C3AED' },
  { label: 'KPI Action Board',   lib: 'mc',  name: 'clipboard-check',  dest: 'actionboard',        adminOnly: false, section: 'main',     bg: '#DCFCE7', fg: '#16A34A' },
  { label: 'My Workday',         lib: 'mc',  name: 'calendar-clock',   dest: 'myworkday',          adminOnly: false, section: 'reports',  bg: '#CFFAFE', fg: '#0E7490' },
  { label: 'My Snapshots',       lib: 'mc',  name: 'camera-account',   dest: 'mysnapshots',        adminOnly: false, section: 'reports',  bg: '#E0F2FE', fg: '#0369A1' },
  { label: 'Upload Requirements', lib: 'mc', name: 'file-document',    dest: 'upload:requirement', adminOnly: true,  section: 'main',     bg: '#FEF3C7', fg: '#D97706' },
  { label: 'Upload Updates',     lib: 'mc',  name: 'cloud-upload',     dest: 'upload:update',      adminOnly: true,  section: 'main',     bg: '#FFEDD5', fg: '#EA580C' },
  { label: 'Upload Bug Reports', lib: 'mc',  name: 'bug',              dest: 'upload:bug',         adminOnly: true,  section: 'main',     bg: '#FEE2E2', fg: '#DC2626' },
  { label: 'Client Task Queue',  lib: 'mc',  name: 'inbox-arrow-down', dest: 'taskqueue',          adminOnly: true,  section: 'main',     bg: '#FEF3C7', fg: '#D97706' },
  { label: 'Generate Client Files', lib: 'mc', name: 'folder-zip',     dest: 'clientfiles',        adminOnly: true,  section: 'main',     bg: '#E0F2FE', fg: '#0284C7' },
  { label: 'Reassignment History', lib: 'mc', name: 'swap-horizontal', dest: 'reassignhistory',    adminOnly: true,  section: 'settings', bg: '#F3E8FF', fg: '#9333EA' },
  { label: 'Users',              lib: 'mc',  name: 'account-multiple-plus', dest: 'users',          adminOnly: true,  section: 'settings', bg: '#E0ECFF', fg: '#2563EB' },
  { label: 'Login Management',   lib: 'mc',  name: 'account-key',      dest: 'loginmgmt',          adminOnly: true,  section: 'settings', bg: '#EDE9FE', fg: '#7C3AED' },
  { label: 'Workday Snapshots',  lib: 'mc',  name: 'camera-timer',     dest: 'snapshots',          adminOnly: true,  section: 'reports',  bg: '#CFFAFE', fg: '#0891B2' },
  { label: 'Daily Reports',      lib: 'mc',  name: 'file-chart',       dest: 'dailyreports',       adminOnly: true,  section: 'reports',  bg: '#DBEAFE', fg: '#4338CA' },
  { label: 'Work Report',        lib: 'mc',  name: 'chart-box-outline', dest: 'workreport',        adminOnly: true,  section: 'reports',  bg: '#E0F2FE', fg: '#0369A1' },
  { label: 'Client Invoices',    lib: 'mc',  name: 'receipt',          dest: 'clientinvoices',     adminOnly: true,  section: 'reports',  bg: '#FEF9C3', fg: '#CA8A04' },
  // Client-facing read-only invoices (whitelisted for clients below; adminOnly hides it from developers).
  { label: 'Invoices',           lib: 'mc',  name: 'receipt-text-outline', dest: 'myinvoices',      adminOnly: true,  section: 'reports',  bg: '#FEF9C3', fg: '#CA8A04' },
  { label: 'Company Branding',   lib: 'mc',  name: 'palette',          dest: 'companybranding',    adminOnly: true,  section: 'settings', bg: '#FCE7F3', fg: '#DB2777' },
  { label: 'Configuration',      lib: 'mc',  name: 'cog',              dest: 'config',             adminOnly: true,  section: 'settings', bg: '#E2E8F0', fg: '#475569' },
  { label: 'Requests',           lib: 'mc',  name: 'clipboard-list-outline', dest: 'mytasks',      adminOnly: true,  section: 'main',     bg: '#DCFCE7', fg: '#16A34A' },
  // Every role sees this (adminOnly:false → developers; whitelisted → clients;
  // not excluded → admins). Role-tagged manuals are filtered server-side.
  { label: 'User Manual',        lib: 'mc',  name: 'book-open-page-variant', dest: 'usermanual',   adminOnly: false, section: 'reports',  bg: '#EEF2FF', fg: '#4F46E5' },
];

// Menu sections (sub-headings), shown in the drawer, the Quick Actions grid, and
// the Edit Quick Actions popup — mirroring the module's KRA / Reports / Settings
// grouping. Every tile has a `section`; anything unset falls into 'main'.
const SECTIONS = [
  { key: 'main',     label: 'KRA / KPI' },
  { key: 'reports',  label: 'Reports' },
  { key: 'settings', label: 'Settings' },
];

// Group a tile list into [{key,label,tiles}] in SECTIONS order, preserving each
// tile's order within its section and dropping empty sections (so a heading only
// ever shows when it has at least one tile).
function groupBySection(tiles) {
  return SECTIONS
    .map((sec) => ({ ...sec, tiles: tiles.filter((t) => (t.section || 'main') === sec.key) }))
    .filter((g) => g.tiles.length > 0);
}

// Home stats strip — live task-status counts, keyed to the Action Board lanes
// (groupIntoLanes / LANES). Pastel bg + accent fg mirror the board's lane hues.
const STAT_META = {
  pending_review:  { label: 'Pending Review',    lib: 'mc', name: 'account-clock',          bg: '#EDE9FE', fg: '#7C3AED' },
  regular:         { label: 'Regular',           lib: 'mc', name: 'clipboard-text-outline', bg: '#E0ECFF', fg: '#2563EB' },
  important:       { label: 'Important',          lib: 'mc', name: 'alert-decagram-outline', bg: '#F3E8FF', fg: '#9333EA' },
  urgent:          { label: 'Urgent',            lib: 'mc', name: 'alert-outline',          bg: '#FEF3C7', fg: '#D97706' },
  in_progress:     { label: 'In Progress',       lib: 'mc', name: 'progress-clock',         bg: '#FFEDD5', fg: '#EA580C' },
  paused:          { label: 'On Hold',           lib: 'mc', name: 'pause-circle-outline',   bg: '#FCE7F3', fg: '#DB2777' },
  approvals:       { label: 'Pending Approvals', lib: 'mc', name: 'check-decagram-outline', bg: '#FEF9C3', fg: '#CA8A04' },
  awaiting_client: { label: 'Awaiting Client',   lib: 'mc', name: 'account-arrow-right',    bg: '#CFFAFE', fg: '#0891B2' },
  completed:       { label: 'Completed',         lib: 'mc', name: 'check-circle-outline',   bg: '#DCFCE7', fg: '#16A34A' },
};

// Which status cards each role sees (curated — 9 lanes is too many for a strip).
const ADMIN_STATS  = ['pending_review', 'in_progress', 'approvals', 'awaiting_client', 'paused', 'completed'];
const CLIENT_STATS = ['awaiting_client', 'in_progress', 'paused', 'completed'];
const DEV_STATS    = ['in_progress', 'paused', 'pending_review', 'completed'];

function statsForRole(role) {
  const keys = role === 'admin' ? ADMIN_STATS : role === 'client' ? CLIENT_STATS : DEV_STATS;
  return keys.map((key) => ({ key, ...STAT_META[key] }));
}

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
        style={[s.qCard, { backgroundColor: q.bg }]} activeOpacity={0.9}
        onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}
      >
        <View style={s.qChip}>
          <Icon lib={q.lib} name={q.name} size={22} color={q.fg} />
        </View>
        <Text style={s.qLabel} numberOfLines={2}>{q.label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// A stats-strip card: pastel bg, white icon chip, a big live count, and a label.
// Cascades in like the quick-action tiles and scales down while pressed.
// count === null → still loading (shows a spinner). Tapping opens the Action Board.
function StatCard({ st: stat, count, index, onPress }) {
  const anim = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
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
        style={[s.statCard, { backgroundColor: stat.bg }]} activeOpacity={0.9}
        onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}
      >
        <View style={s.statChip}>
          <Icon lib={stat.lib} name={stat.name} size={22} color={stat.fg} />
        </View>
        {count === null
          ? <ActivityIndicator color={stat.fg} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
          : <Text style={[s.statCount, { color: stat.fg }]}>{count}</Text>}
        <Text style={s.statLabel}>{stat.label}</Text>
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

// The header bell — rings/shakes in short bursts (every few seconds) while there
// are unread notifications; sits still when `active` is false.
function RingingBell({ active }) {
  const rot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { rot.stopAnimation(() => rot.setValue(0)); return; }
    const ring = Animated.sequence([
      Animated.timing(rot, { toValue: 1,  duration: 110, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: -1, duration: 220, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: 1,  duration: 220, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: -1, duration: 220, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(rot, { toValue: 0,  duration: 110, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(3200),
    ]);
    const loop = Animated.loop(ring);
    loop.start();
    return () => loop.stop();
  }, [active, rot]);
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-16deg', '16deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Ionicons name="notifications-outline" size={26} color={COLORS.navy} />
    </Animated.View>
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
  const arrowH = arrowW * (52 / 230); // taller viewBox (below) gives the arrowhead top headroom
  return (
    <Animated.View style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingTop: arrowH * 0.42 }, style]}>
      <View style={{ justifyContent: 'center', overflow: 'visible' }}>
        {/* Orange 369-style arrow BEHIND the name: swoops down into a V dip,
            then up to the arrowhead. Rendered first + absolute → sits behind.
            Sized from the measured text width so it fits any name length. */}
        {arrowW > 0 && (
          <Svg width={arrowW} height={arrowH} viewBox="0 -8 230 52" style={[s.helloArrow, { top: -arrowH * 0.39 }]} pointerEvents="none">
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

function HomeTab({ name, onOpen, uid, workdayLocked, workdayOpen, dayDone, onNeedPair }) {
  // Fetch the user's role so admin-only tiles can be hidden from regular users.
  // Default to admin=true optimistically until the role resolves, then correct —
  // but hold tile render until we know, to avoid a flash of admin tiles.
  const [isAdmin, setIsAdmin] = useState(null); // null = still resolving
  // Coarse role for the stats-strip card set: 'admin' | 'client' | 'developer'.
  const [role, setRole] = useState(null); // null = still resolving

  useEffect(() => {
    (async () => {
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) { setIsAdmin(true); setRole('admin'); return; } // offline demo → show all
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        // The KRA/KPI role (kpi_role: admin|client|user) is the single source of
        // truth — the same value Login Management's dropdown sets. 'user' is this
        // screen's 'developer'. Falls back to the flags on an older server.
        const kpiRole = (info && info.kpi_role) || '';
        const admin = kpiRole ? kpiRole === 'admin'
          : !!(info && (info.is_system || info.is_owner || info.is_admin));
        const r = kpiRole
          ? (kpiRole === 'admin' ? 'admin' : kpiRole === 'client' ? 'client' : 'developer')
          : (admin ? 'admin' : (info && info.is_client ? 'client' : 'developer'));
        log.info('home role', { kpi_role: kpiRole, admin, role: r, login: info?.login });
        setIsAdmin(admin);
        setRole(r);
      } catch (e) {
        log.warn('role check failed, defaulting to non-admin', e?.message);
        setIsAdmin(false);
        setRole('developer');
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

  // Live task-status counts for the stats strip.
  // null = still loading (cards show a spinner); {} on failure → cards show 0.
  //
  // Role decides the SOURCE. /kra_kpi/tasks/get is the developer/admin board feed
  // and returns NOTHING for a client, so using it for everyone made every client's
  // stats read 0 while they actually had tasks. Clients read the client portal
  // dashboard instead — the same feed My Requests uses.
  const [lanes, setLanes] = useState(null);
  useEffect(() => {
    if (!role) return undefined;        // wait for the role, or we'd pick the wrong source
    let alive = true;
    (async () => {
      try {
        if (role === 'client') {
          const d = await getClientDashboard('all');
          // Count from the task list rather than the portal's `totals`: totals has
          // no `awaiting_client` key (only all/assigned/in_progress/paused/
          // partially_completed/completed), so that card would read 0 — the very
          // bug being fixed. Counting task_state also guarantees Home agrees with
          // the My Requests list, which derives its chips the same way.
          // Shaped like groupIntoLanes' output so StatCard is untouched: it only
          // ever reads `lanes[key].length`.
          const kpis = d.kpis || [];
          const asLanes = {};
          CLIENT_STATS.forEach((k) => {
            asLanes[k] = { length: kpis.filter((t) => t.task_state === k).length };
          });
          if (alive) setLanes(asLanes);
        } else {
          const { tasks } = await fetchTasks();
          if (alive) setLanes(groupIntoLanes(tasks));
        }
      } catch (e) {
        log.warn('home stats failed', e?.message);
        if (alive) setLanes({});
      }
    })();
    return () => { alive = false; };
  }, [role]);

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
    // Leave edit mode on the way out, so re-opening the drawer is back to normal
    // (tap = navigate) instead of silently still being in reorder mode.
    // Nothing to save here: each drop already persisted via onSectionOrder →
    // saveMenuOrder, so the last arrangement is stored even if they close mid-edit.
    setMenuEditing(false);
    setMenuDragging(false);
    Animated.timing(drawerAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => setDrawerMounted(false));
  };
  const drawerSlide = { transform: [{ translateX: drawerAnim.interpolate({ inputRange: [0, 1], outputRange: [-Math.min(300, SW * 0.82) - 20, 0] }) }] };

  // Entrance transition: fade in + slide up when the Home page mounts (replays
  // every time you return to Home from a sub-screen, since it re-mounts).
  // Logo reveal. 0 = logo bold and alone, 1 = settled into a faint watermark with
  // the content over it. Starts at 1 when the intro has already played this
  // launch, so returning to Home is instant.
  const reveal = useRef(new Animated.Value(INTRO_DONE ? 1 : 0)).current;
  const introHold = INTRO_DONE ? 0 : INTRO_HOLD_MS;

  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    enter.setValue(0);
    if (!INTRO_DONE) {
      log.info('logo intro: playing (first Home of this launch)', { holdMs: INTRO_HOLD_MS });
      Animated.timing(reveal, {
        toValue: 1, duration: 700, delay: INTRO_HOLD_MS,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start(() => log.info('logo intro: settled to watermark'));
      INTRO_DONE = true;   // set immediately: a fast back-and-forth must not replay it
    } else {
      log.info('logo intro: skipped (already shown this launch) — instant tiles');
    }
    Animated.timing(enter, {
      // Wait for the logo's moment on a cold launch; instant on every later visit.
      toValue: 1, duration: 420, delay: introHold ? introHold + 200 : 0,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    // introHold/reveal are captured once per mount — intentionally not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enter]);
  const enterStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
  };
  // Bold → faint, with a slight settle, so it reads as a deliberate reveal rather
  // than a loading gap. Opacity + scale only → stays on the native driver.
  const watermarkStyle = {
    opacity: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.30, 0.09] }),
    transform: [{ scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [1.06, 1] }) }],
  };

  // Tiles the user's role is allowed to see (the full menu — always in the drawer).
  // Role-aware: admin = everything (minus the client-only My Requests and the
  // self-scoped My Workday — admins use the team-wide reports instead); client =
  // the two upload tiles + My Requests; developer = the shared board (non-admin tiles).
  const roleTiles = isAdmin
    ? QUICK.filter((q) => !['mytasks', 'myworkday', 'myinvoices', 'mysnapshots'].includes(q.dest))
    : role === 'client'
      ? QUICK.filter((q) => ['upload:requirement', 'upload:update', 'upload:bug', 'mytasks', 'myinvoices', 'usermanual'].includes(q.dest))
      : QUICK.filter((q) => !q.adminOnly);

  // Quick Actions customization: which of the role tiles show on the Home grid.
  // selectedKeys = chosen dest keys (null until loaded → default to all role tiles).
  // The drawer always shows every role tile, so hiding one here never hides it fully.
  const [selectedKeys, setSelectedKeys] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [draftKeys, setDraftKeys] = useState([]);

  // Side-menu order — the user can drag the drawer items into any order they
  // like (every role, not just admins). null = never reordered → natural order.
  const [menuOrder, setMenuOrder] = useState(null);
  const [menuEditing, setMenuEditing] = useState(false);
  // True only while a row is actually being dragged → freezes the drawer's
  // ScrollView so it can't steal the gesture out from under the lifted row.
  const [menuDragging, setMenuDragging] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await getMenuOrder(uid);
      if (alive) setMenuOrder(saved);
    })();
    return () => { alive = false; };
  }, [uid]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await getQuickActions(uid);
      if (alive) setSelectedKeys(saved); // null = not customized → show all (default)
    })();
    return () => { alive = false; };
  }, [uid]);

  // Grid tiles = role tiles filtered by the saved selection (default: all).
  const gridTiles = selectedKeys
    ? roleTiles.filter((q) => selectedKeys.includes(q.dest))
    : roleTiles;

  // Drawer tiles in the user's saved order. Anything not in the saved list (a
  // newly added tile, or one that appeared with a role change) keeps its natural
  // position at the end rather than vanishing.
  const menuTiles = useMemo(() => {
    if (!menuOrder) return roleTiles;
    const left = new Map(roleTiles.map((t) => [t.dest, t]));
    const out = [];
    menuOrder.forEach((d) => { if (left.has(d)) { out.push(left.get(d)); left.delete(d); } });
    left.forEach((t) => out.push(t));
    return out;
  }, [roleTiles, menuOrder]);

  // Reorder WITHIN a section — a drag never crosses a heading, so there's no
  // "moved to another section" step and nothing to confirm. Rebuild the flat saved
  // order: each section in SECTIONS order, using the new within-section order for
  // the one that changed and the current order for the rest.
  const onSectionOrder = useCallback(async (sectionKey, keys) => {
    const grouped = groupBySection(menuTiles);
    const flat = [];
    SECTIONS.forEach((sec) => {
      const g = grouped.find((x) => x.key === sec.key);
      if (!g) return;
      if (sec.key === sectionKey) flat.push(...keys);
      else flat.push(...g.tiles.map((t) => t.dest));
    });
    setMenuOrder(flat);
    await saveMenuOrder(uid, flat);
    log.info('menu order saved', { sectionKey, flat });
  }, [menuTiles, uid]);

  const openEdit = () => {
    // Seed the draft from the current selection (or all, if not customized yet).
    setDraftKeys(selectedKeys ? [...selectedKeys] : roleTiles.map((q) => q.dest));
    setEditOpen(true);
  };
  const toggleDraft = (dest) => {
    setDraftKeys((prev) => (prev.includes(dest) ? prev.filter((d) => d !== dest) : [...prev, dest]));
  };
  const resetDraft = () => setDraftKeys(roleTiles.map((q) => q.dest));
  const saveEdit = async () => {
    // Keep role order; enforce at least one tile.
    let keys = roleTiles.filter((q) => draftKeys.includes(q.dest)).map((q) => q.dest);
    if (keys.length === 0) keys = [roleTiles[0].dest];
    setSelectedKeys(keys);
    await saveQuickActions(uid, keys);
    log.info('quick actions saved', { keys });
    setEditOpen(false);
  };

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
    {/* Alphalize watermark — the app-side twin of the web's .alphalize-watermark.
        Sits right after the background so it stays BEHIND every control, and
        pointerEvents="none" so it can never swallow a tap.
        Stacked (triangle above the wordmark) rather than using the single
        alphalize.png: that asset is wide — symbol and wordmark side by side — so
        fitting it across the screen leaves both small. Split into the icon + the
        wordmark and both get much bigger in the same space.
        No tintColor (unlike Profile's 369 mark): these are the full-colour assets,
        and tinting would flatten them to a silhouette. */}
    <Animated.View style={[s.homeWatermark, watermarkStyle]} pointerEvents="none">
      <Image
        source={require('../assets/alphalize_icon.png')}
        style={s.homeWatermarkIcon}
        resizeMode="contain"
      />
      {/* numberOfLines + adjustsFontSizeToFit: "alphalize" is 9 characters, so at
          this size it wrapped ("ze" dropped to a second line). This keeps it on
          ONE line and shrinks it to fit instead — on any screen width. */}
      <Text
        style={s.homeWatermarkWord}
        numberOfLines={1}
        adjustsFontSizeToFit
        allowFontScaling={false}
      >
        alphalize
      </Text>
    </Animated.View>
    {/* Header — OUTSIDE the ScrollView on purpose, so the menu (☰) and the bell
        stay put while the page scrolls. Same for every role (all roles render
        this one component). */}
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={openDrawer} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="menu" size={28} color={COLORS.navy} />
      </TouchableOpacity>
      <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />
      <TouchableOpacity onPress={() => onOpen('notifications')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <RingingBell active={unread > 0} />
        {unread > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeTxt}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        )}
      </TouchableOpacity>
    </View>

    <ScrollView style={{ backgroundColor: 'transparent' }} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
      {/* Greeting + Quick Actions animate in together on entry */}
      <Animated.View style={enterStyle}>
      <View style={{ paddingHorizontal: PAD, marginTop: 4 }}>
        <Greeting name={name} />
        <Text style={s.helloSub}>Track, Analyze & Improve your KPIs</Text>
        {/* Workday not started → say so up front, right under the name, instead of
            letting them discover it when a button is missing. Developer-only:
            admins and clients are never locked. */}
        {workdayLocked ? (() => {
          // Same decision as the Action Board button (utils/workdayState.js):
          // Continue (workday still open, unpaired) / Start / ended-for-today.
          const wd = workdayButtonState({ locked: true, workdayOpen: !!workdayOpen, dayDone: !!dayDone });
          return (
            <View style={s.roBar}>
              <Ionicons name={dayDone ? 'checkmark-done' : 'lock-closed'} size={14} color={COLORS.red} />
              <Text style={s.roTxt}>
                {dayDone
                  ? "Read-only — everything except Profile.\nWorkday ended for today."
                  : 'Read-only — everything except Profile.\nStart your workday to work on tasks.'}
              </Text>
              {wd.disabled ? null : (
                <TouchableOpacity style={s.roBtn} onPress={onNeedPair} activeOpacity={0.85}>
                  <Text style={s.roBtnTxt}>{wd.label}</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })() : null}
      </View>

      {/* Stats strip — role-aware live task-status counts. Tapping a card opens
          the Action Board focused on that status. */}
      <Text style={s.section}>Your Tasks</Text>
      {role === null ? (
        <View style={s.quickLoading}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <View style={s.statGrid}>
          {statsForRole(role).map((stat, i) => (
            <StatCard
              key={stat.key}
              st={stat}
              count={lanes ? (lanes[stat.key] || []).length : null}
              index={i}
              // A client has no Action Board (it loads 0 tasks for them), so their
              // stats open My Requests instead of a dead-end status view.
              onPress={() => onOpen(role === 'client' ? 'mytasks' : 'status:' + stat.key)}
            />
          ))}
        </View>
      )}

      {/* Quick Actions — wait for the role to resolve so we never flash the
          wrong tile set (admin vs non-admin). Pencil (when there's >1 to choose
          from) opens the customization popup. */}
      <View style={s.sectionRow}>
        <Text style={[s.section, s.sectionFlush]}>Quick Actions</Text>
        {isAdmin !== null && roleTiles.length > 1 ? (
          <TouchableOpacity onPress={openEdit} style={s.editBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="pencil" size={16} color={COLORS.primary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {isAdmin === null ? (
        <View style={s.quickLoading}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : (
        // Grouped by section — a sub-heading appears above a group only when it
        // has at least one shown tile (e.g. add Configuration → a "Settings"
        // heading shows above it).
        <View>
          {groupBySection(gridTiles).map((g) => (
            <View key={g.key}>
              <Text style={s.gridSection}>{g.label}</Text>
              <View style={s.grid}>
                {g.tiles.map((q, i) => (
                  <AnimatedTile key={q.label} q={q} index={i} onPress={() => onTile(q)} />
                ))}
              </View>
            </View>
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
          {/* MENU + the reorder pencil (sits under the X, opposite the label). */}
          <View style={s.drawerLabelRow}>
            <Text style={[s.drawerLabel, { marginBottom: 0, marginTop: 0 }]}>MENU</Text>
            <View style={{ flex: 1 }} />
            {/* Nothing to reorder with a single item — offering the pencil there
                promises something the list can't deliver. (A client, for example,
                may have just one tile.) */}
            {menuTiles.length > 1 && (
              <TouchableOpacity
                onPress={() => setMenuEditing((v) => !v)}
                style={[s.menuEditBtn, menuEditing && s.menuEditBtnOn]}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={menuEditing ? 'checkmark' : 'pencil'}
                  size={14}
                  color={menuEditing ? '#fff' : COLORS.primary}
                />
              </TouchableOpacity>
            )}
          </View>
          {menuEditing && menuTiles.length > 1 && (
            <Text style={s.menuHint}>Hold an item, then drag it to reorder. Tapping is off while editing.</Text>
          )}
          {/* scrollEnabled=false while dragging: the ScrollView is the row's
              ancestor and would otherwise claim the touch the moment the finger
              moves, leaving the lifted row stuck in place. */}
          <ScrollView showsVerticalScrollIndicator={false} scrollEnabled={!menuDragging}>
            {isAdmin === null && <ActivityIndicator color={COLORS.primary} style={{ marginTop: 20 }} />}
            {/* One group per section, each with its sub-heading. Reorder stays
                within a section (drag never crosses a heading). */}
            {isAdmin !== null && groupBySection(menuTiles).map((g) => (
              <View key={g.key}>
                <Text style={s.menuSection}>{g.label}</Text>
                <ReorderableMenu
                  items={g.tiles}
                  // Can never be "editing" with one item: the pencil is hidden there,
                  // so there'd be no way to switch it off — and editing disables
                  // tapping, which would leave that lone tile permanently dead.
                  editing={menuEditing && menuTiles.length > 1}
                  onPress={onTile}
                  onOrder={(keys) => onSectionOrder(g.key, keys)}
                  onDragStateChange={setMenuDragging}
                />
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>

    {/* Customize Quick Actions — checklist popup. Everything stays in the drawer,
        so unchecking a tile only removes it from the Home grid. */}
    <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
      <View style={s.editWrap}>
        <View style={s.editCard}>
          <View style={s.editHead}>
            <Text style={s.editTitle}>Edit Quick Actions</Text>
            <TouchableOpacity onPress={() => setEditOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={COLORS.muted} />
            </TouchableOpacity>
          </View>
          <Text style={s.editSub}>Choose which shortcuts appear on your Home. The rest stay in the menu.</Text>
          <ScrollView style={{ maxHeight: SH * 0.42 }} showsVerticalScrollIndicator persistentScrollbar>
            {groupBySection(roleTiles).map((g) => (
              <View key={g.key}>
                <Text style={s.editSection}>{g.label}</Text>
                {g.tiles.map((q) => {
                  const on = draftKeys.includes(q.dest);
                  return (
                    <TouchableOpacity key={q.dest} style={s.editRow} onPress={() => toggleDraft(q.dest)} activeOpacity={0.7}>
                      <View style={[s.editRowIcon, { backgroundColor: q.bg }]}>
                        <Icon lib={q.lib} name={q.name} size={18} color={q.fg} />
                      </View>
                      <Text style={s.editRowTxt}>{q.label}</Text>
                      <Ionicons
                        name={on ? 'checkbox' : 'square-outline'}
                        size={22}
                        color={on ? COLORS.primary : COLORS.faint}
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </ScrollView>
          <View style={s.editBtns}>
            <TouchableOpacity style={[s.editActBtn, s.editSave]} onPress={saveEdit} activeOpacity={0.85}>
              <Ionicons name="checkmark" size={18} color="#fff" />
              <Text style={s.editSaveTxt}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </>
  );
}

// PROFILE — user + Odoo connection details (like a rental-app account page) + logout.
function ProfileTab({ user, onLogout, dayDone, avatar, setAvatar }) {
  const rows = [
    { icon: 'person-outline',   label: 'Name',     value: user?.name || '—' },
    { icon: 'at-outline',       label: 'Username', value: user?.username || user?.login || '—' },
    // App (non-Odoo) login mobile number — only shown when the user logged in via
    // mobile# + password (Odoo device-setup logins have none).
    ...(user?.mobile ? [{ icon: 'call-outline', label: 'Mobile', value: user.mobile }] : []),
    { icon: 'server-outline',   label: 'Database', value: user?.db || '—' },
    { icon: 'globe-outline',    label: 'Server',   value: user?.serverUrl || '—' },
    { icon: 'finger-print-outline', label: 'User ID', value: user?.uid != null ? String(user.uid) : '—' },
  ];
  const initials = (user?.name || 'U').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  const [logoutOpen, setLogoutOpen] = useState(false);

  const online = !!user?.serverUrl;

  // Entrance transition — mirrors HomeTab (same 420ms / Easing.out(cubic)) so
  // switching tabs feels like one app. Two staggered values: the header drops in
  // with the avatar scaling up, then the details rise behind it. Replays on every
  // mount, i.e. each time you come back to the tab.
  const enter = useRef(new Animated.Value(0)).current;      // header
  const enterBody = useRef(new Animated.Value(0)).current;  // details below
  useEffect(() => {
    enter.setValue(0);
    enterBody.setValue(0);
    Animated.stagger(110, [
      Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(enterBody, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [enter, enterBody]);

  const headStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) }],
  };
  const avatarStyle = {
    transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
  };
  const bodyStyle = {
    opacity: enterBody,
    transform: [{ translateY: enterBody.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) }],
  };

  // KRA/KPI role (Admin / Client / User) — mirrors the "KRA / KPI Role" field on
  // the Odoo user form. This is the app's OWN role, not the Odoo Role
  // (User/Administrator), which is why a user can be an Odoo "User" but a KRA/KPI
  // "Client". Resolved from /kpi_user/info, the same source the Home tiles use.
  const [kpiRole, setKpiRole] = useState(null);
  // True while the app password is still the default 1111 (freshly created / admin
  // reset). Turns the Forgot Password button red to nag them to set their own;
  // cleared automatically once they change it (server flips must_change to false).
  const [mustChange, setMustChange] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) return;                       // offline demo → no badge
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        if (!alive || !info) return;
        setMustChange(!!info.must_change);
        // Read the KRA/KPI role straight off the server (res.users.kpi_role:
        // admin | client | developer) — the same single value Login Management's
        // dropdown sets. No re-deriving from group flags: one field, one answer.
        // `developer` is shown as "User", matching _compute_kpi_role's help text.
        const BADGE = {
          admin:     { label: 'Admin',  bg: '#EDE9FE', fg: '#6D28D9', icon: 'shield-checkmark' },
          client:    { label: 'Client', bg: '#CFFAFE', fg: '#0E7490', icon: 'business' },
          developer: { label: 'User',   bg: '#DBEAFE', fg: '#1D4ED8', icon: 'person' },
        };
        // Fallback to the flags only if the server predates kpi_role on this route.
        const key = info.kpi_role
          || ((info.is_system || info.is_owner || info.is_admin) ? 'admin'
            : info.is_client ? 'client' : 'developer');
        log.info('profile kpi role', {
          kpi_role: info.kpi_role, resolved: key, login: info.login, status: info.status,
        });
        setKpiRole(BADGE[key] || BADGE.developer);   // never leave the badge blank
      } catch (e) {
        log.warn('profile role failed', e?.message);
      }
    })();
    return () => { alive = false; };
  }, [user?.uid]);

  // ── Profile photo (local-only) ─────────────────────────────────────────────
  // Stored as a base64 data URI on this device (AsyncStorage), so it's cleared on
  // uninstall/clear-data. null = none → show the name initials.
  // avatar + setAvatar come from HomeScreen (lifted state + cache) so there's no
  // initials-flash when switching to this tab.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false); // in-app camera (expo-camera)
  const [rationale, setRationale] = useState(null); // null | 'gallery' — pre-permission popup (gallery only)

  // Persist a freshly-picked image by COPYING it into the app's document dir and
  // storing the file path (NOT base64 — base64 of a full photo spikes memory and
  // Android kills/reloads the app on capture-return). Local-only: the doc dir +
  // AsyncStorage are both wiped on uninstall / clear-data.
  const handlePicked = async (srcUri) => {
    try {
      const dest = `${FileSystem.documentDirectory}avatar_${user?.uid ?? 'me'}_${Date.now()}.jpg`;
      // Remove any previous avatar file so they don't pile up.
      try { if (avatar && avatar.startsWith('file')) await FileSystem.deleteAsync(avatar, { idempotent: true }); } catch (_) {}
      await FileSystem.copyAsync({ from: srcUri, to: dest });
      setAvatar(dest);
      await saveAvatar(user?.uid, dest);
      log.info('avatar saved (file)', { dest });
    } catch (e) {
      log.warn('avatar persist failed, using source uri', e?.message);
      setAvatar(srcUri);
      await saveAvatar(user?.uid, srcUri);
    } finally {
      setPickerOpen(false);
    }
  };

  // launch* = request OS permission (shows the system dialog) then pick.
  const launchGallery = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      log.info('avatar: photos permission', { granted: perm.granted, status: perm.status });
      if (!perm.granted) { setPickerOpen(false); return Alert.alert('Photos permission needed', 'Enable photo access in Settings to choose a picture.'); }
      log.info('avatar: opening gallery…');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.5 });
      log.info('avatar: gallery result', { canceled: res.canceled, hasImg: !!res.assets?.[0]?.uri });
      if (!res.canceled && res.assets?.[0]?.uri) handlePicked(res.assets[0].uri);
    } catch (e) { log.warn('avatar: gallery pick failed', e?.message); Alert.alert('Could not open gallery', e?.message || 'Try again.'); }
  };

  // Native pickers/permission dialogs can't present while a RN Modal is still on
  // screen (Android), so we close the popup first and launch after it dismisses.
  const afterClose = (fn) => setTimeout(fn, 350);

  // Camera → in-app camera (expo-camera). Stays inside the app, so capturing +
  // "Use Photo" never kicks the app out (no external activity to be killed).
  const pickFromCamera = () => {
    log.info('avatar: camera tapped → in-app camera');
    setPickerOpen(false);
    afterClose(() => setCameraOpen(true));
  };
  // on* = if permission not yet granted, show our styled rationale first (then the
  // OS dialog fires on Continue); if already granted, go straight to the picker.
  const pickFromGallery = async () => {
    const p = await ImagePicker.getMediaLibraryPermissionsAsync();
    log.info('avatar: gallery tapped', { alreadyGranted: p.granted, canAskAgain: p.canAskAgain });
    setPickerOpen(false);
    if (p.granted) return afterClose(launchGallery);
    log.info('avatar: showing photos permission rationale');
    setRationale('gallery');
  };

  const runFilePick = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
      const file = res.assets?.[0];
      log.info('avatar: file result', { canceled: res.canceled, name: file?.name });
      if (res.canceled || !file?.uri) return;
      // File manager has no crop step → auto-fit (cover) into the circle.
      handlePicked(file.uri);
    } catch (e) { log.warn('avatar: file pick failed', e?.message); Alert.alert('Could not open file', e?.message || 'Try again.'); }
  };
  const pickFromFiles = () => {
    log.info('avatar: file manager tapped');
    setPickerOpen(false);
    afterClose(runFilePick);
  };

  const removeAvatar = async () => {
    try { if (avatar && avatar.startsWith('file')) await FileSystem.deleteAsync(avatar, { idempotent: true }); } catch (_) {}
    setAvatar(null);
    await clearAvatar(user?.uid);
    log.info('avatar removed');
  };

  // ── Forgot / change password (OTP flow, reuses the login services) ─────────
  // Only offered for app-login users (they have a mobile). The number can't be
  // changed here — only its password — so we confirm the number, send a WhatsApp
  // OTP, then collect the code + new password on a dedicated page.
  const mobileDigits = String(user?.mobile || '').replace(/\D/g, '');
  const [pwStep, setPwStep] = useState(null); // null | 'confirm' | 'otp'
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState('');
  const [resendIn, setResendIn] = useState(0); // seconds left before "Resend" is allowed

  // Tick the resend cooldown down to 0 while the OTP popup is open.
  useEffect(() => {
    if (pwStep !== 'otp' || resendIn <= 0) return;
    const id = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [pwStep, resendIn]);

  const openForgot = () => { setPwErr(''); setCode(''); setNewPw(''); setNewPw2(''); setResendIn(0); setPwStep('confirm'); };

  const sendCode = async () => {
    setPwBusy(true); setPwErr('');
    try {
      await requestOtp(mobileDigits);         // generic — always proceeds
      log.info('forgot-pw: OTP requested');
      setResendIn(10);                         // 10s before a resend is allowed
      setPwStep('otp');
    } catch (e) {
      log.warn('forgot-pw: send code failed', e?.message);
      setPwErr('Could not send the code. Try again.');
    } finally { setPwBusy(false); }
  };

  const submitNewPw = async () => {
    if (code.replace(/\D/g, '').length < 4) return setPwErr('Enter the 4-digit code.');
    if (newPw.length < 4) return setPwErr('Password must be at least 4 characters.');
    if (newPw !== newPw2) return setPwErr('Passwords do not match.');
    setPwBusy(true); setPwErr('');
    try {
      const res = await verifyOtp(mobileDigits, code.replace(/\D/g, ''), newPw);
      if (!res.ok) { setPwErr(res.error || 'Incorrect or expired code.'); setPwBusy(false); return; }
      // Success — the OTP verify re-authenticated the same user; refresh the
      // stored session and stay logged in.
      await saveSession(res.user);
      log.info('forgot-pw: password changed');
      setMustChange(false);   // they set their own → clear the red 1111 nag immediately
      setPwStep(null);
      Alert.alert('Password changed', 'Your app password has been updated.');
    } catch (e) {
      log.warn('forgot-pw: verify failed', e?.message);
      setPwErr('Could not verify. Try again.');
    } finally { setPwBusy(false); }
  };

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
        {/* Solid single-color header with avatar — drops in on mount */}
        <Animated.View style={[s.profHead, { paddingTop: TOP + 12 }, headStyle]}>
          <Animated.View style={[s.profAvatarWrap, avatarStyle]}>
            <View style={s.profAvatar}>
              {avatar
                ? <Image source={{ uri: avatar }} style={s.profAvatarImg} resizeMode="cover" />
                : <Text style={s.profAvatarTxt}>{initials}</Text>}
            </View>
            {/* Pencil (bottom-right) — add / replace / remove the photo (via popup). */}
            <TouchableOpacity style={s.avatarPencil} onPress={() => { log.info('avatar: source picker opened'); setPickerOpen(true); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
              <Ionicons name="pencil" size={13} color="#fff" />
            </TouchableOpacity>
          </Animated.View>
          <Text style={s.profName}>{user?.name || 'User'}</Text>
          {/* The Odoo login used to sit here. Under the name we show ONLY the
              KRA/KPI role — that's the role that means anything in this app.
              The login is still listed under Connection Details below. */}
          {/* KRA/KPI role — Admin / Client / User */}
          {kpiRole ? (
            <View style={[s.roleBadge, { backgroundColor: kpiRole.bg }]}>
              <Ionicons name={kpiRole.icon} size={12} color={kpiRole.fg} />
              <Text style={[s.roleBadgeTxt, { color: kpiRole.fg }]}>{kpiRole.label}</Text>
            </View>
          ) : null}
          <View style={[s.profPill, online ? s.profPillOn : s.profPillOff]}>
            <View style={[s.profDot, { backgroundColor: online ? '#4ADE80' : '#F59E0B' }]} />
            <Text style={s.profPillTxt}>{online ? 'Connected' : 'Offline'}</Text>
          </View>
        </Animated.View>

        {/* Everything below rises in just after the header (staggered) */}
        <Animated.View style={bodyStyle}>
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

        {/* Forgot / change password — only for app-login users (need a mobile).
            While the password is still the default 1111 (must_change), this same
            button turns RED with a warning so nothing else moves (Log Out stays
            put); it reverts to normal once they set their own. */}
        {user?.mobile ? (
          <TouchableOpacity style={[s.profForgot, mustChange && s.profForgotWarn]} onPress={openForgot} activeOpacity={0.9}>
            <Ionicons name={mustChange ? 'warning-outline' : 'key-outline'} size={18} color={mustChange ? COLORS.red : COLORS.primary} />
            <Text style={[s.profForgotTxt, mustChange && s.profForgotWarnTxt]}>
              {mustChange ? 'Password is 1111 — tap to set your own' : 'Forgot Password'}
            </Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity style={s.profLogout} onPress={() => setLogoutOpen(true)} activeOpacity={0.9}>
          <Ionicons name="log-out-outline" size={20} color="#fff" />
          <Text style={s.logoutTxt}>Log Out</Text>
        </TouchableOpacity>

        <Text style={s.profFooter}>Alphalize KRA & KPI · v1.0</Text>
        </Animated.View>
      </ScrollView>
    </View>

    {/* Profile-photo source picker */}
    <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
      <TouchableOpacity style={s.picWrap} activeOpacity={1} onPress={() => setPickerOpen(false)}>
        <TouchableOpacity activeOpacity={1} style={s.picCard}>
          <View style={s.picHead}>
            <Text style={s.picTitle}>Profile Photo</Text>
            <TouchableOpacity onPress={() => setPickerOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={COLORS.muted} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={s.picRow} onPress={pickFromCamera} activeOpacity={0.7}>
            <View style={[s.picIcon, { backgroundColor: '#E0ECFF' }]}><Ionicons name="camera" size={20} color={COLORS.primary} /></View>
            <Text style={s.picRowTxt}>Camera</Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.faint} />
          </TouchableOpacity>
          <TouchableOpacity style={s.picRow} onPress={pickFromGallery} activeOpacity={0.7}>
            <View style={[s.picIcon, { backgroundColor: '#EDE9FE' }]}><Ionicons name="images" size={20} color="#7C3AED" /></View>
            <Text style={s.picRowTxt}>Gallery</Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.faint} />
          </TouchableOpacity>
          <TouchableOpacity style={s.picRow} onPress={pickFromFiles} activeOpacity={0.7}>
            <View style={[s.picIcon, { backgroundColor: '#DCFCE7' }]}><Ionicons name="folder-open" size={20} color="#16A34A" /></View>
            <Text style={s.picRowTxt}>File manager</Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.faint} />
          </TouchableOpacity>
          {/* Remove — only when a photo is currently set. Reverts to initials. */}
          {avatar ? (
            <TouchableOpacity style={s.picRow} onPress={() => { removeAvatar(); setPickerOpen(false); }} activeOpacity={0.7}>
              <View style={[s.picIcon, { backgroundColor: COLORS.redBg }]}><Ionicons name="trash" size={20} color={COLORS.red} /></View>
              <Text style={[s.picRowTxt, { color: COLORS.red }]}>Remove Photo</Text>
              <Ionicons name="chevron-forward" size={18} color={COLORS.faint} />
            </TouchableOpacity>
          ) : null}
          <Text style={s.picNote}>Saved on this device only — removed if the app is uninstalled or its data is cleared.</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>

    {/* In-app camera (stays inside the app → no reload on capture). */}
    <CameraCaptureModal
      visible={cameraOpen}
      onClose={() => setCameraOpen(false)}
      onCapture={(uri) => { setCameraOpen(false); handlePicked(uri); }}
    />

    {/* Pre-permission rationale — shown before the OS dialog (WhatsApp-style). */}
    <Modal visible={!!rationale} transparent animationType="fade" onRequestClose={() => setRationale(null)}>
      <View style={s.logoutWrap}>
        <View style={s.logoutCard}>
          <View style={s.pwIconWrap}>
            <Ionicons name="images" size={28} color={COLORS.primary} />
          </View>
          <Text style={s.logoutTitle}>Allow Photos</Text>
          <Text style={s.logoutMsg}>
            We need access to your photos to set a profile picture. The photo stays on this device.
          </Text>
          <View style={s.logoutBtns}>
            <TouchableOpacity style={[s.logoutBtn, s.logoutCancel]} onPress={() => { log.info('avatar: photos rationale dismissed'); setRationale(null); }} activeOpacity={0.85}>
              <Text style={s.logoutCancelTxt}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.logoutBtn, s.pwConfirmBtn]}
              onPress={() => { log.info('avatar: photos rationale continue → OS dialog'); setRationale(null); afterClose(launchGallery); }}
              activeOpacity={0.85}
            >
              <Text style={s.logoutConfirmTxt}>Continue</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    {/* Styled logout confirm popup */}
    <Modal visible={logoutOpen} transparent animationType="fade" onRequestClose={() => setLogoutOpen(false)}>
      <View style={s.logoutWrap}>
        <View style={s.logoutCard}>
          <View style={s.logoutIconWrap}>
            <Ionicons name="log-out-outline" size={34} color={COLORS.red} />
          </View>
          <Text style={s.logoutTitle}>Log out?</Text>
          <Text style={s.logoutMsg}>
            You'll need to sign in again with your username and password.
            {dayDone ? " You've ended your workday — logging out won't let you start another one today." : ''}
          </Text>
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

    {/* Forgot-password step 1 — confirm the number whose password changes. */}
    <Modal visible={pwStep === 'confirm'} transparent animationType="fade" onRequestClose={() => setPwStep(null)}>
      <View style={s.logoutWrap}>
        <View style={s.logoutCard}>
          <View style={s.pwIconWrap}>
            <Ionicons name="key-outline" size={30} color={COLORS.primary} />
          </View>
          <Text style={s.logoutTitle}>Change password?</Text>
          <Text style={s.logoutMsg}>
            We'll send a verification code to your WhatsApp number{'\n'}
            <Text style={{ fontWeight: '900', color: COLORS.navy }}>{user?.mobile}</Text>.
            {'\n'}Only this number's password can be changed. Confirm to continue.
          </Text>
          {!!pwErr && <Text style={s.pwErr}>{pwErr}</Text>}
          <View style={s.logoutBtns}>
            <TouchableOpacity style={[s.logoutBtn, s.logoutCancel]} onPress={() => setPwStep(null)} activeOpacity={0.85} disabled={pwBusy}>
              <Text style={s.logoutCancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.logoutBtn, s.pwConfirmBtn]} onPress={sendCode} activeOpacity={0.85} disabled={pwBusy}>
              {pwBusy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="send" size={16} color="#fff" />
                  <Text style={s.logoutConfirmTxt}>Send Code</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    {/* Forgot-password step 2 — popup (like the confirm popup): OTP + new password. */}
    <Modal visible={pwStep === 'otp'} transparent animationType="fade" onRequestClose={() => setPwStep(null)}>
      <KeyboardAvoidingView style={s.logoutWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.pwCard}>
          <View style={s.pwIconWrap}>
            <Ionicons name="lock-closed-outline" size={28} color={COLORS.primary} />
          </View>
          <Text style={s.pwCardTitle}>Set New Password</Text>
          <Text style={s.pwCardSub}>
            Enter the code sent to <Text style={{ fontWeight: '800', color: COLORS.navy }}>{user?.mobile}</Text> and choose a new password.
          </Text>

          <View style={s.pwField}>
            <Ionicons name="chatbubble-ellipses-outline" size={18} color={COLORS.muted} />
            <TextInput
              style={s.pwInput} placeholder="4-digit code" placeholderTextColor={COLORS.faint}
              keyboardType="number-pad" maxLength={4} value={code} onChangeText={setCode} autoFocus
            />
          </View>
          <View style={s.pwField}>
            <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
            <TextInput
              style={s.pwInput} placeholder="New password" placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw} value={newPw} onChangeText={setNewPw}
            />
            <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color={COLORS.muted} />
            </TouchableOpacity>
          </View>
          <View style={s.pwField}>
            <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
            <TextInput
              style={s.pwInput} placeholder="Re-enter password" placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw} value={newPw2} onChangeText={setNewPw2}
            />
          </View>

          {!!pwErr && <Text style={s.pwErr}>{pwErr}</Text>}

          <TouchableOpacity style={s.pwPrimary} onPress={submitNewPw} disabled={pwBusy} activeOpacity={0.9}>
            {pwBusy ? <ActivityIndicator color="#fff" /> : <Text style={s.pwPrimaryTxt}>Verify & Set Password</Text>}
          </TouchableOpacity>
          <View style={s.pwCardLinks}>
            <TouchableOpacity onPress={sendCode} disabled={pwBusy || resendIn > 0}>
              <Text style={[s.pwLink, (pwBusy || resendIn > 0) && s.pwLinkDisabled]}>
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setPwStep(null)} disabled={pwBusy}>
              <Text style={s.pwCancelLink}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    </>
  );
}

export default function HomeScreen({ user, onLogout, onOpen, workdayLocked, workdayOpen, dayDone, onNeedPair }) {
  const [tab, setTab] = useState('home');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const name = (user && user.name) ? user.name.split(' ')[0] : 'Sonia';

  // Avatar lives HERE (not in ProfileTab) so switching Home⇄Profile never flashes
  // the initials before the photo loads — ProfileTab remounts on every tab switch,
  // but HomeScreen doesn't. Seed synchronously from a module cache for instant show.
  const [avatar, setAvatarState] = useState(() => AVATAR_CACHE[user?.uid ?? 'me'] ?? null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const a = await getAvatar(user?.uid);
      if (alive) { AVATAR_CACHE[user?.uid ?? 'me'] = a; setAvatarState(a); }
    })();
    return () => { alive = false; };
  }, [user?.uid]);
  const setAvatar = (v) => { AVATAR_CACHE[user?.uid ?? 'me'] = v; setAvatarState(v); };

  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
        {tab === 'home'    && (
          <HomeTab
            name={name} onOpen={onOpen} uid={user?.uid}
            workdayLocked={workdayLocked} workdayOpen={workdayOpen} dayDone={dayDone} onNeedPair={onNeedPair}
          />
        )}
        {tab === 'profile' && <ProfileTab user={user} onLogout={onLogout} dayDone={dayDone} avatar={avatar} setAvatar={setAvatar} />}
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
            <Text style={s.logoutMsg}>
              You'll need to sign in again with your username and password.
              {dayDone ? " You've ended your workday — logging out won't let you start another one today." : ''}
            </Text>
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
  // "Workday not started" notice, directly under the name. Red because it's a
  // real restriction, not a hint — but it always carries the way out (the
  // Start Workday button), so it's actionable rather than just a scold.
  roBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10,
    backgroundColor: COLORS.redBg, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    borderLeftWidth: 3, borderLeftColor: COLORS.red,
  },
  roTxt: { flex: 1, fontSize: 12, color: COLORS.red, fontWeight: '700', lineHeight: 17 },
  roBtn: { backgroundColor: COLORS.red, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  roBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 12 },

  section: { fontSize: 18, fontWeight: '900', color: COLORS.navy, paddingHorizontal: PAD, marginTop: 26, marginBottom: 14 },
  // Heading row so the pencil sits at the end of the "Quick Actions" title.
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD, marginTop: 26, marginBottom: 14 },
  sectionFlush: { paddingHorizontal: 0, marginTop: 0, marginBottom: 0 },
  // Sub-headings (KRA / Reports / Settings) across the grid, edit popup and drawer.
  gridSection: { fontSize: 13, fontWeight: '900', color: COLORS.muted, letterSpacing: 0.8, paddingHorizontal: PAD, marginTop: 18, marginBottom: 10, textTransform: 'uppercase' },
  editSection: { fontSize: 12, fontWeight: '900', color: COLORS.primary, letterSpacing: 0.8, marginTop: 12, marginBottom: 2, textTransform: 'uppercase' },
  menuSection: { fontSize: 11.5, fontWeight: '900', color: COLORS.primary, letterSpacing: 1, marginTop: 10, marginBottom: 8, textTransform: 'uppercase' },
  editBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#EAF1FE', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D6E4FB' },

  // Edit-Quick-Actions popup
  editWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  editCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, paddingTop: 18, paddingBottom: 16, paddingHorizontal: 18 },
  editHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  editTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  editSub: { fontSize: 13, color: COLORS.muted, lineHeight: 18, marginBottom: 12 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4 },
  editRowIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  editRowTxt: { flex: 1, fontSize: 14.5, fontWeight: '800', color: COLORS.ink },
  editBtns: { flexDirection: 'row', gap: 12, marginTop: 16 },
  editActBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, borderRadius: 14 },
  editReset: { backgroundColor: '#EEF2F8' },
  editResetTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  editSave: { backgroundColor: COLORS.primary },
  editSaveTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  quickLoading: { paddingVertical: 30, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, gap: 12 },
  qCard: {
    width: QW, minHeight: 68, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: '#334155', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  qChip: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  qLabel: { flex: 1, fontSize: 12.5, fontWeight: '800', color: COLORS.ink },

  // Stats strip
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: PAD, gap: 12, marginBottom: 4 },
  statCard: {
    width: STAT_W, minHeight: 108, borderRadius: 18, padding: 16,
    shadowColor: '#334155', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  statChip: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  statCount: { fontSize: 30, fontWeight: '900', marginTop: 8 },
  statLabel: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginTop: 2 },

  // Alphalize watermark behind the Home content — the app-side twin of the web's
  // .alphalize-watermark. Centered, faint, non-interactive.
  //
  // Stacked on purpose: the supplied alphalize.png is one WIDE image (triangle +
  // wordmark side by side, ~3.8:1), so `contain` sizes it by width and both
  // halves end up small however much height it's given. Splitting them lets the
  // triangle fill the width on its own — much bigger in the same space.
  homeWatermark: {
    // Wide enough for the wordmark to sit on one line at this size.
    position: 'absolute', alignSelf: 'center', top: SH * 0.20,
    width: SW * 0.88, alignItems: 'center', opacity: 0.09,
  },
  homeWatermarkIcon: { width: SW * 0.62, height: SW * 0.62 },
  // The word is TEXT, not an image: the only wordmark we have is baked into
  // alphalize.png next to the triangle, so reusing it here would draw a second
  // triangle. At watermark opacity the substitute font reads fine.
  homeWatermarkWord: {
    marginTop: -SW * 0.05,
    // Sized to fit one line at width 0.88*SW; adjustsFontSizeToFit shrinks it
    // further on narrow screens rather than ever wrapping again.
    width: '100%',
    textAlign: 'center',
    fontSize: SW * 0.17,
    lineHeight: SW * 0.20,     // room for descenders — without this the 'p' clips
    fontWeight: '800',
    letterSpacing: -1,
    color: '#0B4F8A',
  },

  // Profile tab
  profRoot: { flex: 1, backgroundColor: COLORS.bg },
  // 369 watermark low on the screen, below the logout button (tinted brand blue).
  profWatermark: { position: 'absolute', alignSelf: 'center', top: SH * 0.74, width: '62%', height: SH * 0.20, opacity: 0.08 },

  profHead: {
    alignItems: 'center', paddingHorizontal: 24, paddingBottom: 30, overflow: 'hidden',
    backgroundColor: COLORS.primary,   // single solid brand blue (no two-tone)
    borderBottomLeftRadius: 30, borderBottomRightRadius: 30,
  },
  profAvatarWrap: { width: 92, height: 92 },
  profAvatar: {
    width: 92, height: 92, borderRadius: 46, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  profAvatarImg: { width: '100%', height: '100%' },
  profAvatarTxt: { color: '#fff', fontSize: 32, fontWeight: '900' },
  avatarPencil: {
    position: 'absolute', right: -2, bottom: -2, width: 30, height: 30, borderRadius: 15,
    backgroundColor: COLORS.primary, borderWidth: 2.5, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  avatarDelete: {
    position: 'absolute', left: -2, top: -2, width: 28, height: 28, borderRadius: 14,
    backgroundColor: COLORS.red, borderWidth: 2.5, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },

  // Profile-photo source picker (centered popup, like the other dialogs)
  picWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  picCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 18 },
  picHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  picTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  picRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
  picIcon: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  picRowTxt: { flex: 1, fontSize: 15.5, fontWeight: '800', color: COLORS.ink },
  picNote: { fontSize: 12, color: COLORS.muted, lineHeight: 17, marginTop: 10, textAlign: 'center' },
  profName: { color: '#fff', fontSize: 23, fontWeight: '900', marginTop: 16, textAlign: 'center' },
  profSub: { color: '#C7D8F7', fontSize: 14, marginTop: 4, textAlign: 'center' },
  // KRA/KPI role pill under the name (Admin / Client / User).
  roleBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9,
    paddingHorizontal: 11, height: 24, borderRadius: 12,
  },
  roleBadgeTxt: { fontSize: 12, fontWeight: '900', letterSpacing: 0.3 },
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
    marginHorizontal: PAD, marginTop: 14, backgroundColor: COLORS.red, borderRadius: 15, height: 54,
    shadowColor: COLORS.red, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  logoutTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  profFooter: { textAlign: 'center', color: COLORS.faint, fontSize: 12, fontWeight: '600', marginTop: 20 },

  // Forgot / change password — secondary button above Log Out.
  profForgot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: PAD, marginTop: 28, backgroundColor: '#EAF1FE', borderRadius: 15, height: 52,
    borderWidth: 1.5, borderColor: COLORS.primary,
  },
  profForgotTxt: { color: COLORS.primary, fontSize: 15.5, fontWeight: '800' },
  // Same button, red, when the password is still the default 1111.
  profForgotWarn: { backgroundColor: COLORS.redBg, borderColor: COLORS.red },
  profForgotWarnTxt: { color: COLORS.red },

  // Confirm popup — blue key icon chip + Send Code button.
  pwIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#EAF1FE', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 14 },
  pwConfirmBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primary },
  pwErr: { color: COLORS.red, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 4, marginBottom: 6 },

  // OTP / new-password popup card (styled like the confirm/logout popup).
  pwCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, paddingTop: 22, paddingBottom: 18, paddingHorizontal: 20 },
  pwCardTitle: { fontSize: 20, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  pwCardSub: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', lineHeight: 19, marginTop: 8, marginBottom: 18 },
  pwField: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F4F7FB',
    borderWidth: 1.5, borderColor: '#E6ECF5', borderRadius: 12, paddingHorizontal: 14, height: 52, marginBottom: 10,
  },
  pwInput: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },
  pwPrimary: { backgroundColor: COLORS.primary, borderRadius: 12, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  pwPrimaryTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  pwCardLinks: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingHorizontal: 4 },
  pwLink: { color: COLORS.primary, fontSize: 14, fontWeight: '700' },
  pwLinkDisabled: { color: COLORS.faint },
  pwCancelLink: { color: COLORS.muted, fontSize: 14, fontWeight: '700' },

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
  // MENU label + the reorder pencil on the opposite side (under the X).
  drawerLabelRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 12 },
  menuEditBtn: {
    width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#EEF3FF', borderWidth: 1, borderColor: '#DCE4F2',
  },
  menuEditBtnOn: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  menuHint: { fontSize: 11.5, color: COLORS.primary, marginTop: -6, marginBottom: 10, fontWeight: '600' },
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
