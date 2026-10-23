// 🗄️ "It's from the old system" — the box a Bug / Update gets instead of a
// requirement to pick. The new database has none of the old requirements, so
// the client says what it is about: best a 📷 photo or 🎥 video of the old
// screen, else a 🎤 voice note or a typed message; the Request ID and the task
// name are optional. Any ONE is enough (utils/legacyReq.js, the server's rule).
//
// Controlled: the row owns { legacy_ref, legacy_name, legacy_note,
// legacy_files } and this box only reports changes through onChange.
// legacy_files: [{ name, size, mimetype, data_b64, kind: 'image'|'video'|'voice' }].
import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
// SDK 54: the classic readAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import { COLORS } from '../theme';
import { createLogger } from '../api/logger';
import { humanSize, MAX_VIDEO_BYTES, MAX_IMAGE_BYTES } from '../services/uploadAmendments';
import {
  legacyHint, normalizeLegacyRef, MIC_FAILED_MSG, LEGACY_BEST_HINT,
} from '../utils/legacyReq';

const log = createLogger('OldDbBox');

// expo-audio is native, and a build made before it was added has none — loading
// the recorder there throws. Asked for on the first 🎤 tap, never at import, so
// such a build still opens this screen and just says "type it instead".
let recorderMod;
function loadVoiceNoteRecorder() {
  if (recorderMod === undefined) {
    try {
      // eslint-disable-next-line global-require
      recorderMod = require('./VoiceNoteRecorder').default || null;
    } catch (e) {
      log.warn('voice recording not available in this build', e?.message);
      recorderMod = null;
    }
  }
  return recorderMod;
}

