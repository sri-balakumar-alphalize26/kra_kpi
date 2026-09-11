// REMINDERS — standalone reminders (kra_kpi_module's kpi.reminder model).
//
// A reminder that is NOT attached to a task: a name, a date, a time, optionally a
// client or KRA. The same rows the web shows under KRA/KPI → My Work → Reminders,
// so one made here appears there and vice versa. Personal by construction — a
// record rule scopes every row to its owner, so this screen cannot show, or be
// made to show, anybody else's.
//
// It does NOT ring yet. The reminder is stored and the server derives the exact
// UTC instant (next_trigger), but arming an on-device alarm from it needs the
// notifee rebuild — the alarm path no-ops in every currently installed build. The
// screen says so rather than leaving someone to wonder why nothing went off.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, Alert, Switch, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import DateGridModal from '../components/DateGridModal';
import DurationTimePicker from '../components/DurationTimePicker';
import { createLogger } from '../api/logger';
import * as H from '../utils/haptics';
import {
  fetchReminders, saveReminder, completeReminder, deleteReminder, fetchReminderHistory,
} from '../services/reminderList';

const log = createLogger('Reminders');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Matches the model's Selection, in the same order.
const REPEAT_OPTIONS = [
  { value: 'none', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

// Today as 'YYYY-MM-DD' in LOCAL time. Not toISOString().slice(0,10), which is
// UTC and hands back yesterday all evening at +5:30.
function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// The model stores remind_time as a float (9.5 = 09:30); the picker speaks
// {hour24, minute}. These two convert between them and are deliberately a pair —
// changing one without the other silently shifts every reminder.
function floatToHM(f) {
  const v = Number(f) || 0;
  const hour24 = Math.floor(v);
  // Round, don't truncate: 9.499999 from a float round-trip is 09:30, not 09:29.
  let minute = Math.round((v - hour24) * 60);
  if (minute >= 60) return { hour24: Math.min(23, hour24 + 1), minute: 0 };
  return { hour24, minute };
}
function hmToFloat(hour24, minute) {
  return Number(hour24) + Number(minute) / 60;
}
function fmtTime(f) {
  const { hour24, minute } = floatToHM(f);
  const ap = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${ap}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${MON[Number(m) - 1] || ''} ${y}`;
}

export default function Reminders({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [unavailable, setUnavailable] = useState(false);
  const [banner, setBanner] = useState(null);          // { kind, msg }
  const [editor, setEditor] = useState(null);          // null = modal closed
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);          // row mid-complete
  const [datePick, setDatePick] = useState(false);
  const [timePick, setTimePick] = useState(false);
  const [history, setHistory] = useState(null);        // null = sheet closed

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3200); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchReminders();
      if (res?.status) {
        setRows(res.reminders || []);
        setUnavailable(false);
      } else {
        setRows([]);
        setUnavailable(!!res?.notInstalled);
      }
    } catch (e) {
      log.warn('load failed', e?.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => {
    H.tap();
    setEditor({ id: null, name: '', remind_date: todayIso(), remind_time: 9, repeat: 'none', enabled: true });
  };
  const startEdit = (item) => {
    H.tap();
    setEditor({
      id: item.id,
      name: item.name || '',
      remind_date: item.remind_date || todayIso(),
      remind_time: Number(item.remind_time) || 0,
      repeat: item.repeat || 'none',
      enabled: item.enabled !== false,
    });
  };

  const submitEditor = async () => {
    if (!editor) return;
    const name = (editor.name || '').trim();
    if (!name) { flash('err', 'Give the reminder a name.'); return; }
    if (!editor.remind_date) { flash('err', 'Pick a date.'); return; }
    setSaving(true);
    try {
      const res = await saveReminder({
        id: editor.id || undefined,
        name,
        remind_date: editor.remind_date,
        remind_time: editor.remind_time,
        repeat: editor.repeat,
        enabled: editor.enabled,
      });
      if (res?.status) {
        setEditor(null);
        flash('ok', editor.id ? 'Reminder updated.' : 'Reminder added.');
        load();
      } else {
        flash('err', res?.message || 'Could not save the reminder.');
      }
    } catch (e) {
      flash('err', 'Could not save the reminder.');
    } finally {
      setSaving(false);
    }
  };

  // The server decides what completing means — history row, then advance a
  // repeating reminder or switch a one-shot off. Reload rather than guess, so the
  // list shows whatever it actually did.
  const doComplete = async (item) => {
    H.tap();
    setBusyId(item.id);
    try {
      const res = await completeReminder(item.id);
      if (res?.status) {
        flash('ok', item.repeat && item.repeat !== 'none' ? 'Done — moved to its next date.' : 'Done.');
        load();
      } else {
        flash('err', res?.message || 'Could not complete it.');
      }
    } finally {
      setBusyId(null);
    }
  };

  // Flip the switch straight from the list. OFF does not hide the row — that is
  // the whole reason the field is `enabled` and not Odoo's `active`, which would
  // archive it out of every list and make "off" look like "deleted".
  const toggleEnabled = async (item, on) => {
    setRows((prev) => prev.map((r) => (r.id === item.id ? { ...r, enabled: on } : r)));
    const res = await saveReminder({ id: item.id, enabled: on });
    if (!res?.status) {
      setRows((prev) => prev.map((r) => (r.id === item.id ? { ...r, enabled: !on } : r)));
      flash('err', res?.message || 'Could not change that.');
    }
  };

  const confirmDelete = (item) => {
    Alert.alert('Delete reminder', `Delete "${item.name}"? This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          const res = await deleteReminder(item.id);
          // Its completion history deliberately survives — the rows keep a copy of
          // the name and time, so past ticks stay readable after the reminder goes.
          if (res?.status) { flash('ok', 'Reminder deleted.'); load(); }
          else flash('err', res?.message || 'Could not delete.');
        },
      },
    ]);
  };

  const openHistory = async () => {
    H.tap();
    setHistory({ loading: true, rows: [] });
    const res = await fetchReminderHistory();
    setHistory({ loading: false, rows: res?.rows || [] });
  };

  const renderRow = ({ item }) => {
    const off = item.enabled === false;
    const client = Array.isArray(item.client_kra_id) ? item.client_kra_id[1] : '';
    const kra = Array.isArray(item.kra_id) ? item.kra_id[1] : '';
    const repeatLabel = (REPEAT_OPTIONS.find((r) => r.value === item.repeat) || REPEAT_OPTIONS[0]).label;
    return (
      <View style={[s.card, off && s.cardOff]}>
        <View style={s.cardMain}>
          <View style={s.bell}>
            <MaterialCommunityIcons name="bell-outline" size={22} color={off ? COLORS.faint : COLORS.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.remName, off && s.dim]} numberOfLines={2}>{item.name}</Text>
            <View style={s.metaRow}>
              <Text style={[s.when, off && s.dim]}>{fmtDate(item.remind_date)} · {fmtTime(item.remind_time)}</Text>
              {item.repeat && item.repeat !== 'none' ? (
                <View style={s.badge}><Text style={s.badgeTxt}>{repeatLabel}</Text></View>
              ) : null}
            </View>
            {client || kra ? (
              <Text style={s.sub} numberOfLines={1}>
                {client || kra}{client && kra && client !== kra ? ` · ${kra}` : ''}
              </Text>
            ) : null}
            {item.completion_count ? (
              <Text style={s.sub}>Completed {item.completion_count}×</Text>
            ) : null}
          </View>
          <Switch
            value={!off}
            onValueChange={(on) => toggleEnabled(item, on)}
            trackColor={{ true: COLORS.primary }}
          />
        </View>
        <View style={s.rowActions}>
          <TouchableOpacity style={s.rowBtn} onPress={() => doComplete(item)} disabled={busyId === item.id}>
            {busyId === item.id
              ? <ActivityIndicator size="small" color={COLORS.green} />
              : <Ionicons name="checkmark-circle-outline" size={15} color={COLORS.green} />}
            <Text style={[s.rowBtnTxt, { color: COLORS.green }]}>Done</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.rowBtn} onPress={() => startEdit(item)}>
            <Ionicons name="create-outline" size={15} color={COLORS.primary} />
            <Text style={s.rowBtnTxt}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.rowBtn} onPress={() => confirmDelete(item)}>
            <Ionicons name="trash-outline" size={15} color={COLORS.red} />
            <Text style={[s.rowBtnTxt, { color: COLORS.red }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>Reminders</Text>
        <TouchableOpacity onPress={startAdd} style={s.iconBtn}>
          <Ionicons name="add" size={26} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {banner ? (
        <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons
            name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'}
            size={16}
            color={banner.kind === 'ok' ? COLORS.green : COLORS.red}
          />
          <Text style={s.bannerTxt}>{banner.msg}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(it) => String(it.id)}
          contentContainerStyle={rows.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          renderItem={renderRow}
          ListHeaderComponent={rows.length ? (
            <TouchableOpacity style={s.histLink} onPress={openHistory} activeOpacity={0.8}>
              <Ionicons name="time-outline" size={14} color={COLORS.primary} />
              <Text style={s.histLinkTxt}>History</Text>
            </TouchableOpacity>
          ) : null}
          ListEmptyComponent={(
            <View style={s.emptyBox}>
              <MaterialCommunityIcons
                name={unavailable ? 'cloud-off-outline' : 'bell-plus-outline'}
                size={44}
                color={COLORS.faint}
              />
              <Text style={s.emptyTitle}>{unavailable ? 'Not available' : 'No reminders yet'}</Text>
              <Text style={s.emptySub}>
                {unavailable
                  ? 'This server does not have reminders set up.'
                  : 'Tap + to set one. A reminder is not attached to a task — just a name, a date and a time.'}
              </Text>
            </View>
          )}
        />
      )}

      {/* ---- Add / edit ---- */}
      <Modal visible={!!editor} transparent animationType="fade" onRequestClose={() => setEditor(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>{editor?.id ? 'Edit reminder' : 'New reminder'}</Text>
              <TouchableOpacity onPress={() => setEditor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.muted} />
              </TouchableOpacity>
            </View>

            <Text style={s.fLbl}>Reminder</Text>
            <TextInput
              style={s.input}
              placeholder="What is it for?"
              placeholderTextColor={COLORS.faint}
              value={editor?.name || ''}
              onChangeText={(t) => setEditor((p) => ({ ...p, name: t }))}
            />

            <View style={s.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={[s.fLbl, { marginTop: 14 }]}>Date</Text>
                <TouchableOpacity style={s.pickBtn} onPress={() => setDatePick(true)}>
                  <Ionicons name="calendar-outline" size={16} color={COLORS.primary} />
                  <Text style={s.pickTxt} numberOfLines={1}>{fmtDate(editor?.remind_date) || 'Pick'}</Text>
                </TouchableOpacity>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.fLbl, { marginTop: 14 }]}>Time</Text>
                <TouchableOpacity style={s.pickBtn} onPress={() => setTimePick(true)}>
                  <Ionicons name="time-outline" size={16} color={COLORS.primary} />
                  <Text style={s.pickTxt} numberOfLines={1}>{fmtTime(editor?.remind_time)}</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={[s.fLbl, { marginTop: 14 }]}>Repeat</Text>
            <View style={s.chipWrap}>
              {REPEAT_OPTIONS.map((r) => {
                const on = (editor?.repeat || 'none') === r.value;
                return (
                  <TouchableOpacity
                    key={r.value}
                    style={[s.chip, on && s.chipOn]}
                    onPress={() => { H.select(); setEditor((p) => ({ ...p, repeat: r.value })); }}
                  >
                    <Text style={[s.chipTxt, on && s.chipTxtOn]}>{r.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={s.enabledRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.fLbl}>Enabled</Text>
                <Text style={s.hint}>Off keeps it in the list — it just won't remind you.</Text>
              </View>
              <Switch
                value={editor?.enabled !== false}
                onValueChange={(on) => setEditor((p) => ({ ...p, enabled: on }))}
                trackColor={{ true: COLORS.primary }}
              />
            </View>

            <View style={s.modalActions}>
              <TouchableOpacity onPress={() => setEditor(null)}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={submitEditor} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={17} color="#fff" />}
                <Text style={s.saveTxt}>{editor?.id ? 'Save' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Both pickers hardcode `visible`, so they are rendered conditionally. */}
      {datePick ? (
        <DateGridModal
          title="Remind me on"
          value={editor?.remind_date || ''}
          onCancel={() => setDatePick(false)}
          onPick={(iso) => { setDatePick(false); setEditor((p) => ({ ...p, remind_date: iso })); }}
        />
      ) : null}

      {timePick ? (
        <DurationTimePicker
          mode="clock"
          title="Remind me at"
          initial={floatToHM(editor?.remind_time)}
          onCancel={() => setTimePick(false)}
          onConfirm={({ hour24, minute }) => {
            setTimePick(false);
            setEditor((p) => ({ ...p, remind_time: hmToFloat(hour24, minute) }));
          }}
        />
      ) : null}

      {/* ---- History ---- */}
      <Modal visible={!!history} transparent animationType="fade" onRequestClose={() => setHistory(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>History</Text>
              <TouchableOpacity onPress={() => setHistory(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            {history?.loading ? (
              <ActivityIndicator size="large" color={COLORS.primary} style={{ marginVertical: 24 }} />
            ) : history?.rows?.length ? (
              <FlatList
                data={history.rows}
                style={{ maxHeight: 340 }}
                keyExtractor={(it) => String(it.id)}
                renderItem={({ item }) => (
                  <View style={s.histRow}>
                    <Ionicons name="checkmark-circle" size={15} color={COLORS.green} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.histName} numberOfLines={1}>{item.name_snapshot}</Text>
                      <Text style={s.histWhen}>{item.completed_at}</Text>
                    </View>
                    {/* reminder_id is false once the reminder itself is gone; the
                        snapshot above is what keeps the row meaningful. */}
                    {!item.reminder_id ? <Text style={s.histGone}>deleted</Text> : null}
                  </View>
                )}
              />
            ) : (
              <Text style={s.emptySub}>Nothing completed yet.</Text>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy, marginHorizontal: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 10, padding: 10, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '600' },

  histLink: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end', marginBottom: 10, paddingVertical: 4 },
  histLinkTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.primary },

  card: { backgroundColor: COLORS.card, borderRadius: 14, marginBottom: 12, padding: 12, ...SHADOW },
  // Off reads as muted, NOT hidden. Losing the row would make "off" and "deleted"
  // look identical, which is the trap the model's `enabled` field exists to avoid.
  cardOff: { opacity: 0.62 },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bell: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#EEF2FF', alignItems: 'center', justifyContent: 'center' },
  remName: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  dim: { color: COLORS.muted },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' },
  when: { fontSize: 12.5, fontWeight: '600', color: COLORS.primary },
  sub: { fontSize: 11.5, color: COLORS.faint, marginTop: 3 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, backgroundColor: '#EDE9FE' },
  badgeTxt: { fontSize: 10.5, fontWeight: '800', color: '#7C3AED' },

  rowActions: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.line },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: COLORS.bg },
  rowBtnTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.primary },

  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyBox: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: COLORS.muted, marginTop: 6 },
  emptySub: { fontSize: 13, color: COLORS.faint, textAlign: 'center', paddingHorizontal: 20 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  modalCard: { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 20, padding: 20, ...SHADOW },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: COLORS.navy },
  fLbl: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff' },
  twoCol: { flexDirection: 'row', gap: 12 },
  pickBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: COLORS.primary, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12 },
  pickTxt: { flex: 1, fontSize: 13.5, fontWeight: '600', color: COLORS.primary },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipTxt: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  chipTxtOn: { color: '#fff' },
  enabledRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  hint: { fontSize: 11.5, color: COLORS.faint },
  modalActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 18, marginTop: 22 },
  cancelTxt: { fontSize: 14.5, fontWeight: '700', color: COLORS.muted },
  saveBtn: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primary, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 10 },
  saveTxt: { fontSize: 14.5, fontWeight: '800', color: '#fff' },

  histRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.line },
  histName: { fontSize: 13.5, fontWeight: '700', color: COLORS.ink },
  histWhen: { fontSize: 11.5, color: COLORS.faint, marginTop: 2 },
  histGone: { fontSize: 10.5, fontWeight: '700', color: COLORS.faint },
});
