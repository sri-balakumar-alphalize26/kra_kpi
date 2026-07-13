// NOTIFICATIONS — in-app feed for task assignment & upload events.
// The server (kra_api.py /kpi_notifications/*) scopes rows to the logged-in
// user, so admins/owner/coordinator see events across all employees while a
// developer sees only their own tasks. This screen just renders whatever the
// feed returns; no role logic here.
//
// Header: back + "Mark all read". Body: FlatList with an unread dot, an
// event icon, title, body preview, task name, and relative time. Pull to
// refresh. Tapping an unread row marks it read.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, SectionList, StyleSheet,
  ActivityIndicator, RefreshControl, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { fetchNotifications, markRead } from '../services/notifications';

const log = createLogger('NotificationsScreen');

const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Per-event icon + accent color. Falls back to a generic bell.
const EVENT_ICON = {
  task_assigned:       { lib: 'mc', name: 'account-arrow-right', color: '#1E40AF' },
  reassigned:          { lib: 'mc', name: 'account-switch',      color: '#7C3AED' },
  task_created:        { lib: 'mc', name: 'file-plus',           color: '#2563EB' },
  self_task_submitted: { lib: 'mc', name: 'clipboard-account',   color: '#0891B2' },
};

// "just now" / "5m ago" / "3h ago" / "2d ago" / date. `created` is a server
// string like "2026-07-13 10:15:00" already in the user's timezone.
function relativeTime(created) {
  if (!created) return '';
  const then = new Date(created.replace(' ', 'T'));
  if (isNaN(then.getTime())) return created;
  const diff = Date.now() - then.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString();
}

// The accent color for an event type (used by the icon + the row left-edge).
function eventColor(event) {
  return (EVENT_ICON[event] && EVENT_ICON[event].color) || COLORS.primary;
}

