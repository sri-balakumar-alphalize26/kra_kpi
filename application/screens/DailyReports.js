// Daily Task Reports (admin) — the generated per-day PDF reports.
//
//   list  ▸  View (open in the device viewer)  /  Download (save)
//
// The PDF is generated SERVER-SIDE (kpi.daily.report), so this screen is a pure
// viewer: it lists the reports and streams each PDF over the authenticated JSON
// channel (React Native can't send the session cookie to the http download route).

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchDailyReports, fetchDailyReportFile } from '../services/dailyReports';
import { createLogger } from '../api/logger';

const log = createLogger('DailyReports');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

export default function DailyReports({ onBack, focusReportId }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [reports, setReports] = useState([]);
  const [busyId, setBusyId] = useState(null);   // `${id}-view` | `${id}-dl`
  const [banner, setBanner] = useState(null);    // { kind:'ok'|'err', msg } — download/view toast
  const focusedRef = useRef(null);               // only auto-open once per arrival

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchDailyReports(60);
      if (res && res.status === false) {
        setError(res.message || 'Could not load reports.');
        setReports([]);
        return;
      }
      setReports(res?.reports || []);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load reports.');
    }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // fetch → write base64 to a cache .pdf → return the file uri + name.
  const cachePdf = async (report) => {
    const res = await fetchDailyReportFile(report.id);
    if (!res?.status || !res.data_b64) {
      flash('err', res?.message || 'Could not fetch the PDF.');
      return null;
    }
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    let name = res.file_name || report.file_name || `daily-report-${report.report_date}.pdf`;
    name = name.split(/[\\/]/).pop() || 'report.pdf';   // basename only
    const uri = `${dir}${Date.now()}_${name}`;
    await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
    return { uri, name, data_b64: res.data_b64 };
  };

  const onView = async (report) => {
    setBusyId(`${report.id}-view`);
    try {
      const c = await cachePdf(report);
      if (!c) return;

      // Android: fire an ACTION_VIEW intent so the system "Open with" chooser
      // lists every installed PDF reader. Needs a content:// URI + a read grant.
      // If the native module isn't linked yet (before a rebuild) or no viewer is
      // found, fall through to the share sheet below.
      if (Platform.OS === 'android') {
        try {
          // Lazy require: before the rebuild the native module isn't linked, so
          // this throws here (caught) rather than crashing the screen on import.
          const IntentLauncher = require('expo-intent-launcher');
          const contentUri = await FileSystem.getContentUriAsync(c.uri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            flags: 1,   // FLAG_GRANT_READ_URI_PERMISSION
            type: 'application/pdf',
          });
          return;
        } catch (e) {
          log.warn('intent view failed, falling back to share', e?.message);
        }
      }

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(c.uri, {
          mimeType: 'application/pdf',
          dialogTitle: `Open ${c.name}`,
          UTI: 'com.adobe.pdf',
        });
      } else {
        flash('err', 'No app available to open PDFs on this device.');
      }
    } catch (e) {
      log.warn('view failed', e?.message);
      flash('err', 'Could not open the PDF.');
    } finally {
      setBusyId(null);
    }
  };

  const onDownload = async (report) => {
    setBusyId(`${report.id}-dl`);
    try {
      const res = await fetchDailyReportFile(report.id);
      if (!res?.status || !res.data_b64) {
        flash('err', res?.message || 'Could not fetch the PDF.');
        return;
      }
      let name = res.file_name || `daily-report-${report.report_date}.pdf`;
      name = name.split(/[\\/]/).pop() || 'report.pdf';

      const SAF = FileSystem.StorageAccessFramework;
      if (Platform.OS === 'android' && SAF) {
        const perm = await SAF.requestDirectoryPermissionsAsync();
        if (!perm.granted) { flash('err', 'Download cancelled — no folder chosen.'); return; }
        const dot = name.lastIndexOf('.');
        const bare = dot > 0 ? name.slice(0, dot) : name;   // SAF re-appends the ext from the mime
        const uri = await SAF.createFileAsync(perm.directoryUri, bare, 'application/pdf');
        await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
        flash('ok', `Saved ${name}`);
        return;
      }

      // iOS: the share sheet is where "Save to Files" lives.
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Save ${name}` });
        flash('ok', `${name} ready`);
      } else {
        flash('err', 'Saving is not available on this device.');
      }
    } catch (e) {
      log.warn('download failed', e?.message);
      flash('err', 'Could not download the PDF.');
    } finally {
      setBusyId(null);
    }
  };

  // Share = the all-apps OS share sheet (send the PDF to WhatsApp/Gmail/etc.),
  // as opposed to Download which saves it to a chosen folder.
  const onShare = async (report) => {
    setBusyId(`${report.id}-share`);
    log.info('share: start', { report: report.id });
    try {
      const c = await cachePdf(report);
      if (!c) return;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(c.uri, { mimeType: 'application/pdf', dialogTitle: `Share ${c.name}`, UTI: 'com.adobe.pdf' });
        log.info('share: sheet opened', { name: c.name });
      } else {
        log.warn('share: unavailable');
        flash('err', 'Sharing is not available on this device.');
      }
    } catch (e) {
      log.warn('share failed', e?.message);
      flash('err', 'Could not share the PDF.');
    } finally {
      setBusyId(null);
    }
  };

  // Arriving from a "Daily report ready" notification: open that report once.
  useEffect(() => {
    if (!focusReportId || !reports.length) return;
    if (focusedRef.current === focusReportId) return;
    const r = reports.find((x) => x.id === focusReportId);
    if (!r) { log.info('focus report not in list', { focusReportId }); return; }
    focusedRef.current = focusReportId;
    onView(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReportId, reports]);

  const renderItem = ({ item }) => {
    const rowBusy = busyId === `${item.id}-view` || busyId === `${item.id}-dl`;
    return (
      <View style={s.card}>
        <View style={s.cardTop}>
          <Ionicons name="document-text" size={20} color={COLORS.primary} />
          <Text style={s.cardDate}>{item.date_display || item.report_date}</Text>
        </View>
        <Text style={s.cardMeta}>
          {item.employee_count} employee{item.employee_count !== 1 ? 's' : ''} · {item.task_count} task{item.task_count !== 1 ? 's' : ''}
        </Text>
        {item.generated_at ? <Text style={s.cardGen}>Generated {item.generated_at}</Text> : null}
        <View style={s.btnRow}>
          <TouchableOpacity style={s.btn} onPress={() => onView(item)} disabled={rowBusy} activeOpacity={0.85}>
            {busyId === `${item.id}-view`
              ? <ActivityIndicator size="small" color={COLORS.primary} />
              : <Ionicons name="eye-outline" size={15} color={COLORS.primary} />}
            <Text style={s.btnTxt}>View</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btn} onPress={() => onDownload(item)} disabled={rowBusy} activeOpacity={0.85}>
            {busyId === `${item.id}-dl`
              ? <ActivityIndicator size="small" color={COLORS.primary} />
              : <Ionicons name="download-outline" size={15} color={COLORS.primary} />}
            <Text style={s.btnTxt}>Download</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btn} onPress={() => onShare(item)} disabled={rowBusy} activeOpacity={0.85}>
            {busyId === `${item.id}-share`
              ? <ActivityIndicator size="small" color={COLORS.primary} />
              : <Ionicons name="share-social-outline" size={15} color={COLORS.primary} />}
            <Text style={s.btnTxt}>Share</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Daily Task Reports</Text>
        <TouchableOpacity
          onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}
        >
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {!!banner && (
        <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
            color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle" size={34} color={COLORS.red} />
          <Text style={s.errTxt}>{error}</Text>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={reports}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          contentContainerStyle={reports.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
          ListEmptyComponent={
            <View style={s.emptyBox}>
              <Ionicons name="document-text-outline" size={40} color={COLORS.faint} />
              <Text style={s.emptyTitle}>No reports yet</Text>
              <Text style={s.emptySub}>A daily task report is generated automatically on the configured schedule.</Text>
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
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy, marginHorizontal: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 6, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 },
  bannerOk: { backgroundColor: COLORS.greenBg },
  bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  errTxt: { fontSize: 13, color: COLORS.red, textAlign: 'center' },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  emptyBox: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: COLORS.muted },
  emptySub: { fontSize: 12.5, color: COLORS.faint, textAlign: 'center' },

  card: {
    backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: COLORS.line,
    padding: 14, marginBottom: 10, ...SHADOW,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardDate: { fontSize: 15.5, fontWeight: '900', color: COLORS.ink },
  cardMeta: { fontSize: 12.5, color: COLORS.muted, fontWeight: '700', marginTop: 6, marginLeft: 28 },
  cardGen: { fontSize: 11, color: COLORS.faint, marginTop: 2, marginLeft: 28 },

  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingVertical: 9, backgroundColor: '#fff',
  },
  btnTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
});
