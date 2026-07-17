// NOTIFICATIONS — in-app feed for task assignment & upload events.
// The server (kra_api.py /kpi_notifications/*) scopes rows to the logged-in
// user, so admins/owner/coordinator see events across all employees while a
// developer sees only their own tasks. This screen just renders whatever the
// feed returns; no role logic here.
//
// Header: back + "Mark all read". Body: FlatList with an unread dot, an
// event icon, title, body preview, task name, and relative time. Pull to
// refresh. Tapping an unread row marks it read.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, SectionList, StyleSheet,
  ActivityIndicator, RefreshControl, StatusBar as RNStatusBar, Animated, Easing,
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
//
// An admin/owner receives ~13 of these, so the COLOUR carries the meaning and the
// feed stays scannable at a glance:
//   red    = urgent, someone is blocked right now
//   amber  = needs YOUR action
//   orange = sent back / rejected
//   green  = good news, nothing to do
//   purple = a decision was recorded
//   blue   = routine activity
const EVENT_ICON = {
  // 🚨 A developer is blocked RIGHT NOW — the loudest thing in the feed.
  urgent_pause:        { lib: 'mc', name: 'alert-octagram',      color: '#DC2626' },

  // ── Needs action (amber) ──
  client_task_queued:  { lib: 'mc', name: 'inbox-arrow-down',    color: '#D97706' },
  internal_approved:   { lib: 'mc', name: 'file-sign',           color: '#D97706' },
  pre_approval_request:  { lib: 'mc', name: 'account-clock',     color: '#D97706' },
  pre_approval_reminder: { lib: 'mc', name: 'bell-ring',         color: '#D97706' },
  partial_timeout:     { lib: 'mc', name: 'timer-sand',          color: '#D97706' },

  // ── Sent back / rejected (orange-red) ──
  internal_rejected:   { lib: 'mc', name: 'backup-restore',      color: '#EA580C' },
  client_task_rejected: { lib: 'mc', name: 'account-cancel',     color: '#EA580C' },

  // ── Good news (green) ──
  final_approved:      { lib: 'mc', name: 'check-decagram',      color: '#16A34A' },
  self_task_accepted:  { lib: 'mc', name: 'clipboard-check',     color: '#16A34A' },

  // ── Decisions recorded (purple) ──
  pre_approval_decided:      { lib: 'mc', name: 'gavel',          color: '#7C3AED' },
  pre_approval_decided_late: { lib: 'mc', name: 'clock-alert',    color: '#7C3AED' },
  pre_approval_held:         { lib: 'mc', name: 'pause-octagon',  color: '#7C3AED' },

  // ── Routine activity (blue / slate) ──
  task_created:        { lib: 'mc', name: 'file-plus',           color: '#2563EB' },
  task_assigned:       { lib: 'mc', name: 'account-arrow-right', color: '#1E40AF' },
  reassigned:          { lib: 'mc', name: 'account-switch',      color: '#7C3AED' },
  task_reassigned:     { lib: 'mc', name: 'account-arrow-left',  color: '#64748B' },
  self_task_submitted: { lib: 'mc', name: 'clipboard-account',   color: '#0891B2' },
  self_task_rejected:  { lib: 'mc', name: 'clipboard-remove',    color: '#EA580C' },
  task_auto_away:      { lib: 'mc', name: 'sleep',               color: '#64748B' },
  workday_auto_closed: { lib: 'mc', name: 'weather-night',       color: '#64748B' },
  daily_report:        { lib: 'mc', name: 'file-chart',          color: '#4338CA' },
};

// Events that mean "someone has to DO something" → the Action needed tab.
const ACTION_EVENTS = new Set([
  'urgent_pause',
  'client_task_queued',
  'self_task_submitted',
  'internal_approved',
  'pre_approval_request',
  'pre_approval_reminder',
  'partial_timeout',
]);

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

