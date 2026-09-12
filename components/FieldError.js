// One line of red, under the field it is about.
//
// The bug this exists for: several editors validated with flash()/a banner drawn
// in the SCREEN's root view while the form itself is a Modal. The message
// rendered behind the modal backdrop, auto-dismissed a few seconds later, and was
// never seen — pressing Save just looked like nothing happened.
//
// Inline rather than a popup, and that is a settled question here:
// KpiActionBoard.js says "the answer is three inches away on the same screen, so
// throwing a system dialog over it made the fix harder to reach than the mistake
// was. Stacking the board's own popup would be worse still: two RN Modals at once
// are unreliable on Android." Every form using this is already inside a Modal.
//
// Renders nothing without a message, so callers can drop it in unconditionally
// rather than wrapping each one in a ternary.
//
// Matches `inlineErr` / `inlineErrTxt` in KpiActionBoard (and its copies in
// PauseReasonDialog, AddTimeModal, LiveTracking) — this is the same look
// extracted, not a new one.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';

export default function FieldError({ msg, style }) {
  if (!msg) return null;
  return (
    <View style={[s.box, style]}>
      <Ionicons name="alert-circle" size={14} color={COLORS.red} />
      <Text style={s.txt}>{msg}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 9, paddingHorizontal: 9, paddingVertical: 7, marginTop: 6,
  },
  txt: { flex: 1, fontSize: 12, color: COLORS.red, fontWeight: '600', lineHeight: 16 },
});
