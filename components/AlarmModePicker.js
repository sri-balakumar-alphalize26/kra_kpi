// How a reminder should fire: a single notification, or a full-screen ringing
// alarm — plus the alarm's sound, ring length and snooze length.
//
// WHY THIS IS SHARED. The task Remind-me dialog (screens/KpiActionBoard.js) has
// offered this choice for a long time; personal reminders (screens/Reminders.js)
// never did, and services/reminderAlarm.js decided for them by capability instead
// — `canRing = alarmAvailable()`, so once a build shipped with notifee EVERY
// reminder became a full-screen alarm. Giving Reminders the same control meant
// either copying the block or lifting it. Copying is what left this codebase with
// two `dlg`/`say()` implementations and two MeetingPickers; one definition here
// means the two screens cannot drift.
//
// WHAT IS PER-REMINDER AND WHAT IS NOT. The MODE is per reminder and the caller
// owns it (passed in, reported back through onModeChange). The sound, ring length
// and snooze length are GLOBAL app settings, read by services/alarm.js at schedule
// time — one set, shared by task alarms and reminder alarms alike. That is why the
// hint says so out loud: without it, people reasonably expect the sound they picked
// here to belong to this reminder only, and report it as a bug.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../theme';
import { alarmAvailable, pickAlarmSound, titleFromUri } from '../services/alarm';
import {
  getAlarmSound, setAlarmSound,
  getAlarmSettings, setAlarmSettings,
} from '../api/session';
import DurationTimePicker from './DurationTimePicker';

// 15→"15 min", 60→"1 hr", 90→"1 hr 30 min". Same shape the board uses for its
// quick-timer chips, so the two read identically.
function fmtDurLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

/**
 * @param {'notify'|'alarm'} mode   current choice
 * @param {(m: string) => void} onModeChange
 * @param {boolean} showSharedHint  say that sound/ring/snooze are app-wide
 * @param {React.ReactNode} children  rendered between the hint and the alarm rows
 *
 * `children` exists for the task Remind-me dialog, which has always drawn its
 * "Reason (optional)" field in exactly that gap. Without the slot, adopting this
 * component would silently reorder a working screen — the reason field would jump
 * below the sound and snooze rows. A layout change nobody asked for is not an
 * acceptable side effect of removing a duplicate.
 */