// withMedia: false for an admin's row — those go through the bulk route, which
// cannot carry the files with the task, so only the typed fields count there.
// extraFiles: what the screen's own Photos / video section holds for this row —
// it counts too.
export default function OldDbBox({ value, onChange, withMedia = true, extraFiles = [], onError }) {
  const v = value || {};
  const files = v.legacy_files || [];
  const noteRef = useRef(null);
  const [busy, setBusy] = useState('');          // 'image' | 'video' | ''
  const [micMsg, setMicMsg] = useState('');      // overrides the hint until the next edit
  const [Recorder, setRecorder] = useState(null);
  const [recOpen, setRecOpen] = useState(false);

  const set = (patch) => { setMicMsg(''); onChange({ ...v, ...patch }); };

  const counted = withMedia ? [...files, ...extraFiles] : [];
  const hint = legacyHint({ ref: v.legacy_ref, name: v.legacy_name, note: v.legacy_note, files: counted });

  function micFailed() {
    // No microphone (or not allowed): type it instead, never stuck.
    setRecOpen(false);
    setMicMsg(MIC_FAILED_MSG);
    setTimeout(() => noteRef.current?.focus(), 150);
  }

  function onVoice() {
    const R = loadVoiceNoteRecorder();
    if (!R) { micFailed(); return; }
    setRecorder(() => R);
    setRecOpen(true);
  }

  async function pick(kind) {
    setBusy(kind);
    try {
      const isVideo = kind === 'video';
      // Camera first — the point is a picture of the old screen as it is now.
      let perm = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
      const opts = { mediaTypes: isVideo ? ['videos'] : ['images'], quality: 1 };
      const res = perm?.granted
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset) return;
      let uri = asset.uri;
      let name = asset.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`);
      if (!isVideo) {
        // Shrink before base64, as the Photos / video section does.
        const m = await ImageManipulator.manipulateAsync(
          uri, [{ resize: { width: 1600 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
        );
        uri = m.uri;
        if (!/\.(jpg|jpeg)$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
      }
      const info = await FileSystem.getInfoAsync(uri);
      const size = info?.size || 0;
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (size > cap) {
        onError?.(`${isVideo ? 'Video' : 'Image'} is ${humanSize(size)} — the limit is ${humanSize(cap)}.`);
        return;
      }
      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const mimetype = isVideo ? (asset.mimeType || 'video/mp4') : 'image/jpeg';
      set({ legacy_files: [...files, { name, size, mimetype, data_b64: data, kind }] });
      log.info('old-DB media added', { name, size, kind });
    } catch (e) {
      log.error('old-DB media pick failed', e?.message);
      onError?.(e?.message || 'Could not read that file');
    } finally {
      setBusy('');
    }
  }

  const voiceCount = files.filter((f) => f.kind === 'voice').length;

  return (
    <View style={st.box}>
      <View style={st.badge}><Text style={st.badgeTxt}>🗄️ Old DB Requirement</Text></View>

      {withMedia && (
        <>
          <Text style={st.best}>{LEGACY_BEST_HINT}</Text>
          {/* Photo / video first — the main buttons. */}
          <View style={st.mainBtns}>
            {[['image', 'camera', '📷 Photo'], ['video', 'videocam', '🎥 Video']].map(([k, icon, label]) => (
              <TouchableOpacity key={k} style={st.mainBtn} onPress={() => pick(k)} disabled={!!busy} activeOpacity={0.85}>
                {busy === k ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={icon} size={16} color="#fff" />}
                <Text style={st.mainBtnTxt}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* Voice note after them, as the secondary button. */}
          <TouchableOpacity style={st.voiceBtn} onPress={onVoice} activeOpacity={0.85}>
            <Ionicons name="mic-outline" size={16} color={COLORS.primary} />
            <Text style={st.voiceTxt}>🎤 Voice note</Text>
          </TouchableOpacity>

          {files.length > 0 && (
            <View style={st.chips}>
              {files.map((f, i) => (
                <View key={`${f.name}-${i}`} style={st.chip}>
                  <Ionicons
                    name={f.kind === 'voice' ? 'mic' : f.kind === 'video' ? 'videocam' : 'image'}
                    size={13} color={COLORS.primary} />
                  <Text style={st.chipTxt} numberOfLines={1}>{f.name} · {humanSize(f.size)}</Text>
                  <TouchableOpacity
                    onPress={() => set({ legacy_files: files.filter((_, j) => j !== i) })}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={16} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </>
      )}

      <Text style={st.label}>Message</Text>
      <TextInput
        ref={noteRef}
        style={st.note}
        placeholder="What is it about? Which screen, what goes wrong…"
        placeholderTextColor={COLORS.faint}
        value={v.legacy_note || ''}
        onChangeText={(t) => set({ legacy_note: t })}
        multiline textAlignVertical="top"
      />

      <View style={st.split}>
        <View style={{ flex: 1 }}>
          <Text style={st.label}>Request ID (optional)</Text>
          <TextInput
            style={st.input} placeholder="e.g. REQ-012" placeholderTextColor={COLORS.faint}
            value={v.legacy_ref || ''} autoCapitalize="characters"
            onChangeText={(t) => set({ legacy_ref: t })}
            onBlur={() => { const n = normalizeLegacyRef(v.legacy_ref); if (n) set({ legacy_ref: n }); }}
          />
        </View>
        <View style={{ flex: 1.4 }}>
          <Text style={st.label}>Task name (optional)</Text>
          <TextInput
            style={st.input} placeholder="The old task's name" placeholderTextColor={COLORS.faint}
            value={v.legacy_name || ''} onChangeText={(t) => set({ legacy_name: t })}
          />
        </View>
      </View>

      <Text style={[st.hint, (micMsg || !hint.ok) ? st.hintBad : st.hintOk]}>{micMsg || hint.text}</Text>

      {Recorder && recOpen && (
        <Recorder
          visible={recOpen}
          count={voiceCount + 1}
          onMicFailed={micFailed}
          onCancel={(msg) => { setRecOpen(false); if (msg) onError?.(msg); }}
          onDone={(f) => {
            setRecOpen(false);
            set({ legacy_files: [...files, { name: f.name, size: f.size, mimetype: f.mimetype, data_b64: f.data_b64, kind: 'voice' }] });
          }}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  box: { marginTop: 10, borderWidth: 1.5, borderColor: '#FCD9A8', backgroundColor: '#FFFBF3', borderRadius: 12, padding: 11 },
  badge: { alignSelf: 'flex-start', backgroundColor: COLORS.amberBg, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '800', color: '#92400E' },
  best: { fontSize: 12.5, color: COLORS.ink, marginTop: 8, lineHeight: 17 },
  mainBtns: { flexDirection: 'row', gap: 8, marginTop: 9 },
  mainBtn: {
    flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center',
    height: 44, borderRadius: 11, backgroundColor: COLORS.primary,
  },
  mainBtnTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
  voiceBtn: {
    flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    height: 40, borderRadius: 11, borderWidth: 1.5, borderColor: '#C7D8F7', backgroundColor: '#fff',
  },
  voiceTxt: { fontSize: 13.5, fontWeight: '700', color: COLORS.primary },
  chips: { marginTop: 8, gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff',
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6,
  },
  chipTxt: { flex: 1, fontSize: 12.5, color: COLORS.ink, fontWeight: '600' },
  label: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted, marginTop: 10, marginBottom: 5 },
  note: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 14.5, color: COLORS.ink, minHeight: 70,
  },
  split: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    paddingHorizontal: 12, height: 44, fontSize: 14.5, color: COLORS.ink,
  },
  hint: { fontSize: 12.5, marginTop: 9, lineHeight: 17, fontWeight: '600' },
  hintBad: { color: COLORS.red },
  hintOk: { color: COLORS.green },
});
