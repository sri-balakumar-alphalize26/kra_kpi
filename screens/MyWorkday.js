// My Workday — the logged-in developer's OWN daily report: per day, their presence,
// productive hours, and the tasks they worked on. Server-side the route is hard-scoped
// to the current user, so no one can see anyone else's days here.

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchMyWorkday } from '../services/myWorkday';
import { createLogger } from '../api/logger';

const log = createLogger('MyWorkday');

export default function MyWorkday({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [days, setDays] = useState([]);
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchMyWorkday();
      if (res && res.status === false) {
        setError(res.message || 'Could not load your workday.');
        setDays([]);
        return;
      }
      setDays(res?.days || []);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load your workday.');
    }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const toggle = (date) => setExpanded((e) => ({ ...e, [date]: !e[date] }));

  const renderDay = ({ item }) => {
    const open = !!expanded[item.date];
    return (
      <View style={styles.card}>
        <TouchableOpacity style={styles.dayHeader} onPress={() => toggle(item.date)} activeOpacity={0.7}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dayDate}>{item.date}</Text>
            <Text style={styles.daySub}>
              {item.task_count} task{item.task_count === 1 ? '' : 's'}
              {item.session_count ? `  ·  ${item.session_count} session${item.session_count === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Productive</Text>
              <Text style={[styles.metricVal, { color: '#16A34A' }]}>{item.productive_display}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Present</Text>
              <Text style={[styles.metricVal, { color: '#2563EB' }]}>{item.presence_display}</Text>
            </View>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color="#94A3B8" style={{ marginLeft: 6 }} />
          </View>
        </TouchableOpacity>

        {open && (
          <View style={styles.taskList}>
            {(item.tasks || []).length === 0 ? (
              <Text style={styles.empty}>No task time logged this day.</Text>
            ) : (
              (item.tasks || []).map((t, i) => (
                <View key={`${item.date}-${i}`} style={styles.taskRow}>
                  <Text style={styles.taskRef}>{t.ref}</Text>
                  <Text style={styles.taskName} numberOfLines={2}>{t.name}</Text>
                  <Text style={styles.taskHours}>{t.hours_display}</Text>
                </View>
              ))
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <GradientBackground />
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS?.navy || '#16306B'} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>My Workday</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#1E6FD9" /></View>
      ) : error ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.center} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Ionicons name="alert-circle-outline" size={40} color="#EF4444" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={onRefresh} style={styles.retry}><Text style={styles.retryText}>Retry</Text></TouchableOpacity>
        </ScrollView>
      ) : days.length === 0 ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.center} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Ionicons name="calendar-outline" size={44} color="#94A3B8" />
          <Text style={styles.empty}>No workday activity in the last 30 days.</Text>
        </ScrollView>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={days}
          keyExtractor={(d) => d.date}
          renderItem={renderDay}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...(SHADOW || {}) },
  title: { flex: 1, textAlign: 'center', marginHorizontal: 8, fontSize: 20, fontWeight: '800', color: COLORS?.navy || '#16306B' },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  errorText: { marginTop: 10, color: '#EF4444', textAlign: 'center' },
  retry: { marginTop: 14, backgroundColor: '#1E6FD9', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '700' },
  empty: { marginTop: 10, color: '#64748B', textAlign: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 12, ...(SHADOW || {}), overflow: 'hidden' },
  dayHeader: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  dayDate: { fontSize: 15, fontWeight: '800', color: '#0F172A' },
  daySub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  metrics: { flexDirection: 'row', alignItems: 'center' },
  metric: { alignItems: 'flex-end', marginLeft: 12 },
  metricLabel: { fontSize: 10, color: '#94A3B8' },
  metricVal: { fontSize: 14, fontWeight: '800' },
  taskList: { borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingHorizontal: 14, paddingVertical: 8 },
  taskRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F8FAFC' },
  taskRef: { fontSize: 12, fontWeight: '700', color: '#6366F1', width: 78 },
  taskName: { flex: 1, fontSize: 13, color: '#334155', paddingRight: 8 },
  taskHours: { fontSize: 13, fontWeight: '700', color: '#0891B2' },
});
