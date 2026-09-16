// REMINDERS — standalone reminders (kra_kpi_module's kpi.reminder model).
//
// A reminder that is NOT attached to a task: a name, a date, a time, optionally a
// client or KRA. The same rows the web shows under KRA/KPI → My Work → Reminders,
// so one made here appears there and vice versa. Personal by construction — a
// record rule scopes every row to its owner, so this screen cannot show, or be
// made to show, anybody else's.
//
// It rings. The server computes the exact UTC instant (next_trigger, in the
// user's own timezone, DST included) and this screen arms a local notification
// from it through services/reminderAlarm.js — a heads-up banner with sound on the
// shared 'reminders' channel.
//
// It is NOT the looping full-screen alarm services/alarm.js does; that one is
// notifee and stays dead until an APK ships with it. This was reachable without
// any rebuild because expo-notifications is already in every installed build,
// already doing exactly this for per-task reminders. The header used to say the
// feature needed the notifee rebuild, which was only ever true of the ringing
// kind.
//
// Three honest limits, all consequences of having no native scheduler: nothing
// re-arms after a reboot, a reminder created on the WEB arms only when this
// device next syncs (the server pushes nothing for reminders), and only the next
// occurrence of a repeat is armed — the server advances remind_date when one is
// completed, so until then there is no later instant to schedule.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, SectionList, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, Switch, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import DateGridModal from '../components/DateGridModal';
import DurationTimePicker from '../components/DurationTimePicker';
import { createLogger } from '../api/logger';
import { syncReminderAlarms } from '../services/reminderAlarm';
import FieldError from '../components/FieldError';
import AppDialog from '../components/AppDialog';
import AlarmModePicker from '../components/AlarmModePicker';
import * as H from '../utils/haptics';
import { getReminderModes, setReminderMode } from '../api/session';
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

