// ✅ Completed / 🏁 Partially completed — the same two choices the Odoo KPI
// Details panel, the web and the WhatsApp task page offer. Completed asks for
// what the task's type needs; Partially completed only for a summary, which
// the client is sent (server: kpi_finish._finish_tell_review).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const CHOICES = [
  { partial: false, title: '✅ Completed', sub: 'Everything this task needs' },
  { partial: true, title: '🏁 Partially completed', sub: 'Only a summary' },
];

export default function FinishModeRadio({ partial, onChange }) {
  return (
    <View style={s.row} accessibilityRole="radiogroup">
      {CHOICES.map((c) => {
        const on = !!partial === c.partial;
        return (
          <TouchableOpacity key={c.title} style={[s.opt, on && s.optOn]} activeOpacity={0.8}
            accessibilityRole="radio" accessibilityState={{ checked: on }}
            onPress={() => onChange && onChange(c.partial)}>
            <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={18}
              color={on ? COLORS.primary : COLORS.faint} style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{c.title}</Text>
              <Text style={s.sub}>{c.sub}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export const PARTIAL_NOTE = '📝 Only this summary is sent. The client is sent it with the task to check.';

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  opt: {
    flex: 1, flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 10,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, backgroundColor: '#fff',
  },
  optOn: { borderColor: COLORS.primary, backgroundColor: '#F1F5FF' },
  title: { fontSize: 13, fontWeight: '800', color: COLORS.ink },
  sub: { fontSize: 11.5, color: COLORS.muted, marginTop: 2 },
});
