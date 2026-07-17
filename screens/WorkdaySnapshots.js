// Workday Snapshots (admin) — the frozen End-Workday summary images.
//
//   date  ▸  developer  ▸  image  →  popup  →  download / share
//
// The image is drawn SERVER-SIDE at End Workday (kpi.workday.snapshot), so this
// screen is a pure viewer: it never recomputes anything. That is the point — the
// numbers on a snapshot are frozen, and anything recomputed here would drift.

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Image, Modal, Dimensions, Animated, LayoutAnimation, Platform, UIManager,
  Easing, findNodeHandle, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchSnapshots, fetchSnapshotImage, fetchMySnapshots, fetchMySnapshotImage } from '../services/workdaySnapshots';
import { createLogger } from '../api/logger';

const log = createLogger('Snapshots');
const SW = Dimensions.get('window').width;
const TOP = (RNStatusBar.currentHeight || 0) + 12;

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// `mine` → self-scoped "My Snapshots": the server route returns only the current
// user's own days, so any user (not just admins) can review their own workday
// images. Everything else on this screen is identical.
export default function WorkdaySnapshots({ onBack, focusSnapshotId, mine }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState([]);
  const [openDates, setOpenDates] = useState({});
  const [openDevs, setOpenDevs] = useState({});
  const [images, setImages] = useState({});      // snapshot_id -> {b64, name} | 'loading' | 'error'
  const [viewing, setViewing] = useState(null);  // the full-size popup
  const [busyShare, setBusyShare] = useState(false);
  const [busySend, setBusySend] = useState(false);
  const [limitDays, setLimitDays] = useState(30);
  const [banner, setBanner] = useState(null);   // { kind:'ok'|'err', msg }

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };
  const Banner = () => (!banner ? null : (
    <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
      <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
        color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
      <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
    </View>
  ));

  // Arriving from an "X ended their workday" notification: open that day + that
  // developer, scroll to it, and flash it twice so it's obvious which one was
  // meant. Same double heartbeat the board's TaskListRow uses.
  const [pulseId, setPulseId] = useState(null);
  const beat = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef(null);
  const rowRefs = useRef({});
  const focusedRef = useRef(null);   // only auto-open once per arrival

  const load = useCallback(async (dayLimit = limitDays) => {
    setLoading(true);
    setError(null);
    try {
      const res = await (mine ? fetchMySnapshots : fetchSnapshots)(dayLimit);
      if (res && res.status === false) {
        setError(res.message || 'Could not load snapshots.');
        setDays([]);
        return;
      }
      const list = res?.days || [];
      setDays(list);
      // Open the newest day by default — it is what the viewer came for.
      if (list.length) setOpenDates((p) => ({ ...p, [list[0].date]: true }));
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load snapshots.');
    } finally {
      setLoading(false);
    }
  }, [limitDays, mine]);

  useEffect(() => { load(); }, [load]);

  // Pull ONE image, only when a developer row is opened. The list deliberately
  // carries no bytes.
  const ensureImage = useCallback(async (snapshotId) => {
    if (images[snapshotId]) return;
    setImages((p) => ({ ...p, [snapshotId]: 'loading' }));
    try {
      const res = await (mine ? fetchMySnapshotImage : fetchSnapshotImage)(snapshotId);
      if (res && res.status && res.data_b64) {
        setImages((p) => ({ ...p, [snapshotId]: { b64: res.data_b64, name: res.file_name } }));
      } else {
        setImages((p) => ({ ...p, [snapshotId]: 'error' }));
      }
    } catch (e) {
      log.warn('image fetch failed', e?.message);
      setImages((p) => ({ ...p, [snapshotId]: 'error' }));
    }
  }, [images, mine]);

  // Auto-expand + flash the snapshot a notification pointed at.
  useEffect(() => {
    if (!focusSnapshotId || !days.length) return;
    if (focusedRef.current === focusSnapshotId) return;   // already handled
    const day = days.find((d) => (d.devs || []).some((x) => x.snapshot_id === focusSnapshotId));
    if (!day) {
      // The tap pointed at a day outside the current range (e.g. "last 7 days"
      // while the notification is older). Say so instead of silently doing nothing.
      log.info('focus snapshot not in range', { focusSnapshotId, limitDays });
      return;
    }
    focusedRef.current = focusSnapshotId;
    log.info('focus snapshot → expanding', { focusSnapshotId, date: day.date });
    setOpenDates((p) => ({ ...p, [day.date]: true }));
    setOpenDevs((p) => ({ ...p, [focusSnapshotId]: true }));
    ensureImage(focusSnapshotId);

    // Let the rows mount before measuring, then scroll and beat.
    const t = setTimeout(() => {
      const node = rowRefs.current[focusSnapshotId];
      const scroll = scrollRef.current;
      if (node && scroll) {
        const handle = findNodeHandle(scroll);
        if (handle) {
          node.measureLayout(handle,
            (x, y) => scroll.scrollTo({ y: Math.max(0, y - 70), animated: true }),
            () => {});
        }
      }
      setPulseId(focusSnapshotId);
    }, 380);
    return () => clearTimeout(t);
  }, [focusSnapshotId, days, limitDays, ensureImage]);

  // The double heartbeat, lifted verbatim from the board's TaskListRow so the app
  // feels the same wherever a notification lands you.
  useEffect(() => {
    if (!pulseId) return;
    beat.setValue(0);
    const oneBeat = () => Animated.sequence([
      Animated.timing(beat, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(beat, { toValue: 0, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]);
    Animated.sequence([oneBeat(), Animated.delay(160), oneBeat()]).start();
    const t = setTimeout(() => setPulseId(null), 3000);
    return () => clearTimeout(t);
  }, [pulseId, beat]);
  const washOpacity = beat.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] });

  const toggleDate = (date) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenDates((p) => ({ ...p, [date]: !p[date] }));
  };
  const toggleDev = (dev) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenDevs((p) => {
      const next = !p[dev.snapshot_id];
      if (next) ensureImage(dev.snapshot_id);
      return { ...p, [dev.snapshot_id]: next };
    });
  };

  // Save the PNG. Android asks WHERE to save (folder picker) via the Storage
  // Access Framework; iOS falls back to the share sheet ("Save Image").
  const shareImage = async (dev) => {
    const img = images[dev.snapshot_id];
    if (!img || typeof img === 'string') return;
    setBusyShare(true);
    try {
      const name = (img.name || 'workday.png').split(/[\\/]/).pop();

      const SAF = FileSystem.StorageAccessFramework;
      if (Platform.OS === 'android' && SAF) {
        // Ask WHERE to save first — nothing is written until a folder is chosen.
        const perm = await SAF.requestDirectoryPermissionsAsync();
        if (!perm.granted) { flash('err', 'Download cancelled — no folder chosen.'); return; }
        const dot = name.lastIndexOf('.');
        const bare = dot > 0 ? name.slice(0, dot) : name;   // SAF re-appends the ext from the mime
        const uri = await SAF.createFileAsync(perm.directoryUri, bare, 'image/png');
        await FileSystem.writeAsStringAsync(uri, img.b64, { encoding: FileSystem.EncodingType.Base64 });
        flash('ok', `Saved ${name}`);
        return;
      }

      // iOS: the share sheet is where "Save Image" / "Save to Files" live.
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, img.b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `Save ${name}`, UTI: 'public.png' });
        flash('ok', `${name} ready`);
      } else {
        flash('err', 'Saving is not available on this device.');
      }
    } catch (e) {
      log.warn('share failed', e?.message);
      flash('err', 'Could not save the image.');
    } finally {
      setBusyShare(false);
    }
  };

  // Share = the all-apps OS share sheet (send the PNG to WhatsApp/Gmail/etc.),
  // as opposed to Download which saves it to a chosen folder.
  const sendImage = async (dev) => {
    const img = images[dev.snapshot_id];
    if (!img || typeof img === 'string') return;
    setBusySend(true);
    log.info('share: start', { snapshot: dev.snapshot_id });
    try {
      const name = (img.name || 'workday.png').split(/[\\/]/).pop();
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, img.b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `Share ${name}`, UTI: 'public.png' });
        log.info('share: sheet opened', { name });
      } else {
        log.warn('share: unavailable');
        flash('err', 'Sharing is not available on this device.');
      }
    } catch (e) {
      log.warn('send failed', e?.message);
      flash('err', 'Could not share the image.');
    } finally {
      setBusySend(false);
    }
  };

  const totalDevs = days.reduce((n, d) => n + (d.devs?.length || 0), 0);

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{mine ? 'My Snapshots' : 'Workday Snapshots'}</Text>
        <TouchableOpacity onPress={() => load()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.iconBtn}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>
      <Banner />

      <View style={s.rangeRow}>
        {[7, 30, 90].map((n) => (
          <TouchableOpacity
            key={n}
            style={[s.rangePill, limitDays === n && s.rangePillOn]}
            onPress={() => { setLimitDays(n); load(n); }}
            activeOpacity={0.85}
          >
            <Text style={[s.rangeTxt, limitDays === n && s.rangeTxtOn]}>Last {n} days</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle" size={34} color={COLORS.red} />
          <Text style={s.errTxt}>{error}</Text>
        </View>
      ) : !days.length ? (
        <View style={s.center}>
          <Ionicons name="camera-outline" size={40} color={COLORS.faint} />
          <Text style={s.emptyTitle}>No snapshots yet</Text>
          <Text style={s.emptySub}>{mine
            ? 'Your snapshot is saved automatically each time you end your workday.'
            : 'One is saved automatically each time a developer ends their workday.'}</Text>
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <Text style={s.count}>{days.length} day{days.length !== 1 ? 's' : ''} · {totalDevs} snapshot{totalDevs !== 1 ? 's' : ''}</Text>

          {days.map((day) => (
            <View key={day.date} style={s.dayCard}>
              {/* Level 1 — the date */}
              <TouchableOpacity style={s.dayHead} onPress={() => toggleDate(day.date)} activeOpacity={0.8}>
                <Ionicons
                  name={openDates[day.date] ? 'chevron-down' : 'chevron-forward'}
                  size={18} color={COLORS.muted}
                />
                <Text style={s.dayLbl}>{day.label}</Text>
                <View style={s.dayBadge}><Text style={s.dayBadgeTxt}>{day.devs?.length || 0}</Text></View>
              </TouchableOpacity>

              {openDates[day.date] && (day.devs || []).map((dev) => (
                <Animated.View
                  key={dev.snapshot_id}
                  ref={(r) => { rowRefs.current[dev.snapshot_id] = r; }}
                  style={[s.devBox, pulseId === dev.snapshot_id && s.devBoxPulse]}
                >
                  {/* Highlight wash — fades in/out with the double heartbeat. */}
                  {pulseId === dev.snapshot_id ? (
                    <Animated.View pointerEvents="none" style={[s.pulseWash, { opacity: washOpacity }]} />
                  ) : null}
                  {/* Level 2 — the developer */}
                  <TouchableOpacity style={s.devHead} onPress={() => toggleDev(dev)} activeOpacity={0.8}>
                    <Ionicons
                      name={openDevs[dev.snapshot_id] ? 'chevron-down' : 'chevron-forward'}
                      size={15} color={COLORS.faint}
                    />
                    <Text style={s.devName} numberOfLines={1}>{dev.name}</Text>
                    {/* The 9h rule, frozen as it was judged on the day */}
                    <View style={[s.presPill, { backgroundColor: dev.met_standard ? COLORS.greenBg : COLORS.redBg }]}>
                      <Text style={[s.presTxt, { color: dev.met_standard ? COLORS.green : COLORS.red }]}>
                        {dev.presence_display}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <Text style={s.devMeta}>
                    Productive {dev.productive_display} · {dev.task_count} task{dev.task_count !== 1 ? 's' : ''} · vs {dev.standard_hours}h standard
                  </Text>

                  {/* Level 3 — the image */}
                  {openDevs[dev.snapshot_id] && (
                    <View style={s.imgBox}>
                      {images[dev.snapshot_id] === 'loading' ? (
                        <View style={s.imgLoading}><ActivityIndicator color={COLORS.primary} /></View>
                      ) : images[dev.snapshot_id] === 'error' || !images[dev.snapshot_id] ? (
                        <View style={s.imgLoading}>
                          <Text style={s.errTxt}>Couldn't load the image.</Text>
                        </View>
                      ) : (
                        <>
                          <TouchableOpacity onPress={() => setViewing(dev)} activeOpacity={0.9}>
                            <Image
                              source={{ uri: 'data:image/png;base64,' + images[dev.snapshot_id].b64 }}
                              style={s.thumb}
                              resizeMode="contain"
                            />
                          </TouchableOpacity>
                          <View style={s.imgBtnRow}>
                            <TouchableOpacity style={s.imgBtn} onPress={() => setViewing(dev)} activeOpacity={0.85}>
                              <Ionicons name="expand" size={14} color={COLORS.primary} />
                              <Text style={s.imgBtnTxt}>View full size</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.imgBtn} onPress={() => shareImage(dev)} disabled={busyShare} activeOpacity={0.85}>
                              {busyShare
                                ? <ActivityIndicator size="small" color={COLORS.primary} />
                                : <Ionicons name="download-outline" size={14} color={COLORS.primary} />}
                              <Text style={s.imgBtnTxt}>Download</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.imgBtn} onPress={() => sendImage(dev)} disabled={busySend} activeOpacity={0.85}>
                              {busySend
                                ? <ActivityIndicator size="small" color={COLORS.primary} />
                                : <Ionicons name="share-social-outline" size={14} color={COLORS.primary} />}
                              <Text style={s.imgBtnTxt}>Share</Text>
                            </TouchableOpacity>
                          </View>
                        </>
                      )}
                    </View>
                  )}
                </Animated.View>
              ))}
            </View>
          ))}
        </ScrollView>
      )}

      {/* Full-size popup */}
      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={s.mWrap}>
          <View style={s.mCard}>
            <View style={s.mHead}>
              <Text style={s.mTitle} numberOfLines={1}>{viewing?.name}</Text>
              <TouchableOpacity onPress={() => setViewing(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.ink} />
              </TouchableOpacity>
            </View>
            <Banner />
            <ScrollView
              style={{ maxHeight: Dimensions.get('window').height * 0.62 }}
              contentContainerStyle={{ padding: 10 }}
              maximumZoomScale={4}
              minimumZoomScale={1}
            >
              {viewing && images[viewing.snapshot_id] && typeof images[viewing.snapshot_id] !== 'string' ? (
                <Image
                  source={{ uri: 'data:image/png;base64,' + images[viewing.snapshot_id].b64 }}
                  style={s.full}
                  resizeMode="contain"
                />
              ) : null}
            </ScrollView>
            <View style={s.mFoot}>
              <TouchableOpacity
                style={s.mShare}
                onPress={() => viewing && sendImage(viewing)}
                disabled={busySend}
                activeOpacity={0.85}
              >
                {busySend
                  ? <ActivityIndicator size="small" color={COLORS.primary} />
                  : <><Ionicons name="share-social-outline" size={16} color={COLORS.primary} />
                      <Text style={s.mShareTxt}>Share</Text></>}
              </TouchableOpacity>
              <TouchableOpacity
                style={s.mDownload}
                onPress={() => viewing && shareImage(viewing)}
                disabled={busyShare}
                activeOpacity={0.85}
              >
                {busyShare
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <><Ionicons name="download-outline" size={16} color="#fff" />
                      <Text style={s.mDownloadTxt}>Download</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: TOP, paddingBottom: 12,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy, marginHorizontal: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: COLORS.greenBg, borderColor: '#A7F3D0' },
  bannerErr: { backgroundColor: COLORS.redBg, borderColor: '#FCA5A5' },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },

  rangeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  rangePill: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  rangePillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  rangeTxt: { fontSize: 12, fontWeight: '700', color: COLORS.muted },
  rangeTxtOn: { color: '#fff' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 8 },
  errTxt: { fontSize: 13, color: COLORS.red, textAlign: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: COLORS.muted },
  emptySub: { fontSize: 12.5, color: COLORS.faint, textAlign: 'center' },
  count: { fontSize: 12, color: COLORS.muted, fontWeight: '700', marginBottom: 8 },

  dayCard: {
    backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: COLORS.line,
    marginBottom: 10, overflow: 'hidden', ...SHADOW,
  },
  dayHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13 },
  dayLbl: { flex: 1, fontSize: 14.5, fontWeight: '900', color: COLORS.ink },
  dayBadge: { backgroundColor: COLORS.line, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  dayBadgeTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted },

  devBox: {
    borderTopWidth: 1, borderTopColor: COLORS.line,
    paddingHorizontal: 12, paddingVertical: 10, overflow: 'hidden',
  },
  devBoxPulse: { backgroundColor: '#F0F9FF' },
  // Absolutely positioned so the beat can't reflow the row it is highlighting.
  pulseWash: { ...StyleSheet.absoluteFillObject, backgroundColor: '#BAE6FD' },
  devHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  devName: { flex: 1, fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  presPill: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 3 },
  presTxt: { fontSize: 12, fontWeight: '900' },
  devMeta: { fontSize: 11, color: COLORS.faint, marginLeft: 22, marginTop: 3 },

  imgBox: { marginTop: 10 },
  imgLoading: { paddingVertical: 26, alignItems: 'center' },
  thumb: {
    width: '100%', height: (SW - 60) * 1.0, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  imgBtnRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  imgBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 9,
    paddingHorizontal: 11, paddingVertical: 7, backgroundColor: '#fff',
  },
  imgBtnTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary },

  mWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.6)', justifyContent: 'center', padding: 14 },
  mCard: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden' },
  mHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  mTitle: { flex: 1, fontSize: 15.5, fontWeight: '900', color: COLORS.ink },
  full: { width: '100%', height: Dimensions.get('window').height * 0.55 },
  mFoot: { padding: 12, borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  mDownload: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primary,
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, minWidth: 130, justifyContent: 'center',
  },
  mDownloadTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
  mShare: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff',
    borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.primary,
    paddingHorizontal: 16, paddingVertical: 10, minWidth: 110, justifyContent: 'center',
  },
  mShareTxt: { color: COLORS.primary, fontWeight: '800', fontSize: 13.5 },
});
