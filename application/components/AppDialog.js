// The app's own alert and confirm.
//
// Replaces Alert.alert, which draws the OS dialog: square, grey, system-font, and
// visibly not part of this app — jarring next to screens that are otherwise all
// rounded cards and gradients. The web made the same move, swapping its browser
// alert/confirm/prompt calls for in-page dialogs.
//
// Two shapes, one component:
//   tone 'info' | 'ok' | 'warn' | 'danger'  — colours the header strip and the
//   confirm button, so "your estimate was extended" and "this cannot be undone"
//   do not arrive looking identical.
//
// A confirm is any call that passes onConfirm; without one this is an alert with
// a single dismiss button. Cancel is always available and always safe.

import React, { useState, useEffect } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const TONE = {
  info:   { fg: COLORS.primary, bg: '#EAF1FE', icon: 'information-circle' },
  ok:     { fg: '#16A34A',      bg: '#DCFCE7', icon: 'checkmark-circle' },
  warn:   { fg: '#B45309',      bg: '#FEF3C7', icon: 'alert-circle' },
  danger: { fg: COLORS.red,     bg: '#FEE2E2', icon: 'warning' },
};

export default function AppDialog({
  visible,
  tone = 'info',
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  // Optional single free-text field, for a confirm that has to carry a reason
  // with it. Off unless `input` is passed, so every existing caller is
  // unaffected. `inputRequired` dims and disables the confirm until it is filled;
  // the text arrives as the argument to onConfirm.
  input = null,              // { label, placeholder, required }
  onConfirm,
  onClose,
}) {
  const t = TONE[tone] || TONE.info;
  const isConfirm = !!onConfirm;
  const [text, setText] = useState('');
  // Clear between openings — a reason typed for one task must never arrive
  // attached to the next.
  useEffect(() => { if (!visible) setText(''); }, [visible]);
  const inputBlocked = !!(input && input.required && !text.trim());
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <View style={[s.iconWrap, { backgroundColor: t.bg }]}>
            <Ionicons name={destructive ? 'warning' : t.icon} size={26} color={destructive ? COLORS.red : t.fg} />
          </View>
          {!!title && <Text style={s.title}>{title}</Text>}
          {/* Scrolls, because a server refusal can be a paragraph and a truncated
              explanation is worse than none. */}
          {!!message && (
            <ScrollView style={{ maxHeight: 220 }}>
              <Text style={s.msg}>{message}</Text>
            </ScrollView>
          )}
          {!!input && (
            <View style={s.inputWrap}>
              {!!input.label && <Text style={s.inputLabel}>{input.label}</Text>}
              <TextInput
                style={s.input}
                placeholder={input.placeholder || ''}
                placeholderTextColor={COLORS.faint}
                value={text}
                onChangeText={setText}
                multiline
                editable={!busy}
              />
            </View>
          )}
          <View style={s.btns}>
            {isConfirm && (
              <TouchableOpacity style={s.cancel} onPress={busy ? undefined : onClose} activeOpacity={0.85}>
                <Text style={s.cancelTxt}>{cancelLabel}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[s.ok, { backgroundColor: destructive ? COLORS.red : t.fg }, (busy || inputBlocked) && { opacity: 0.6 }]}
              onPress={(busy || inputBlocked) ? undefined : (isConfirm ? () => onConfirm(text.trim()) : onClose)}
              activeOpacity={0.85}
            >
              <Text style={s.okTxt}>{busy ? 'Working…' : confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  card: { width: '100%', maxWidth: 400, backgroundColor: '#fff', borderRadius: 18, padding: 20, alignItems: 'center' },
  iconWrap: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: 16.5, fontWeight: '900', color: COLORS.navy, textAlign: 'center', marginBottom: 6 },
  msg: { fontSize: 13.5, color: COLORS.muted, lineHeight: 20, textAlign: 'center' },
  inputWrap: { alignSelf: 'stretch', marginTop: 14 },
  inputLabel: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginBottom: 6 },
  input: {
    borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 12, paddingHorizontal: 12,
    paddingVertical: 10, minHeight: 74, textAlignVertical: 'top', fontSize: 14, color: COLORS.ink,
    backgroundColor: '#fff',
  },
  btns: { flexDirection: 'row', gap: 10, marginTop: 18, alignSelf: 'stretch' },
  cancel: {
    flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  cancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  ok: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  okTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
