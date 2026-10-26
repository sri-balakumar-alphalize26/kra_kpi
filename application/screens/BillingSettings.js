// BILLING — mobile port of the web Settings › Billing page
// (web/components/settings/Billing.jsx; Odoo's kpi_billing_settings screen).
//
// When a task is 🏁 Full Complete its bill is made from this price list: the
// client's own price for the task's work type if it has one, else the Default's.
// With neither there is no bill — those gaps show in red so they get filled.
//
// One section per client (the Default first), every work type in it. Each
// client also carries:
//   • its invoice WhatsApp group (where its bills are posted)
//   • the Send invoices switch (off: no bill is made automatically)
//   • the invoice details printed under Bill To (logo, address, phone, email, tax no)
//
// Admin-only. Every /kpi_billing/* route answers {status:false} for anyone else,
// so the screen shows a lock instead of a form whose every save would fail.
// 🧾 Bill now is a per-TASK action (the web has it on the task panel), so it is
// not on this page — services/billing.js exports billNow() for the task screens.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch, Image,
  ActivityIndicator, Modal, FlatList, KeyboardAvoidingView, Platform,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import GradientButton from '../components/GradientButton';
import DateGridModal from '../components/DateGridModal';
import useAppDialog from '../components/useAppDialog';
import { createLogger } from '../api/logger';
import {
  fetchBilling, saveRate, deleteRate, setClientInvoice, fetchInvoiceGroups,
} from '../services/billing';

const log = createLogger('BillingSettings');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const FAR = '9999-12-31';
const NEAR = '0000-01-01';

const METHOD_OPTS = [
  { value: 'per_task', label: 'Per task (fixed amount)' },
  { value: 'hourly', label: 'Hourly (amount × hours)' },
];

