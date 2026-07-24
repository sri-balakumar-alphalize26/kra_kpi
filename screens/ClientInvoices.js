// CLIENT INVOICES (admin) — mobile port of the Odoo web invoice screen.
// Three modes: LIST (status chips + counts), DETAIL (header, lines, totals,
// workflow, mark paid/unpaid, PDF) and CREATE (client + period + billing).
// The PDF is rendered server-side (reportlab) and opened via the OS viewer.
// Admin-only (Home tile + server ACL/rules both gate it).

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Modal, Alert, Switch, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import * as svc from '../services/clientInvoices';

const log = createLogger('ClientInvoices');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const CHIPS = [
  { key: 'all', label: 'All' }, { key: 'draft', label: 'Draft' },
  { key: 'finalized', label: 'Finalized' }, { key: 'sent', label: 'Sent' },
  { key: 'due', label: 'Payment Due' }, { key: 'paid', label: 'Paid' },
];
// Client (portal) chips — no draft/finalized/sent internals; the server record
// rule already limits a client to their own finalized/sent invoices.
const PORTAL_CHIPS = [
  { key: 'all', label: 'All' }, { key: 'due', label: 'Payment Due' }, { key: 'paid', label: 'Paid' },
];
const STATE_COLOR = { draft: '#64748B', finalized: '#2563EB', sent: '#16A34A' };
const PRESETS = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This Week' }, { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' }, { key: 'custom', label: 'Custom' },
];
// Task-type labels shown in the create form (match the web).
const TASK_TYPES = [
  { key: 'REQ', label: 'Requirements' },
  { key: 'UPT', label: 'Updates / Amendments' },
  { key: 'BUG', label: 'Bug Fixes' },
];
const TYPE_COLOR = { REQ: '#2563EB', UPT: '#0891B2', BUG: '#DC2626' };

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(key) {
  const now = new Date();
  const sod = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (key === 'today') return { from: fmt(sod(now)), to: fmt(sod(now)) };
  if (key === 'yesterday') { const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); return { from: fmt(y), to: fmt(y) }; }
  if (key === 'this_week') { const dow = (now.getDay() + 6) % 7; return { from: fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)), to: fmt(sod(now)) }; }
  if (key === 'last_month') return {
    from: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: fmt(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
  if (key === 'custom') return null;
  return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(sod(now)) };  // this_month
}
const money = (amt, cur) => {
  const dp = cur?.decimal_places ?? 2;
  const s = Number(amt || 0).toFixed(dp);
  return cur?.name ? `${cur.name} ${s}` : s;
};
const stripHtml = (h) => (h || '').replace(/<[^>]+>/g, '').trim();

