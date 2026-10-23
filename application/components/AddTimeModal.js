// Add time to a task's estimate.
//
// One component, used by both KPI Details and the KPI Action Board. The board
// used to hand the job to Details — which meant leaving the list to answer a
// question about a row in it — and the alternative was a second copy of this
// form. Two copies of a dialog whose whole point is a REQUIRED reason is two
// places for that requirement to drift apart, so it lives here instead.
//
// It owns its fields and their validation and nothing else: the caller supplies
// the task and decides what happens after a successful write, because "stay on
// the board and refresh the row" and "stay on the detail screen and reload it"
// are different answers to the same success.

import React, { useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { COLORS } from '../theme';
import GradientButton from './GradientButton';
import { addTaskTime } from '../services/kpiActions';

export default function AddTimeModal({ visible, task, onClose, onDone }) {
  const [h, setH] = useState('');
  const [m, setM] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    setH(''); setM(''); setReason(''); setErr('');
    onClose && onClose();
  };

  const submit = async () => {
    const hh = parseInt(h, 10) || 0;
    const mm = parseInt(m, 10) || 0;
    // Checked here as well as server-side so the answer is immediate, and worded
    // the way the server words it rather than inventing a second sentence.
    if (hh === 0 && mm === 0) { setErr('Add more than 0 minutes.'); return; }
    if (!reason.trim()) { setErr('Give a reason — it is shown on the task.'); return; }
    setBusy(true);
    try {
      const res = await addTaskTime(task.id, hh, mm, reason.trim());
      if (res?.status) {
        setH(''); setM(''); setReason(''); setErr('');
        onDone && onDone(res.message || 'Estimate extended.');
        onClose && onClose();
      } else {
        // The server refuses for reasons worth reading — the client owns the
        // estimate, or it is not your task — so show its words, not a generic one.
        setErr(res?.message || 'Could not add time.');
      }
    } catch (e) {
      setErr('Could not add time.');
    } finally { setBusy(false); }
  };

  if (!task) return null;
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.title}>Add time to the estimate</Text>
          <Text style={s.hint}>
            This adds to the current estimate of {task.estimate_display || '00:00'} — it does
            not replace it. The reason is shown on the task.
          </Text>
          <View style={s.row}>
            <TextInput style={s.num} keyboardType="number-pad" placeholder="0"
              placeholderTextColor={COLORS.faint} value={h}
              onChangeText={(t) => { setH(t.replace(/[^\d]/g, '')); if (err) setErr(''); }} />
            <Text style={s.unit}>hours</Text>
            <TextInput style={s.num} keyboardType="number-pad" placeholder="0"
              placeholderTextColor={COLORS.faint} value={m}
              onChangeText={(t) => { setM(t.replace(/[^\d]/g, '')); if (err) setErr(''); }} />
            <Text style={s.unit}>minutes</Text>
          </View>
          <TextInput style={s.reason} multiline maxLength={255}
            placeholder="Why does it need more time?" placeholderTextColor={COLORS.faint}
            value={reason}
            onChangeText={(t) => { setReason(t); if (err) setErr(''); }} />
          {!!err && <Text style={s.err}>{err}</Text>}
          <View style={s.btns}>
            <TouchableOpacity style={s.cancel} onPress={close}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <GradientButton label={busy ? 'Adding…' : 'Add time'} disabled={busy}
              onPress={submit} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  title: { fontSize: 16, fontWeight: '900', color: COLORS.ink, marginBottom: 4 },
  hint: { fontSize: 12, color: COLORS.muted, lineHeight: 17, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  num: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: COLORS.ink, width: 74, textAlign: 'center', backgroundColor: '#fff' },
  unit: { fontSize: 13, color: COLORS.muted, fontWeight: '700' },
  reason: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, padding: 11, minHeight: 74, fontSize: 14, color: COLORS.ink, textAlignVertical: 'top', backgroundColor: '#fff' },
  err: { fontSize: 12, color: COLORS.red, fontWeight: '700', marginTop: 8 },
  btns: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancel: { flex: 1, height: 44, borderRadius: 11, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  cancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
});
