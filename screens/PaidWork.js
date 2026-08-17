// PAID WORK (admin) — the record of what has been billed and settled.
//
// Marking an invoice paid ARCHIVES its tasks, so they disappear from every board
// and every search. That is right for the developer — finished, paid, gone — but
// it left admins with no way to see what had actually been paid for. This is that
// record, and nothing more: it is read-only by design, because every number here
// belongs to an invoice that is already closed.
//
// The web shows this as a lane on the KPI Action board. On a phone a lane of up
// to 200 read-only cards is unusable, so it lives on its own screen alongside the
// other admin views (Live Tracking, Workday Snapshots).

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchPaidTasks } from '../services/kpiActions';
import { createLogger } from '../api/logger';

const log = createLogger('PaidWork');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Seconds → "2h 15m". Time spent is the point of comparison against the
// estimate, so minutes are enough — nobody reconciles a paid invoice to the
// second.
function fmtSpent(sec) {
  const m = Math.floor((sec || 0) / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// An amount of 0 means a time-only invoice with no rate set, not "free". Showing
// 0.00 would state a price that was never agreed, so show nothing at all — the
// same reasoning the server uses when it computes this.
function money(amount, currency) {
  if (!amount) return '';
  const n = Number(amount).toFixed(2);
  return currency ? `${currency} ${n}` : n;
}

export default function PaidWork({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [limit, setLimit] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetchPaidTasks();
      if (res?.status === false) {
        // Usually the role gate. That is a real answer, not a crash — say it
        // plainly rather than showing an empty list that implies nothing is paid.
        setError(res.message || 'Not authorized.');
        setTasks([]);
        return;
      }
      setError('');
      setTasks(res?.tasks || []);
      setTruncated(!!res?.truncated);
      setLimit(res?.limit || 0);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError('Could not load paid work.');
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={s.head}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.hTitle} numberOfLines={1}>Paid Work</Text>
        <View style={s.iconBtn} />
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="lock-closed-outline" size={26} color={COLORS.muted} />
          <Text style={s.centerTxt}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
        >
          <Text style={s.lead}>
            Work on invoices that have been paid. These tasks are closed and no longer
            appear on any board.
          </Text>

          {/* A truncated list that looks complete is how somebody concludes work
              was never billed. Say it, rather than quietly cutting at 200. */}
          {truncated ? (
            <View style={s.truncBar}>
              <Ionicons name="information-circle-outline" size={15} color={COLORS.amber} />
              <Text style={s.truncTxt}>
                Showing the {limit} most recently paid. Older paid work is not listed here.
              </Text>
            </View>
          ) : null}

          {!tasks.length ? (
            <View style={s.center}>
              <MaterialCommunityIcons name="cash-check" size={30} color={COLORS.faint} />
              <Text style={s.centerTxt}>Nothing has been paid for yet.</Text>
            </View>
          ) : tasks.map((t) => {
            const amt = money(t.amount, t.currency);
            return (
              <View key={t.id} style={s.card}>
                <View style={s.cardTop}>
                  {!!t.external_ref && (
                    <View style={s.refTag}><Text style={s.refTxt}>{t.external_ref}</Text></View>
                  )}
                  <Text style={s.name} numberOfLines={2}>{t.name}</Text>
                </View>

                <View style={s.metaRow}>
                  <Ionicons name="person-outline" size={13} color={COLORS.muted} />
                  <Text style={s.meta} numberOfLines={1}>{t.user_name || 'Unassigned'}</Text>
                </View>
                {!!t.client_name && (
                  <View style={s.metaRow}>
                    <Ionicons name="business-outline" size={13} color={COLORS.muted} />
                    <Text style={s.meta} numberOfLines={1}>{t.client_name}</Text>
                  </View>
                )}

                <View style={s.divider} />

                <View style={s.statRow}>
                  <View style={s.stat}>
                    <Text style={s.statLbl}>Spent</Text>
                    <Text style={s.statVal}>{fmtSpent(t.timer_total_seconds)}</Text>
                  </View>
                  <View style={s.stat}>
                    <Text style={s.statLbl}>Estimated</Text>
                    <Text style={s.statVal}>{t.estimate_display || '—'}</Text>
                  </View>
                  <View style={s.stat}>
                    <Text style={s.statLbl}>Amount</Text>
                    {/* Blank means a time-only invoice with no rate, not zero. */}
                    <Text style={[s.statVal, amt && s.statPaid]}>{amt || '—'}</Text>
                  </View>
                </View>

                <View style={s.payRow}>
                  <MaterialCommunityIcons name="file-document-outline" size={13} color={COLORS.muted} />
                  <Text style={s.payTxt} numberOfLines={1}>
                    {t.invoice_name || 'Invoice'}
                    {t.paid_on ? ` · confirmed ${t.paid_on}` : ''}
                  </Text>
                </View>
                {/* Kept distinct from the confirmation date: when the client SAID
                    they paid, versus when it was actually confirmed. */}
                {!!t.client_paid_on && (
                  <Text style={s.claimTxt}>Client said they paid on {t.client_paid_on}</Text>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: TOP, paddingBottom: 8 },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  hTitle: { flex: 1, fontSize: 19, fontWeight: '900', color: COLORS.navy },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 34, flexGrow: 1 },
  centerTxt: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', lineHeight: 19 },
  lead: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18, marginBottom: 12 },
  truncBar: {
    flexDirection: 'row', alignItems: 'center', gap: 7, padding: 10, borderRadius: 10,
    backgroundColor: COLORS.amberBg, borderWidth: 1, borderColor: '#FCD34D', marginBottom: 12,
  },
  truncTxt: { flex: 1, fontSize: 11.5, color: '#92400E', fontWeight: '700', lineHeight: 16 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 13, marginBottom: 11, ...SHADOW },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  refTag: { backgroundColor: '#E0ECFF', borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2 },
  refTxt: { fontSize: 11, fontWeight: '900', color: '#2563EB', letterSpacing: 0.3 },
  name: { flex: 1, fontSize: 14.5, fontWeight: '800', color: COLORS.ink, lineHeight: 19 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  meta: { flex: 1, fontSize: 12, color: COLORS.muted },
  divider: { height: 1, backgroundColor: COLORS.line, marginVertical: 10 },
  statRow: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1 },
  statLbl: { fontSize: 10.5, fontWeight: '800', color: COLORS.faint, textTransform: 'uppercase', letterSpacing: 0.4 },
  statVal: { fontSize: 13.5, fontWeight: '800', color: COLORS.ink, marginTop: 2 },
  statPaid: { color: COLORS.green },
  payRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  payTxt: { flex: 1, fontSize: 11.5, color: COLORS.muted, fontWeight: '600' },
  claimTxt: { fontSize: 11, color: COLORS.faint, marginTop: 4 },
});
