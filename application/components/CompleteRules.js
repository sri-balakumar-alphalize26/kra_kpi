// What this task's type needs to be completed — one row per rule, ✓ when it is
// already on the task, ✗ when it is required and still missing, "optional"
// otherwise. Rules that can be typed here (app link, manual link, website URL,
// the four database details) get an input under their row while not done.
//
// The rules come from the server (meta.completion_rules / the checklists route,
// built by kpi_workflow._completion_rules), the same list the Odoo screen, the
// web and the WhatsApp task page show — never decided in the app.
//
// readOnly: the Approve popup shows the list without inputs.
import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { COMPLETE_FIELDS } from '../utils/completeMissing';

export default function CompleteRules({ rules, filled = {}, onChange, readOnly = false, hasSummary = false }) {
  if (!rules || !rules.length) return null;
  return (
    <View>
      {rules.map((r) => {
        const field = !readOnly && !r.done ? COMPLETE_FIELDS[r.key] : null;
        const done = r.done || (r.key === 'summary' && hasSummary) || !!String(filled[r.key] || '').trim();
        return (
          <View key={r.key} style={s.row}>
            <View style={s.line}>
              <Ionicons
                name={done ? 'checkmark-circle' : (r.required ? 'close-circle' : 'ellipse-outline')}
                size={18} color={done ? COLORS.green : (r.required ? COLORS.red : COLORS.faint)} />
              <Text style={s.label}>
                {r.label}{r.required ? <Text style={s.req}> *</Text> : null}
              </Text>
              {!done && !r.required ? <Text style={s.opt}>optional</Text> : null}
            </View>
            {field ? (
              <TextInput
                style={s.input}
                value={filled[r.key] || ''}
                onChangeText={(t) => onChange && onChange({ ...filled, [r.key]: t })}
                placeholder={field.placeholder}
                placeholderTextColor={COLORS.faint}
                secureTextEntry={!!field.secure}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: { paddingVertical: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  label: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '700' },
  req: { color: COLORS.red },
  opt: { fontSize: 11.5, color: COLORS.muted, fontWeight: '600' },
  input: {
    marginTop: 6, marginLeft: 27, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: COLORS.ink,
  },
});