// The price `e` would clash with: same client (or Default), same work type,
// overlapping days (no dates = always). The server refuses it too; saying so
// before the round trip lets the admin jump to the existing one instead.
function duplicateOf(rates, e) {
  if (!e) return null;
  const from = e.date_from || NEAR, to = e.date_to || FAR;
  return (rates || []).find((r) => r.id !== e.id
    && String(r.client_id || '') === String(e.client_id || '')
    && r.work_type === e.work_type
    && (r.date_from || NEAR) <= to && from <= (r.date_to || FAR)) || null;
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const money = (r) => `${r.currency_symbol || r.currency || ''} ${Number(r.amount || 0).toFixed(2)}${r.method === 'hourly' ? ' /h' : ''}`;

function Card({ color, icon, title, right, children }) {
  return (
    <View style={[s.card, { borderLeftColor: color }]}>
      <View style={s.cardHead}>
        <MaterialCommunityIcons name={icon} size={18} color={color} />
        <Text style={s.cardTitle}>{title}</Text>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      <View style={s.cardBody}>{children}</View>
    </View>
  );
}

export default function BillingSettings({ onBack }) {
  const { dialog, say, showError, confirm } = useAppDialog();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);        // the /kpi_billing/config answer
  const [denied, setDenied] = useState('');      // status:false message → lock screen
  const [loadError, setLoadError] = useState('');
  const [groups, setGroups] = useState(null);    // null = not loaded yet
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set(['']));   // '' = the Default, open by default
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState(null);        // the price being added / edited
  const [editErr, setEditErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);    // { title, options:[{value,label,meta,section}], current, onPick, search }
  const [pickQuery, setPickQuery] = useState('');
  const [datePick, setDatePick] = useState(null); // 'date_from' | 'date_to'
  const [savedClient, setSavedClient] = useState(0); // client id whose ✓ is showing
  const [clientBusy, setClientBusy] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetchBilling();
      if (!r || r.status === false) {
        setDenied(r?.message || 'Only an admin can change billing.');
        return;
      }
      setDenied('');
      setLoadError('');
      setData(r);
    } catch (e) {
      log.warn('load failed', e?.message);
      setLoadError('Could not load billing — check the connection and pull refresh.');
    }
  }, []);

  const loadGroups = useCallback(async () => {
    setGroupsBusy(true);
    try {
      setGroups(await fetchInvoiceGroups());
    } catch (e) {
      log.warn('groups', e?.message);
      setGroups((g) => g || []);
    } finally { setGroupsBusy(false); }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
    loadGroups();
  }, [load, loadGroups]);

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Sections: the Default, then every client, each with every work type ──
  const today = todayIso();
  const sections = useMemo(() => {
    if (!data) return [];
    const rates = data.rates || [];
    const live = (r) => r.always || ((r.date_from || NEAR) <= today && today <= (r.date_to || FAR));
    const ofClient = (id) => rates.filter((r) => String(r.client_id || '') === String(id || ''));
    const defaults = ofClient('');
    const build = (key, name, isDefault, client) => {
      const mine = ofClient(key);
      const types = (data.work_types || []).map((w) => ({
        key: w.key, label: w.label,
        rates: mine.filter((r) => r.work_type === w.key),
        fallback: isDefault ? null : (defaults.find((r) => r.work_type === w.key && live(r)) || null),
      }));
      // The Default is optional: only a client's own gap is "missing".
      return {
        key, name, isDefault, client, types,
        missing: isDefault ? 0 : types.filter((t) => !t.rates.length && !t.fallback).length,
      };
    };
    return [
      build('', 'Default (every client)', true, null),
      ...(data.clients || []).map((c) => build(String(c.id), c.name, false, c)),
    ];
  }, [data, today]);

  const missingTotal = sections.reduce((n, x) => n + x.missing, 0);
  const q = query.trim().toLowerCase();
  const shown = q ? sections.filter((x) => x.isDefault || (x.name || '').toLowerCase().includes(q)) : sections;

  const toggleOpen = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // ── Price editor ─────────────────────────────────────────────────────────
  // A new price starts on the first work type the Default has no price for yet,
  // in the currency already in use (the newest price's), else the company's.
  const blank = () => {
    const rates = data?.rates || [];
    const used = new Set(rates.filter((r) => !r.client_id && r.always).map((r) => r.work_type));
    const wts = data?.work_types || [];
    const newest = rates.reduce((a, r) => (!a || r.id > a.id ? r : a), null);
    return {
      id: false, client_id: '',
      work_type: (wts.find((w) => !used.has(w.key)) || wts[0] || { key: 'requirement' }).key,
      method: 'per_task', amount: '',
      currency_id: String(newest?.currency_id || data?.company_currency_id || data?.currencies?.[0]?.id || ''),
      date_from: '', date_to: '', note: '', showDates: false,
    };
  };
  const fromRate = (r) => ({
    ...r, client_id: r.client_id ? String(r.client_id) : '', currency_id: String(r.currency_id),
    amount: String(r.amount ?? ''), date_from: r.date_from || '', date_to: r.date_to || '',
    note: r.note || '', showDates: !r.always,
  });
  const openNew = () => { setEditErr(''); setEdit(blank()); };
  const addFor = (clientKey, workType) => { setEditErr(''); setEdit({ ...blank(), client_id: clientKey || '', work_type: workType }); };
  const patch = (k, v) => setEdit((x) => ({ ...x, [k]: v }));
  const dup = duplicateOf(data?.rates, edit);

  const onSaveRate = async () => {
    if (!edit || dup) return;
    const amt = String(edit.amount).replace(/,/g, '').trim();
    if (amt === '' || Number.isNaN(parseFloat(amt))) { setEditErr('Enter the amount.'); return; }
    if (!edit.currency_id) { setEditErr('Pick a currency.'); return; }
    if (edit.date_from && edit.date_to && edit.date_to < edit.date_from) { setEditErr('"To" is before "From".'); return; }
    setBusy(true); setEditErr('');
    try {
      const r = await saveRate({ ...edit, amount: amt });
      if (!r || r.status === false) { setEditErr(r?.message || 'Could not save the price.'); return; }
      setEdit(null);
      say('Price saved', 'Bills from now on use it.', 'ok');
      await load();
    } catch (e) {
      log.warn('saveRate', e?.message);
      setEditErr(e?.message || 'Could not reach the server — the price was not saved.');
    } finally { setBusy(false); }
  };

  const onDelete = (r) => confirm({
    title: 'Delete this price?',
    message: `${r.client_name || 'Default'} · ${r.work_type_label}. A price already used on a bill is kept for that bill and only hidden here.`,
    confirmLabel: 'Delete', destructive: true, tone: 'danger',
    onConfirm: async () => {
      try {
        const res = await deleteRate(r.id);
        if (!res || res.status === false) { showError("Couldn't delete", res?.message || 'Please try again.'); return; }
        if (edit?.id === r.id) setEdit(null);
        await load();
        say(res.archived ? 'Hidden' : 'Deleted', res.archived ? 'It is on a bill already, so it is kept for that bill.' : 'The price is gone.', 'ok');
      } catch (e) {
        showError("Couldn't delete", e?.message || 'Please try again.');
      }
    },
  });

  // ── Per client: invoice group, Send invoices, Bill To details ───────────
  const clientSet = async (c, vals) => {
    setClientBusy(c.id);
    try {
      const r = await setClientInvoice(c.id, vals);
      if (!r || r.status === false) { showError("Couldn't save", r?.message || 'Please try again.'); return false; }
      // The server's echo wins over what was sent.
      setData((d) => ({
        ...d,
        clients: d.clients.map((x) => (x.id === c.id ? {
          ...x,
          invoice_group_jid: r.invoice_group_jid, invoice_group_name: r.invoice_group_name,
          send_invoice: r.send_invoice, bill_address: r.bill_address, bill_phone: r.bill_phone,
          bill_email: r.bill_email, bill_tax_id: r.bill_tax_id, bill_logo: r.bill_logo,
        } : x)),
      }));
      setSavedClient(c.id);
      setTimeout(() => setSavedClient((k) => (k === c.id ? 0 : k)), 1400);
      return true;
    } catch (e) {
      log.warn('clientSet', e?.message);
      showError("Couldn't save", 'Could not reach the server — that change was not saved.');
      return false;
    } finally { setClientBusy(0); }
  };

  const pickGroup = (c) => {
    if (groups === null && !groupsBusy) loadGroups();
    const list = groups || [];
    const opts = [
      { value: '', label: 'No group (bills are not sent)' },
      // The stored group may not be in the gateway's list right now — keep it pickable.
      ...(c.invoice_group_jid && !list.some((g) => g.jid === c.invoice_group_jid)
        ? [{ value: c.invoice_group_jid, label: c.invoice_group_name || c.invoice_group_jid }] : []),
      ...list.map((g) => ({ value: g.jid, label: g.name || g.jid, meta: g.name ? g.jid.split('@')[0].slice(-6) : '' })),
    ];
    setPickQuery('');
    setPicker({
      title: `Invoice group — ${c.name}`, current: c.invoice_group_jid || '', options: opts, search: true,
      groupPicker: true,
      onPick: (jid) => {
        const g = list.find((x) => x.jid === jid);
        clientSet(c, { jid, name: g?.name || (jid === c.invoice_group_jid ? c.invoice_group_name : '') || '' });
      },
    });
  };

  // ── Generic pickers for the editor ───────────────────────────────────────
  const openPicker = (p) => { setPickQuery(''); setPicker(p); };
  const curLabel = (c) => `${c.name}${c.symbol ? ` (${c.symbol})` : ''}`;
  const currencyOpts = () => {
    const cs = data?.currencies || [];
    return [
      ...cs.filter((c) => c.active).map((c) => ({ value: String(c.id), label: curLabel(c), section: 'In use' })),
      ...cs.filter((c) => !c.active).map((c) => ({ value: String(c.id), label: curLabel(c), section: 'All currencies' })),
    ];
  };
  const clientName = (id) => (id ? ((data?.clients || []).find((c) => String(c.id) === String(id))?.name || 'this client') : 'Default (every client)');
  const typeLabel = (k) => (data?.work_types || []).find((w) => w.key === k)?.label || k;
  const currencyName = (id) => {
    const c = (data?.currencies || []).find((x) => String(x.id) === String(id));
    return c ? curLabel(c) : 'Pick a currency';
  };

  // ── Gates ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <View style={s.center}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={s.centerTxt}>Loading billing…</Text>
        </View>
      </View>
    );
  }

  const header = (
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <Text style={s.hTitle} numberOfLines={1}>Billing</Text>
      {denied ? <View style={s.iconBtn} /> : (
        <TouchableOpacity onPress={refresh} style={s.iconBtn} disabled={refreshing}>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.primary} />
            : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      )}
    </View>
  );

  if (denied) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        {header}
        <View style={[s.center, { padding: 32 }]}>
          <View style={s.lockWrap}><Ionicons name="lock-closed" size={40} color={COLORS.amber} /></View>
          <Text style={s.lockTitle}>Admins only</Text>
          <Text style={s.lockMsg}>{denied}</Text>
          <TouchableOpacity style={s.lockBtn} onPress={onBack} activeOpacity={0.9}>
            <Ionicons name="arrow-back" size={18} color="#fff" />
            <Text style={s.lockBtnTxt}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const pickList = picker ? picker.options.filter((o) => !pickQuery.trim()
    || `${o.label} ${o.meta || ''}`.toLowerCase().includes(pickQuery.trim().toLowerCase())) : [];

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      {header}

      {data?.isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to load live billing</Text>
        </View>
      )}
      {!!loadError && (
        <View style={s.mockBar}>
          <Ionicons name="alert-circle-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>{loadError}</Text>
        </View>
      )}

      {data && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Card
            color="#CA8A04" icon="receipt" title="Prices"
            right={(
              <TouchableOpacity style={s.addBtn} onPress={openNew} activeOpacity={0.85}>
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={s.addBtnTxt}>Add price</Text>
              </TouchableOpacity>
            )}
          >
            <Text style={s.hintTop}>
              When a task is <Text style={s.b}>Full Complete</Text>, its bill is made from this list: the
              client's own price if it has one, else the Default. <Text style={s.b}>Per task</Text> bills the
              amount once; <Text style={s.b}>Hourly</Text> bills the client's quoted hours (or the time
              logged) × the amount.
            </Text>

            {missingTotal > 0 && (
              <View style={s.alertBox}>
                <Ionicons name="warning" size={15} color={COLORS.red} />
                <Text style={s.alertTxt}>
                  {missingTotal} price(s) missing: tasks of those types are fully completed but get no
                  bill. Add them below.
                </Text>
              </View>
            )}

            {sections.length > 8 && (
              <View style={s.searchBox}>
                <Ionicons name="search" size={16} color={COLORS.muted} />
                <TextInput
                  style={s.searchInput} value={query} onChangeText={setQuery}
                  placeholder="Find a client…" placeholderTextColor={COLORS.faint}
                />
                {!!query && (
                  <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={16} color={COLORS.faint} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {shown.map((sec) => {
              const isOpen = open.has(sec.key);
              const c = sec.client;
              return (
                <View key={sec.key || 'default'} style={[s.section, sec.missing > 0 && s.sectionBad]}>
                  <TouchableOpacity style={s.secHead} onPress={() => toggleOpen(sec.key)} activeOpacity={0.8}>
                    <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.navy} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.secName} numberOfLines={2}>{sec.name}</Text>
                      {sec.isDefault && <Text style={s.secSub}>used for any client without its own price</Text>}
                      {!sec.isDefault && (
                        <Text style={s.secSub}>
                          Invoices {c.send_invoice ? 'on' : 'off'}
                          {c.invoice_group_jid ? ` · ${c.invoice_group_name || 'group set'}` : ''}
                        </Text>
                      )}
                    </View>
                    {sec.missing > 0
                      ? <View style={[s.pill, s.pillBad]}><Text style={[s.pillTxt, { color: COLORS.red }]}>{sec.missing} missing</Text></View>
                      : !sec.isDefault ? <View style={[s.pill, s.pillOk]}><Text style={[s.pillTxt, { color: COLORS.green }]}>✓ complete</Text></View> : null}
                  </TouchableOpacity>

                  {isOpen && (
                    <View>
                      {!sec.isDefault && (
                        <View style={s.clientBox}>
                          <Text style={s.label}>Invoice group</Text>
                          <View style={s.inlineRow}>
                            <TouchableOpacity style={[s.select, { flex: 1 }]} onPress={() => pickGroup(c)} activeOpacity={0.8}>
                              <Text style={[s.selectTxt, !c.invoice_group_jid && { color: COLORS.faint }]} numberOfLines={1}>
                                {c.invoice_group_jid ? (c.invoice_group_name || c.invoice_group_jid) : 'Choose a WhatsApp group…'}
                              </Text>
                              <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
                            </TouchableOpacity>
                            {clientBusy === c.id ? <ActivityIndicator size="small" color={COLORS.primary} />
                              : savedClient === c.id ? <Text style={s.savedTick}>✓</Text> : null}
                          </View>

                          <View style={[s.switchRow, { marginTop: 12 }]}>
                            <View style={{ flex: 1 }}>
                              <Text style={[s.label, { marginBottom: 0 }]}>Send invoices</Text>
                              <Text style={s.hintSm}>
                                {c.send_invoice
                                  ? 'On: each fully complete task makes a bill and posts it in the invoice group.'
                                  : 'Off: no bill is made (🧾 Bill now on the task makes one by hand).'}
                              </Text>
                            </View>
                            <Switch
                              value={!!c.send_invoice}
                              disabled={clientBusy === c.id}
                              onValueChange={(v) => clientSet(c, { send: v })}
                              trackColor={{ true: COLORS.primary }}
                            />
                          </View>
                          {c.send_invoice && !c.invoice_group_jid && (
                            <View style={[s.alertBox, { marginTop: 10, marginBottom: 0 }]}>
                              <Ionicons name="warning" size={15} color={COLORS.red} />
                              <Text style={s.alertTxt}>Invoices are on, but no invoice group is picked: bills are made but not sent.</Text>
                            </View>
                          )}

                          <BillDetails
                            client={c} busy={clientBusy === c.id} onError={showError}
                            save={(details) => clientSet(c, { details })}
                          />
                        </View>
                      )}

                      {sec.types.map((ty) => (ty.rates.length ? ty.rates.map((r) => (
                        <View key={r.id} style={[s.rateRow, edit?.id === r.id && { backgroundColor: '#FFFBEB' }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.rateType}>{ty.label}</Text>
                            <Text style={s.rateMeta}>
                              {r.method === 'hourly' ? 'Hourly' : 'Per task'} · {r.always ? 'Always' : r.range_label}
                            </Text>
                            {!!r.note && <Text style={s.rateNote} numberOfLines={2}>{r.note}</Text>}
                          </View>
                          <Text style={s.rateAmt}>{money(r)}</Text>
                          <TouchableOpacity style={s.rowIcon} onPress={() => { setEditErr(''); setEdit(fromRate(r)); }} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                            <Ionicons name="create-outline" size={18} color={COLORS.primary} />
                          </TouchableOpacity>
                          <TouchableOpacity style={s.rowIcon} onPress={() => onDelete(r)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                            <Ionicons name="trash-outline" size={18} color={COLORS.red} />
                          </TouchableOpacity>
                        </View>
                      )) : ty.fallback ? (
                        <View key={ty.key} style={[s.rateRow, { backgroundColor: '#FFFBEB' }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.rateType}>{ty.label}</Text>
                            <Text style={s.rateMeta}>Uses the Default: {ty.fallback.price_label}</Text>
                          </View>
                          <TouchableOpacity style={s.ghostBtn} onPress={() => addFor(sec.key, ty.key)}>
                            <Text style={s.ghostBtnTxt}>+ Own price</Text>
                          </TouchableOpacity>
                        </View>
                      ) : sec.isDefault ? (
                        <View key={ty.key} style={s.rateRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={[s.rateType, { color: COLORS.muted }]}>{ty.label}</Text>
                            <Text style={s.rateMeta}>Not set (optional): a client without its own price gets no bill</Text>
                          </View>
                          <TouchableOpacity style={s.ghostBtn} onPress={() => addFor(sec.key, ty.key)}>
                            <Text style={s.ghostBtnTxt}>+ Add</Text>
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <View key={ty.key} style={[s.rateRow, { backgroundColor: COLORS.redBg }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={[s.rateType, { color: COLORS.red }]}>{ty.label}</Text>
                            <Text style={[s.rateMeta, { color: COLORS.red, fontWeight: '700' }]}>⚠ No price: no bill can be made</Text>
                          </View>
                          <TouchableOpacity style={[s.ghostBtn, s.dangerBtn]} onPress={() => addFor(sec.key, ty.key)}>
                            <Text style={[s.ghostBtnTxt, { color: '#fff' }]}>+ Add</Text>
                          </TouchableOpacity>
                        </View>
                      )))}
                    </View>
                  )}
                </View>
              );
            })}
            {!!q && shown.length <= 1 && <Text style={s.hint}>No client matches “{query}”.</Text>}
          </Card>
        </ScrollView>
      )}

      {/* Add / edit a price */}
      <Modal visible={!!edit} transparent animationType="fade" onRequestClose={() => setEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalBackdrop}>
          <View style={[s.modalSheet, { maxHeight: '88%', maxWidth: 420 }]}>
            <View style={s.modalHead}>
              <Text style={[s.modalTitle, { flex: 1 }]} numberOfLines={2}>
                {edit?.id ? `${typeLabel(edit.work_type)} price · ${clientName(edit.client_id)}` : 'New price'}
              </Text>
              <TouchableOpacity onPress={() => setEdit(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {edit && (
              <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
                {!!edit.id && (
                  <Text style={[s.hintSm, { marginTop: 0, marginBottom: 10 }]}>Client and work type stay as they are. For
                    another work type, close this and use Add price.</Text>
                )}
                <Text style={s.label}>Client</Text>
                <TouchableOpacity
                  style={[s.select, !!dup && s.selectBad, !!edit.id && s.selectOff]} disabled={!!edit.id} activeOpacity={0.8}
                  onPress={() => openPicker({
                    title: 'Client', current: edit.client_id, search: true,
                    options: [{ value: '', label: 'Default (every client)' },
                      ...(data?.clients || []).map((c) => ({ value: String(c.id), label: c.name }))],
                    onPick: (v) => patch('client_id', v),
                  })}
                >
                  <Text style={s.selectTxt} numberOfLines={1}>{clientName(edit.client_id)}</Text>
                  {!edit.id && <Ionicons name="chevron-down" size={18} color={COLORS.muted} />}
                </TouchableOpacity>

                <Text style={[s.label, { marginTop: 12 }]}>Work type</Text>
                <TouchableOpacity
                  style={[s.select, !!dup && s.selectBad, !!edit.id && s.selectOff]} disabled={!!edit.id} activeOpacity={0.8}
                  onPress={() => openPicker({
                    title: 'Work type', current: edit.work_type,
                    options: (data?.work_types || []).map((w) => ({ value: w.key, label: w.label })),
                    onPick: (v) => patch('work_type', v),
                  })}
                >
                  <Text style={s.selectTxt}>{typeLabel(edit.work_type)}</Text>
                  {!edit.id && <Ionicons name="chevron-down" size={18} color={COLORS.muted} />}
                </TouchableOpacity>

                {!!dup && (
                  <View style={[s.alertBox, { marginTop: 10, marginBottom: 0 }]}>
                    <Ionicons name="warning" size={15} color={COLORS.red} />
                    <Text style={s.alertTxt}>
                      {dup.client_name || 'The Default'} already has a {dup.work_type_label} price
                      ({dup.price_label}{dup.always ? '' : `, ${dup.range_label}`}).{' '}
                      <Text style={s.alertLink} onPress={() => { setEditErr(''); setEdit(fromRate(dup)); }}>Edit that one instead</Text>
                    </Text>
                  </View>
                )}

                <Text style={[s.label, { marginTop: 12 }]}>Method</Text>
                <TouchableOpacity
                  style={s.select} activeOpacity={0.8}
                  onPress={() => openPicker({ title: 'Method', current: edit.method, options: METHOD_OPTS, onPick: (v) => patch('method', v) })}
                >
                  <Text style={s.selectTxt}>{METHOD_OPTS.find((o) => o.value === edit.method)?.label || edit.method}</Text>
                  <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
                </TouchableOpacity>

                <Text style={[s.label, { marginTop: 12 }]}>Currency</Text>
                <TouchableOpacity
                  style={s.select} activeOpacity={0.8}
                  onPress={() => openPicker({ title: 'Currency', current: edit.currency_id, search: true, options: currencyOpts(), onPick: (v) => patch('currency_id', v) })}
                >
                  <Text style={s.selectTxt} numberOfLines={1}>{currencyName(edit.currency_id)}</Text>
                  <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
                </TouchableOpacity>
                <Text style={s.hintSm}>Picking a currency that is switched off in Odoo switches it on.</Text>

                <Text style={[s.label, { marginTop: 12 }]}>Amount {edit.method === 'hourly' ? '(per hour)' : '(per task)'}</Text>
                <TextInput
                  style={[s.input, { textAlign: 'right' }]} keyboardType="decimal-pad" placeholder="0.00"
                  placeholderTextColor={COLORS.faint} value={String(edit.amount)} onChangeText={(t) => patch('amount', t)}
                />

                <Text style={[s.label, { marginTop: 12 }]}>Note (optional)</Text>
                <TextInput
                  style={s.input} maxLength={200} value={edit.note} onChangeText={(t) => patch('note', t)}
                  placeholder="e.g. agreed in the March quote" placeholderTextColor={COLORS.faint}
                />

                {!edit.showDates ? (
                  <TouchableOpacity onPress={() => patch('showDates', true)} style={{ marginTop: 12 }}>
                    <Text style={s.linkTxt}>📅 Set dates (optional): only to plan a price change ahead</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={[s.inlineRow, { marginTop: 12, alignItems: 'flex-start' }]}>
                    {[['date_from', 'From (empty = always)'], ['date_to', 'To (empty = no end)']].map(([k, lbl]) => (
                      <View key={k} style={{ flex: 1 }}>
                        <Text style={s.label}>{lbl}</Text>
                        <View style={s.inlineRow}>
                          <TouchableOpacity style={[s.select, { flex: 1, paddingHorizontal: 10 }]} onPress={() => setDatePick(k)} activeOpacity={0.8}>
                            <Text style={[s.selectTxt, !edit[k] && { color: COLORS.faint }]}>{edit[k] || 'Pick'}</Text>
                          </TouchableOpacity>
                          {!!edit[k] && (
                            <TouchableOpacity onPress={() => patch(k, '')} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                              <Ionicons name="close-circle" size={18} color={COLORS.faint} />
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {!!editErr && <Text style={s.errTxt}>⚠ {editErr}</Text>}

                <View style={[s.inlineRow, { marginTop: 16 }]}>
                  <TouchableOpacity style={s.cancelBtn} onPress={() => { setEdit(null); setEditErr(''); }}>
                    <Text style={s.cancelBtnTxt}>Cancel</Text>
                  </TouchableOpacity>
                  <GradientButton
                    label={busy ? 'Saving…' : 'Save'} disabled={busy || !!dup} onPress={onSaveRate}
                    style={{ flex: 1 }}
                  />
                </View>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Generic picker (client / work type / method / currency / invoice group).
          Mounted after the editor, so it paints above it. */}
      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPicker(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={[s.modalTitle, { flex: 1 }]} numberOfLines={1}>{picker?.title || 'Select'}</Text>
              {picker?.groupPicker && (
                <TouchableOpacity onPress={loadGroups} style={{ marginRight: 14 }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  {groupsBusy ? <ActivityIndicator size="small" color={COLORS.primary} /> : <Ionicons name="refresh" size={18} color={COLORS.primary} />}
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setPicker(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {picker?.search && (
              <View style={[s.searchBox, { marginHorizontal: 14, marginTop: 10 }]}>
                <Ionicons name="search" size={16} color={COLORS.muted} />
                <TextInput
                  style={s.searchInput} value={pickQuery} onChangeText={setPickQuery}
                  placeholder="Search…" placeholderTextColor={COLORS.faint}
                />
              </View>
            )}
            {picker?.groupPicker && groupsBusy && groups === null && (
              <Text style={[s.hint, { paddingHorizontal: 20 }]}>Loading the WhatsApp groups…</Text>
            )}
            <FlatList
              data={pickList}
              keyExtractor={(o, i) => `${o.value}:${i}`}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item, index }) => {
                const on = String(item.value) === String(picker?.current ?? '');
                const head = !!item.section && (index === 0 || pickList[index - 1].section !== item.section);
                return (
                  <View>
                    {head && <Text style={s.pickSection}>{item.section}</Text>}
                    <TouchableOpacity
                      style={[s.ccRow, on && s.ccRowOn]} activeOpacity={0.8}
                      onPress={() => { const f = picker.onPick; setPicker(null); if (f) f(item.value); }}
                    >
                      <Text style={s.ccRowName} numberOfLines={2}>{item.label}</Text>
                      {!!item.meta && <Text style={s.ccRowMeta}>{item.meta}</Text>}
                      {on && <Text style={s.ccRowTick}>✓</Text>}
                    </TouchableOpacity>
                  </View>
                );
              }}
              ListEmptyComponent={<Text style={[s.hint, { paddingHorizontal: 20 }]}>Nothing to pick.</Text>}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {!!datePick && (
        <DateGridModal
          title={datePick === 'date_from' ? 'Price applies from' : 'Price applies until'}
          value={edit?.[datePick] || ''}
          minDate={datePick === 'date_to' ? (edit?.date_from || undefined) : undefined}
          maxDate={datePick === 'date_from' ? (edit?.date_to || undefined) : undefined}
          onCancel={() => setDatePick(null)}
          onPick={(iso) => { patch(datePick, iso); setDatePick(null); }}
        />
      )}

      {dialog}
    </View>
  );
}

// The client's logo and details, printed under Bill To on its invoices
// (kra.master logo + kpi_bill_*). Collapsed by default — it is set once.
function BillDetails({ client, save, busy, onError }) {
  const [openBox, setOpenBox] = useState(false);
  const [f, setF] = useState(() => ({
    address: client.bill_address || '', phone: client.bill_phone || '',
    email: client.bill_email || '', tax_id: client.bill_tax_id || '',
  }));
  const [picking, setPicking] = useState(false);
  const set = (k) => (t) => setF((x) => ({ ...x, [k]: t }));
  const has = !!(client.bill_logo || client.bill_address);

  // Same shrink-then-base64 as Company Branding, so a phone photo stays well
  // under the server's 3 MB cap.
  const pickLogo = async () => {
    setPicking(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset) return;
      const m = await ImageManipulator.manipulateAsync(
        asset.uri, [{ resize: { width: 512 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.PNG },
      );
      const data = await FileSystem.readAsStringAsync(m.uri, { encoding: FileSystem.EncodingType.Base64 });
      await save({ logo: data });
    } catch (e) {
      log.warn('logo pick failed', e?.message);
      onError && onError('Logo', 'Could not read that image.');
    } finally { setPicking(false); }
  };

  return (
    <View style={s.detailsBox}>
      <TouchableOpacity style={s.inlineRow} onPress={() => setOpenBox((v) => !v)} activeOpacity={0.8}>
        <Ionicons name={openBox ? 'chevron-down' : 'chevron-forward'} size={14} color={COLORS.navy} />
        <Text style={s.detailsHead}>Invoice details (logo, address, tax no){has ? ' ✓' : ''}</Text>
      </TouchableOpacity>
      {openBox && (
        <View style={{ marginTop: 10 }}>
          <View style={[s.inlineRow, { alignItems: 'center' }]}>
            <View style={s.logoBox}>
              {client.bill_logo
                ? <Image source={{ uri: client.bill_logo }} style={{ width: 96, height: 56 }} resizeMode="contain" />
                : <Text style={s.hintSm}>No logo</Text>}
            </View>
            <View style={{ gap: 6 }}>
              <TouchableOpacity onPress={pickLogo} disabled={picking || busy}>
                <Text style={s.linkTxt}>{picking ? 'Reading…' : 'Upload logo'}</Text>
              </TouchableOpacity>
              {!!client.bill_logo && (
                <TouchableOpacity onPress={() => save({ logo: '' })} disabled={busy}>
                  <Text style={[s.linkTxt, { color: COLORS.red }]}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          <TextInput
            style={[s.input, { height: 64, marginTop: 10, textAlignVertical: 'top', paddingTop: 10 }]} multiline
            placeholder="Address" placeholderTextColor={COLORS.faint} value={f.address} onChangeText={set('address')}
          />
          <TextInput style={[s.input, { marginTop: 8 }]} placeholder="Phone" keyboardType="phone-pad"
            placeholderTextColor={COLORS.faint} value={f.phone} onChangeText={set('phone')} />
          <TextInput style={[s.input, { marginTop: 8 }]} placeholder="Email" keyboardType="email-address" autoCapitalize="none"
            placeholderTextColor={COLORS.faint} value={f.email} onChangeText={set('email')} />
          <TextInput style={[s.input, { marginTop: 8 }]} placeholder="Tax no (VAT / TRN / GST)"
            placeholderTextColor={COLORS.faint} value={f.tax_id} onChangeText={set('tax_id')} />
          <GradientButton label={busy ? 'Saving…' : 'Save details'} disabled={busy} onPress={() => save(f)} style={{ marginTop: 10 }} />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerTxt: { marginTop: 10, color: COLORS.muted, fontSize: 13 },

  lockWrap: { width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.amberBg, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  lockTitle: { fontSize: 18, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },
  lockMsg: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', lineHeight: 20 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, backgroundColor: COLORS.primary, paddingHorizontal: 20, height: 44, borderRadius: 12 },
  lockBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },

  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 16, borderLeftWidth: 4, overflow: 'hidden', ...SHADOW },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  cardBody: { padding: 14 },

  b: { fontWeight: '800', color: COLORS.ink },
  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 8, lineHeight: 17 },
  hintTop: { fontSize: 12, color: COLORS.muted, lineHeight: 17, marginBottom: 12 },
  hintSm: { fontSize: 11.5, color: COLORS.muted, marginTop: 4, lineHeight: 16 },
  linkTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  errTxt: { color: COLORS.red, fontSize: 12.5, fontWeight: '700', marginTop: 12 },

  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.primary, paddingHorizontal: 10, height: 32, borderRadius: 9 },
  addBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 12.5 },

  alertBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: COLORS.redBg,
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 12,
  },
  alertTxt: { color: '#B91C1C', fontSize: 12, fontWeight: '700', flex: 1, lineHeight: 17 },
  alertLink: { textDecorationLine: 'underline', fontWeight: '900' },

  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderColor: COLORS.line,
    borderRadius: 10, paddingHorizontal: 10, height: 42, backgroundColor: '#fff', marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.ink, paddingVertical: 0 },

  section: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  sectionBad: { borderColor: '#FCA5A5' },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: '#F7F9FC' },
  secName: { fontSize: 14, fontWeight: '800', color: COLORS.navy },
  secSub: { fontSize: 11.5, color: COLORS.muted, marginTop: 1 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  pillBad: { backgroundColor: COLORS.redBg },
  pillOk: { backgroundColor: COLORS.greenBg },
  pillTxt: { fontSize: 11, fontWeight: '800' },

  clientBox: { padding: 12, borderTopWidth: 1, borderTopColor: COLORS.line },
  detailsBox: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F1F4F9' },
  detailsHead: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy },
  logoBox: { width: 110, height: 66, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', marginRight: 6 },

  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#F1F4F9' },
  rateType: { fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  rateMeta: { fontSize: 11.5, color: COLORS.muted, marginTop: 1 },
  rateNote: { fontSize: 11.5, color: COLORS.ink, marginTop: 2, fontStyle: 'italic' },
  rateAmt: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy, fontVariant: ['tabular-nums'] },
  rowIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  ghostBtn: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 10, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  ghostBtnTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary },
  dangerBtn: { backgroundColor: COLORS.red, borderColor: COLORS.red },

  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 46, backgroundColor: '#fff' },
  selectBad: { borderColor: COLORS.red },
  selectOff: { backgroundColor: '#F1F4F9' },
  selectTxt: { fontSize: 14.5, color: COLORS.ink, fontWeight: '600', flexShrink: 1 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  savedTick: { color: COLORS.green, fontSize: 18, fontWeight: '900', marginLeft: 6 },

  cancelBtn: {
    flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  cancelBtnTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },

  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 22,
  },
  modalSheet: {
    width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20,
    maxHeight: '70%', paddingBottom: 12, overflow: 'hidden',
  },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  pickSection: { fontSize: 11, fontWeight: '800', color: COLORS.muted, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, textTransform: 'uppercase' },
  ccRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowMeta: { fontSize: 12, color: COLORS.muted, marginRight: 8 },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },
});