export default function ClientInvoices({ onBack, portal = false, focusInvoiceId, onFocusHandled }) {
  const [mode, setMode] = useState('list');   // list | detail | create
  const chips = portal ? PORTAL_CHIPS : CHIPS;   // client sees a trimmed set

  // ── List ──
  const [statusFilter, setStatusFilter] = useState('all');
  const [invoices, setInvoices] = useState([]);
  const [counts, setCounts] = useState({});
  const [loadingList, setLoadingList] = useState(true);

  // ── Detail ──
  const [detail, setDetail] = useState(null);   // serialize_for_ui + pdf currency
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(null);       // 'finalize'|'send'|'reset'|'paid'|'unpaid'|'pdf'
  const [showAmounts, setShowAmounts] = useState(true);  // hide money when off (web parity)

  // ── Create ──
  const [clients, setClients] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [cForm, setCForm] = useState(null);     // create form state
  const [pick, setPick] = useState(null);       // { title, options, current, onPick }
  const [prompt, setPrompt] = useState(null);   // { title, fields:[{key,label,val}], onOk }
  const [banner, setBanner] = useState(null);   // { kind:'ok'|'err', msg }

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };

  const loadList = useCallback(async (sf = statusFilter) => {
    setLoadingList(true);
    try {
      const res = await svc.fetchInvoiceList(sf, false);
      if (res?.status) { setInvoices(res.invoices || []); setCounts(res.counts || {}); }
      else setInvoices([]);
    } catch (e) { log.warn('list failed', e?.message); }
    finally { setLoadingList(false); }
  }, [statusFilter]);

  useEffect(() => { loadList('all'); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const openInvoice = async (id) => {
    setMode('detail'); setDetail(null); setLoadingDetail(true);
    try {
      const res = await svc.fetchInvoice(id);
      if (res?.status) setDetail(res.data);
      else flash('err', res?.message || 'Could not open invoice.');
    } catch (e) { flash('err', 'Could not open invoice.'); }
    finally { setLoadingDetail(false); }
  };

  // Arriving from an invoice notification tap → open that invoice, then clear the
  // App-level focus slot so a repeat tap of the SAME invoice re-opens it (a sticky
  // ref would swallow the second tap while this screen stays mounted).
  useEffect(() => {
    if (!focusInvoiceId) return;
    openInvoice(focusInvoiceId);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInvoiceId]);

  const refreshDetail = async () => {
    if (!detail) return;
    const res = await svc.fetchInvoice(detail.id);
    if (res?.status) setDetail(res.data);
  };

  const doAction = async (key, fn) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res?.status) { if (res.data) setDetail(res.data); else await refreshDetail(); flash('ok', 'Done'); }
      else flash('err', res?.message || 'Action failed.');
    } catch (e) { flash('err', 'Action failed.'); }
    finally { setBusy(null); }
  };

  const downloadPdf = async (id) => {
    setBusy('pdf');
    try {
      const res = await svc.fetchInvoicePdf(id);
      if (!res?.status || !res.data_b64) { flash('err', res?.message || 'Could not build the PDF.'); return; }
      const name = (res.file_name || 'Invoice.pdf').split(/[\\/]/).pop();

      const SAF = FileSystem.StorageAccessFramework;
      if (Platform.OS === 'android' && SAF) {
        // Ask WHERE to save first — nothing is written until a folder is chosen.
        const perm = await SAF.requestDirectoryPermissionsAsync();
        if (!perm.granted) { flash('err', 'Download cancelled — no folder chosen.'); return; }
        const dot = name.lastIndexOf('.');
        const bare = dot > 0 ? name.slice(0, dot) : name;   // SAF re-appends the ext from the mime
        const uri = await SAF.createFileAsync(perm.directoryUri, bare, 'application/pdf');
        await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
        flash('ok', `Saved ${name}`);
        return;
      }

      // iOS: the share sheet is where "Save to Files" lives.
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Save ${name}`, UTI: 'com.adobe.pdf' });
        flash('ok', `${name} ready`);
      } else {
        flash('err', 'Saving is not available on this device.');
      }
    } catch (e) { flash('err', 'Could not build the PDF.'); }
    finally { setBusy(null); }
  };

  // Share = the all-apps OS share sheet (send the PDF to WhatsApp/Gmail/etc.),
  // as opposed to Download which saves it to a chosen folder.
  const sharePdf = async (id) => {
    setBusy('share');
    log.info('share: start', { invoice: id });
    try {
      const res = await svc.fetchInvoicePdf(id);
      if (!res?.status || !res.data_b64) { flash('err', res?.message || 'Could not build the PDF.'); return; }
      const name = (res.file_name || 'Invoice.pdf').split(/[\\/]/).pop();
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Share ${name}`, UTI: 'com.adobe.pdf' });
        log.info('share: sheet opened', { name });
      } else {
        log.warn('share: unavailable');
        flash('err', 'Sharing is not available on this device.');
      }
    } catch (e) { log.warn('share failed', e?.message); flash('err', 'Could not share the PDF.'); }
    finally { setBusy(null); }
  };

  // Edit a line field (draft only) then refresh the detail.
  const saveLine = async (lineId, field, value) => {
    const r = await svc.saveInvoiceLine({ line_id: lineId, [field]: value });
    if (r?.status) refreshDetail(); else flash('err', r?.message || 'Could not save the line.');
  };
  const saveNotes = async (text) => {
    if (!detail) return;
    const r = await svc.saveInvoiceNotes(detail.id, text);
    if (!r?.status) flash('err', r?.message || 'Could not save notes.');
  };
  // Client (portal) "I've paid" — flags the claim server-side and notifies admins.
  const clientPaid = async (id) => {
    setBusy('claim');
    try {
      const r = await svc.clientMarkPaid(id);
      if (r?.status) { if (r.data) setDetail(r.data); flash('ok', "Thanks — we've told the team you've paid."); }
      else flash('err', r?.message || 'Could not send.');
    } catch (e) { flash('err', 'Could not send.'); }
    finally { setBusy(null); }
  };

  // Edit the invoice title / hourly rate (draft only). The route returns the
  // refreshed invoice, so the totals + per-line amounts update live.
  const saveHeader = async (field, value) => {
    if (!detail) return;
    const r = await svc.saveInvoiceHeader({ invoice_id: detail.id, [field]: value });
    if (r?.status && r.data) setDetail(r.data);
    else if (!r?.status) flash('err', r?.message || 'Could not save.');
  };

  // ── Create ──
  const startCreate = async () => {
    setMode('create');
    const r = presetRange('this_month');
    setCForm({
      clientId: false, clientName: '', title: '', preset: 'this_month',
      from: r.from, to: r.to, billing: 'hourly', rate: '0',
      priceReq: '0', priceUpt: '0', priceBug: '0',
      currencyId: false, currencyName: '', types: { REQ: true, UPT: true, BUG: true },
      subKras: [], users: [], kpis: [], filterSub: [], filterUser: [], filterKpi: [], creating: false,
    });
    try {
      const [f, c] = await Promise.all([svc.fetchInvoiceFilters(), svc.fetchInvoiceCurrencies()]);
      if (f?.status) setClients(f.clients || []);
      if (c?.status) setCurrencies(c.currencies || []);
    } catch (_) {}
  };

  // On client selection, load the optional after-client filters (sub-KRAs / devs / tasks).
  const onClientChange = async (id, label) => {
    setCForm((p) => ({ ...p, clientId: id, clientName: label, subKras: [], users: [], kpis: [], filterSub: [], filterUser: [], filterKpi: [] }));
    try {
      const [sk, uk] = await Promise.all([svc.fetchSubKras(id), svc.fetchClientUsersKpis(id, [])]);
      setCForm((p) => ({ ...p, subKras: sk?.sub_kras || [], users: uk?.users || [], kpis: uk?.kpis || [] }));
    } catch (_) {}
  };

  // Toggling a Sub-KRA re-scopes the Developers/Tasks lists (web _refreshScopeForSubKras)
  // and drops any now-stale developer/task picks.
  const onSubKraToggle = async (ids) => {
    const cid = cForm?.clientId;
    setCForm((p) => ({ ...p, filterSub: ids, filterUser: [], filterKpi: [] }));
    if (!cid) return;
    try {
      const uk = await svc.fetchClientUsersKpis(cid, ids);
      setCForm((p) => ({ ...p, users: uk?.users || [], kpis: uk?.kpis || [] }));
    } catch (_) {}
  };

  const submitCreate = async () => {
    if (!cForm.clientId) { flash('err', 'Choose a client.'); return; }
    const task_types = Object.keys(cForm.types).filter((k) => cForm.types[k]);
    if (!task_types.length) { flash('err', 'Pick at least one task type (REQ / UPT / BUG).'); return; }
    setCForm((p) => ({ ...p, creating: true }));
    const params = {
      client_kra_id: cForm.clientId, from_date: cForm.from, to_date: cForm.to,
      billing_method: cForm.billing, invoice_title: cForm.title || false,
      currency_id: cForm.currencyId || false, task_types,
      hourly_rate: parseFloat(cForm.rate) || 0,
      price_req: parseFloat(cForm.priceReq) || 0,
      price_upt: parseFloat(cForm.priceUpt) || 0,
      price_bug: parseFloat(cForm.priceBug) || 0,
      filter_sub_kra_ids: cForm.filterSub || [],
      filter_user_ids: cForm.filterUser || [],
      filter_kpi_ids: cForm.filterKpi || [],
    };
    try {
      const res = await svc.createInvoice(params);
      if (res?.status && res.invoice_id) {
        setDetail(res.data); setMode('detail');
        loadList('all');
      } else flash('err', res?.message || 'Could not create the invoice.');
    } catch (e) { flash('err', 'Could not create the invoice.'); }
    finally { setCForm((p) => (p ? { ...p, creating: false } : p)); }
  };

  // ═══════════════════════ RENDER ═══════════════════════
  const Header = ({ title, onLeft, right }) => (
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={onLeft} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
      {right || <View style={{ width: 40 }} />}
    </View>
  );

  const Banner = () => (!banner ? null : (
    <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
      <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
        color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
      <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
    </View>
  ));

  // ---- LIST ----
  if (mode === 'list') {
    return (
      <View style={s.root}>
        <GradientBackground />
        <Header title={portal ? 'Invoices' : 'Client Invoices'} onLeft={onBack}
          right={portal ? undefined : <TouchableOpacity onPress={startCreate} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}><Ionicons name="add" size={24} color={COLORS.primary} /></TouchableOpacity>} />
        <Banner />
        <View style={s.chipRow}>
          <FlatList
            horizontal showsHorizontalScrollIndicator={false} data={chips} keyExtractor={(c) => c.key}
            contentContainerStyle={{ paddingHorizontal: 14, gap: 8 }}
            renderItem={({ item }) => {
              const on = statusFilter === item.key;
              const n = counts[item.key];
              return (
                <TouchableOpacity style={[s.chip, on && s.chipOn]} onPress={() => { setStatusFilter(item.key); loadList(item.key); }} activeOpacity={0.85}>
                  <Text style={[s.chipTxt, on && s.chipTxtOn]}>{item.label}{n != null ? ` ${n}` : ''}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>
        {loadingList ? (
          <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
        ) : (
          <FlatList
            style={{ flex: 1 }}
            data={invoices} keyExtractor={(it) => String(it.id)}
            contentContainerStyle={invoices.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
            renderItem={({ item }) => (
              <View style={s.card}>
                <TouchableOpacity onPress={() => openInvoice(item.id)} activeOpacity={0.85}>
                  <View style={s.cardTop}>
                    <Text style={s.invName}>{item.name}</Text>
                    <View style={[s.stateBadge, { backgroundColor: (STATE_COLOR[item.state] || '#64748B') + '22' }]}>
                      <Text style={[s.stateTxt, { color: STATE_COLOR[item.state] || '#64748B' }]}>{item.state}</Text>
                    </View>
                  </View>
                  <Text style={s.invClient} numberOfLines={1}>{item.parent_name ? `${item.parent_name} · ` : ''}{item.client_name}</Text>
                  <Text style={s.invPeriod}>{item.from_date} → {item.to_date} · {item.invoice_date}</Text>
                  <View style={s.hrsRow}>
                    <Text style={s.hrsCell}>Quoted <Text style={s.hrsVal}>{item.total_quoted_hours}h</Text></Text>
                    <Text style={s.hrsCell}>Adjust <Text style={s.hrsVal}>{item.total_adjusted_hours}h</Text></Text>
                    <Text style={s.hrsCell}>Total <Text style={s.hrsVal}>{item.grand_total_hours}h</Text></Text>
                    {item.state !== 'draft' ? (
                      <View style={[s.payBadge, { backgroundColor: item.payment_status === 'paid' ? '#DCFCE7' : '#FEF3C7' }]}>
                        <Text style={[s.payTxt, { color: item.payment_status === 'paid' ? '#16A34A' : '#D97706' }]}>{item.payment_status === 'paid' ? 'PAID' : 'DUE'}</Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
                <View style={s.rowActions}>
                  <TouchableOpacity style={s.rowBtn} onPress={() => openInvoice(item.id)} activeOpacity={0.85}>
                    <Ionicons name="eye-outline" size={14} color={COLORS.primary} /><Text style={s.rowBtnTxt}>Open</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.rowBtn} onPress={() => downloadPdf(item.id)} activeOpacity={0.85}>
                    <Ionicons name="download-outline" size={14} color={COLORS.primary} /><Text style={s.rowBtnTxt}>PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.rowBtn} onPress={() => sharePdf(item.id)} activeOpacity={0.85}>
                    <Ionicons name="share-social-outline" size={14} color={COLORS.primary} /><Text style={s.rowBtnTxt}>Share</Text>
                  </TouchableOpacity>
                  {!portal && item.state !== 'draft' && item.payment_status !== 'paid' ? (
                    <TouchableOpacity style={[s.rowBtn, s.rowBtnPaid]} onPress={() => openMarkPaidList(item, true)} activeOpacity={0.85}>
                      <Ionicons name="checkmark-circle-outline" size={14} color="#fff" /><Text style={[s.rowBtnTxt, { color: '#fff' }]}>Mark Paid</Text>
                    </TouchableOpacity>
                  ) : null}
                  {!portal && item.state !== 'draft' && item.payment_status === 'paid' ? (
                    <TouchableOpacity style={s.rowBtn} onPress={() => openMarkPaidList(item, false)} activeOpacity={0.85}>
                      <Ionicons name="arrow-undo-outline" size={14} color={COLORS.muted} /><Text style={[s.rowBtnTxt, { color: COLORS.muted }]}>Revert</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            )}
            ListEmptyComponent={
              <View style={s.emptyBox}>
                <Ionicons name="receipt-outline" size={40} color={COLORS.faint} />
                <Text style={s.emptyTitle}>No invoices</Text>
                <Text style={s.emptySub}>{portal ? 'Your invoices will appear here once they are ready.' : 'Tap + to create one.'}</Text>
              </View>
            }
          />
        )}
        {renderPickModal()}
        {renderPromptModal()}
      </View>
    );
  }

  // ---- DETAIL ----
  if (mode === 'detail') {
    const d = detail;
    const cur = d?.currency || (currencies.find((c) => c.id === d?.currency_id)) || null;
    const isDraft = d?.state === 'draft';
    const perTask = d?.billing_method === 'per_task';
    const headBadge = d && (isDraft
      ? { txt: 'Draft', color: '#64748B' }
      : (d.payment_status === 'paid' ? { txt: 'Paid', color: COLORS.green } : { txt: 'Unpaid', color: COLORS.red }));
    return (
      <View style={s.root}>
        <GradientBackground />
        <Header title={d?.name || 'Invoice'} onLeft={() => { setMode('list'); loadList(statusFilter); }} />
        <Banner />
        {loadingDetail || !d ? (
          <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <View style={s.card}>
              <View style={s.cardTop}>
                <Text style={s.invName}>{d.name}</Text>
                {headBadge ? (
                  <View style={[s.stateBadge, { backgroundColor: headBadge.color + '22' }]}>
                    <Text style={[s.stateTxt, { color: headBadge.color }]}>{headBadge.txt}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={s.invClient}>{d.parent_name ? `${d.parent_name} · ` : ''}{d.client_name}</Text>
              <Text style={s.invPeriod}>Period {d.from_date} → {d.to_date} · Dated {d.invoice_date}</Text>
              <View style={s.statusRow}>
                <Text style={s.miniLbl}>Status</Text>
                <View style={[s.stateBadge, { backgroundColor: (STATE_COLOR[d.state] || '#64748B') + '22' }]}>
                  <Text style={[s.stateTxt, { color: STATE_COLOR[d.state] || '#64748B' }]}>{d.state}</Text>
                </View>
                {d.payment_status === 'paid' && d.paid_by_name ? <Text style={s.paidBy}>Paid · {d.paid_by_name}</Text> : null}
              </View>
              {!portal && d.client_paid_claim && d.payment_status !== 'paid' ? (
                <View style={s.claimHint}>
                  <Ionicons name="cash-outline" size={13} color="#B45309" />
                  <Text style={s.claimHintTxt}>Client marked this as paid{d.client_paid_claim_date ? ` on ${d.client_paid_claim_date}` : ''} — confirm with Mark Paid.</Text>
                </View>
              ) : null}
              <View style={s.showAmtRow}>
                <Text style={s.miniLbl}>Show amounts</Text>
                <Switch value={showAmounts} onValueChange={setShowAmounts} trackColor={{ true: COLORS.primary }} />
              </View>
            </View>

            {/* Editable header (draft) / read-only summary */}
            {isDraft ? (
              <View style={s.card}>
                <Text style={s.fLbl}>Invoice Title</Text>
                <TextInput style={s.input} defaultValue={d.invoice_title || ''} placeholder="e.g. Monthly Services - May 2026" placeholderTextColor={COLORS.faint}
                  onEndEditing={(e) => saveHeader('invoice_title', e.nativeEvent.text)} />
                {!perTask && showAmounts ? (
                  <>
                    <Text style={[s.fLbl, { marginTop: 12 }]}>Hourly Rate <Text style={s.miniInline}>(0 = time-only)</Text></Text>
                    <TextInput style={[s.input, { width: 150 }]} keyboardType="decimal-pad" defaultValue={String(d.hourly_rate ?? 0)}
                      onEndEditing={(e) => saveHeader('hourly_rate', parseFloat(e.nativeEvent.text) || 0)} />
                  </>
                ) : null}
              </View>
            ) : ((d.invoice_title || (d.hourly_rate > 0 && showAmounts)) ? (
              <View style={s.card}>
                {d.invoice_title ? <Text style={s.roText}>Title: <Text style={s.roVal}>{d.invoice_title}</Text></Text> : null}
                {d.hourly_rate > 0 && showAmounts ? <Text style={s.roText}>Rate: <Text style={s.roVal}>{Number(d.hourly_rate).toFixed(2)} / hour</Text></Text> : null}
              </View>
            ) : null)}

            {/* Totals strip */}
            <View style={s.totalsStrip}>
              <View style={s.totCard}><Text style={s.totCardLbl}>Project Quoted (KRA)</Text><Text style={s.totCardVal}>{d.project_quoted_hours ?? 0}h</Text></View>
              <View style={s.totCard}><Text style={s.totCardLbl}>Sum of KPI Quoted</Text><Text style={s.totCardVal}>{d.total_quoted_hours}h</Text></View>
              <View style={s.totCard}><Text style={s.totCardLbl}>Sum of Actual</Text><Text style={s.totCardVal}>{d.total_actual_hours}h</Text></View>
              <View style={[s.totCard, s.totCardMain]}>
                <Text style={s.totCardLbl}>Grand Total (Bill)</Text>
                <Text style={s.totCardVal}>{d.grand_total_hours}h</Text>
                {showAmounts ? <Text style={s.totCardAmt}>Amount: {money(d.total_amount, cur)}</Text> : null}
              </View>
            </View>

            {/* Lines */}
            <View style={s.lineHeadRow}>
              <Text style={s.sectionLbl}>Invoice Lines ({(d.lines || []).length})</Text>
              {isDraft ? (
                <TouchableOpacity style={s.addAdjBtn} onPress={openAddAdjustment} activeOpacity={0.85}>
                  <Ionicons name="add" size={14} color={COLORS.primary} /><Text style={s.addAdjTxt}>Add Adjustment</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {isDraft && showAmounts ? (
              <View style={s.infoAlert}>
                <Ionicons name="information-circle-outline" size={15} color={COLORS.primary} />
                <Text style={s.infoAlertTxt}>{perTask
                  ? 'Set a Price for each task below — it saves as you go and the total updates live.'
                  : 'Set the Hours for each task — Amount = hours × rate, and the total updates live.'}</Text>
              </View>
            ) : null}
            {(d.lines || []).map((l) => {
              const locked = !!l.already_invoiced;
              const amount = (Number(l.quoted_hours) || 0) * (Number(d.hourly_rate) || 0);
              return (
                <View key={l.id} style={[s.lineCard, locked && s.lineLockedCard]}>
                  <View style={s.lineTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.lineType}>{l.line_type === 'adjustment' ? 'ADJUSTMENT' : (perTask ? (l.task_kind || 'TASK').toUpperCase() : 'KPI')}</Text>
                      <Text style={s.lineDesc} numberOfLines={2}>{l.description}</Text>
                    </View>
                    {isDraft && l.line_type === 'adjustment' ? (
                      <TouchableOpacity onPress={() => confirmRemoveLine(l)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="trash-outline" size={16} color={COLORS.red} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <View style={s.lineMetaRow}>
                    {perTask ? (
                      isDraft && showAmounts && !locked ? (
                        <View style={s.lineEdit}>
                          <Text style={s.lineMeta}>Price </Text>
                          <TextInput style={s.lineInput} keyboardType="decimal-pad" defaultValue={String(l.unit_price ?? 0)}
                            onEndEditing={(e) => saveLine(l.id, 'unit_price', parseFloat(e.nativeEvent.text) || 0)} />
                        </View>
                      ) : (showAmounts ? <Text style={s.lineMeta}>Price {money(l.unit_price, cur)}</Text> : <Text style={s.lineMeta}> </Text>)
                    ) : (
                      isDraft && !locked ? (
                        <View style={s.lineEdit}>
                          <Text style={s.lineMeta}>Quoted </Text>
                          <TextInput style={s.lineInput} keyboardType="decimal-pad" defaultValue={String(l.quoted_hours ?? 0)}
                            onEndEditing={(e) => saveLine(l.id, 'quoted_hours', parseFloat(e.nativeEvent.text) || 0)} />
                          <Text style={s.lineMeta}> h · Actual {l.actual_hours}h</Text>
                        </View>
                      ) : (
                        <Text style={s.lineMeta}>Quoted {l.quoted_hours}h · Actual {l.actual_hours}h</Text>
                      )
                    )}
                    {!perTask && showAmounts ? <Text style={s.lineAmt}>{money(amount, cur)}</Text> : null}
                  </View>
                  {locked ? (
                    <View style={s.lockRow}><Ionicons name="lock-closed" size={11} color={COLORS.red} /><Text style={s.lineLocked}>Billed on {l.invoiced_on}</Text></View>
                  ) : null}
                </View>
              );
            })}
            {(d.lines || []).length === 0 ? <Text style={s.noLines}>No lines yet.</Text> : null}

            {/* Notes */}
            <Text style={[s.sectionLbl, { marginTop: 4 }]}>Overall Notes</Text>
            {isDraft ? (
              <TextInput style={s.notesInput} multiline defaultValue={stripHtml(d.notes)} placeholder="Overall notes…" placeholderTextColor={COLORS.faint}
                onEndEditing={(e) => saveNotes(e.nativeEvent.text)} />
            ) : (
              <View style={s.notesBox}><Text style={s.notesTxt}>{stripHtml(d.notes) || '(no notes)'}</Text></View>
            )}

            {/* Workflow + actions */}
            <View style={s.actionsWrap}>
              {!portal && isDraft ? (
                <ActBtn label="Finalize" icon="lock-closed-outline" busy={busy === 'finalize'} onPress={() => doAction('finalize', () => svc.finalizeInvoice(d.id))} primary />
              ) : null}
              {!portal && d.state === 'finalized' ? (
                <ActBtn label="Mark Sent" icon="send-outline" busy={busy === 'send'} onPress={() => doAction('send', () => svc.sendInvoice(d.id))} primary />
              ) : null}
              {!portal && d.state === 'finalized' && d.payment_status !== 'paid' ? (
                <ActBtn label="Reset to Draft" icon="arrow-undo-outline" busy={busy === 'reset'} onPress={() => doAction('reset', () => svc.resetInvoiceDraft(d.id))} />
              ) : null}
              {portal && d.payment_status !== 'paid' ? (
                d.client_paid_claim
                  ? <ActBtn label="Payment claim sent" icon="checkmark-done-outline" onPress={() => {}} />
                  : <ActBtn label="I've paid" icon="cash-outline" busy={busy === 'claim'} onPress={() => clientPaid(d.id)} primary />
              ) : null}
              <ActBtn label="Download PDF" icon="document-text-outline" busy={busy === 'pdf'} onPress={() => downloadPdf(d.id)} />
              <ActBtn label="Share" icon="share-social-outline" busy={busy === 'share'} onPress={() => sharePdf(d.id)} />
            </View>
          </ScrollView>
        )}
        {renderPickModal()}
        {renderPromptModal()}
      </View>
    );
  }

  // ---- CREATE ----
  const f = cForm || {};
  return (
    <View style={s.root}>
      <GradientBackground />
      <Header title="New Invoice" onLeft={() => setMode('list')} />
      <Banner />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.fLbl}>Client</Text>
          <TouchableOpacity style={s.select} activeOpacity={0.8}
            onPress={() => setPick({ title: 'Select client', current: f.clientId, options: clients.map((c) => ({ value: c.id, label: c.parent_name ? `${c.parent_name} > ${c.name}` : c.name })), onPick: (v, label) => onClientChange(v, label) })}>
            <Text style={s.selectTxt} numberOfLines={1}>{f.clientName || '-- Select Client --'}</Text>
            <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
          </TouchableOpacity>

          <Text style={[s.fLbl, { marginTop: 14 }]}>Invoice Title (optional)</Text>
          <TextInput style={s.input} value={f.title} onChangeText={(t) => setCForm((p) => ({ ...p, title: t }))} placeholder="e.g. Monthly Services - May 2026" placeholderTextColor={COLORS.faint} />

          <Text style={[s.fLbl, { marginTop: 14 }]}>Period</Text>
          <View style={s.pillWrap}>
            {PRESETS.map((p) => (
              <TouchableOpacity key={p.key} style={[s.pill, f.preset === p.key && s.pillOn]} onPress={() => { const r = presetRange(p.key); setCForm((x) => ({ ...x, preset: p.key, from: r.from, to: r.to })); }} activeOpacity={0.85}>
                <Text style={[s.pillTxt, f.preset === p.key && s.pillTxtOn]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.dateRow}>
            <View style={{ flex: 1 }}><Text style={s.miniLbl}>From</Text><TextInput style={s.input} value={f.from} onChangeText={(t) => setCForm((p) => ({ ...p, preset: 'custom', from: t }))} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.faint} /></View>
            <View style={{ flex: 1 }}><Text style={s.miniLbl}>To</Text><TextInput style={s.input} value={f.to} onChangeText={(t) => setCForm((p) => ({ ...p, preset: 'custom', to: t }))} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.faint} /></View>
          </View>

          <Text style={[s.fLbl, { marginTop: 14 }]}>Billing method</Text>
          <View style={s.toggle}>
            <TouchableOpacity style={[s.toggleBtn, f.billing === 'hourly' && s.toggleOn]} onPress={() => setCForm((p) => ({ ...p, billing: 'hourly' }))} activeOpacity={0.85}><Text style={[s.toggleTxt, f.billing === 'hourly' && s.toggleTxtOn]}>Per Hour</Text></TouchableOpacity>
            <TouchableOpacity style={[s.toggleBtn, f.billing === 'per_task' && s.toggleOn]} onPress={() => setCForm((p) => ({ ...p, billing: 'per_task' }))} activeOpacity={0.85}><Text style={[s.toggleTxt, f.billing === 'per_task' && s.toggleTxtOn]}>Per Task</Text></TouchableOpacity>
          </View>

          {f.billing === 'hourly' ? (
            <>
              <Text style={[s.fLbl, { marginTop: 14 }]}>Per Hour Rate (0 = time-only)</Text>
              <TextInput style={[s.input, { width: 130 }]} keyboardType="decimal-pad" value={f.rate} onChangeText={(t) => setCForm((p) => ({ ...p, rate: t }))} />
            </>
          ) : (
            <View style={s.priceRow}>
              {[['REQ', 'priceReq'], ['UPT', 'priceUpt'], ['BUG', 'priceBug']].map(([lbl, key]) => (
                <View key={key} style={{ flex: 1 }}>
                  <Text style={s.miniLbl}>{lbl} price</Text>
                  <TextInput style={s.input} keyboardType="decimal-pad" value={f[key]} onChangeText={(t) => setCForm((p) => ({ ...p, [key]: t }))} />
                </View>
              ))}
            </View>
          )}

          <Text style={[s.fLbl, { marginTop: 14 }]}>Currency</Text>
          <TouchableOpacity style={s.select} activeOpacity={0.8}
            onPress={() => setPick({ title: 'Currency', current: f.currencyId, options: [{ value: false, label: '-- default --' }, ...currencies.map((c) => ({ value: c.id, label: `${c.name}${c.symbol ? ` (${c.symbol})` : ''}` }))], onPick: (v, label) => setCForm((p) => ({ ...p, currencyId: v || false, currencyName: v ? label : '' })) })}>
            <Text style={s.selectTxt}>{f.currencyName || '-- default --'}</Text>
            <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
          </TouchableOpacity>

          {f.billing === 'per_task' ? (
            <View style={s.infoAlert}>
              <Ionicons name="information-circle-outline" size={16} color={COLORS.primary} />
              <Text style={s.infoAlertTxt}>After you click Create Invoice, you'll set a price for each task individually in the invoice.</Text>
            </View>
          ) : null}

          <Text style={[s.fLbl, { marginTop: 14 }]}>Include Task Types</Text>
          {TASK_TYPES.map((tt) => {
            const on = !!f.types?.[tt.key];
            return (
              <TouchableOpacity key={tt.key} style={s.typeRow} onPress={() => setCForm((p) => ({ ...p, types: { ...p.types, [tt.key]: !p.types[tt.key] } }))} activeOpacity={0.85}>
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? COLORS.primary : COLORS.faint} />
                <View style={[s.typeTag, { backgroundColor: TYPE_COLOR[tt.key] }]}><Text style={s.typeTagTxt}>{tt.key}</Text></View>
                <Text style={s.typeLbl}>{tt.label}</Text>
              </TouchableOpacity>
            );
          })}

          {(f.subKras?.length || f.users?.length || f.kpis?.length) ? (
            <View style={{ marginTop: 4 }}>
              {f.subKras?.length ? (
                <CheckList label="Filter: Sub-KRA / Project" help="(optional — leave empty to invoice the whole client)"
                  items={f.subKras} sel={f.filterSub} onToggle={onSubKraToggle} />
              ) : null}
              {f.users?.length ? (
                <CheckList label="Filter: Developers" help="(optional — leave empty for all)"
                  items={f.users} sel={f.filterUser} onToggle={(ids) => setCForm((p) => ({ ...p, filterUser: ids }))} />
              ) : null}
              {f.kpis?.length ? (
                <CheckList label="Filter: Tasks" help="(optional — leave empty for all)"
                  items={f.kpis.map((k) => ({ id: k.id, name: k.kra_name ? `${k.name} (${k.kra_name})` : k.name }))}
                  sel={f.filterKpi} onToggle={(ids) => setCForm((p) => ({ ...p, filterKpi: ids }))} />
              ) : null}
            </View>
          ) : null}

          <TouchableOpacity style={[s.createBtn, f.creating && { opacity: 0.6 }]} onPress={submitCreate} disabled={f.creating} activeOpacity={0.9}>
            {f.creating ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.createTxt}>Create Invoice</Text></>}
          </TouchableOpacity>
        </View>
      </ScrollView>
      {renderPickModal()}
    </View>
  );

  // ── helpers using closures ──
  function confirmRemoveLine(l) {
    Alert.alert('Remove line', `Remove "${l.description}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { const r = await svc.removeInvoiceLine(l.id); if (r?.status) refreshDetail(); else Alert.alert('Invoice', r?.message || 'Could not remove.'); } },
    ]);
  }
  function openAddAdjustment() {
    setPrompt({
      title: 'Add adjustment', fields: [{ key: 'description', label: 'Description', val: '' }, { key: 'quoted_hours', label: 'Hours', val: '0', numeric: true }],
      onOk: async (vals) => {
        const r = await svc.addAdjustment({ invoice_id: detail.id, description: vals.description || 'Adjustment', quoted_hours: parseFloat(vals.quoted_hours) || 0 });
        if (r?.status) refreshDetail(); else Alert.alert('Invoice', r?.message || 'Could not add.');
      },
    });
  }
  function openMarkPaid(d, paid) {
    setPrompt({
      title: paid ? 'Mark paid' : 'Mark unpaid', fields: [{ key: 'note', label: 'Note (optional)', val: '' }],
      onOk: async (vals) => { doAction(paid ? 'paid' : 'unpaid', () => svc.markInvoicePaid(d.id, paid, vals.note || '')); },
    });
  }
  // Mark paid/unpaid straight from a list row (refreshes the list, not a detail).
  function openMarkPaidList(inv, paid) {
    setPrompt({
      title: paid ? 'Mark paid' : 'Mark unpaid', fields: [{ key: 'note', label: 'Note (optional)', val: '' }],
      onOk: async (vals) => {
        const r = await svc.markInvoicePaid(inv.id, paid, vals.note || '');
        if (r?.status) { flash('ok', paid ? 'Marked paid' : 'Marked unpaid'); loadList(statusFilter); }
        else flash('err', r?.message || 'Action failed.');
      },
    });
  }
  function renderPickModal() {
    return (
      <Modal visible={!!pick} transparent animationType="fade" onRequestClose={() => setPick(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPick(null)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>{pick?.title || 'Select'}</Text>
              <TouchableOpacity onPress={() => setPick(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={s.modalClose}>✕</Text></TouchableOpacity>
            </View>
            <FlatList
              data={pick?.options || []} keyExtractor={(o) => String(o.value)} keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = item.value === pick.current;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} activeOpacity={0.8}
                    onPress={() => { const fn = pick.onPick; setPick(null); if (fn) fn(item.value, item.label); }}>
                    <Text style={s.ccRowName}>{item.label}</Text>
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    );
  }
  function renderPromptModal() {
    if (!prompt) return null;
    return <PromptModal prompt={prompt} onClose={() => setPrompt(null)} />;
  }
}

function ActBtn({ label, icon, onPress, busy, primary }) {
  return (
    <TouchableOpacity style={[s.actBtn, primary && s.actBtnPrimary]} onPress={onPress} disabled={busy} activeOpacity={0.88}>
      {busy ? <ActivityIndicator size="small" color={primary ? '#fff' : COLORS.primary} />
        : <Ionicons name={icon} size={16} color={primary ? '#fff' : COLORS.primary} />}
      <Text style={[s.actTxt, primary && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// A labeled list of toggleable rows for the optional after-client filters.
function CheckList({ label, help, items, sel, onToggle }) {
  const set = new Set(sel || []);
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={s.filterLbl}>{label}{help ? <Text style={s.filterHelp}>  {help}</Text> : null}</Text>
      {(items || []).map((it) => {
        const on = set.has(it.id);
        return (
          <TouchableOpacity key={it.id} style={s.checkRow} activeOpacity={0.85}
            onPress={() => { const n = new Set(set); on ? n.delete(it.id) : n.add(it.id); onToggle([...n]); }}>
            <Ionicons name={on ? 'checkbox' : 'square-outline'} size={18} color={on ? COLORS.primary : COLORS.faint} />
            <Text style={s.checkTxt} numberOfLines={1}>{it.name}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function PromptModal({ prompt, onClose }) {
  const [vals, setVals] = useState(() => {
    const o = {}; (prompt.fields || []).forEach((fld) => { o[fld.key] = fld.val || ''; }); return o;
  });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={[s.modalSheet, { padding: 18 }]}>
          <Text style={[s.modalTitle, { marginBottom: 12 }]}>{prompt.title}</Text>
          {(prompt.fields || []).map((fld) => (
            <View key={fld.key} style={{ marginBottom: 10 }}>
              <Text style={s.miniLbl}>{fld.label}</Text>
              <TextInput
                style={s.input} value={vals[fld.key]} keyboardType={fld.numeric ? 'decimal-pad' : 'default'}
                onChangeText={(t) => setVals((p) => ({ ...p, [fld.key]: t }))}
              />
            </View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 6 }}>
            <TouchableOpacity onPress={onClose}><Text style={s.promptCancel}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { const fn = prompt.onOk; onClose(); if (fn) fn(vals); }}><Text style={s.promptOk}>OK</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy, marginHorizontal: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: COLORS.greenBg, borderColor: '#A7F3D0' },
  bannerErr: { backgroundColor: COLORS.redBg, borderColor: '#FCA5A5' },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },

  hrsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  hrsCell: { fontSize: 11.5, color: COLORS.faint, fontWeight: '700' },
  hrsVal: { color: COLORS.ink, fontWeight: '900' },

  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, borderTopWidth: 1, borderTopColor: '#F1F4F9', paddingTop: 10 },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  rowBtnTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary },
  rowBtnPaid: { backgroundColor: COLORS.green, borderColor: COLORS.green },

  showAmtRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, borderTopWidth: 1, borderTopColor: '#F1F4F9', paddingTop: 10 },

  totalsStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  totCard: { flexGrow: 1, minWidth: '46%', backgroundColor: '#F8FAFC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 12, paddingHorizontal: 12 },
  totCardMain: { backgroundColor: '#EEF2FF', borderColor: '#C7D2FE' },
  totCardLbl: { fontSize: 11, fontWeight: '700', color: COLORS.muted },
  totCardVal: { fontSize: 18, fontWeight: '900', color: COLORS.ink, marginTop: 3 },
  totCardAmt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary, marginTop: 2 },

  lineType: { fontSize: 10, fontWeight: '900', color: COLORS.faint, letterSpacing: 0.5, marginBottom: 3 },
  lineEdit: { flexDirection: 'row', alignItems: 'center' },
  lineInput: { minWidth: 56, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12.5, color: COLORS.ink, backgroundColor: '#fff' },
  lineAmt: { fontSize: 13, fontWeight: '900', color: COLORS.ink },

  notesInput: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, minHeight: 80, padding: 12, fontSize: 13.5, color: COLORS.ink, backgroundColor: '#fff', textAlignVertical: 'top', marginBottom: 14 },
  notesBox: { backgroundColor: '#F8FAFC', borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, padding: 12, marginBottom: 14 },
  notesTxt: { fontSize: 13, color: COLORS.muted },

  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  typeTag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  typeTagTxt: { fontSize: 10.5, fontWeight: '900', color: '#fff' },
  typeLbl: { fontSize: 13.5, fontWeight: '700', color: COLORS.ink },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 6 },
  checkTxt: { flex: 1, fontSize: 13, color: COLORS.muted, fontWeight: '600' },

  chipRow: { paddingBottom: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipTxt: { fontSize: 12, fontWeight: '700', color: COLORS.muted },
  chipTxtOn: { color: '#fff' },

  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  emptyBox: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: COLORS.muted },
  emptySub: { fontSize: 12.5, color: COLORS.faint },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: COLORS.line, ...SHADOW },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  invName: { fontSize: 15.5, fontWeight: '900', color: COLORS.ink },
  invTitle: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginTop: 4 },
  invClient: { fontSize: 13, color: COLORS.muted, fontWeight: '700', marginTop: 5 },
  invPeriod: { fontSize: 11.5, color: COLORS.faint, marginTop: 4 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  stateBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  stateTxt: { fontSize: 11, fontWeight: '900', textTransform: 'capitalize' },
  payBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  payTxt: { fontSize: 10.5, fontWeight: '900' },

  sectionLbl: { fontSize: 12, fontWeight: '800', color: COLORS.muted, marginBottom: 8, marginLeft: 2 },
  lineCard: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, padding: 11, marginBottom: 8 },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  lineDesc: { flex: 1, fontSize: 13.5, fontWeight: '700', color: COLORS.ink },
  lineMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  lineMeta: { fontSize: 12, color: COLORS.muted },
  lineLocked: { fontSize: 11, color: COLORS.red, marginTop: 4 },
  addLineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: COLORS.line, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 10, marginBottom: 12 },
  addLineTxt: { fontSize: 13, fontWeight: '800', color: COLORS.primary },

  totalsCard: { backgroundColor: '#F8FAFC', borderRadius: 12, padding: 14, marginBottom: 14 },
  totLine: { fontSize: 13.5, color: COLORS.muted, fontWeight: '700', textAlign: 'right', marginTop: 2 },
  totVal: { color: COLORS.ink, fontWeight: '900', fontSize: 15 },

  actionsWrap: { gap: 10 },
  actBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 12, paddingVertical: 12, backgroundColor: '#fff' },
  actBtnPrimary: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  actTxt: { fontSize: 14, fontWeight: '800', color: COLORS.primary },

  // create
  fLbl: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  miniLbl: { fontSize: 11, fontWeight: '700', color: COLORS.muted, marginBottom: 5 },
  filterLbl: { fontSize: 12.5, fontWeight: '800', color: COLORS.ink, marginBottom: 4 },
  filterHelp: { fontSize: 10.5, fontWeight: '600', color: COLORS.faint },
  infoAlert: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 14, padding: 11, borderRadius: 10, backgroundColor: '#EEF2FF', borderWidth: 1, borderColor: '#C7D2FE' },
  infoAlertTxt: { flex: 1, fontSize: 12, fontWeight: '600', color: COLORS.primaryDark, lineHeight: 17 },
  input: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 44, paddingHorizontal: 12, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff' },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 46, backgroundColor: '#fff' },
  selectTxt: { flex: 1, fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  pillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pillTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted },
  pillTxtOn: { color: '#fff' },
  dateRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  toggle: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, overflow: 'hidden', alignSelf: 'flex-start' },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 9, backgroundColor: '#fff' },
  toggleOn: { backgroundColor: COLORS.primary },
  toggleTxt: { fontSize: 13, fontWeight: '800', color: COLORS.muted },
  toggleTxtOn: { color: '#fff' },
  priceRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, marginTop: 20 },
  createTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  paidBy: { fontSize: 11, fontWeight: '700', color: COLORS.green },
  claimHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: 9, borderRadius: 9, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D' },
  claimHintTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: '#92400E', lineHeight: 16 },
  miniInline: { fontSize: 11, fontWeight: '600', color: COLORS.faint },
  roText: { fontSize: 13, color: COLORS.muted, marginBottom: 3 },
  roVal: { color: COLORS.ink, fontWeight: '800' },
  lineHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addAdjBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, borderWidth: 1, borderColor: COLORS.primary, backgroundColor: '#fff', marginBottom: 8 },
  addAdjTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary },
  lineLockedCard: { backgroundColor: '#FEF2F2', borderColor: '#FCA5A5' },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  noLines: { fontSize: 13, color: COLORS.faint, textAlign: 'center', paddingVertical: 16 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  modalSheet: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 20, maxHeight: '70%', paddingBottom: 12, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  ccRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },
  promptCancel: { fontSize: 15, fontWeight: '700', color: COLORS.muted },
  promptOk: { fontSize: 15, fontWeight: '900', color: COLORS.primary },
});
