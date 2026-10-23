// EMPLOYEE TRACKER — the team-wide presence / productive report, per person, per
// period, with each period's sessions and per-task breakdown underneath.
//
// The app had no team report at all. HomeScreen hides My Workday from admins
// saying "admins use the team-wide reports instead" — which existed only on the
// web, so an admin on a phone could see nobody's day but their own, and not even
// that.
//
// A VIEWER, deliberately. Every figure here — productive, presence, paused, the
// per-task durations — is computed and formatted server-side by
// /kpi_reports/developer_summary, including the live folding-in of a RUNNING time
// log (which stores a duration of 0 until it stops). Recomputing any of it here
// would be a second opinion that drifts from the web's, which is exactly the
// class of bug this catch-up has spent its time removing.

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, ScrollView, Modal, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import {
  fetchDeveloperSummary, fetchTrackerEmployees, TIME_FRAMES,
} from '../services/employeeTracker';
import { createLogger } from '../api/logger';
import * as H from '../utils/haptics';

const log = createLogger('EmployeeTracker');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

export default function EmployeeTracker({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [expanded, setExpanded] = useState({});

  const [timeFrame, setTimeFrame] = useState('daily');
  const [userId, setUserId] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [pickUser, setPickUser] = useState(false);

  // The newest request wins: switching the time frame or the person twice in
  // quick succession fired two requests, and the slower one landed last and
  // showed the wrong period under the chip that was tapped.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError(null);
    try {
      const res = await fetchDeveloperSummary({ timeFrame, userId });
      if (seq !== loadSeq.current) return;
      if (res && res.status === false) {
        // The route answers "Not authorized." below Coordinator rather than
        // raising, so it must be READ, not assumed to be an empty team.
        setError(res.message || 'Could not load the report.');
        setPeriods([]);
        return;
      }
      setPeriods(res?.periods || []);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load the report.');
      setPeriods([]);
    }
  }, [timeFrame, userId]);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  useEffect(() => {
    (async () => { setEmployees(await fetchTrackerEmployees()); })();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Keyed by user AND period: the same date appears once per person, so keying by
  // the period alone would open every developer's row at once.
  const rowKey = (p) => `${p.user_id}:${p.period_key}`;
  const toggle = (p) => {
    H.select();
    const k = rowKey(p);
    setExpanded((e) => ({ ...e, [k]: !e[k] }));
  };

  const chosenName = userId
    ? (employees.find((e) => e.id === userId)?.name || 'Selected person')
    : 'Everyone';

  const renderPeriod = ({ item }) => {
    const open = !!expanded[rowKey(item)];
    return (
      <View style={s.card}>
        <TouchableOpacity style={s.head} onPress={() => toggle(item)} activeOpacity={0.7}>
          <View style={{ flex: 1 }}>
            <Text style={s.who} numberOfLines={1}>{item.user_name}</Text>
            <Text style={s.period}>{item.label}</Text>
            <Text style={s.sub}>
              {item.task_count} task{item.task_count === 1 ? '' : 's'}
              {(item.sessions || []).length
                ? `  ·  ${item.sessions.length} session${item.sessions.length === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
          <View style={s.metrics}>
            <View style={s.metric}>
              <Text style={s.metricLabel}>Productive</Text>
              <Text style={[s.metricVal, { color: '#16A34A' }]}>{item.productive_display}</Text>
            </View>
            <View style={s.metric}>
              <Text style={s.metricLabel}>Present</Text>
              <Text style={[s.metricVal, { color: '#2563EB' }]}>{item.presence_display}</Text>
            </View>
            {/* Presence already has deliberate pauses taken off it, so a paused
                week reads SHORT. Paused is what explains that — shown only when
                there was one, or every ordinary period grows a "0m" that looks
                like a gap. */}
            {(item.paused_seconds || 0) > 0 ? (
              <View style={s.metric}>
                <Text style={s.metricLabel}>Paused</Text>
                <Text style={[s.metricVal, { color: '#B45309' }]}>{item.paused_display}</Text>
              </View>
            ) : null}
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color="#94A3B8" style={{ marginLeft: 6 }} />
          </View>
        </TouchableOpacity>

        {open ? (
          <View style={s.drill}>
            {(item.tasks || []).length === 0 ? (
              <Text style={s.empty}>No task time logged in this period.</Text>
            ) : (item.tasks || []).map((t) => (
              <View key={`${rowKey(item)}-t${t.kpi_id}`} style={s.taskRow}>
                <Text style={s.taskRef}>{t.ref}</Text>
                <Text style={s.taskName} numberOfLines={2}>{t.name}</Text>
                {/* The server marks a task whose timer is running right now; its
                    duration includes the live elapsed time. */}
                {t.running ? <View style={s.liveDot} /> : null}
                <Text style={s.taskHours}>{t.duration_display}</Text>
              </View>
            ))}

            {(item.sessions || []).length ? (
              <>
                <Text style={s.sessTitle}>Sessions</Text>
                {item.sessions.map((sess) => (
                  <View key={`${rowKey(item)}-s${sess.session_id}`} style={s.sessRow}>
                    <Text style={s.sessDate}>{sess.session_date}</Text>
                    <Text style={s.sessTime} numberOfLines={1}>
                      {(sess.login_at || '—').split(' ')[1] || sess.login_at || '—'}
                      {' → '}
                      {sess.logout_at ? ((sess.logout_at.split(' ')[1]) || sess.logout_at) : 'open'}
                    </Text>
                    {/* Closed by the cron rather than by the developer — worth
                        saying, because such a session's figures end wherever the
                        cron happened to run. */}
                    {sess.auto_closed ? <Text style={s.autoTag}>auto</Text> : null}
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>Employee Tracker</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.controls}>
        <View style={s.frameRow}>
          {TIME_FRAMES.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[s.frameChip, timeFrame === f.key && s.frameChipOn]}
              onPress={() => { H.select(); setTimeFrame(f.key); }}
              activeOpacity={0.85}
            >
              <Text style={[s.frameTxt, timeFrame === f.key && s.frameTxtOn]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={s.whoBtn} onPress={() => setPickUser(true)} activeOpacity={0.8}>
          <Ionicons name="person-outline" size={14} color={COLORS.primary} />
          <Text style={s.whoBtnTxt} numberOfLines={1}>{chosenName}</Text>
          <Ionicons name="chevron-down" size={14} color={COLORS.muted} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.center}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Ionicons name="alert-circle-outline" size={40} color="#EF4444" />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity onPress={onRefresh} style={s.retry}><Text style={s.retryText}>Retry</Text></TouchableOpacity>
        </ScrollView>
      ) : periods.length === 0 ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.center}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Ionicons name="people-outline" size={44} color="#94A3B8" />
          <Text style={s.empty}>No workday activity in this period.</Text>
        </ScrollView>
      ) : (
        <FlatList
          data={periods}
          keyExtractor={rowKey}
          renderItem={renderPeriod}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}

      <Modal visible={pickUser} transparent animationType="fade" onRequestClose={() => setPickUser(false)}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => setPickUser(false)}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Show whose days</Text>
              <TouchableOpacity onPress={() => setPickUser(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <FlatList
              style={{ maxHeight: 380 }}
              data={[{ id: null, name: 'Everyone' }, ...employees]}
              keyExtractor={(o) => String(o.id ?? 'all')}
              renderItem={({ item }) => {
                const on = (item.id ?? null) === userId;
                return (
                  <TouchableOpacity
                    style={s.optRow}
                    onPress={() => { H.select(); setUserId(item.id ?? null); setPickUser(false); }}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.optTxt, on && s.optOn]} numberOfLines={1}>{item.name}</Text>
                    {on ? <Ionicons name="checkmark" size={17} color={COLORS.primary} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy },

  controls: { paddingHorizontal: 14, gap: 8, marginBottom: 6 },
  frameRow: { flexDirection: 'row', gap: 6 },
  frameChip: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10,
    borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  frameChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  frameTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted },
  frameTxtOn: { color: '#fff' },
  whoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff',
    borderRadius: 10, paddingHorizontal: 12, height: 40, borderWidth: 1.5, borderColor: COLORS.line,
  },
  whoBtnTxt: { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.ink },

  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 12, overflow: 'hidden', ...SHADOW },
  head: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  who: { fontSize: 14.5, fontWeight: '900', color: COLORS.navy },
  period: { fontSize: 12.5, fontWeight: '700', color: COLORS.primary, marginTop: 1 },
  sub: { fontSize: 11.5, color: COLORS.muted, marginTop: 2 },
  metrics: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  metric: { alignItems: 'flex-end' },
  metricLabel: { fontSize: 9.5, fontWeight: '800', color: '#94A3B8', textTransform: 'uppercase' },
  metricVal: { fontSize: 13.5, fontWeight: '900' },

  drill: { borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingHorizontal: 14, paddingVertical: 10 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  taskRef: { fontSize: 11, fontWeight: '900', color: COLORS.primary, minWidth: 62 },
  taskName: { flex: 1, fontSize: 12.5, color: COLORS.ink },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#16A34A' },
  taskHours: { fontSize: 12, fontWeight: '800', color: COLORS.navy },

  sessTitle: { fontSize: 11, fontWeight: '900', color: '#94A3B8', textTransform: 'uppercase', marginTop: 10, marginBottom: 4 },
  sessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  sessDate: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted, minWidth: 84 },
  sessTime: { flex: 1, fontSize: 11.5, color: COLORS.ink },
  autoTag: {
    fontSize: 9.5, fontWeight: '900', color: '#7a5200', backgroundColor: COLORS.amberBg,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },

  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 30 },
  empty: { fontSize: 13, color: COLORS.muted, textAlign: 'center' },
  errorText: { fontSize: 13.5, color: '#B91C1C', textAlign: 'center', fontWeight: '700' },
  retry: { marginTop: 6, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, backgroundColor: COLORS.primary },
  retryText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  sheet: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 20, overflow: 'hidden', paddingBottom: 8 },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  optRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  optTxt: { flex: 1, fontSize: 13.5, color: COLORS.ink },
  optOn: { fontWeight: '900', color: COLORS.primary },
});
