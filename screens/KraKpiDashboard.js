// KRA / KPI Master — the KRA → sub-KRA → KPI hierarchy tree with full CRUD.
// Mirrors the Odoo kra_kpi_dashboard: KRA+ / KPI+ create, node rename (pencil),
// node delete (trash). Used two ways:
//   • pushed as a full screen from the Home "KRA / KPI Master" tile → pass onBack
//   • rendered inside the "KPIs" bottom tab                          → omit onBack
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  ActivityIndicator, Alert, Modal, KeyboardAvoidingView, Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { COLORS, SHADOW } from '../theme';
import KraNode from '../components/KraNode';
import { createLogger } from '../api/logger';
import * as svc from '../services/kraKpi';

const log = createLogger('KraKpiMaster');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Roll the tree up into { kras, subKras, kpis } for the summary strip.
function summarize(tree) {
  let kras = 0, subKras = 0, kpis = 0;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (depth === 0) kras += 1; else subKras += 1;
      kpis += (n.kpi_ids || []).length;
      walk(n.child_ids || [], depth + 1);
    }
  };
  walk(tree, 0);
  return { kras, subKras, kpis };
}

// A node and every KRA under it. Used by the delete dialog to name the real
// cascade — the server deletes the whole subtree, so "all its sub-KRAs" was
// asking someone to accept an unknown number.
function countKras(node) {
  let n = 1;
  for (const c of node.child_ids || []) n += countKras(c);
  return n;
}
function countKpis(node) {
  let n = (node.kpi_ids || []).length;
  for (const c of node.child_ids || []) n += countKpis(c);
  return n;
}

function Stat({ icon, lib, value, label }) {
  const IconCmp = lib === 'mc' ? MaterialCommunityIcons : Ionicons;
  return (
    <View style={s.stat}>
      <IconCmp name={icon} size={20} color={COLORS.primary} />
      <Text style={s.statVal}>{value}</Text>
      <Text style={s.statLbl}>{label}</Text>
    </View>
  );
}

