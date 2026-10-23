// A clock-style wheel picker used across the reminder popup. Two modes:
//   mode="duration" → Hours (0–12) + Minutes (0–59) columns → returns { minutes }.
//   mode="clock"    → Hour (1–12) + Minute (0–59) + AM/PM columns → returns { hour24, minute }.
// Pure JS (snap-scroll wheels), so it works in Expo Go too. Render it only while
// open (mount = fresh scroll position). Hours column is on the left → "first hr, then min".
import React, { useRef, useState, useEffect } from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';

const ITEM_H = 44;
const VISIBLE = 5;
const WHEEL_H = ITEM_H * VISIBLE;
const PAD = (WHEEL_H - ITEM_H) / 2;

const range = (a, b) => { const out = []; for (let i = a; i <= b; i += 1) out.push(i); return out; };
const HOURS_DUR = range(0, 12);
const HOURS_CLOCK = range(1, 12);
const MINUTES = range(0, 59);
const APS = ['AM', 'PM'];

// One scrollable wheel column. Snaps to ITEM_H; reports the centered value on settle.
function Wheel({ data, value, onChange, width, format }) {
  const ref = useRef(null);
  const idx = Math.max(0, data.indexOf(value));
  useEffect(() => {
    const t = setTimeout(() => ref.current && ref.current.scrollTo({ y: idx * ITEM_H, animated: false }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onEnd = (e) => {
    let i = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
    i = Math.max(0, Math.min(data.length - 1, i));
    if (data[i] !== value) onChange(data[i]);
  };
  return (
    <View style={[styles.wheel, { width, height: WHEEL_H }]}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        nestedScrollEnabled
        onMomentumScrollEnd={onEnd}
        contentContainerStyle={{ paddingVertical: PAD }}
      >
        {data.map((d, i) => (
          <View key={i} style={styles.item}>
            <Text style={[styles.itemTxt, d === value && styles.itemTxtSel]}>
              {format ? format(d) : String(d)}
            </Text>
          </View>
        ))}
      </ScrollView>
      <View pointerEvents="none" style={styles.centerBand} />
    </View>
  );
}

export default function DurationTimePicker({ mode = 'duration', initial, title, infiniteLabel, onCancel, onConfirm }) {
  const seedHour = mode === 'duration'
    ? Math.floor((initial || 0) / 60)
    : ((((initial && initial.hour24 != null ? initial.hour24 : 8) + 11) % 12) + 1);
  const seedMin = mode === 'duration' ? ((initial || 0) % 60) : (initial && initial.minute != null ? initial.minute : 0);
  const seedAp = mode === 'clock' ? ((initial && initial.hour24 != null ? initial.hour24 : 8) < 12 ? 'AM' : 'PM') : 'AM';

  const [h, setH] = useState(seedHour);
  const [m, setM] = useState(seedMin);
  const [ap, setAp] = useState(seedAp);

  const confirm = () => {
    if (mode === 'duration') {
      onConfirm({ minutes: h * 60 + m });
    } else {
      let hour24 = h % 12;
      if (ap === 'PM') hour24 += 12;
      onConfirm({ hour24, minute: m });
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title || (mode === 'duration' ? 'Set duration' : 'Set time')}</Text>
          <View style={styles.wheels}>
            {mode === 'duration' ? (
              <>
                <Wheel data={HOURS_DUR} value={h} onChange={setH} width={96} format={(d) => `${d} hr`} />
                <Wheel data={MINUTES} value={m} onChange={setM} width={96} format={(d) => `${d} min`} />
              </>
            ) : (
              <>
                <Wheel data={HOURS_CLOCK} value={h} onChange={setH} width={64} />
                <Wheel data={MINUTES} value={m} onChange={setM} width={64} format={(d) => String(d).padStart(2, '0')} />
                <Wheel data={APS} value={ap} onChange={setAp} width={64} />
              </>
            )}
          </View>
          {/* Optional "no auto-stop" shortcut (ring picker) → confirms 0 minutes. */}
          {infiniteLabel ? (
            <TouchableOpacity onPress={() => onConfirm({ minutes: 0 })} style={styles.infiniteBtn} activeOpacity={0.8}>
              <Text style={styles.infiniteTxt}>🔔  {infiniteLabel}</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.actions}>
            <TouchableOpacity onPress={onCancel} style={styles.btnGhost} activeOpacity={0.7}>
              <Text style={styles.btnGhostTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={confirm} style={styles.btnPrimary} activeOpacity={0.85}>
              <Text style={styles.btnPrimaryTxt}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  sheet: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 18, padding: 18 },
  title: { fontSize: 16, fontWeight: '900', color: '#0F1F4D', textAlign: 'center', marginBottom: 10 },
  wheels: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  wheel: { position: 'relative' },
  item: { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  itemTxt: { fontSize: 18, fontWeight: '700', color: '#9AA7C2' },
  itemTxtSel: { fontSize: 20, fontWeight: '900', color: '#1E40AF' },
  centerBand: {
    position: 'absolute', left: 0, right: 0, top: PAD, height: ITEM_H,
    borderTopWidth: 1.5, borderBottomWidth: 1.5, borderColor: '#C7DDF7',
  },
  infiniteBtn: { marginTop: 12, paddingVertical: 11, borderRadius: 10, backgroundColor: '#EAF2FF', borderWidth: 1, borderColor: '#C7DDF7', alignItems: 'center' },
  infiniteTxt: { color: '#1E40AF', fontWeight: '800', fontSize: 13.5 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btnGhost: { flex: 1, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: '#C7DDF7', alignItems: 'center' },
  btnGhostTxt: { color: '#4B5B7A', fontWeight: '800', fontSize: 14.5 },
  btnPrimary: { flex: 1, paddingVertical: 13, borderRadius: 12, backgroundColor: '#1E40AF', alignItems: 'center' },
  btnPrimaryTxt: { color: '#fff', fontWeight: '900', fontSize: 14.5 },
});
