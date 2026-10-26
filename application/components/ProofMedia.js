// One photo / video / voice note / document that lives behind an Odoo
// type='http' route (a client send-back's proof at /kpi/sendback/file/<id>, a
// meeting recording at /web/content/<id>). Used by SendBackHistory on the board
// card and in KPI Details, and by the Meetings section.
//
// The bytes come down with the session (fetchChatFile — an <Image> pointed at
// the route would not carry the cookie and would render the login page), are
// cached as a local file, and then:
//   image  → a thumbnail; tap for the full-screen viewer
//   audio  → plays in place with expo-audio (one at a time, across the screen)
//   video / document / no expo-audio → handed to the device's own player
//
// Self-contained on purpose: the board card has none of KPI Details' file
// machinery, and both must open the same proof the same way.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Image, Modal, ScrollView, ActivityIndicator, StyleSheet, StatusBar as RNStatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// SDK 54: the classic writeAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { COLORS } from '../theme';
import { fetchChatFile } from '../services/kpiActions';
import { createLogger } from '../api/logger';

const log = createLogger('ProofMedia');

const KIND_ICON = { image: '🖼', video: '🎬', audio: '🎵', document: '📄' };

// url → local file:// uri, for as long as the app runs, so a card that scrolls
// out and back (or the same proof on the card and in KPI Details) is fetched once.
const cached = new Map();

// Uploaded names can arrive URL-encoded ("banner_2%20(1).jpg"); show them plain.
function shownName(n) {
  if (!n) return '';
  try { return decodeURIComponent(n); } catch (_) { return n; }
}

async function cacheFile(f) {
  if (cached.has(f.url)) return cached.get(f.url);
  const res = await fetchChatFile(f.url);
  if (!res?.status) throw new Error(res?.message || 'Could not fetch the file');
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  let name = f.name || 'file';
  try { name = decodeURIComponent(name); } catch (_) {}
  // Basename only, so a name with separators can't write outside the cache.
  name = name.split(/[\\/]/).pop() || 'file';
  const uri = `${dir}proof_${String(f.id || Date.now())}_${name}`;
  await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
  cached.set(f.url, uri);
  return uri;
}

// The one voice note playing anywhere — starting another stops it.
let nowPlaying = null;   // { player, done }
function stopNowPlaying() {
  const p = nowPlaying;
  nowPlaying = null;
  if (!p) return;
  try { p.player.remove(); } catch (_) {}
  p.done();
}

const sizeLabel = (n) => {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

// f: { id, name, kind: image|video|audio|document, mime, size, url }.
// onError(message) reports a failure; without one it is only logged.
export default function ProofMedia({ f, onError, small = false }) {
  const [thumb, setThumb] = useState(cached.get(f.url) || null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [viewer, setViewer] = useState(false);
  const fail = (msg) => { log.warn('proof file', msg); if (onError) onError(msg); };

  // Photos load as thumbnails on their own; everything else waits for a tap.
  useEffect(() => {
    let live = true;
    if (f.kind === 'image' && f.url && !thumb) {
      cacheFile(f).then((u) => { if (live) setThumb(u); }).catch((e) => log.warn('thumb failed', e?.message));
    }
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.url]);
  useEffect(() => () => { if (nowPlaying && nowPlaying.url === f.url) stopNowPlaying(); }, [f.url]);

  async function open() {
    if (f.kind === 'audio' && playing) { stopNowPlaying(); return; }
    setBusy(true);
    try {
      const uri = await cacheFile(f);
      if (f.kind === 'image') { setThumb(uri); setViewer(true); return; }
      if (f.kind === 'audio') {
        let audio = null;
        try {
          // eslint-disable-next-line global-require
          audio = require('expo-audio');
          await audio.setAudioModeAsync({ playsInSilentMode: true });
        } catch (e) {
          log.warn('in-app audio not available', e?.message);
          audio = null;
        }
        if (audio) {
          stopNowPlaying();
          const player = audio.createAudioPlayer(uri);
          nowPlaying = { player, url: f.url, done: () => setPlaying(false) };
          player.addListener('playbackStatusUpdate', (st) => { if (st?.didJustFinish) stopNowPlaying(); });
          player.play();
          setPlaying(true);
          return;
        }
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: f.mime || undefined, dialogTitle: `Open ${f.name || 'file'}` });
      } else {
        fail('No app available to open this file');
      }
    } catch (e) {
      fail(e?.message || 'Could not open that file');
    } finally { setBusy(false); }
  }

  const meta = [shownName(f.name), sizeLabel(f.size)].filter(Boolean).join(' · ');
  if (f.kind === 'image') {
    return (
      <View style={st.wrap}>
        <TouchableOpacity activeOpacity={0.85} onPress={open} disabled={busy}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={small ? st.thumbSm : st.thumb} resizeMode="cover" />
          ) : (
            <View style={[small ? st.thumbSm : st.thumb, st.thumbWait]}><ActivityIndicator color={COLORS.primary} /></View>
          )}
        </TouchableOpacity>
        {!small && <Text style={st.meta} numberOfLines={1}>{meta}</Text>}
        <Modal visible={viewer} transparent animationType="fade" onRequestClose={() => setViewer(false)}>
          <View style={st.viewerWrap}>
            <View style={st.viewerHead}>
              <Text style={st.viewerName} numberOfLines={1}>{shownName(f.name) || 'Photo'}</Text>
              <TouchableOpacity onPress={() => setViewer(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={st.viewerBody} maximumZoomScale={4} minimumZoomScale={1} centerContent>
              {!!thumb && <Image source={{ uri: thumb }} style={st.viewerImg} resizeMode="contain" />}
            </ScrollView>
          </View>
        </Modal>
      </View>
    );
  }
  const label = f.kind === 'video' ? 'Play video'
    : f.kind === 'audio' ? (playing ? 'Stop' : 'Play voice note')
      : 'Open';
  return (
    <View style={st.wrap}>
      <TouchableOpacity style={st.row} activeOpacity={0.7} disabled={busy} onPress={open}>
        {busy ? <ActivityIndicator size="small" color={COLORS.primary} />
          : <Text style={st.icon}>{playing ? '⏹' : (KIND_ICON[f.kind] || '📎')}</Text>}
        <Text style={st.txt} numberOfLines={1}>{label}</Text>
      </TouchableOpacity>
      {!small && <Text style={st.meta} numberOfLines={1}>{meta}</Text>}
    </View>
  );
}

const TOP = (RNStatusBar.currentHeight || 0) + 12;

const st = StyleSheet.create({
  wrap: { marginTop: 4, maxWidth: '100%' },
  thumb: { width: 120, height: 90, borderRadius: 8, backgroundColor: '#E5E7EB' },
  thumbSm: { width: 64, height: 64, borderRadius: 8, backgroundColor: '#E5E7EB' },
  thumbWait: { alignItems: 'center', justifyContent: 'center' },
  meta: { fontSize: 10.5, color: COLORS.faint, marginTop: 2, maxWidth: 200 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(15,23,42,0.06)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, alignSelf: 'flex-start' },
  icon: { fontSize: 14 },
  txt: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy },
  viewerWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  viewerHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: TOP, paddingHorizontal: 16, paddingBottom: 12 },
  viewerName: { flex: 1, fontSize: 14, fontWeight: '800', color: '#fff' },
  viewerBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 10 },
  viewerImg: { width: '100%', height: undefined, aspectRatio: 1, maxHeight: '100%' },
});
