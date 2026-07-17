// CLIENT TASK QUEUE (admin-only) — mobile port of the web kpi_pending_queue.
// Client-submitted tasks land here unpublished and INVISIBLE to the team. The
// admin fills in the missing details (Ref ID, estimate, developer) and hits
// Save & Publish, which releases the task AND asks the client to approve the
// assigned developer (auto-approves after the configured window).
//
// Layout: a drill-down rather than a wall of full-width cards —
//   Date  ▸  Client  ▸  Task  ▸  the full editable form (one task at a time)
// so a long queue stays scannable and you only open what you're working on.
//
// Gating: /kpi_pending_queue/list has no server-side guard, but update/publish/
// delete enforce group_kra_admin | base.group_system (owner NOT included). So we
// gate on the same rule the ROUTES use — otherwise an owner would get a form that
// fails on every submit.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Platform, ActivityIndicator, Modal,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { fetchQueue, saveQueueTask, publishQueueTask, discardQueueTask } from '../services/pendingQueue';
// Reuse: same route the web picker uses, and the same priority triple.
import { getUsers, getUserInfo, PRIORITIES } from '../services/uploadAmendments';

const log = createLogger('ClientTaskQueue');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

const KIND_META = {
  requirement: { label: 'REQ', bg: '#EDE9FE', fg: '#6D28D9' },
  update:      { label: 'UPT', bg: '#FFEDD5', fg: '#EA580C' },
  bug:         { label: 'BUG', bg: '#FEE2E2', fg: '#DC2626' },
};
const prioLabel = (v) => (PRIORITIES.find((p) => p.value === v) || {}).label || 'Regular';
// received_at arrives pre-formatted 'YYYY-MM-DD HH:MM' — just take the date half.
const dayOf = (received) => (String(received || '').split(' ')[0] || 'Unknown');