function Row({ item, index = 0, onPress, showWho }) {
  // A developer is blocked right now — this must not look like a task-created row.
  const isUrgent = item.event === 'urgent_pause';
  // Admins get almost every event, so show WHO + WHICH CLIENT on the row itself.
  const who = showWho ? [item.developer, item.client_name].filter(Boolean) : [];
  // Staggered entrance: each card fades + slides up, delayed by its index so the
  // rows appear one-by-one (delay capped so long lists don't drag).
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1, duration: 320, delay: Math.min(index, 12) * 55,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [anim, index]);
  const enterStyle = {
    opacity: anim,
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };
  return (
    <Animated.View style={enterStyle}>
    <TouchableOpacity
      style={[s.row, !item.is_read && s.rowUnread, isUrgent && s.rowUrgent]}
      activeOpacity={0.8}
      onPress={() => onPress(item)}
    >
      {/* Colored left edge — event type at a glance. */}
      <View style={[s.rowAccent, { backgroundColor: eventColor(item.event) }]} />
      <EventIcon event={item.event} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={s.rowTop}>
          <Text style={[s.title, !item.is_read && s.titleUnread, isUrgent && s.titleUrgent]} numberOfLines={1}>
            {item.title || 'Notification'}
          </Text>
          {isUrgent && <View style={s.urgentPill}><Text style={s.urgentPillTxt}>URGENT</Text></View>}
          <Text style={s.time}>{relativeTime(item.created_at)}</Text>
        </View>
        {!!item.kpi_name && <Text style={s.task} numberOfLines={1}>{item.kpi_name}</Text>}
        {/* Admin only: 👤 developer · 🏢 client — the two things that tell
            otherwise-identical rows apart. */}
        {who.length > 0 && (
          <View style={s.whoRow}>
            {!!item.developer && (
              <View style={s.whoChip}>
                <Ionicons name="person" size={10} color={COLORS.muted} />
                <Text style={s.whoTxt} numberOfLines={1}>{item.developer}</Text>
              </View>
            )}
            {!!item.client_name && (
              <View style={s.whoChip}>
                <Ionicons name="business" size={10} color={COLORS.muted} />
                <Text style={s.whoTxt} numberOfLines={1}>{item.client_name}</Text>
              </View>
            )}
          </View>
        )}
        {!!item.body && <Text style={s.body} numberOfLines={2}>{item.body}</Text>}
      </View>
      {!item.is_read && <View style={s.dot} />}
    </TouchableOpacity>
    </Animated.View>
  );
}