export default function Reminders({ onBack, uid }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [unavailable, setUnavailable] = useState(false);
  const [banner, setBanner] = useState(null);          // { kind, msg }
  const [editor, setEditor] = useState(null);          // null = modal closed
  const [saving, setSaving] = useState(false);
  // Editor errors, keyed by the field they belong to, plus `form` for a save
  // that failed. These used to go through flash(), which draws its banner in
  // the SCREEN's root view -- and the editor is a Modal, so every one of them
  // rendered behind the backdrop and expired unseen. Pressing Save simply
  // looked like it did nothing.
  const [errs, setErrs] = useState({});
  const clearErr = (k) => setErrs((p) => (p[k] ? { ...p, [k]: null } : p));
  const [busyId, setBusyId] = useState(null);          // row mid-complete
  const [datePick, setDatePick] = useState(false);
  const [timePick, setTimePick] = useState(false);
  const [history, setHistory] = useState(null);        // null = sheet closed
  // { [reminderId]: 'notify' | 'alarm' } — device-local, so it is read here rather
  // than arriving with the server rows. Absent means 'alarm' (see api/session.js).
  const [modes, setModes] = useState({});

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3200); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Read the local modes alongside the rows: syncReminderAlarms below reads
      // the same map, and the list rows need it to show the right bell icon.
      setModes(await getReminderModes(uid));
      const res = await fetchReminders();
      if (res?.status) {
        const list = res.reminders || [];
        setRows(list);
        setUnavailable(false);
        // Arm from the list we just received, not from `rows` in an effect: on
        // the first render rows is still [], and syncing that would cancel every
        // alarm on the device a moment before the real list arrived.
        //
        // Every mutation on this screen ends in load(), so this one call covers
        // add, edit, complete and delete. The toggle is the exception -- it
        // updates optimistically without reloading -- and syncs itself below.
        syncReminderAlarms(list, uid);
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
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => {
    H.tap();
    setErrs({});
    setEditor({ id: null, name: '', remind_date: todayIso(), remind_time: 9, repeat: 'none',
      enabled: true, mode: 'alarm' });
  };
  const startEdit = (item) => {
    H.tap();
    setErrs({});
    setEditor({
      id: item.id,
      name: item.name || '',
      remind_date: item.remind_date || todayIso(),
      remind_time: Number(item.remind_time) || 0,
      repeat: item.repeat || 'none',
      enabled: item.enabled !== false,
      mode: modes[String(item.id)] === 'notify' ? 'notify' : 'alarm',
    });
  };

  const submitEditor = async () => {
    if (!editor) return;
    const name = (editor.name || '').trim();
    // Collected together rather than returning on the first miss, so a form with
    // two things wrong says so once instead of making the user press Save twice.
    const next = {};
    if (!name) next.name = 'Give the reminder a name.';
    if (!editor.remind_date) next.date = 'Pick a date.';
    setErrs(next);
    if (next.name || next.date) return;
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
        // Before load(): load() re-reads the mode map and then calls
        // syncReminderAlarms, so writing after it would arm the OLD mode and leave
        // the new one waiting for the next sync.
        if (res.id) await setReminderMode(res.id, editor.mode, uid);
        setEditor(null);
        flash('ok', editor.id ? 'Reminder updated.' : 'Reminder added.');
        load();
      } else {
        // NOT flash(): the modal is still open at this point, so a banner would
        // be drawn behind it. Shown above the Save button instead -- a failed save
        // belongs to the button that was pressed, not to any one field.
        setErrs({ form: res?.message || 'Could not save the reminder.' });
      }
    } catch (e) {
      setErrs({ form: 'Could not save the reminder.' });
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
      return;
    }
    // This is the one change that does not reload, and `enabled` decides whether
    // a reminder is armed at all -- the server's next_trigger does NOT depend on
    // it, so switching one off leaves a perfectly good future instant behind.
    // Without this the switch would say off and the phone would still ring.
    setRows((prev) => { syncReminderAlarms(prev, uid); return prev; });
  };

  // The app's own dialog rather than Alert.alert. The OS alert is the one piece
  // of this screen that looked like a different app: no shared icon, tone or
  // button styling, and on Android it cannot show the danger red the action
  // deserves. AppDialog also gives us a `busy` state, which the OS alert has no
  // way to express — it dismisses on tap and leaves the row sitting there while
  // the request is still in flight.
  const [delItem, setDelItem] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const doDelete = async () => {
    if (!delItem || deleting) return;
    setDeleting(true);
    try {
      const res = await deleteReminder(delItem.id);
      setDelItem(null);
      // Its completion history deliberately survives — the rows keep a copy of
      // the name and time, so past ticks stay readable after the reminder goes.
      // Its MODE does not: that is device-local bookkeeping keyed by an id the
      // server will reuse for somebody else's reminder, so it is dropped here
      // rather than left to accumulate.
      if (res?.status) {
        await setReminderMode(delItem.id, null, uid);
        flash('ok', 'Reminder deleted.');
        load();
      }
      else flash('err', res?.message || 'Could not delete.');
    } catch (e) {
      setDelItem(null);
      flash('err', 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDelete = (item) => { H.tap(); setDelItem(item); };

  const openHistory = async () => {
    H.tap();
    setHistory({ loading: true, rows: [] });
    const res = await fetchReminderHistory();
    setHistory({ loading: false, rows: res?.rows || [] });
  };

  // Split the list by how each reminder will actually fire. A reminder that rings
  // full-screen and one that posts a quiet banner are very different things to be
  // expecting, and in a flat list the only difference was a small icon.
  //
  // Order is Alarm first: those are the ones that will interrupt you, so they are
  // what someone scanning this screen is checking on. An empty section is dropped
  // rather than shown — a "Notify (0)" header is noise.
  const sections = useMemo(() => {
    const alarm = [];
    const notify = [];
    for (const r of rows) {
      (modes[String(r.id)] === 'notify' ? notify : alarm).push(r);
    }
    return [
      { title: `Alarm · ${alarm.length}`, mode: 'alarm', data: alarm },
      { title: `Notify · ${notify.length}`, mode: 'notify', data: notify },
    ].filter((sec) => sec.data.length);
  }, [rows, modes]);

  const renderRow = ({ item }) => {
    const off = item.enabled === false;
    const client = Array.isArray(item.client_kra_id) ? item.client_kra_id[1] : '';
    const kra = Array.isArray(item.kra_id) ? item.kra_id[1] : '';
    const repeatLabel = (REPEAT_OPTIONS.find((r) => r.value === item.repeat) || REPEAT_OPTIONS[0]).label;
    // A ringing alarm and a quiet notification are very different things to be
    // expecting, so the row says which without having to open the editor.
    const isAlarm = modes[String(item.id)] !== 'notify';
    return (
      <View style={[s.card, off && s.cardOff]}>
        <View style={s.cardMain}>
          <View style={s.bell}>
            <MaterialCommunityIcons
              name={isAlarm ? 'alarm' : 'bell-outline'}
              size={22}
              color={off ? COLORS.faint : COLORS.primary}
            />
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

      {/* Outside the list, and NOT gated on whether there are any reminders.
          History outlives the reminders it came from — that is the entire point
          of snapshotting the name and time and setting reminder_id to null on
          delete — so tying this link to the list would hide the surviving history
          at exactly the moment it is the only thing left. Deleting your last
          reminder must not also delete your record of having done it.

          It sits here rather than in ListHeaderComponent because the empty state
          centres its children, which would leave this floating mid-screen. */}
      {!loading ? (
        <TouchableOpacity style={s.histLink} onPress={openHistory} activeOpacity={0.8}>
          <Ionicons name="time-outline" size={14} color={COLORS.primary} />
          <Text style={s.histLinkTxt}>History</Text>
        </TouchableOpacity>
      ) : null}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(it) => String(it.id)}
          contentContainerStyle={rows.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          renderItem={renderRow}
          stickySectionHeadersEnabled={false}
          // Only drawn when there is something to separate. With every reminder on
          // the same setting a lone header is noise, and on a screen most people
          // use for two or three reminders that is the common case.
          renderSectionHeader={({ section }) => (
            sections.length > 1
              ? (
                <View style={s.sectionHead}>
                  <MaterialCommunityIcons
                    name={section.mode === 'alarm' ? 'alarm' : 'bell-outline'}
                    size={14}
                    color={COLORS.muted}
                  />
                  <Text style={s.sectionTxt}>{section.title}</Text>
                </View>
              )
              : null
          )}
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
              style={[s.input, errs.name && s.inputErr]}
              placeholder="What is it for?"
              placeholderTextColor={COLORS.faint}
              value={editor?.name || ''}
              onChangeText={(t) => { setEditor((p) => ({ ...p, name: t })); clearErr('name'); }}
            />
            <FieldError msg={errs.name} />

            <View style={s.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={[s.fLbl, { marginTop: 14 }]}>Date</Text>
                <TouchableOpacity
                  style={[s.pickBtn, errs.date && s.inputErr]}
                  onPress={() => { clearErr('date'); setDatePick(true); }}
                >
                  <Ionicons name="calendar-outline" size={16} color={COLORS.primary} />
                  <Text style={s.pickTxt} numberOfLines={1}>{fmtDate(editor?.remind_date) || 'Pick'}</Text>
                </TouchableOpacity>
                <FieldError msg={errs.date} />
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

            {/* How it fires. Until this existed services/reminderAlarm.js decided
                by capability, so a build with notifee turned every reminder into a
                full-screen alarm whether or not that was wanted. */}
            <Text style={[s.fLbl, { marginTop: 14 }]}>How it reminds you</Text>
            <AlarmModePicker
              mode={editor?.mode === 'notify' ? 'notify' : 'alarm'}
              onModeChange={(m) => { H.select(); setEditor((p) => ({ ...p, mode: m })); }}
            />

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

            {/* Beside the button it belongs to. utils/workdayNote.js records the
                opposite mistake: a refusal rendered far above the button, which
                made the button itself read as broken. */}
            <FieldError msg={errs.form} />

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

      {/* Last in the tree so it paints above everything, including the
          editor sheet. */}
      <AppDialog
        visible={!!delItem}
        tone="danger"
        destructive
        busy={deleting}
        title="Delete reminder"
        message={delItem ? `Delete \u201c${delItem.name}\u201d? This can\u2019t be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setDelItem(null)}
      />
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

  histLink: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end', marginRight: 14, marginBottom: 4, paddingVertical: 4 },
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

  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10, paddingBottom: 6, paddingHorizontal: 2 },
  sectionTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted, letterSpacing: 0.4, textTransform: 'uppercase' },
  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyBox: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: COLORS.muted, marginTop: 6 },
  emptySub: { fontSize: 13, color: COLORS.faint, textAlign: 'center', paddingHorizontal: 20 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  modalCard: { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 20, padding: 20, ...SHADOW },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: COLORS.navy },
  fLbl: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted, marginBottom: 6 },
  inputErr: { borderColor: COLORS.red },
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