export default function ClientTaskQueue({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [allowed, setAllowed] = useState(true);
  const [roleName, setRoleName] = useState('');
  const [rows, setRows] = useState([]);          // local, editable copies
  const [users, setUsers] = useState([]);
  const [busyId, setBusyId] = useState(null);    // save/publish in flight
  const [picker, setPicker] = useState(null);    // {kind:'req'|'prio'|'dev', id}
  const [discardFor, setDiscardFor] = useState(null);
  const [popup, setPopup] = useState(null);      // { ok, title, message }
  const [banner, setBanner] = useState(null);    // { type, text }

  // Drill-down state
  const [openDates, setOpenDates] = useState(() => new Set());
  const [openClients, setOpenClients] = useState(() => new Set());
  const [openTask, setOpenTask] = useState(null);  // only ONE task form open

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 3500); };

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchQueue();
      setRows(res.queue || []);
      // Everything starts COLLAPSED: only the dates show. Tap a date to reveal
      // its clients, tap a client to reveal its tasks, tap a task for the form.
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Could not load the queue');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const info = await getUserInfo().catch(() => ({ isMock: false }));
        // Match the ROUTES: admin | system. Owner is deliberately excluded — the
        // server would reject their save/publish with "Admin only.".
        const ok = !!(info.isMock || info.is_system || info.is_admin);
        setAllowed(ok);
        setRoleName(
          (info.is_system || info.is_owner || info.is_admin) ? 'Admin'
            : info.is_client ? 'Client' : 'User'
        );
        if (!ok) { setLoading(false); return; }
        const u = await getUsers().catch(() => ({ users: [] }));
        setUsers(u.users || []);
        await load();
      } catch (e) {
        log.error('mount failed', e?.message);
        setError(e.message || 'Failed to load');
        setLoading(false);
      }
    })();
  }, [load]);

  // Date → Client → tasks. The serial number (#1, #2 …) is assigned over the
  // whole queue in server order, so it stays stable whatever you expand.
  const groups = useMemo(() => {
    const byDate = new Map();
    rows.forEach((r, i) => {
      const day = dayOf(r.received_at);
      const client = r.client_name || '—';
      if (!byDate.has(day)) byDate.set(day, new Map());
      const byClient = byDate.get(day);
      if (!byClient.has(client)) byClient.set(client, []);
      byClient.get(client).push({ ...r, _n: i + 1 });
    });
    return [...byDate.entries()].map(([day, byClient]) => {
      const clients = [...byClient.entries()].map(([name, tasks]) => ({ name, tasks }));
      return {
        day,
        count: clients.reduce((a, c) => a + c.tasks.length, 0),
        rejected: clients.some((c) => c.tasks.some((t) => t.rejected)),
        clients,
      };
    });
  }, [rows]);

  const toggle = (setFn, key) => setFn((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const patch = (id, changes) =>
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...changes } : r)));

  const onSave = async (row, silent) => {
    setBusyId(row.id);
    try {
      await saveQueueTask(row);
      if (!silent) flash('ok', 'Saved');
      return true;
    } catch (e) {
      log.error('save failed', e?.message);
      setPopup({ ok: false, title: "Couldn't save", message: e.message || 'Please try again.' });
      return false;
    } finally {
      if (!silent) setBusyId(null);
    }
  };

  // Save THEN publish — same order the web uses, so the developer just picked is
  // committed before the server checks for one.
  const onPublish = async (row) => {
    setBusyId(row.id);
    try {
      const saved = await onSave(row, true);
      if (!saved) return;
      const res = await publishQueueTask(row.id);
      if (!res || res.status === false) {
        // Expected case: no developer assigned. Show the server's own wording.
        setPopup({ ok: false, title: 'Cannot publish yet', message: res?.message || 'Could not publish.' });
        return;
      }
      setPopup({ ok: true, title: 'Published', message: res.message || `Published: ${row.name}` });
      setOpenTask(null);
      await load();
    } catch (e) {
      log.error('publish failed', e?.message);
      setPopup({ ok: false, title: "Couldn't publish", message: e.message || 'Please try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const onDiscard = async () => {
    const row = discardFor;
    setDiscardFor(null);
    if (!row) return;
    setBusyId(row.id);
    try {
      await discardQueueTask(row.id);
      flash('ok', 'Task discarded');
      setOpenTask(null);
      await load();
    } catch (e) {
      log.error('discard failed', e?.message);
      setPopup({ ok: false, title: "Couldn't discard", message: e.message || 'Please try again.' });
    } finally {
      setBusyId(null);
    }
  };

  // ---- Gates ---------------------------------------------------------------
  if (loading) {
    // Gradient FIRST, content on top — and the root stays transparent so the
    // loading screen shows the same background as the loaded one (no flash of a
    // different colour on the way in).
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <View style={s.center}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={s.centerTxt}>Loading queue…</Text>
        </View>
      </View>
    );
  }

  if (!allowed) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <Header onBack={onBack} count={null} onRefresh={null} />
        <View style={[s.center, { flex: 1, padding: 32 }]}>
          <View style={s.lockWrap}><Ionicons name="lock-closed" size={40} color={COLORS.amber} /></View>
          <Text style={s.lockTitle}>Admins only</Text>
          <Text style={s.lockMsg}>
            The Client Task Queue is restricted to Admin accounts.
            {roleName ? `\n\nYou're signed in as: ${roleName}.` : ''}
          </Text>
          <TouchableOpacity style={s.lockBtn} onPress={onBack} activeOpacity={0.9}>
            <Ionicons name="arrow-back" size={18} color="#fff" />
            <Text style={s.lockBtnTxt}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const pickerRow = picker ? rows.find((r) => r.id === picker.id) : null;

  return (
    // Plain View + transparent root, exactly like ClientTasks / Notifications /
    // Configuration. A KeyboardAvoidingView wrapper here was letting a strip of
    // the root background show down the right-hand edge instead of the gradient;
    // the ScrollView already handles the keyboard on its own.
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <Header onBack={onBack} count={rows.length} onRefresh={() => { setRefreshing(true); load(); }} refreshing={refreshing} />

      {banner && (
        <View style={[s.banner, banner.type === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.type === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={16} color={banner.type === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.type === 'ok' ? COLORS.green : COLORS.red }]}>{banner.text}</Text>
        </View>
      )}

      {error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={() => { setLoading(true); load(); }}>
            <Text style={s.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: BOTTOM_PAD + 20 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Why this screen exists — same wording as the web. */}
          <View style={s.info}>
            <Ionicons name="information-circle" size={17} color={COLORS.primary} style={{ marginTop: 1 }} />
            <Text style={s.infoTxt}>
              Tasks here are <Text style={s.infoBold}>not visible to the team yet</Text>. Fill in the
              missing details (Ref ID, estimate, developer) and tap <Text style={s.infoBold}>Save &amp; Publish</Text> to
              release each task.
            </Text>
          </View>

          {rows.length === 0 ? (
            <View style={[s.center, { paddingVertical: 50 }]}>
              <MaterialCommunityIcons name="inbox-outline" size={46} color={COLORS.faint} />
              <Text style={s.centerTxt}>No client tasks waiting.</Text>
            </View>
          ) : groups.map((g) => {
            const dOpen = openDates.has(g.day);
            return (
              <View key={g.day} style={s.dateBlock}>
                {/* ── Level 1: date ── */}
                <TouchableOpacity style={s.dateHead} onPress={() => toggle(setOpenDates, g.day)} activeOpacity={0.75}>
                  <Ionicons name={dOpen ? 'chevron-down' : 'chevron-forward'} size={18} color={COLORS.navy} />
                  <Ionicons name="calendar-outline" size={15} color={COLORS.muted} />
                  <Text style={s.dateTxt}>{g.day}</Text>
                  {g.rejected && <View style={s.rejDot} />}
                  <View style={s.cntPill}><Text style={s.cntTxt}>{g.count}</Text></View>
                </TouchableOpacity>

                {dOpen && g.clients.map((c) => {
                  const cKey = `${g.day}|${c.name}`;
                  const cOpen = openClients.has(cKey);
                  return (
                    <View key={cKey} style={s.clientBlock}>
                      {/* ── Level 2: client ── */}
                      <TouchableOpacity style={s.clientHead} onPress={() => toggle(setOpenClients, cKey)} activeOpacity={0.75}>
                        <Ionicons name={cOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.primary} />
                        <Ionicons name="business-outline" size={14} color={COLORS.muted} />
                        <Text style={s.clientTxt} numberOfLines={1}>{c.name}</Text>
                        {c.tasks.some((t) => t.rejected) && <View style={s.rejDot} />}
                        <View style={s.cntPillSm}><Text style={s.cntTxtSm}>{c.tasks.length}</Text></View>
                      </TouchableOpacity>

                      {cOpen && c.tasks.map((t) => {
                        const tOpen = openTask === t.id;
                        const kind = KIND_META[t.kind] || KIND_META.requirement;
                        return (
                          <View key={t.id} style={s.taskBlock}>
                            {/* ── Level 3: task ── */}
                            <TouchableOpacity
                              style={[s.taskHead, tOpen && s.taskHeadOn, t.rejected && s.taskHeadRej]}
                              onPress={() => setOpenTask(tOpen ? null : t.id)}
                              activeOpacity={0.75}
                            >
                              <Ionicons name={tOpen ? 'chevron-down' : 'chevron-forward'} size={15} color={COLORS.muted} />
                              <View style={[s.kindTag, { backgroundColor: kind.bg }]}>
                                <Text style={[s.kindTxt, { color: kind.fg }]}>{kind.label}</Text>
                              </View>
                              <Text style={[s.taskTxt, tOpen && s.taskTxtOn]} numberOfLines={1}>{t.name}</Text>
                              {t.rejected && <Ionicons name="close-circle" size={14} color={COLORS.red} />}
                              {!t.user_id && <Ionicons name="person-remove-outline" size={14} color={COLORS.amber} />}
                            </TouchableOpacity>

                            {/* ── The full editable box, for this task alone ── */}
                            {tOpen && (
                              <TaskForm
                                r={t} users={users} busy={busyId === t.id}
                                patch={patch} setPicker={setPicker}
                                onSave={onSave} onPublish={onPublish} onDiscard={setDiscardFor}
                              />
                            )}
                          </View>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Linked Req / Priority / Developer picker */}
      <PickerSheet
        picker={picker} row={pickerRow} users={users}
        onClose={() => setPicker(null)}
        onPick={(changes) => { if (pickerRow) patch(pickerRow.id, changes); setPicker(null); }}
      />

      {/* Discard confirm — the server UNLINKS the task, it is not recoverable. */}
      <Modal visible={!!discardFor} transparent animationType="fade" onRequestClose={() => setDiscardFor(null)}>
        <View style={s.mWrap}>
          <View style={s.mCard}>
            <View style={s.mIcon}><Ionicons name="trash" size={28} color={COLORS.red} /></View>
            <Text style={s.mTitle}>Discard this task?</Text>
            <Text style={s.mMsg} numberOfLines={3}>{discardFor?.name}</Text>
            <Text style={s.mWarn}>This permanently deletes it — it cannot be undone.</Text>
            <View style={s.mBtns}>
              <TouchableOpacity style={[s.mBtn, s.mCancel]} onPress={() => setDiscardFor(null)} activeOpacity={0.85}>
                <Text style={s.mCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.mBtn, s.mDo]} onPress={onDiscard} activeOpacity={0.85}>
                <Text style={s.mDoTxt}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Result popup (publish outcome / errors) */}
      <Modal visible={!!popup} transparent animationType="fade" onRequestClose={() => setPopup(null)}>
        <View style={s.mWrap}>
          <View style={s.mCard}>
            <View style={[s.mIcon, { backgroundColor: popup?.ok ? COLORS.greenBg : COLORS.amberBg }]}>
              <Ionicons name={popup?.ok ? 'checkmark-circle' : 'alert-circle'} size={28} color={popup?.ok ? COLORS.green : COLORS.amber} />
            </View>
            <Text style={s.mTitle}>{popup?.title}</Text>
            <Text style={s.mMsg}>{popup?.message}</Text>
            <TouchableOpacity style={[s.mBtn, s.mOk, { marginTop: 16 }]} onPress={() => setPopup(null)} activeOpacity={0.85}>
              <Text style={s.mDoTxt}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---- The full editable box (only the chosen task renders this) -------------
function TaskForm({ r, users, busy, patch, setPicker, onSave, onPublish, onDiscard }) {
  const reqLabel = r.related_req_ref
    ? ((r.req_options || []).find((o) => o.ref === r.related_req_ref) || {}).label || r.related_req_ref
    : '';
  return (
    <View style={s.form}>
      {/* The client turned this developer down — lead with it. */}
      {r.rejected ? (
        <View style={s.rejBox}>
          <View style={s.rejTop}>
            <Ionicons name="close-circle" size={15} color="#B91C1C" />
            <Text style={s.rejTitle}>Client rejected the assignment — needs a new developer.</Text>
          </View>
          {!!r.reject_reason && (
            <Text style={s.rejReason}>Reason: <Text style={s.rejReasonB}>{r.reject_reason}</Text></Text>
          )}
          <Text style={s.rejBy}>by {r.rejected_by || '—'} · {r.rejected_at || ''}</Text>
        </View>
      ) : null}

      <Text style={s.submitted}>
        Submitted by <Text style={s.submittedB}>{r.submitted_by || 'Unknown'}</Text>
        {r.submitted_login ? ` (${r.submitted_login})` : ''} · {r.received_at || ''}
      </Text>
      {!!r.project_name && <Text style={s.project} numberOfLines={1}>📁 {r.project_name}</Text>}

      {/* Photos / video the submitter attached, each with their reason. Names +
          reasons only: the file bytes stay on the server — open them on the web
          (Task Related Documents) to view/play. */}
      {(r.attachments || []).length > 0 && (
        <View style={s.attBox}>
          <Text style={s.attHead}>📎 {r.attachments.length} attachment{r.attachments.length === 1 ? '' : 's'}</Text>
          {r.attachments.map((a) => (
            <View key={a.id} style={s.attLine}>
              <Ionicons
                name={/\.(mp4|mov|avi|mkv|webm)$/i.test(a.file_name) ? 'videocam' : 'image'}
                size={13}
                color={COLORS.primary}
              />
              <View style={{ flex: 1 }}>
                <Text style={s.attFile} numberOfLines={1}>{a.file_name}</Text>
                {!!a.reason && <Text style={s.attWhy} numberOfLines={2}>{a.reason}</Text>}
              </View>
            </View>
          ))}
        </View>
      )}

      <View style={s.split}>
        <View style={s.half}>
          <Text style={s.lbl}>Ref ID</Text>
          <TextInput
            style={s.input} value={r.external_ref || ''} autoCapitalize="characters"
            onChangeText={(v) => patch(r.id, { external_ref: v })}
          />
        </View>
        <View style={s.half}>
          <Text style={s.lbl}>Linked Req</Text>
          <Selector value={reqLabel} placeholder="— none —" onPress={() => setPicker({ kind: 'req', id: r.id })} />
        </View>
      </View>

      <Text style={s.lbl}>Task Name</Text>
      <TextInput
        style={[s.input, { minHeight: 44 }]} value={r.name || ''} multiline
        onChangeText={(v) => patch(r.id, { name: v })}
      />

      {/* Only shown when the client actually sent one (matches the web). */}
      {!!r.description && (
        <>
          <Text style={s.lbl}>Description</Text>
          <TextInput
            style={s.textarea} value={r.description} multiline textAlignVertical="top"
            onChangeText={(v) => patch(r.id, { description: v })}
          />
        </>
      )}

      <View style={s.split}>
        <View style={s.half}>
          <Text style={s.lbl}>Estimate Hours</Text>
          <TextInput
            style={s.input} keyboardType="number-pad" value={String(r.estimate_hours ?? 0)}
            onChangeText={(v) => patch(r.id, { estimate_hours: v.replace(/[^0-9]/g, '') })}
          />
        </View>
        <View style={s.half}>
          <Text style={s.lbl}>Minutes</Text>
          <TextInput
            style={s.input} keyboardType="number-pad" value={String(r.estimate_minutes ?? 0)}
            onChangeText={(v) => {
              let m = parseInt(v.replace(/[^0-9]/g, ''), 10);
              if (isNaN(m)) m = 0; if (m > 59) m = 59;
              patch(r.id, { estimate_minutes: m });
            }}
          />
        </View>
      </View>

      <View style={s.split}>
        <View style={s.half}>
          <Text style={s.lbl}>Priority</Text>
          <Selector value={prioLabel(r.priority)} onPress={() => setPicker({ kind: 'prio', id: r.id })} />
        </View>
        <View style={s.half}>
          {/* Required to publish — the client is asked to approve WHO got it. */}
          <Text style={s.lbl}>Assign Developer <Text style={s.req}>*</Text></Text>
          <Selector
            value={(users.find((u) => u.id === r.user_id) || {}).name || ''}
            placeholder="-- None --"
            error={!r.user_id}
            onPress={() => setPicker({ kind: 'dev', id: r.id })}
          />
        </View>
      </View>

      <View style={s.actions}>
        <TouchableOpacity style={s.discardBtn} onPress={() => onDiscard(r)} disabled={busy} activeOpacity={0.85}>
          <Ionicons name="trash-outline" size={15} color={COLORS.red} />
          <Text style={s.discardTxt}>Discard</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={s.saveBtn} onPress={() => onSave(r)} disabled={busy} activeOpacity={0.85}>
          <Ionicons name="save-outline" size={15} color={COLORS.muted} />
          <Text style={s.saveTxt}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.pubBtn, busy && { opacity: 0.7 }]} onPress={() => onPublish(r)} disabled={busy} activeOpacity={0.9}>
          {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={15} color="#fff" />}
          <Text style={s.pubTxt}>Save &amp; Publish</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---- Pieces ---------------------------------------------------------------
function Header({ onBack, count, onRefresh, refreshing }) {
  return (
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <View style={s.hTitleWrap}>
        <Text style={s.hTitle} numberOfLines={1}>Client Task Queue</Text>
        {count != null && count > 0 && (
          <View style={s.hCount}><Text style={s.hCountTxt}>{count}</Text></View>
        )}
      </View>
      {onRefresh ? (
        <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.primary} />
            : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      ) : <View style={{ width: 40 }} />}
    </View>
  );
}

function Selector({ value, placeholder, onPress, error }) {
  return (
    <TouchableOpacity style={[s.input, s.selector, error && s.selectorErr]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.selectorTxt, { color: value ? COLORS.ink : COLORS.faint }]} numberOfLines={1}>
        {value || placeholder || '— select —'}
      </Text>
      <Ionicons name="chevron-down" size={16} color={COLORS.muted} />
    </TouchableOpacity>
  );
}

function PickerSheet({ picker, row, users, onClose, onPick }) {
  if (!picker || !row) return null;
  let title = 'Select';
  let items = [];
  if (picker.kind === 'req') {
    title = 'Linked Req';
    items = [
      { key: 'none', label: '— none —', selected: !row.related_req_ref, onPress: () => onPick({ related_req_ref: '' }) },
      ...(row.req_options || []).map((o) => ({
        key: o.ref, label: o.label, selected: o.ref === row.related_req_ref,
        onPress: () => onPick({ related_req_ref: o.ref }),
      })),
    ];
  } else if (picker.kind === 'prio') {
    title = 'Priority';
    items = PRIORITIES.map((p) => ({
      key: p.value, label: p.label, selected: p.value === row.priority,
      onPress: () => onPick({ priority: p.value }),
    }));
  } else {
    title = 'Assign Developer';
    items = [
      { key: 'none', label: '-- None --', selected: !row.user_id, onPress: () => onPick({ user_id: false }) },
      ...users.map((u) => ({
        key: String(u.id), label: u.name, selected: u.id === row.user_id,
        onPress: () => onPick({ user_id: u.id }),
      })),
    ];
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.mWrap}>
        <View style={s.pickCard}>
          <View style={s.pickHead}>
            <Text style={s.pickTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
          {items.length === 0 ? (
            <Text style={s.pickEmpty}>Nothing to choose.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 340 }}>
              {items.map((it) => (
                <TouchableOpacity key={it.key} style={[s.pickItem, it.selected && s.pickItemOn]} onPress={it.onPress} activeOpacity={0.7}>
                  <Text style={[s.pickItemTxt, it.selected && s.pickItemTxtOn]} numberOfLines={2}>{it.label}</Text>
                  {it.selected ? <Ionicons name="checkmark-circle" size={18} color={COLORS.primary} /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <View style={s.pickFoot}>
            <TouchableOpacity style={s.pickCancel} onPress={onClose}><Text style={s.pickCancelTxt}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  // TRANSPARENT — same as ClientTasks / NotificationsScreen / ConfigurationScreen.
  // A solid colour here is what produced the pale strip down the right edge: it
  // showed through wherever the gradient SVG didn't paint. Transparent lets the
  // gradient be the only background, with nothing behind it to leak.
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerTxt: { color: COLORS.muted, marginTop: 10, textAlign: 'center' },
  retry: { marginTop: 14, backgroundColor: COLORS.primary, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '800' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  hTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },
  hCount: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: COLORS.amber, alignItems: 'center', justifyContent: 'center' },
  hCountTxt: { color: '#fff', fontSize: 11.5, fontWeight: '900' },

  lockWrap: { width: 88, height: 88, borderRadius: 26, backgroundColor: COLORS.amberBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  lockTitle: { fontSize: 22, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  lockMsg: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center', lineHeight: 21 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 26, backgroundColor: COLORS.primary, borderRadius: 13, paddingHorizontal: 24, height: 50 },
  lockBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { fontSize: 13, fontWeight: '600', flex: 1 },

  info: { flexDirection: 'row', gap: 9, backgroundColor: '#E0F2FE', borderRadius: 12, padding: 12, marginBottom: 14 },
  infoTxt: { flex: 1, fontSize: 12.5, color: '#075985', lineHeight: 18 },
  infoBold: { fontWeight: '900' },

  // ── Drill-down: date ▸ client ▸ task ──
  dateBlock: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, overflow: 'hidden', ...SHADOW },
  dateHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 13 },
  dateTxt: { flex: 1, fontSize: 14.5, fontWeight: '900', color: COLORS.navy },
  cntPill: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: '#EEF3FF', alignItems: 'center', justifyContent: 'center' },
  cntTxt: { fontSize: 11.5, fontWeight: '900', color: COLORS.primary },
  rejDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.red },

  clientBlock: { borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  clientHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 22, paddingRight: 12, paddingVertical: 11, backgroundColor: '#FBFCFE' },
  clientTxt: { flex: 1, fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  cntPillSm: { minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center' },
  cntTxtSm: { fontSize: 10.5, fontWeight: '900', color: COLORS.muted },

  taskBlock: { borderTopWidth: 1, borderTopColor: '#F5F7FA' },
  taskHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 34, paddingRight: 12, paddingVertical: 11 },
  taskHeadOn: { backgroundColor: '#EEF3FF' },
  taskHeadRej: { backgroundColor: '#FEF2F2' },
  taskTxt: { flex: 1, fontSize: 13, color: COLORS.ink },
  taskTxtOn: { fontWeight: '800', color: COLORS.primary },
  snBadge: { backgroundColor: COLORS.navy, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  snTxt: { color: '#fff', fontSize: 10, fontWeight: '900' },
  kindTag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  kindTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.3 },

  // ── The expanded form ──
  form: { paddingHorizontal: 12, paddingBottom: 14, paddingTop: 2, backgroundColor: '#F8FAFF' },
  rejBox: { backgroundColor: '#FEF2F2', borderRadius: 10, padding: 10, marginTop: 10 },
  rejTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  rejTitle: { flex: 1, fontSize: 12.5, fontWeight: '900', color: '#B91C1C', lineHeight: 17 },
  rejReason: { fontSize: 12.5, color: '#7F1D1D', marginTop: 5 },
  rejReasonB: { fontWeight: '900' },
  rejBy: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },

  attBox: { backgroundColor: '#F1F5FB', borderRadius: 10, padding: 10, marginTop: 10 },
  attHead: { fontSize: 12, fontWeight: '900', color: COLORS.navy, marginBottom: 4 },
  attLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 4 },
  attFile: { fontSize: 12, fontWeight: '700', color: COLORS.ink },
  attWhy: { fontSize: 11.5, color: COLORS.muted, marginTop: 1, lineHeight: 16 },

  submitted: { fontSize: 11.5, color: COLORS.faint, marginTop: 10 },
  submittedB: { fontWeight: '800', color: COLORS.muted },
  project: { fontSize: 12, color: COLORS.muted, marginTop: 3 },

  split: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  lbl: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted, marginBottom: 5, marginTop: 11 },
  req: { color: COLORS.red },
  input: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    paddingHorizontal: 11, minHeight: 42, fontSize: 14.5, color: COLORS.ink,
  },
  selector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  selectorErr: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  selectorTxt: { flex: 1, fontSize: 14, paddingVertical: 11 },
  textarea: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    padding: 11, fontSize: 14, color: COLORS.ink, minHeight: 70,
  },

  // flexWrap so the three buttons drop to a second line on a narrow screen
  // instead of overflowing past the card's right edge.
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' },
  discardBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 40, borderRadius: 10, borderWidth: 1.5, borderColor: '#FECACA', backgroundColor: '#fff' },
  discardTxt: { color: COLORS.red, fontWeight: '800', fontSize: 13 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 40, borderRadius: 10, borderWidth: 1.5, borderColor: '#E7ECF3', backgroundColor: '#fff' },
  saveTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 13 },
  pubBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: 10, backgroundColor: COLORS.green },
  pubTxt: { color: '#fff', fontWeight: '900', fontSize: 13 },

  mWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  mCard: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 20, alignItems: 'center', padding: 22 },
  mIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  mTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  mMsg: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', marginTop: 6, lineHeight: 19 },
  mWarn: { fontSize: 12, color: COLORS.red, textAlign: 'center', marginTop: 8, fontWeight: '700' },
  mBtns: { flexDirection: 'row', gap: 12, marginTop: 16, width: '100%' },
  mBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 46, borderRadius: 12 },
  mCancel: { backgroundColor: '#EEF2F8' },
  mCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 15 },
  mDo: { backgroundColor: COLORS.red },
  mOk: { backgroundColor: COLORS.primary, width: '100%' },
  mDoTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  pickCard: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  pickHead: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.primary, paddingHorizontal: 16, paddingVertical: 13 },
  pickTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  pickEmpty: { color: COLORS.muted, fontSize: 14, padding: 18 },
  pickItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  pickItemOn: { backgroundColor: '#EEF3FF' },
  pickItemTxt: { flex: 1, fontSize: 14.5, color: COLORS.ink },
  pickItemTxtOn: { color: COLORS.primary, fontWeight: '800' },
  pickFoot: { paddingHorizontal: 18, paddingVertical: 13, borderTopWidth: 1, borderTopColor: COLORS.line },
  pickCancel: { height: 44, borderRadius: 11, backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center' },
  pickCancelTxt: { fontSize: 15, fontWeight: '800', color: COLORS.muted },
});