export default function AlarmModePicker({ mode, onModeChange, showSharedHint = true, children }) {
  const [sound, setSound] = useState(null);
  const [settings, setSettings] = useState({ ringMins: 5, snoozeMins: 5 });
  // { field: 'ring' | 'snooze' } while the wheel picker is up. Rendered only while
  // open so it remounts at the right scroll position each time.
  const [picker, setPicker] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [snd, saved] = await Promise.all([getAlarmSound(), getAlarmSettings()]);
      if (!alive) return;
      // Always re-derive the name from the URI so old or generic saves self-heal —
      // early builds stored a placeholder title alongside a perfectly good uri, and
      // without this the row keeps showing that stale name forever.
      setSound(snd ? { ...snd, title: titleFromUri(snd.uri) || snd.title } : null);
      setSettings(saved);
    })();
    return () => { alive = false; };
  }, []);

  const chooseSound = async () => {
    const snd = await pickAlarmSound(sound);
    if (!snd) return;               // cancelled — leave the current choice alone
    setSound(snd);
    await setAlarmSound(snd);
  };

  const onPickerConfirm = async (result) => {
    const field = picker && picker.field;
    setPicker(null);
    if (!field) return;
    const key = field === 'ring' ? 'ringMins' : 'snoozeMins';
    // ringMins may be 0 — that is "ring until I stop it", so clamp at 0, not 1.
    // snoozeMins must be at least a minute or Snooze would re-ring immediately.
    const mins = field === 'ring'
      ? Math.max(0, result.minutes)
      : Math.max(1, result.minutes);
    setSettings((s) => ({ ...s, [key]: mins }));
    await setAlarmSettings({ [key]: mins });
  };

  const isAlarm = mode === 'alarm';
  // Android-only: pickAlarmSound drives the system ringtone picker, and the
  // full-screen alarm is an Android affordance to begin with.
  const showAlarmRows = isAlarm && Platform.OS === 'android';

  return (
    <>
      <View style={st.modeRow}>
        <TouchableOpacity
          style={[st.modeBtn, !isAlarm && st.modeBtnActive]}
          activeOpacity={0.85}
          onPress={() => onModeChange('notify')}
        >
          <Text style={[st.modeTxt, !isAlarm && st.modeTxtActive]}>🔔 Notify</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[st.modeBtn, isAlarm && st.modeBtnActive]}
          activeOpacity={0.85}
          onPress={() => onModeChange('alarm')}
        >
          <Text style={[st.modeTxt, isAlarm && st.modeTxtActive]}>⏰ Alarm</Text>
        </TouchableOpacity>
      </View>

      <Text style={st.modeHint}>
        {isAlarm
          ? (alarmAvailable()
              ? 'Rings full-screen and loops until you tap Stop.'
              : 'Rings full-screen on a build with the alarm engine; here it falls back to a notification.')
          : 'A single notification with sound, at the time you set.'}
      </Text>

      {children}

      {showAlarmRows ? (
        <>
          <TouchableOpacity style={st.row} activeOpacity={0.8} onPress={chooseSound}>
            <Ionicons name="musical-notes-outline" size={18} color={COLORS.primary} />
            <Text style={st.rowLabel} numberOfLines={1}>
              Alarm sound: <Text style={st.rowValue}>{(sound && sound.title) || 'Default alarm'}</Text>
            </Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={st.row}
            activeOpacity={0.8}
            onPress={() => setPicker({ field: 'ring' })}
          >
            <Ionicons name="timer-outline" size={18} color={COLORS.primary} />
            <Text style={st.rowLabel} numberOfLines={1}>
              Rings for: <Text style={st.rowValue}>
                {settings.ringMins > 0 ? fmtDurLabel(settings.ringMins) : 'Until I stop it'}
              </Text>
            </Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={st.row}
            activeOpacity={0.8}
            onPress={() => setPicker({ field: 'snooze' })}
          >
            <Ionicons name="bed-outline" size={18} color={COLORS.primary} />
            <Text style={st.rowLabel} numberOfLines={1}>
              Snooze: <Text style={st.rowValue}>{fmtDurLabel(settings.snoozeMins)}</Text>
            </Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />
          </TouchableOpacity>

          {showSharedHint ? (
            <Text style={st.sharedHint}>
              Sound, ring length and snooze apply to every alarm in the app.
            </Text>
          ) : null}
        </>
      ) : null}

      {picker ? (
        <DurationTimePicker
          mode="duration"
          title={picker.field === 'ring' ? 'Rings for' : 'Snooze for'}
          initial={picker.field === 'ring' ? settings.ringMins : settings.snoozeMins}
          infiniteLabel={picker.field === 'ring' ? 'Ring until I stop it' : undefined}
          onCancel={() => setPicker(null)}
          onConfirm={onPickerConfirm}
        />
      ) : null}
    </>
  );
}

const st = StyleSheet.create({
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  modeBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff' },
  modeBtnActive: { borderColor: COLORS.primary, backgroundColor: '#E0ECFF' },
  modeTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.muted },
  modeTxtActive: { color: COLORS.primary },
  modeHint: { fontSize: 11.5, color: COLORS.faint, marginBottom: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 12, backgroundColor: '#F7FAFF', marginBottom: 12 },
  rowLabel: { flex: 1, fontSize: 13.5, fontWeight: '700', color: COLORS.muted },
  rowValue: { color: COLORS.primary, fontWeight: '800' },
  sharedHint: { fontSize: 11, color: COLORS.faint, marginTop: -6, marginBottom: 12 },
});