export default function NotificationsScreen({ onBack, onOpen, isClient = false }) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isMock, setIsMock] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false); // server-resolved; gates the who-line
  const [tab, setTab] = useState('all'); // 'all' | 'unread' | 'action'

  // How many rows actually need someone to act — drives the tab badge.
  const actionCount = useMemo(
    () => items.filter((n) => ACTION_EVENTS.has(n.event)).length,
    [items],
  );

  // Client-side filter (we already hold every row + its is_read flag), then
  // bucket into date sections. Tab switching is instant, no refetch.
  const sections = useMemo(() => {
    let visible = items;
    if (tab === 'unread') visible = items.filter((n) => !n.is_read);
    else if (tab === 'action') {
      // Only the act-on-me rows, urgent first — a blocked developer outranks
      // everything else regardless of when it arrived.
      visible = items
        .filter((n) => ACTION_EVENTS.has(n.event))
        .slice()
        .sort((a, b) => (b.event === 'urgent_pause') - (a.event === 'urgent_pause'));
    }
    return groupByDay(visible);
  }, [items, tab]);

  const load = useCallback(async () => {
    try {
      const res = await fetchNotifications({ limit: 100 });
      setItems(res.items || []);
      setUnread(res.unreadCount || 0);
      setIsMock(!!res.isMock);
      setIsAdmin(!!res.isAdmin);
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
    if (!onOpen) return;
    // Some rows point at something that ISN'T a task. "X ended their workday"
    // opens that day's frozen summary image — checked FIRST because such a row
    // also carries a kpi_id (the arbitrary task _notify was anchored on), and
    // routing on that would dump the admin on an unrelated task.
    // Invoice notifications open the invoice (client → My Invoices, admin →
    // Client Invoices) — checked before kpi_id, which is only the anchor task.
    if (item.invoice_id) {
      log.info('notification → invoice', { invoiceId: item.invoice_id });
      onOpen(isClient ? 'myinvoices' : 'clientinvoices', item.invoice_id);
      return;
    }
    if (item.snapshot_id) {
      log.info('notification → snapshot', { snapshotId: item.snapshot_id });
      onOpen('snapshots', item.snapshot_id);
      return;
    }
    // "Daily report ready" opens that report's PDF on the Daily Reports screen —
    // also checked before kpi_id, for the same reason (it carries an anchor kpi_id).
    if (item.report_id) {
      log.info('notification → daily report', { reportId: item.report_id });
      onOpen('dailyreports', item.report_id);
      return;
    }
    // Role decides the destination. A CLIENT has no Action Board — it loads 0
    // tasks for them and then can't even fetch the row — so their tasks open in
    // My Requests. Uses the KRA/KPI role (kpi_role: admin|client|user), the same
    // single value Login Management shows.
    if (item.kpi_id) {
      onOpen(isClient ? 'mytasks' : 'actionboard', item.kpi_id);
    }
  }, [onOpen, isClient]);

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

      {/* All / Unread / Action needed — each tab shows a count badge. "Action
          needed" is the admin's answer to "what do I actually have to do?",
          since they receive nearly every event type. */}
      <View style={s.tabsBar}>
        {[
          { k: 'all', label: 'All', count: items.length },
          { k: 'unread', label: 'Unread', count: unread },
          { k: 'action', label: 'Action needed', count: actionCount },
        ].map((t) => {
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
          renderItem={({ item, index }) => (
            <Row item={item} index={index} onPress={onRowPress} showWho={isAdmin} />
          )}
          renderSectionHeader={({ section }) => (
            <Text style={s.sectionHeaderTxt}>{section.title.toUpperCase()}</Text>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={sections.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Ionicons
                name={tab === 'all' ? 'notifications-off-outline' : 'checkmark-done-circle-outline'}
                size={40}
                color={COLORS.faint}
              />
              <Text style={s.emptyTxt}>
                {tab === 'action' ? 'Nothing needs your action'
                  : tab === 'unread' ? "You're all caught up"
                  : 'No notifications yet'}
              </Text>
              <Text style={s.emptySub}>
                {tab === 'action'
                  ? 'No urgent pauses, queued client tasks or reviews waiting on you.'
                  : tab === 'unread'
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
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
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
  // 🚨 Urgent — a blocked developer. Tinted + outlined so it can't be mistaken
  // for routine activity in a feed the admin receives everything into.
  rowUrgent: { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' },
  titleUrgent: { color: '#B91C1C', fontWeight: '900' },
  urgentPill: {
    backgroundColor: '#DC2626', borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 2, marginLeft: 6,
  },
  urgentPillTxt: { color: '#fff', fontSize: 9.5, fontWeight: '900', letterSpacing: 0.5 },
  // Colored left edge (event type). Absolute so it fills the card height.
  rowAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 14, fontWeight: '600', color: COLORS.ink },
  titleUnread: { fontWeight: '800', color: COLORS.navy },
  time: { fontSize: 11, color: COLORS.faint, marginLeft: 8 },
  task: { fontSize: 12.5, color: COLORS.primary, marginTop: 2, fontWeight: '600' },
  // Admin-only "who + which client" chips.
  whoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5 },
  whoChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '58%',
    backgroundColor: '#F1F5FB', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  whoTxt: { fontSize: 11, color: COLORS.muted, fontWeight: '700', flexShrink: 1 },
  body: { fontSize: 12.5, color: COLORS.muted, marginTop: 3, lineHeight: 17 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.primary, marginLeft: 8, marginTop: 4 },

  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', paddingHorizontal: 40 },
  emptyTxt: { marginTop: 12, fontSize: 15, fontWeight: '700', color: COLORS.muted },
  emptySub: { marginTop: 4, fontSize: 12.5, color: COLORS.faint, textAlign: 'center' },
});