// Parse a server datetime string ("YYYY-MM-DD HH:MM:SS", already in user tz).
function parseCreated(created) {
  if (!created) return null;
  const d = new Date(String(created).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

// Bucket rows into Today / Yesterday / Earlier sections (drops empty ones).
function groupByDay(list) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const today = [], yesterday = [], earlier = [];
  for (const n of list) {
    const d = parseCreated(n.created_at);
    const t = d ? d.getTime() : 0;
    if (t >= startOfToday) today.push(n);
    else if (t >= startOfYesterday) yesterday.push(n);
    else earlier.push(n); // includes unparseable dates
  }
  const out = [];
  if (today.length) out.push({ title: 'Today', data: today });
  if (yesterday.length) out.push({ title: 'Yesterday', data: yesterday });
  if (earlier.length) out.push({ title: 'Earlier', data: earlier });
  return out;
}

function EventIcon({ event }) {
  const cfg = EVENT_ICON[event] || { lib: 'ion', name: 'notifications-outline', color: COLORS.primary };
  return (
    <View style={[s.iconWrap, { backgroundColor: cfg.color + '18' }]}>
      {cfg.lib === 'mc'
        ? <MaterialCommunityIcons name={cfg.name} size={20} color={cfg.color} />
        : <Ionicons name={cfg.name} size={20} color={cfg.color} />}
    </View>
  );
}

function Row({ item, onPress }) {
  return (
    <TouchableOpacity
      style={[s.row, !item.is_read && s.rowUnread]}
      activeOpacity={0.8}
      onPress={() => onPress(item)}
    >
      {/* Colored left edge — event type at a glance. */}
      <View style={[s.rowAccent, { backgroundColor: eventColor(item.event) }]} />
      <EventIcon event={item.event} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={s.rowTop}>
          <Text style={[s.title, !item.is_read && s.titleUnread]} numberOfLines={1}>
            {item.title || 'Notification'}
          </Text>
          <Text style={s.time}>{relativeTime(item.created_at)}</Text>
        </View>
        {!!item.kpi_name && <Text style={s.task} numberOfLines={1}>{item.kpi_name}</Text>}
        {!!item.body && <Text style={s.body} numberOfLines={2}>{item.body}</Text>}
      </View>
      {!item.is_read && <View style={s.dot} />}
    </TouchableOpacity>
  );
}

export default function NotificationsScreen({ onBack, onOpen }) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [tab, setTab] = useState('all'); // 'all' | 'unread'

  // Client-side filter (we already hold every row + its is_read flag), then
  // bucket into date sections. Tab switching is instant, no refetch.
  const sections = useMemo(() => {
    const visible = tab === 'unread' ? items.filter((n) => !n.is_read) : items;
    return groupByDay(visible);
  }, [items, tab]);

  const load = useCallback(async () => {
    try {
      const res = await fetchNotifications({ limit: 100 });
      setItems(res.items || []);
      setUnread(res.unreadCount || 0);
      setIsMock(!!res.isMock);
    } catch (e) {
      log.warn('load failed', e?.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Tap a row → navigate to the task on the Action Board (and pulse its card),
  // marking the row read on the way if it was unread. Already-read rows still
  // navigate — only the mark-read side-effect is skipped for them.
  const onRowPress = useCallback(async (item) => {
    if (!item.is_read) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, is_read: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
      try {
        const { unreadCount } = await markRead([item.id]);
        setUnread(unreadCount);
      } catch (e) {
        log.warn('markRead failed', e?.message);
      }
    }
    if (onOpen && item.kpi_id) onOpen('actionboard', item.kpi_id);
  }, [onOpen]);

  const onMarkAll = useCallback(async () => {
    if (!unread) return;
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    try {
      const { unreadCount } = await markRead(); // no ids → all
      setUnread(unreadCount);
    } catch (e) {
      log.warn('markRead all failed', e?.message);
    }
  }, [unread]);

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      {/* Header — balanced: back button (left) + Mark-all icon (right) are the
          same width so the title sits truly centered. */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <View style={s.hTitleWrap}>
          <Text style={s.hTitle} numberOfLines={1}>Notifications</Text>
          {unread > 0 && (
            <View style={s.hCount}><Text style={s.hCountTxt}>{unread > 99 ? '99+' : unread}</Text></View>
          )}
        </View>
        <TouchableOpacity
          onPress={onMarkAll}
          disabled={!unread}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={[s.iconBtn, s.markAllBtn, !unread && s.markAllBtnOff]}
          accessibilityLabel="Mark all read"
        >
          <Ionicons name="checkmark-done" size={20} color={unread ? COLORS.primary : COLORS.faint} />
        </TouchableOpacity>
      </View>

      {/* All / Unread segmented control — each tab shows a count badge. */}
      <View style={s.tabsBar}>
        {[{ k: 'all', label: 'All', count: items.length }, { k: 'unread', label: 'Unread', count: unread }].map((t) => {
          const on = tab === t.k;
          return (
            <TouchableOpacity
              key={t.k}
              style={[s.tab, on && s.tabOn]}
              activeOpacity={0.85}
              onPress={() => setTab(t.k)}
            >
              <Text style={[s.tabTxt, on && s.tabTxtOn]}>{t.label}</Text>
              {t.count > 0 && (
                <View style={[s.tabBadge, on && s.tabBadgeOn]}>
                  <Text style={[s.tabBadgeTxt, on && s.tabBadgeTxtOn]}>{t.count > 99 ? '99+' : t.count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to load live notifications</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(it) => String(it.id)}
          renderItem={({ item }) => <Row item={item} onPress={onRowPress} />}
          renderSectionHeader={({ section }) => (
            <Text style={s.sectionHeaderTxt}>{section.title.toUpperCase()}</Text>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={sections.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Ionicons
                name={tab === 'unread' ? 'checkmark-done-circle-outline' : 'notifications-off-outline'}
                size={40}
                color={COLORS.faint}
              />
              <Text style={s.emptyTxt}>{tab === 'unread' ? "You're all caught up" : 'No notifications yet'}</Text>
              <Text style={s.emptySub}>
                {tab === 'unread'
                  ? 'No unread notifications right now.'
                  : "You'll see task assignments and uploads here."}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  // Square rounded white button — matches the back button on the Upload /
  // Action Board screens. Both header controls share this so the title centers.
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  markAllBtn: {},
  markAllBtnOff: { opacity: 0.55 },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  hTitle: { textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy },
  hCount: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  hCountTxt: { color: '#fff', fontSize: 11, fontWeight: '800' },

  // All / Unread segmented control (transparent so the gradient shows through)
  tabsBar: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8,
    backgroundColor: 'transparent',
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 8, borderRadius: 10,
    backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line,
  },
  tabOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tabTxt: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  tabTxtOn: { color: '#fff' },
  // Count badge on each tab.
  tabBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: COLORS.line, alignItems: 'center', justifyContent: 'center',
  },
  tabBadgeOn: { backgroundColor: '#FFFFFF3D' },
  tabBadgeTxt: { fontSize: 10.5, fontWeight: '800', color: COLORS.muted },
  tabBadgeTxtOn: { color: '#fff' },

  // Date section headers
  sectionHeaderTxt: {
    fontSize: 11, fontWeight: '800', color: COLORS.faint, letterSpacing: 0.6,
    marginTop: 6, marginBottom: 8, marginLeft: 4,
  },

  mockBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14,
  },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: COLORS.card, borderRadius: 14, padding: 14, paddingLeft: 18,
    marginBottom: 10, overflow: 'hidden', ...SHADOW,
  },
  rowUnread: { backgroundColor: '#F0F5FF' },
  // Colored left edge (event type). Absolute so it fills the card height.
  rowAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 14, fontWeight: '600', color: COLORS.ink },
  titleUnread: { fontWeight: '800', color: COLORS.navy },
  time: { fontSize: 11, color: COLORS.faint, marginLeft: 8 },
  task: { fontSize: 12.5, color: COLORS.primary, marginTop: 2, fontWeight: '600' },
  body: { fontSize: 12.5, color: COLORS.muted, marginTop: 3, lineHeight: 17 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.primary, marginLeft: 8, marginTop: 4 },

  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', paddingHorizontal: 40 },
  emptyTxt: { marginTop: 12, fontSize: 15, fontWeight: '700', color: COLORS.muted },
  emptySub: { marginTop: 4, fontSize: 12.5, color: COLORS.faint, textAlign: 'center' },
});