export default function KraKpiDashboard({ onBack }) {
  const [tree, setTree] = useState([]);
  const [isMock, setIsMock] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); // a mutation is in flight

  // Dropdown data for the create forms.
  const [parentKras, setParentKras] = useState([]);
  const [users, setUsers] = useState([]);

  // Modal: { type:'kra'|'kpi'|'editKra'|'editKpi', ... }
  const [modal, setModal] = useState(null);

  // Assign-clients dialog, kept separate from `modal` because it isn't a
  // name-and-submit form — it's a multi-select whose value is a list.
  // { kraId, kraName, picked: number[], original: number[], loading }
  const [assign, setAssign] = useState(null);
  const [clientUsers, setClientUsers] = useState([]);

  // Delete confirmation: { kind:'kra'|'kpi', name, subKras, kpis, run }
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { tree: data, isMock: mock } = await svc.getKraTree();
      const rows = data || [];
      setTree(rows);
      setIsMock(mock);
      setExpanded(new Set(rows.map((n) => n.id)));
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Reload just the tree after a mutation, preserving expansion.
  const reloadTree = useCallback(async () => {
    try {
      const { tree: data } = await svc.getKraTree();
      setTree(data || []);
    } catch (e) { log.error('reload failed', e?.message); }
  }, []);

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Lazy-load dropdown data the first time a create form opens.
  async function ensureFormData() {
    try {
      const [p, u] = await Promise.all([svc.getParentKras(), svc.getUsers()]);
      setParentKras(p.kras || []);
      setUsers(u.users || []);
    } catch (e) { log.warn('form data load failed', e?.message); }
  }

  function openCreateKra() {
    ensureFormData();
    setModal({ type: 'kra', name: '', parentId: '' });
  }
  function openCreateKpi() {
    ensureFormData();
    setModal({ type: 'kpi', name: '', kraId: '', hours: '0', minutes: '0', priority: 'regular', userId: '' });
  }

  // ---- Edit (rename) ------------------------------------------------------
  function onEditKra(node) { setModal({ type: 'editKra', id: node.id, name: node.name }); }
  function onEditKpi(kpi) { setModal({ type: 'editKpi', id: kpi.id, name: kpi.name }); }

  // ---- Assign client logins (client KRAs only) ---------------------------
  // Parity with the web's 👥 button on a client KRA. Which logins are attached
  // here decides what that client can see, so it is a visibility control, not a
  // label — hence the confirm before clearing the last one.
  async function onAssignClients(node, inheritedFrom) {
    const current = (node.client_user_ids || []).map((u) => Number(u.id)).filter(Boolean);
    // Seed the ticks from the tree we already hold, so the list opens with the
    // right boxes checked even if the fetch below is slow or fails outright.
    setAssign({
      kraId: node.id, kraName: node.name, picked: current, original: current,
      // Only worth saying when this KRA has none of its own — otherwise its own
      // logins are the answer and the ancestor is a detail.
      inheritedFrom: current.length === 0 ? (inheritedFrom || null) : null,
      loading: true,
    });
    try {
      const { users } = await svc.getClientUsers();
      setClientUsers(users || []);
    } catch (e) {
      log.warn('client users load failed', e?.message);
      Alert.alert('Error', e?.message || 'Could not load client logins');
    } finally {
      setAssign((a) => (a ? { ...a, loading: false } : a));
    }
  }

  function saveAssign() {
    if (!assign) return;
    const { kraId, kraName, picked, original, inheritedFrom } = assign;
    const commit = () => {
      setAssign(null);
      runMutation(
        () => svc.assignKraClients({ kraId, userIds: picked }),
        picked.length
          ? `${picked.length} client login${picked.length === 1 ? '' : 's'} assigned to “${kraName}”`
          : `Cleared every client login on “${kraName}”`,
      );
    };
    // Saving an empty list CLEARS the set server-side (it writes the full 6,0
    // value). Going from "some" to "none" gets asked about — but only when it
    // actually costs someone their access. Under a KRA that already grants it,
    // detaching a login here changes nothing a client can see, so warning about
    // it would be crying wolf on the one dialog that needs to be believed.
    if (picked.length === 0 && original.length > 0 && !inheritedFrom) {
      Alert.alert(
        'Remove all client access?',
        `Nobody will be able to see “${kraName}” from the client portal until a login is assigned again.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove all', style: 'destructive', onPress: commit }],
      );
      return;
    }
    commit();
  }

  // ---- Delete (with confirm) ---------------------------------------------
  // These were Alert.alert. A native alert is the wrong control for this one:
  // deleting a KRA cascades to every sub-KRA and KPI under it, and an OS dialog
  // can only offer a title, one line of body, and two buttons — so the row that
  // says "and 23 KPIs with it" had nowhere to go. It also looks nothing like the
  // rest of this screen, and the destructive button sits where the harmless one
  // does on the other dialogs.
  function onDeleteKra(node) {
    setConfirm({
      kind: 'kra',
      name: node.name,
      // Counted from the tree in hand, so the dialog states the real blast
      // radius instead of the word "all".
      subKras: countKras(node) - 1,
      kpis: countKpis(node),
      run: () => runMutation(() => svc.deleteKra(node.id), 'KRA deleted'),
    });
  }
  function onDeleteKpi(kpi) {
    setConfirm({
      kind: 'kpi',
      name: kpi.name,
      subKras: 0,
      kpis: 0,
      run: () => runMutation(() => svc.deleteKpi(kpi.id), 'KPI deleted'),
    });
  }

  // Run a create/edit/delete, then refresh the tree.
  async function runMutation(fn, okMsg) {
    setBusy(true);
    try {
      await fn();
      await reloadTree();
      if (okMsg) Alert.alert('Done', okMsg);
    } catch (e) {
      log.error('mutation failed', e?.message);
      Alert.alert('Error', e?.message || 'Operation failed');
    } finally {
      setBusy(false);
    }
  }

  // ---- Modal submit handlers ---------------------------------------------
  async function submitModal() {
    if (!modal) return;
    if (modal.type === 'kra') {
      if (!modal.name.trim()) { Alert.alert('Required', 'Enter a KRA name'); return; }
      setModal(null);
      await runMutation(() => svc.createKra({ name: modal.name, parentId: modal.parentId }), 'KRA created');
    } else if (modal.type === 'kpi') {
      if (!modal.name.trim()) { Alert.alert('Required', 'Enter a KPI name'); return; }
      if (!modal.kraId) { Alert.alert('Required', 'Select a KRA for this KPI'); return; }
      setModal(null);
      await runMutation(() => svc.createKpi({
        name: modal.name, kraId: modal.kraId,
        estimateHours: modal.hours, estimateMinutes: modal.minutes,
        priority: modal.priority, userId: modal.userId,
      }), 'KPI created');
    } else if (modal.type === 'editKra') {
      if (!modal.name.trim()) { Alert.alert('Required', 'Enter a name'); return; }
      const id = modal.id, name = modal.name;
      setModal(null);
      await runMutation(() => svc.updateKra({ kraId: id, name }), 'KRA renamed');
    } else if (modal.type === 'editKpi') {
      if (!modal.name.trim()) { Alert.alert('Required', 'Enter a name'); return; }
      const id = modal.id, name = modal.name;
      setModal(null);
      await runMutation(() => svc.updateKpi({ kpiId: id, name }), 'KPI renamed');
    }
  }

  const totals = summarize(tree);

  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      {/* Light-blue gradient background (matches the Odoo screen) */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
            <Stop offset="0" stopColor="#EAF2FF" />
            <Stop offset="1" stopColor="#C7DDF7" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#bg)" />
      </Svg>

      {/* Header — back button matches the Tasks board (white rounded, shadow) */}
      <View style={[s.header, { paddingTop: TOP }]}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
        <Text style={s.title}>KRA / KPI Master</Text>
        <TouchableOpacity onPress={load} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {/* Summary strip */}
      <View style={s.stats}>
        <Stat lib="ion" icon="folder" value={totals.kras} label="KRAs" />
        <View style={s.statDiv} />
        <Stat lib="ion" icon="git-branch" value={totals.subKras} label="Sub-KRAs" />
        <View style={s.statDiv} />
        <Stat lib="mc" icon="target" value={totals.kpis} label="KPIs" />
      </View>

      {/* KRA + / KPI + */}
      <View style={s.actions}>
        <TouchableOpacity style={s.chip} onPress={openCreateKra} activeOpacity={0.85} disabled={busy}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.chipTxt}>KRA</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.chip, s.chipAlt]} onPress={openCreateKpi} activeOpacity={0.85} disabled={busy}>
          <Ionicons name="add" size={18} color={COLORS.primary} />
          <Text style={[s.chipTxt, { color: COLORS.primary }]}>KPI</Text>
        </TouchableOpacity>
        {busy ? <ActivityIndicator color={COLORS.primary} style={{ marginLeft: 6 }} /> : null}
      </View>

      {!loading && !error && isMock ? (
        <View style={s.mockHint}>
          <Ionicons name="information-circle-outline" size={16} color={COLORS.amber} />
          <Text style={s.mockTxt}>Showing sample data — connect to Odoo to see live KRAs.</Text>
        </View>
      ) : null}

      {/* Body */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={s.centerTxt}>Loading hierarchy…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={load} activeOpacity={0.85}>
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={s.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : tree.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="folder-open-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>No KRAs yet — tap “KRA” to add one.</Text>
        </View>
      ) : (
        <ScrollView style={s.treeWrap} contentContainerStyle={{ paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
          <View style={s.treeCard}>
            {tree.map((n) => (
              <KraNode
                key={n.id} node={n} depth={0} expanded={expanded} onToggle={toggle}
                onEditKra={onEditKra} onDeleteKra={onDeleteKra}
                onEditKpi={onEditKpi} onDeleteKpi={onDeleteKpi}
                onAssignClients={onAssignClients}
              />
            ))}
          </View>
        </ScrollView>
      )}

      {/* Create / edit modal */}
      <CrudModal
        modal={modal}
        setModal={setModal}
        parentKras={parentKras}
        users={users}
        onSubmit={submitModal}
      />

      {/* Assign client logins to a client KRA */}
      <AssignClientsModal
        assign={assign}
        setAssign={setAssign}
        users={clientUsers}
        onSave={saveAssign}
      />

      {/* Delete confirmation */}
      <ConfirmDeleteModal confirm={confirm} setConfirm={setConfirm} />
    </View>
  );
}

// ---- Delete confirmation ---------------------------------------------------
// Replaces Alert.alert for both deletes. The point of a custom dialog here is
// the cascade: a KRA takes its whole subtree with it, and that count is the one
// fact someone needs before tapping Delete.

function ConfirmDeleteModal({ confirm, setConfirm }) {
  if (!confirm) return null;
  const close = () => setConfirm(null);
  const isKra = confirm.kind === 'kra';
  const { subKras, kpis } = confirm;
  const cascades = isKra && (subKras > 0 || kpis > 0);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={close}>
        <TouchableOpacity activeOpacity={1} style={s.sheet}>
          <View style={s.delHead}>
            <View style={s.delIcon}>
              <Ionicons name="trash" size={20} color={COLORS.red} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.delTitle}>Delete this {isKra ? 'KRA' : 'KPI'}?</Text>
              <Text style={s.delName} numberOfLines={3}>{confirm.name}</Text>
            </View>
          </View>

          {/* Spell the cascade out as rows. This is what the OS alert could not
              show, and it is the whole reason for the change. */}
          {cascades ? (
            <View style={s.delCascade}>
              <Text style={s.delCascadeHead}>This also deletes</Text>
              {subKras > 0 ? (
                <View style={s.delRow}>
                  <Ionicons name="git-branch" size={15} color={COLORS.red} />
                  <Text style={s.delRowTxt}>
                    <Text style={s.delRowNum}>{subKras}</Text> sub-KRA{subKras === 1 ? '' : 's'}
                  </Text>
                </View>
              ) : null}
              {kpis > 0 ? (
                <View style={s.delRow}>
                  <MaterialCommunityIcons name="target" size={15} color={COLORS.red} />
                  <Text style={s.delRowTxt}>
                    <Text style={s.delRowNum}>{kpis}</Text> KPI{kpis === 1 ? '' : 's'}, with their time logs and history
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={s.delPlain}>
              {isKra
                ? 'It has no sub-KRAs or KPIs, so nothing else is affected.'
                : 'Its time logs and history go with it.'}
            </Text>
          )}

          <Text style={s.delWarn}>This cannot be undone.</Text>

          <View style={s.sheetBtns}>
            <TouchableOpacity style={s.cancelBtn} onPress={close} activeOpacity={0.85}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
            {/* Destructive action sits on the right, same slot as Save on every
                other dialog on this screen — a delete button where muscle memory
                expects "confirm" is worse than one that simply looks dangerous. */}
            <TouchableOpacity style={s.delBtn} activeOpacity={0.85}
              onPress={() => { const run = confirm.run; setConfirm(null); run(); }}>
              <Ionicons name="trash-outline" size={17} color="#fff" />
              <Text style={s.delBtnTxt}>Delete</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ---- Assign client logins --------------------------------------------------
// A multi-select, not a form: the value is the whole ticked set, because that is
// what the server stores (it replaces client_user_ids outright).

function AssignClientsModal({ assign, setAssign, users, onSave }) {
  if (!assign) return null;

  const close = () => setAssign(null);
  const toggle = (id) => setAssign((a) => {
    if (!a) return a;
    const n = Number(id);
    return { ...a, picked: a.picked.includes(n) ? a.picked.filter((x) => x !== n) : [...a.picked, n] };
  });

  // Anyone already attached but missing from the group list — deactivated, or
  // dropped out of the client group while still assigned. Hiding them would make
  // Save silently detach someone the operator never saw.
  const known = new Set(users.map((u) => Number(u.id)));
  const orphans = assign.picked.filter((id) => !known.has(id));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={close}>
          <TouchableOpacity activeOpacity={1} style={s.sheet}>
            <Text style={s.sheetTitle}>Assign clients</Text>
            <Text style={s.assignSub} numberOfLines={2}>{assign.kraName}</Text>

            {/* Access already flows down from an ancestor, so an empty list here
                is not a gap. Said up front, because the obvious reading of "no
                boxes ticked" is that somebody forgot. */}
            {assign.inheritedFrom ? (
              <View style={s.inheritNote}>
                <Ionicons name="git-branch-outline" size={15} color={COLORS.link} />
                <Text style={s.inheritTxt}>
                  Already visible to whoever is assigned on <Text style={s.inheritName}>{assign.inheritedFrom}</Text>.
                  Access reaches every KRA beneath it, so this one needs nothing. Adding logins here narrows nothing —
                  it only grants extra people access to this branch.
                </Text>
              </View>
            ) : null}

            {assign.loading ? (
              <View style={s.assignLoading}>
                <ActivityIndicator color={COLORS.primary} />
                <Text style={s.assignLoadTxt}>Loading client logins…</Text>
              </View>
            ) : users.length === 0 ? (
              <View style={s.assignLoading}>
                <Ionicons name="people-outline" size={34} color={COLORS.faint} />
                <Text style={s.assignLoadTxt}>No client logins exist yet. Create one in Login Management.</Text>
              </View>
            ) : (
              <ScrollView style={s.assignList} showsVerticalScrollIndicator={false}>
                {users.map((u) => {
                  const on = assign.picked.includes(Number(u.id));
                  return (
                    <TouchableOpacity key={u.id} style={s.assignRow} activeOpacity={0.7}
                      onPress={() => toggle(u.id)}>
                      <Ionicons
                        name={on ? 'checkbox' : 'square-outline'}
                        size={21}
                        color={on ? COLORS.primary : COLORS.faint}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={s.assignName} numberOfLines={1}>{u.name || u.login}</Text>
                        {u.login && u.login !== u.name ? (
                          <Text style={s.assignLogin} numberOfLines={1}>{u.login}</Text>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
                {orphans.length > 0 ? (
                  <Text style={s.assignWarn}>
                    {orphans.length} assigned login{orphans.length === 1 ? '' : 's'} no longer in the client
                    group — saving now will detach {orphans.length === 1 ? 'it' : 'them'}.
                  </Text>
                ) : null}
              </ScrollView>
            )}

            <Text style={s.assignCount}>
              {assign.picked.length > 0
                ? `${assign.picked.length} selected`
                : assign.inheritedFrom
                  // Saving nothing here is a genuine no-op, and saying "clears
                  // client access" would be a lie — the ancestor still grants it.
                  ? 'Nothing selected — access still comes from the parent KRA.'
                  : 'Nobody selected — no client will be able to see this KRA.'}
            </Text>

            <View style={s.sheetBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={close} activeOpacity={0.85}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.saveBtn, assign.loading && { opacity: 0.6 }]}
                onPress={onSave} activeOpacity={0.85} disabled={assign.loading}>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={s.saveTxt}>Save</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---- Create / edit bottom-sheet modal -------------------------------------

function CrudModal({ modal, setModal, parentKras, users, onSubmit }) {
  const [picker, setPicker] = useState(null); // 'parent' | 'kra' | 'user' | 'priority'
  if (!modal) return null;

  const set = (patch) => setModal((m) => ({ ...m, ...patch }));
  const close = () => { setPicker(null); setModal(null); };

  const isKra = modal.type === 'kra';
  const isKpi = modal.type === 'kpi';
  const isEdit = modal.type === 'editKra' || modal.type === 'editKpi';
  const title = isKra ? 'New KRA' : isKpi ? 'New KPI'
    : modal.type === 'editKra' ? 'Rename KRA' : 'Rename KPI';

  const parentName = parentKras.find((k) => String(k.id) === String(modal.parentId))?.name;
  const kraName = parentKras.find((k) => String(k.id) === String(modal.kraId))?.name;
  const userName = users.find((u) => String(u.id) === String(modal.userId))?.name;
  const prioLabel = svc.PRIORITIES.find((p) => p.value === modal.priority)?.label || 'Regular';

  // Sub-picker sheet (parent KRA / KRA / user / priority).
  const pickerItems = () => {
    if (picker === 'parent') return [{ id: '', name: '— None (root KRA) —' }, ...parentKras];
    if (picker === 'kra') return parentKras;
    if (picker === 'user') return [{ id: '', name: '— None —' }, ...users];
    if (picker === 'priority') return svc.PRIORITIES.map((p) => ({ id: p.value, name: p.label }));
    return [];
  };
  const onPick = (item) => {
    if (picker === 'parent') set({ parentId: item.id });
    else if (picker === 'kra') set({ kraId: item.id });
    else if (picker === 'user') set({ userId: item.id });
    else if (picker === 'priority') set({ priority: item.id });
    setPicker(null);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={close}>
          <TouchableOpacity activeOpacity={1} style={s.sheet}>
            {/* drag handle removed: these are centred dialogs now, not bottom sheets — a grab bar on a dialog you cannot drag is just noise */}
            <Text style={s.sheetTitle}>{title}</Text>

            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 420 }}>
              {/* Name (all modes) */}
              <Text style={s.mLabel}>Name <Text style={s.req}>*</Text></Text>
              <TextInput
                style={s.mInput} placeholder="Enter name" placeholderTextColor={COLORS.faint}
                value={modal.name} onChangeText={(t) => set({ name: t })} autoFocus
              />

              {/* KRA create → optional parent */}
              {isKra && (
                <>
                  <Text style={s.mLabel}>Parent KRA (optional — leave as root)</Text>
                  <Selector value={parentName} placeholder="— None (root KRA) —" onPress={() => setPicker('parent')} />
                </>
              )}

              {/* KPI create → KRA + estimate + priority + assignee */}
              {isKpi && (
                <>
                  <Text style={s.mLabel}>KRA <Text style={s.req}>*</Text></Text>
                  <Selector value={kraName} placeholder="Select a KRA" onPress={() => setPicker('kra')} />

                  <View style={s.row2}>
                    <View style={s.col}>
                      <Text style={s.mLabel}>Hours</Text>
                      <TextInput style={s.mNum} keyboardType="number-pad" value={String(modal.hours)}
                        onChangeText={(t) => set({ hours: t.replace(/[^0-9]/g, '') })} />
                    </View>
                    <View style={s.col}>
                      <Text style={s.mLabel}>Minutes</Text>
                      <TextInput style={s.mNum} keyboardType="number-pad" value={String(modal.minutes)}
                        onChangeText={(t) => { let m = parseInt(t.replace(/[^0-9]/g, ''), 10); if (isNaN(m)) m = 0; if (m > 59) m = 59; set({ minutes: String(m) }); }} />
                    </View>
                  </View>

                  <Text style={s.mLabel}>Priority</Text>
                  <Selector value={prioLabel} onPress={() => setPicker('priority')} />

                  <Text style={s.mLabel}>Assignee (optional)</Text>
                  <Selector value={userName} placeholder="— None —" onPress={() => setPicker('user')} />
                </>
              )}
            </ScrollView>

            <View style={s.sheetBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={close}>
                <Text style={s.cancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={onSubmit} activeOpacity={0.9}>
                <Ionicons name={isEdit ? 'checkmark' : 'add'} size={18} color="#fff" />
                <Text style={s.saveTxt}>{isEdit ? 'Save' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>

      {/* Nested picker sheet */}
      {picker ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPicker(null)}>
          <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => setPicker(null)}>
            <TouchableOpacity activeOpacity={1} style={s.sheet}>
              {/* drag handle removed: these are centred dialogs now, not bottom sheets — a grab bar on a dialog you cannot drag is just noise */}
              <Text style={s.sheetTitle}>Select</Text>
              <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled">
                {pickerItems().length === 0 ? (
                  <Text style={s.pickEmpty}>Nothing to choose.</Text>
                ) : pickerItems().map((it) => (
                  <TouchableOpacity key={String(it.id)} style={s.pickItem} onPress={() => onPick(it)}>
                    <Text style={s.pickTxt}>{it.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </Modal>
  );
}

function Selector({ value, placeholder, onPress }) {
  return (
    <TouchableOpacity style={s.mSelector} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.mSelTxt, { color: value ? COLORS.ink : COLORS.faint }]} numberOfLines={1}>
        {value || placeholder || 'Select'}
      </Text>
      <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
    </TouchableOpacity>
  );
}

const PAD = 16;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: PAD, paddingBottom: 8,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { fontSize: 18, fontWeight: '900', color: COLORS.navy },

  stats: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: PAD, marginTop: 4,
    backgroundColor: COLORS.card, borderRadius: 16, paddingVertical: 14, ...SHADOW,
  },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 20, fontWeight: '900', color: COLORS.navy, marginTop: 2 },
  statLbl: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted },
  statDiv: { width: 1, height: 36, backgroundColor: COLORS.line },

  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: PAD, marginTop: 16 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 38, paddingHorizontal: 18,
    borderRadius: 12, backgroundColor: COLORS.primary, ...SHADOW,
  },
  chipAlt: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.primary },
  chipTxt: { color: '#fff', fontSize: 13.5, fontWeight: '800' },

  mockHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: PAD, marginTop: 12, paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: COLORS.amberBg, borderRadius: 10,
  },
  mockTxt: { flex: 1, fontSize: 12, color: COLORS.amber, fontWeight: '600' },

  treeWrap: { flex: 1, marginTop: 16 },
  treeCard: { marginHorizontal: PAD, backgroundColor: COLORS.card, borderRadius: 16, overflow: 'hidden', ...SHADOW },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  centerTxt: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, backgroundColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 22, height: 44 },
  retryTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Modal
  // Centred dialog, not a bottom sheet: a popup that slides up from the edge
  // of the screen puts its content under the thumb and, on a short screen,
  // partly behind the keyboard. Centre + fade matches every other modal here.
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#fff', borderRadius: 20, padding: 18, paddingBottom: 20, maxHeight: '85%' },
  sheetTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },

  mLabel: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginTop: 12, marginBottom: 6 },
  req: { color: COLORS.red, fontWeight: '900' },
  mInput: { backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 14, height: 50, fontSize: 15.5, color: COLORS.ink },
  mNum: { backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 14, height: 48, fontSize: 15, color: COLORS.ink },
  row2: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  mSelector: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 14, height: 50,
  },
  mSelTxt: { flex: 1, fontSize: 15, marginRight: 8 },

  sheetBtns: { flexDirection: 'row', gap: 12, marginTop: 20 },
  cancelBtn: { flex: 1, height: 50, borderRadius: 13, backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center' },
  cancelTxt: { fontSize: 15.5, fontWeight: '800', color: COLORS.muted },
  saveBtn: { flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50, borderRadius: 13, backgroundColor: COLORS.primary },
  saveTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },

  pickItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  pickTxt: { fontSize: 15.5, color: COLORS.ink },
  pickEmpty: { color: COLORS.muted, fontSize: 14, paddingVertical: 14 },

  // Assign-clients dialog
  assignSub: { fontSize: 13.5, fontWeight: '700', color: COLORS.muted, marginBottom: 10 },
  assignLoading: { alignItems: 'center', gap: 10, paddingVertical: 28 },
  assignLoadTxt: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', paddingHorizontal: 10 },
  // Capped, not flex: this dialog is centred, so an unbounded list pushes its own
  // title and buttons off the screen on a phone.
  assignList: { maxHeight: 340 },
  assignRow: {
    flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: '#F0F3F8',
  },
  assignName: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  assignLogin: { fontSize: 12, color: COLORS.faint, marginTop: 1 },
  assignWarn: { fontSize: 12, color: COLORS.amber, fontWeight: '700', paddingVertical: 10, lineHeight: 17 },
  assignCount: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted, marginTop: 12 },
  inheritNote: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    backgroundColor: '#EFF6FF', borderRadius: 12, padding: 11, marginBottom: 10,
  },
  inheritTxt: { flex: 1, fontSize: 12, color: COLORS.ink, lineHeight: 17 },
  inheritName: { fontWeight: '900', color: COLORS.link },

  // Delete dialog
  delHead: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 14 },
  delIcon: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: COLORS.redBg,
    alignItems: 'center', justifyContent: 'center',
  },
  delTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },
  delName: { fontSize: 13.5, fontWeight: '700', color: COLORS.muted, marginTop: 3 },
  delCascade: {
    backgroundColor: COLORS.redBg, borderRadius: 12, padding: 12, gap: 8,
  },
  delCascadeHead: { fontSize: 11.5, fontWeight: '900', color: COLORS.red, letterSpacing: 0.4, textTransform: 'uppercase' },
  delRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  delRowTxt: { flex: 1, fontSize: 13, color: COLORS.ink, lineHeight: 18 },
  delRowNum: { fontWeight: '900', color: COLORS.red },
  delPlain: { fontSize: 13, color: COLORS.muted, lineHeight: 18 },
  delWarn: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted, marginTop: 12 },
  delBtn: {
    flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    height: 50, borderRadius: 13, backgroundColor: COLORS.red,
  },
  delBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
});
