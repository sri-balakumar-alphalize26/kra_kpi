// 🎤 Voice note recorder — a small popup: it asks for the mic, records, and on
// Stop hands back the file named "Voice note 1 (0m07s).m4a". The server reads
// the length back from that name (models/kpi_legacy.py voice_seconds), which is
// why the name is not left to the recorder.
//
// expo-audio is a native module. Builds made before it was added do not have
// it, and importing it there throws — so NOTHING may import this file at module
// scope. Load it with loadVoiceNoteRecorder() (components/OldDbBox.js), which
// answers null on such a build and the caller says "type it instead".
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useAudioRecorder, useAudioRecorderState, RecordingPresets,
  requestRecordingPermissionsAsync, setAudioModeAsync,
} from 'expo-audio';
// SDK 54: the classic readAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import { COLORS } from '../theme';
import { createLogger } from '../api/logger';
import { voiceNoteName } from '../utils/legacyReq';

const log = createLogger('VoiceNote');

// Long enough to explain an old screen; short enough to stay a voice NOTE.
const VOICE_MAX_MS = 5 * 60 * 1000;

const clock = (ms) => {
  const t = Math.floor((ms || 0) / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// count: the number this note gets ("Voice note 2 …").
// onDone({ name, uri, size, mimetype, data_b64, millis }) · onCancel() · onMicFailed()
export default function VoiceNoteRecorder({ visible, count = 1, onDone, onCancel, onMicFailed }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState('idle');   // idle | starting | recording | saving
  const lastMs = useRef(0);

  if (state?.durationMillis) lastMs.current = state.durationMillis;

  async function resetMode() {
    try { await setAudioModeAsync({ allowsRecording: false }); } catch (_) { /* nothing to undo */ }
  }

  // Open = start: the button the person pressed WAS "record".
  useEffect(() => {
    if (!visible) return undefined;
    let gone = false;
    (async () => {
      setPhase('starting');
      lastMs.current = 0;
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (gone) return;
        if (!perm?.granted) {
          log.warn('mic permission denied');
          setPhase('idle');
          onMicFailed?.();
          return;
        }
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
        await recorder.prepareToRecordAsync();
        if (gone) return;
        recorder.record();
        setPhase('recording');
        log.info('recording started');
      } catch (e) {
        log.error('could not start recording', e?.message);
        setPhase('idle');
        await resetMode();
        if (!gone) onMicFailed?.();
      }
    })();
    return () => { gone = true; };
  }, [visible]);

  // The cap stops it by itself, and keeps what was said.
  useEffect(() => {
    if (phase === 'recording' && (state?.durationMillis || 0) >= VOICE_MAX_MS) stop(true);
  }, [phase, state?.durationMillis]);

  async function stop(keep) {
    if (phase !== 'recording') { if (!keep) onCancel?.(); return; }
    setPhase('saving');
    const millis = Math.max(lastMs.current, recorder.currentTime ? recorder.currentTime * 1000 : 0);
    try {
      await recorder.stop();
    } catch (e) {
      log.warn('stop failed', e?.message);
    }
    await resetMode();
    if (!keep) { setPhase('idle'); onCancel?.(); return; }
    try {
      const uri = recorder.uri;
      if (!uri) throw new Error('Nothing was recorded');
      const info = await FileSystem.getInfoAsync(uri);
      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const name = voiceNoteName(count, millis, 'm4a');
      log.info('voice note ready', { name, size: info?.size || 0 });
      setPhase('idle');
      onDone?.({ name, uri, size: info?.size || 0, mimetype: 'audio/mp4', data_b64: data, millis });
    } catch (e) {
      log.error('voice note not saved', e?.message);
      setPhase('idle');
      onCancel?.('Nothing was recorded — try again.');
    }
  }

  const ms = state?.durationMillis || 0;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => stop(false)}>
      <View style={st.wrap}>
        <View style={st.card}>
          <View style={st.micRing}>
            <Ionicons name="mic" size={34} color={phase === 'recording' ? COLORS.red : COLORS.muted} />
          </View>
          <Text style={st.time}>{clock(ms)}</Text>
          <Text style={st.sub}>
            {phase === 'starting' ? 'Getting the mic ready…'
              : phase === 'saving' ? 'Saving…'
              : ms < 5000 ? 'Recording — keep going, 5 seconds or more.'
              : 'Recording — tap Stop & attach when you are done.'}
          </Text>
          <View style={st.btns}>
            <TouchableOpacity style={st.cancel} onPress={() => stop(false)} disabled={phase === 'saving'}>
              <Text style={st.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.stopBtn, phase !== 'recording' && { opacity: 0.6 }]}
              onPress={() => stop(true)} disabled={phase !== 'recording'} activeOpacity={0.9}>
              {phase === 'saving' ? <ActivityIndicator color="#fff" size="small" /> : (
                <><Ionicons name="stop" size={16} color="#fff" /><Text style={st.stopTxt}>Stop & attach</Text></>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 18, padding: 22, alignItems: 'center' },
  micRing: { width: 74, height: 74, borderRadius: 37, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center' },
  time: { fontSize: 30, fontWeight: '800', color: COLORS.navy, marginTop: 12, fontVariant: ['tabular-nums'] },
  sub: { fontSize: 13, color: COLORS.muted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
  btns: { flexDirection: 'row', gap: 10, marginTop: 18, alignSelf: 'stretch' },
  cancel: { flex: 1, height: 46, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  cancelTxt: { fontSize: 14, fontWeight: '700', color: COLORS.muted },
  stopBtn: { flex: 1.4, height: 46, borderRadius: 12, backgroundColor: COLORS.red, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  stopTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
