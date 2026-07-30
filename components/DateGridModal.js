// A month-grid date picker, as a centred dialog.
//
// Hand-rolled on purpose. The app ships no date library, and
// @react-native-community/datetimepicker is a native module — adding one means a
// new build, which is not always available. This works in Expo Go and in an
// already-installed APK with no rebuild, and it looks the same on both platforms
// instead of inheriting two different OS pickers.
//
// The calendar arithmetic lives in utils/dateGrid so the fiddly parts (leap
// years, month lengths, Monday-first alignment) are unit-tested without
// rendering. This file is only presentation.
//
// Extracted from ClientInvoices so WorkReport can use the same picker rather than
// carry a second copy of it — the two screens had the identical typed-date
// problem, and one of them fixed is how they drift apart.

import React, { useState } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import {
  fmtYMD, parseYMD, monthGrid, shiftMonth, monthTitle, WEEKDAY_LABELS,
} from '../utils/dateGrid';

/**
 * title    — dialog heading, e.g. 'Period from'
 * value    — currently selected 'YYYY-MM-DD' (or '')
 * minDate  — 'YYYY-MM-DD'; earlier days render but cannot be picked
 * maxDate  — as above, for later days
 * onPick   — (iso) => void
 * onCancel — () => void
 */
export default function DateGridModal({ title, value, minDate, maxDate, onCancel, onPick }) {
  // Open on the month of the current value, falling back to today for a blank
  // or malformed field.
  const [cursor, setCursor] = useState(() => {
    const d = parseYMD(value) || new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const cells = monthGrid(cursor.year, cursor.month);
  const todayIso = fmtYMD(new Date());

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity style={s.sheet} activeOpacity={1}>
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.close}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={s.nav}>
            <TouchableOpacity style={s.navBtn} activeOpacity={0.7}
              onPress={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}>
              <Ionicons name="chevron-back" size={20} color={COLORS.primary} />
            </TouchableOpacity>
            <Text style={s.navTitle}>{monthTitle(cursor.year, cursor.month)}</Text>
            <TouchableOpacity style={s.navBtn} activeOpacity={0.7}
              onPress={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}>
              <Ionicons name="chevron-forward" size={20} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          <View style={s.grid}>
            {WEEKDAY_LABELS.map((w, i) => (
              // Index in the key, not the letter: T/T and S/S repeat.
              <Text key={`wd-${i}`} style={s.weekday}>{w}</Text>
            ))}
            {cells.map((c) => {
              if (!c.day) return <View key={c.key} style={s.cell} />;
              // Out-of-range days stay visible but unpickable — hiding them makes
              // the month look wrong; greying says why it will not respond.
              const blocked = (minDate && c.iso < minDate) || (maxDate && c.iso > maxDate);
              const sel = c.iso === value;
              return (
                <TouchableOpacity key={c.key} style={s.cell} activeOpacity={blocked ? 1 : 0.7}
                  disabled={blocked} onPress={() => onPick(c.iso)}>
                  <View style={[s.day, sel && s.dayOn, !sel && c.iso === todayIso && s.dayToday]}>
                    <Text style={[s.dayTxt, sel && s.dayTxtOn, blocked && s.dayTxtOff]}>{c.day}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={s.foot}>
            <TouchableOpacity onPress={() => onPick(todayIso)}>
              <Text style={s.ok}>Today</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onCancel}>
              <Text style={s.cancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  // maxHeight so the card can never outgrow the screen — a centred dialog that
  // does pushes its own header off the top.
  sheet: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 20, maxHeight: '85%', paddingBottom: 16, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  title: { flex: 1, fontSize: 17, fontWeight: '800', color: COLORS.navy },
  close: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },

  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  navBtn: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F5FF' },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '800', color: COLORS.navy },

  // Sevenths, so the columns line up with the weekday header at any width.
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingBottom: 6 },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 11, fontWeight: '800', color: COLORS.faint, paddingVertical: 6 },
  cell: { width: `${100 / 7}%`, alignItems: 'center', justifyContent: 'center', paddingVertical: 3 },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: COLORS.primary },
  dayToday: { borderWidth: 1.5, borderColor: COLORS.primary },
  dayTxt: { fontSize: 14, fontWeight: '700', color: COLORS.ink },
  dayTxtOn: { color: '#fff', fontWeight: '900' },
  dayTxtOff: { color: COLORS.faint, fontWeight: '600' },

  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.line },
  ok: { fontSize: 15, fontWeight: '900', color: COLORS.primary },
  cancel: { fontSize: 15, fontWeight: '700', color: COLORS.muted },
});
