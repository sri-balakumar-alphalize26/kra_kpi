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
import DateGridModal from '../components/DateGridModal';
import { createLogger } from '../api/logger';
import * as svc from '../services/clientInvoices';
import { fmtYMD as fmt } from '../utils/dateGrid';

const log = createLogger('ClientInvoices');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// `claimed` is its own filter, not a shade of `due`: the server's `due` domain is
// state in (finalized,sent) AND unpaid AND client_paid_claim = False, so it
// deliberately EXCLUDES claims. Without this chip a claimed invoice reached no
// payment filter at all — it sat under All and its state chip, and the one list an
// admin opens to find work waiting on them was the one list that never showed it.
const CHIPS = [
  { key: 'all', label: 'All' }, { key: 'draft', label: 'Draft' },
  { key: 'finalized', label: 'Finalized' }, { key: 'sent', label: 'Sent' },
  { key: 'due', label: 'Payment Due' }, { key: 'claimed', label: 'Payment Claimed' },
  { key: 'paid', label: 'Paid' },
];
// Client (portal) chips — no draft/finalized/sent internals; the server record
// rule already limits a client to their own finalized/sent invoices. The client
// needs the claim filter too: once they have reported paying, "Unpaid" no longer
// contains their invoice and they would otherwise think it had gone missing.
const PORTAL_CHIPS = [
  { key: 'all', label: 'All' }, { key: 'due', label: 'Unpaid' },
  { key: 'claimed', label: 'Claimed' }, { key: 'paid', label: 'Paid' },
];
const STATE_COLOR = { draft: '#64748B', finalized: '#2563EB', sent: '#16A34A' };

// Why a task cannot be billed yet, coloured by the server's coarse grouping so
// "the client still has to sign this off" reads differently from "we are still
// working on it". Collapsing the two is what made merely-unstarted work look
// like it was sitting on the client's desk.
//   signoff  — really is the client's move
//   progress — the team is still working on it
//   invoiced — settled, already on an invoice
const BLOCK_BG = { signoff: '#FEF3C7', progress: '#DBEAFE', invoiced: '#F1F5F9' };
const BLOCK_FG = { signoff: '#92400E', progress: '#1D4ED8', invoiced: '#64748B' };

// Client picker rows, grouped the way the web's clientGroups() groups them
// (kpi_client_invoice.js) — the clients you can invoice today must not be buried
// among ones with nothing outstanding. /kpi_client_invoice/get_filters has always
// sent the tallies; the app listed name only, so ninety clients read as ninety
// identical lines and the APITEST fixtures made that literal.
//
// Same three buckets and the same order as the web, so the two clients cannot sort
// the same data differently. Headings are inert rows rather than styled options,
// which is what optgroup gives the web for free.
const CLIENT_GROUPS = [
  { key: 'ready', label: 'Ready to bill', match: (c) => (c.billable_count || 0) > 0 },
  { key: 'done', label: 'Nothing left to bill', match: (c) => !(c.billable_count || 0) && (c.task_count || 0) > 0 },
  { key: 'empty', label: 'No tasks yet', match: (c) => !(c.task_count || 0) },
];

// The second line under a client's name. `has_client_user === false` means nobody
// can sign that client's work off, so an invoice for them can only ever be empty —
// the web says so in the dropdown deliberately, to make it visible BEFORE picking
// rather than after creating. Checked against false explicitly, so a server that
// stops sending the field says nothing instead of accusing every client.
function clientMeta(c) {
  const bits = [];
  if (c.billable_count) bits.push(`${c.billable_count} to bill`);
  else if (c.invoiced_count) bits.push('all invoiced');
  if (c.has_client_user === false) bits.push('no client user assigned');
  return bits.join(' · ');
}

function clientPickOptions(clients) {
  const out = [];
  for (const g of CLIENT_GROUPS) {
    const rows = (clients || []).filter(g.match);
    if (!rows.length) continue;
    out.push({ header: true, key: `h:${g.key}`, label: `${g.label} (${rows.length})` });
    for (const c of rows) {
      out.push({
        value: c.id,
        // parent_name > name, matching the web. Level-2 nodes are projects and
        // belong to the Sub-KRA filter, so in practice only a nested client shows
        // the prefix — but when it does, it is the only thing telling two
        // same-named clients apart.
        label: c.parent_name ? `${c.parent_name} > ${c.name}` : c.name,
        meta: clientMeta(c),
      });
    }
  }
  return out;
}
// 'all' leads, and is the default, exactly as the web has it. A month window is
// the wrong default for invoicing: work becomes billable only once the client signs
// it off, which is routinely after the month it was done in — so "This Month"
// showed nothing to bill for clients who had plenty.
const PRESETS = [
  { key: 'all', label: 'All unbilled' },
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

function presetRange(key) {
  const now = new Date();
  const sod = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  // Everything the client has signed off and nobody has billed yet. The web's
  // default, and the reason it finds work where a month window finds none: signed
  // work is usually older than the current month by the time it is billable.
  if (key === 'all') return { from: '2000-01-01', to: '2099-12-31' };
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
// Mirrors the web's _typeAllowed() and, through it, the server's _populate rule:
// the ticks match the external_ref PREFIX. All three ticked sends no filter at
// all, so anything with an odd or missing prefix still passes — narrowing the
// ticks is what starts excluding work.
// Says WHICH of the two reasons the box is empty for. "No signed-off work" and
// "you have filtered the types down" need different answers, and the second is
// self-inflicted and fixable one tap away.
function emptyBillableMessage(types, blockedCount) {
  const on = ['REQ', 'UPT', 'BUG'].filter((t) => (types || {})[t]);
  if (on.length && on.length < 3) {
    return `No ${on.join(' / ')} work available to bill — check Include Task Types above.`;
  }
  if (blockedCount) return 'No signed-off work waiting to be billed.';
  return 'No signed-off work waiting to be billed.';
}
function typeAllowed(k, types) {
  const on = ['REQ', 'UPT', 'BUG'].filter((t) => (types || {})[t]);
  if (on.length === 3 || !on.length) return true;
  return on.includes(String(k.task_type || '').toUpperCase());
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
  const [showBlocked, setShowBlocked] = useState(false); // reveal the not-yet-billable tasks
  // Marks the Client row when Create is pressed without one. A banner alone put the
  // complaint at the top of the screen and the field halfway down it.
  const [missingClient, setMissingClient] = useState(false);
  const [pick, setPick] = useState(null);       // { title, options, current, onPick }
  const [datePick, setDatePick] = useState(null); // { field:'from'|'to', title }
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
  // Asks how they paid before sending, so the admin has something to reconcile
  // against. The claim does NOT settle the invoice — an admin still confirms.
  const clientPaid = (id) => {
    setPrompt({
      title: "Report payment",
      fields: [{ key: 'method', label: 'How did you pay?', val: 'bank_transfer', choices: svc.PAYMENT_METHODS },
               { key: 'note', label: 'Reference or note (optional)', val: '' }],
      onOk: async (vals) => {
        setBusy('claim');
        try {
          const r = await svc.clientMarkPaid(id, vals.method, vals.note || '');
          if (r?.status) { if (r.data) setDetail(r.data); flash('ok', "Thanks — we've told the team you've paid."); }
          else flash('err', r?.message || 'Could not send.');
        } catch (e) { flash('err', 'Could not send.'); }
        finally { setBusy(null); }
      },
    });
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
    const r = presetRange('all');
    setCForm({
      clientId: false, clientName: '', title: '', preset: 'all',
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
    // Collapse the hidden-tasks list too. Left open it would expand straight into
    // the NEW client's blocked tasks, which nobody asked to see.
    setShowBlocked(false);
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
    if (!cForm.clientId) { setMissingClient(true); flash('err', 'Choose the client this invoice is for.'); return; }
    const task_types = Object.keys(cForm.types).filter((k) => cForm.types[k]);
    if (!task_types.length) { flash('err', 'Pick at least one task type (REQ / UPT / BUG).'); return; }
    // An hourly invoice at rate 0 totals 0 however many hours it bills. That is a
    // real thing to want — a time-only record — but it is not what anyone means by
    // accident, and the app used to create it silently.
    if (cForm.billing === 'hourly' && !(parseFloat(cForm.rate) > 0)) {
      setPrompt({
        title: 'Per-hour rate is 0',
        body: 'This invoice will total 0 no matter how many hours it bills.\n\n'
          + 'That is right for a time-only record you are sending for information. '
          + 'If you meant to charge for this work, set a rate first.',
        okLabel: 'Create it anyway', fields: [],
        onOk: async () => { doCreate(task_types); },
      });
      return;
    }
    doCreate(task_types);
  };

  const doCreate = async (task_types) => {
    setCForm((p) => ({ ...p, creating: true }));
    // Only ticks that still mean something. A tick survives a type change or a
    // re-fetch that made the task unbillable, and sending a stale id narrows the
    // invoice to work the server then refuses — an empty invoice from a form that
    // looked correct.
    const shown = new Set((cForm.kpis || [])
      .filter((k) => typeAllowed(k, cForm.types) && k.billable !== false)
      .map((k) => k.id));
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
      filter_kpi_ids: (cForm.filterKpi || []).filter((id) => shown.has(id)),
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
                    {/* Three payment states, not two. A claimed invoice was showing
                        as a plain DUE, which is the one thing it is not: the client
                        has reported paying and is waiting on someone here. */}
                    {item.state !== 'draft' ? (() => {
                      const pay = item.payment_status === 'paid'
                        ? { txt: 'PAID', bg: '#DCFCE7', fg: '#16A34A' }
                        : (item.client_paid_claim
                          ? { txt: 'CLAIMED', bg: '#FEF3C7', fg: '#B45309' }
                          : { txt: 'DUE', bg: '#FEE2E2', fg: '#DC2626' });
                      return (
                        <View style={[s.payBadge, { backgroundColor: pay.bg }]}>
                          <Text style={[s.payTxt, { color: pay.fg }]}>{pay.txt}</Text>
                        </View>
                      );
                    })() : null}
                  </View>
                  {/* A reversed payment is the one thing a client scanning their list
                      needs to spot without opening anything — the invoice they thought
                      was settled is due again. Both serializers carry the reason and
                      the app was rendering it nowhere. */}
                  {item.unpaid_reason ? (
                    <View style={s.revRow}>
                      <Ionicons name="arrow-undo" size={12} color={COLORS.red} />
                      <Text style={s.revTxt} numberOfLines={2}>Payment reversed — {item.unpaid_reason}</Text>
                    </View>
                  ) : null}
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
      : (d.payment_status === 'paid' ? { txt: 'Paid', color: COLORS.green }
        : (d.client_paid_claim ? { txt: 'Payment claimed', color: '#B45309' }
          : { txt: 'Unpaid', color: COLORS.red })));
    // Revise and Reset to Draft are both refused by the server while a claim is
    // open — the client has sent money against this exact figure. Hiding them and
    // saying why beats offering a button whose only outcome is a ValidationError.
    const claimOpen = !!(d && d.client_paid_claim && d.payment_status !== 'paid');
    const canEditFinalized = !!(d && d.state === 'finalized' && d.payment_status !== 'paid' && !claimOpen);
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
              {/* How the money actually arrived, admin only — the server withholds
                  these fields from clients for the same reason. Without it the note
                  typed into Mark Paid could never be read back by anyone. */}
              {!portal && d.payment_status === 'paid' ? (
                <View style={s.paidHint}>
                  <Ionicons name="checkmark-circle" size={13} color={COLORS.green} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.paidHintTxt}>
                      Paid{d.payment_method_label ? ` by ${d.payment_method_label}` : ''}
                      {d.payment_date ? ` on ${d.payment_date}` : ''}
                      {d.paid_by_name || d.paid_by ? ` — recorded by ${d.paid_by_name || d.paid_by}` : ''}
                    </Text>
                    {d.payment_notes ? <Text style={s.paidHintNote}>{d.payment_notes}</Text> : null}
                  </View>
                </View>
              ) : null}
              {/* A reversed payment, shown to BOTH sides. The client is the person
                  who most needs it — their settled invoice is due again — and the
                  reason lives in its own field precisely so it can be published,
                  unlike payment_notes. */}
              {d.unpaid_reason ? (
                <View style={s.revHint}>
                  <Ionicons name="arrow-undo" size={13} color={COLORS.red} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.revHintTxt}>
                      {portal ? 'This payment was reversed — the invoice is due again.' : 'Payment reverted to Due.'}
                    </Text>
                    <Text style={s.revHintBody}>{d.unpaid_reason}</Text>
                    {d.unpaid_on ? <Text style={s.revHintWhen}>Reverted {d.unpaid_on}</Text> : null}
                  </View>
                </View>
              ) : null}
              {claimOpen ? (
                <View style={s.claimHint}>
                  <Ionicons name="cash-outline" size={13} color="#B45309" />
                  <View style={{ flex: 1 }}>
                    <Text style={s.claimHintTxt}>
                      {portal
                        ? 'You reported paying this invoice.'
                        : `Client marked this as paid${d.client_paid_claim_date ? ` on ${d.client_paid_claim_date}` : ''}${d.client_paid_method_label ? ` by ${d.client_paid_method_label}` : ''}.`}
                    </Text>
                    {/* The client's own reference. The admin reconciling the payment
                        is the one person who needs it, and it was being collected
                        and then never shown to anybody. */}
                    {!portal && d.client_paid_notes ? <Text style={s.claimNote}>{d.client_paid_notes}</Text> : null}
                    {portal ? (
                      <Text style={s.claimNote}>Awaiting confirmation — we'll mark it paid once the payment is checked.</Text>
                    ) : (
                      // Both outcomes, side by side. A claim made by mistake used to
                      // be unclearable: the client cannot claim twice, and the only
                      // other way to drop the flag was marking the invoice paid —
                      // the one thing you must not do to correct it.
                      <View style={s.claimBtns}>
                        <TouchableOpacity onPress={() => openMarkPaid(d, true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={s.claimConfirm}>Confirm payment</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => openClearClaim(d)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={s.claimClear}>Not received</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </View>
              ) : null}
              {/* The client may be holding a PDF showing the old figure. A total that
                  changes with nothing explaining it is how billing disputes start —
                  so this shows on BOTH sides, not just the admin's. */}
              {d.revised_on ? (
                <View style={s.revisedHint}>
                  <Ionicons name="create-outline" size={13} color={COLORS.primary} />
                  <Text style={s.revisedHintTxt}>
                    Revised on {d.revised_on}{d.revision_reason ? ` — ${d.revision_reason}` : ''}
                  </Text>
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
              {!portal ? (
                <View style={s.totCard}><Text style={s.totCardLbl}>Sum of Actual</Text><Text style={s.totCardVal}>{d.total_actual_hours}h</Text></View>
              ) : null}
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
                          {/* Actual time is ours, not the client's business — the web
                              guards this column and the Sum of Actual tile the same
                              way, and the app was showing it on the portal. */}
                          <Text style={s.lineMeta}>{portal ? ' h' : ` h · Actual ${l.actual_hours}h`}</Text>
                        </View>
                      ) : (
                        <Text style={s.lineMeta}>
                          Quoted {l.quoted_hours}h{portal ? '' : ` · Actual ${l.actual_hours}h`}
                        </Text>
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
            {/* An empty invoice with "No lines yet." explains nothing, and creating
                one is easy to do by accident. The server already works out WHY
                nothing was billable — date window, sign-off, type filter, already
                invoiced — and the app was discarding the answer. Only /create
                returns it, so it shows on the invoice you just made. */}
            {(d.lines || []).length === 0 && (d.empty_reasons || []).length ? (
              <View style={s.emptyWhy}>
                <View style={s.emptyWhyHead}>
                  <Ionicons name="information-circle-outline" size={15} color="#B45309" />
                  <Text style={s.emptyWhyTitle}>Nothing to bill for this period</Text>
                </View>
                {d.empty_reasons.map((r, i) => (
                  <Text key={i} style={s.emptyWhyItem}>• {r}</Text>
                ))}
                <Text style={s.emptyWhyFoot}>
                  Work becomes billable only once the client has signed it off in their portal.
                  You can delete this draft and create it again after they do.
                </Text>
              </View>
            ) : null}
            {(d.lines || []).length === 0 && !(d.empty_reasons || []).length ? <Text style={s.noLines}>No lines yet.</Text> : null}

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
                <ActBtn label="Finalize" icon="lock-closed-outline" busy={busy === 'finalize'} onPress={() => confirmFinalize(d)} primary />
              ) : null}
              {!portal && d.state === 'finalized' ? (
                <ActBtn label="Mark Sent" icon="send-outline" busy={busy === 'send'} onPress={() => doAction('send', () => svc.sendInvoice(d.id))} primary />
              ) : null}
              {/* Reduce a finalized invoice, then re-finalize. Finalized only — the
                  server also refuses anything sent, paid, or with a claim open. */}
              {!portal && canEditFinalized ? (
                <ActBtn label="Revise" icon="create-outline" busy={busy === 'revise'} onPress={() => openRevise(d)} />
              ) : null}
              {!portal && canEditFinalized ? (
                <ActBtn label="Reset to Draft" icon="arrow-undo-outline" busy={busy === 'reset'} onPress={() => confirmResetDraft(d)} />
              ) : null}
              {/* Why the two buttons above are absent. Silence would read as the
                  feature being missing rather than deliberately withheld. */}
              {!portal && d.state === 'finalized' && d.payment_status !== 'paid' && claimOpen ? (
                <Text style={s.lockNote}>
                  Revise is locked while the client's payment claim is open — confirm it, or clear
                  it if the money never arrived.
                </Text>
              ) : null}
              {/* Deleting a draft frees the tasks it is holding. Without this the app
                  could create an empty draft and never remove it, and those tasks stay
                  out of every future invoice. */}
              {!portal && isDraft ? (
                <ActBtn label="Delete Draft" icon="trash-outline" busy={busy === 'delete'} onPress={() => confirmDeleteDraft(d)} />
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
  // Only signed-off work can actually be billed. The server says so per task and
  // the app used to throw that away, offering everything as tickable — so an
  // admin could select nine tasks and get an empty invoice with nothing
  // explaining why. `billable === false` explicitly, so a server that stops
  // sending the field degrades to "offer it" rather than hiding every task.
  //
  // Everything below is filtered by Include Task Types first. The picker used to
  // ignore those ticks entirely, so unticking BUG still listed and still let you
  // tick bug fixes — which the invoice then dropped, because the server DOES obey
  // the filter. Same rule as the web's _typeAllowed and the server's _populate:
  // all three ticked means no filter at all, so BRAND-, TST- and untyped refs pass.
  const allKpis = (f.kpis || []).filter((k) => typeAllowed(k, f.types));
  const billableKpis = allKpis.filter((k) => k.billable !== false);
  // Already on an invoice — settled, and worth showing separately from work that
  // is merely unfinished. Lumping the two together is what made "already invoiced"
  // read as "the client still has to sign this off".
  const invoicedKpis = allKpis.filter((k) => k.billable === false && k.not_billable_code === 'invoiced');
  const blockedKpis = allKpis.filter((k) => k.billable === false && k.not_billable_code !== 'invoiced');
  return (
    <View style={s.root}>
      <GradientBackground />
      <Header title="New Invoice" onLeft={() => setMode('list')} />
      <Banner />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.fLbl}>Client <Text style={s.reqStar}>*</Text></Text>
          <TouchableOpacity style={[s.select, missingClient && s.selectBad]} activeOpacity={0.8}
            onPress={() => setPick({ title: 'Select client', current: f.clientId, options: clientPickOptions(clients), onPick: (v, label) => { setMissingClient(false); onClientChange(v, label); } })}>
            <Text style={s.selectTxt} numberOfLines={1}>{f.clientName || '-- Select Client --'}</Text>
            <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
          </TouchableOpacity>
          {missingClient ? <Text style={s.fieldErr}>Choose the client this invoice is for.</Text> : null}

          <Text style={[s.fLbl, { marginTop: 14 }]}>Invoice Title (optional)</Text>
          <TextInput style={s.input} value={f.title} onChangeText={(t) => setCForm((p) => ({ ...p, title: t }))} placeholder="e.g. Monthly Services - May 2026" placeholderTextColor={COLORS.faint} />

          <Text style={[s.fLbl, { marginTop: 14 }]}>Period</Text>
          <View style={s.pillWrap}>
            {PRESETS.map((p) => (
              // 'custom' has no range of its own — presetRange returns null for
              // it, which used to throw on r.from. It means "I'll pick the dates
              // myself", so it opens the From picker and leaves the range alone.
              <TouchableOpacity key={p.key} style={[s.pill, f.preset === p.key && s.pillOn]} onPress={() => {
                if (p.key === 'custom') { setCForm((x) => ({ ...x, preset: 'custom' })); setDatePick({ field: 'from', title: 'Period from' }); return; }
                const r = presetRange(p.key);
                setCForm((x) => ({ ...x, preset: p.key, from: r.from, to: r.to }));
              }} activeOpacity={0.85}>
                <Text style={[s.pillTxt, f.preset === p.key && s.pillTxtOn]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* Tap-to-pick rather than free text: these go straight to the server
              as from_date/to_date, and a typo used to sail through unvalidated. */}
          <View style={s.dateRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.miniLbl}>From</Text>
              <TouchableOpacity style={s.select} activeOpacity={0.8} onPress={() => setDatePick({ field: 'from', title: 'Period from' })}>
                <Text style={s.selectTxt} numberOfLines={1}>{f.from || 'Pick a date'}</Text>
                <Ionicons name="calendar-outline" size={17} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.miniLbl}>To</Text>
              <TouchableOpacity style={s.select} activeOpacity={0.8} onPress={() => setDatePick({ field: 'to', title: 'Period to' })}>
                <Text style={s.selectTxt} numberOfLines={1}>{f.to || 'Pick a date'}</Text>
                <Ionicons name="calendar-outline" size={17} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
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
              {/* Two boxes, as the web has them. "Available to bill" carries the only
                  checkboxes — ticking a task you cannot bill means nothing, and
                  offering the tick is what let an admin select nine tasks and get an
                  empty invoice. "Already invoiced" is settled work, listed so its
                  absence from the first box is explained rather than mysterious. */}
              <Text style={s.fLbl}>Filter: Tasks <Text style={s.fHelp}>(optional — leave empty for all)</Text></Text>

              <View style={s.taskBox}>
                <View style={s.taskBoxHead}>
                  <Ionicons name="checkbox-outline" size={14} color={COLORS.green} />
                  <Text style={s.taskBoxTitle}>Available to bill</Text>
                  <View style={[s.countPill, { backgroundColor: '#DCFCE7' }]}>
                    <Text style={[s.countPillTxt, { color: '#16A34A' }]}>{billableKpis.length}</Text>
                  </View>
                </View>
                {billableKpis.length ? billableKpis.map((k) => {
                  const on = (f.filterKpi || []).includes(k.id);
                  return (
                    <TouchableOpacity key={k.id} style={s.tickRow} activeOpacity={0.8}
                      onPress={() => setCForm((p) => ({
                        ...p,
                        filterKpi: on ? p.filterKpi.filter((x) => x !== k.id) : [...p.filterKpi, k.id],
                      }))}>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={18} color={on ? COLORS.primary : COLORS.faint} />
                      <Text style={s.tickTxt} numberOfLines={2}>
                        {k.kra_name ? `${k.name} (${k.kra_name})` : k.name}
                      </Text>
                    </TouchableOpacity>
                  );
                }) : (
                  <Text style={s.boxEmpty}>{emptyBillableMessage(f.types, blockedKpis.length)}</Text>
                )}
                {/* Not billable and not yet invoiced — the reason is the point. Each
                    string comes from the server so the app and the web cannot
                    describe the same state two different ways. */}
                {blockedKpis.length ? (
                  <View>
                    <TouchableOpacity style={s.hiddenRow} activeOpacity={0.8} onPress={() => setShowBlocked((v) => !v)}>
                      <Ionicons name={showBlocked ? 'chevron-down' : 'chevron-forward'} size={15} color={COLORS.muted} />
                      <Text style={s.hiddenTxt}>{blockedKpis.length} task(s) hidden — not signed off yet</Text>
                    </TouchableOpacity>
                    {showBlocked ? blockedKpis.map((k) => (
                      <View key={k.id} style={s.blockedRow}>
                        <Text style={s.blockedName} numberOfLines={2}>
                          {k.kra_name ? `${k.name} (${k.kra_name})` : k.name}
                        </Text>
                        <View style={[s.blockedTag, { backgroundColor: BLOCK_BG[k.not_billable_code] || '#F1F5F9' }]}>
                          <Text style={[s.blockedTagTxt, { color: BLOCK_FG[k.not_billable_code] || COLORS.muted }]}>
                            {k.not_billable_reason || 'not ready'}
                          </Text>
                        </View>
                      </View>
                    )) : null}
                  </View>
                ) : null}
              </View>

              <View style={s.taskBox}>
                <View style={s.taskBoxHead}>
                  <Ionicons name="lock-closed" size={13} color={COLORS.muted} />
                  <Text style={s.taskBoxTitle}>Already invoiced</Text>
                  <View style={[s.countPill, { backgroundColor: '#F1F5F9' }]}>
                    <Text style={[s.countPillTxt, { color: COLORS.muted }]}>{invoicedKpis.length}</Text>
                  </View>
                </View>
                {invoicedKpis.length ? invoicedKpis.map((k) => (
                  <View key={k.id} style={s.blockedRow}>
                    <Text style={s.blockedName} numberOfLines={2}>
                      {k.kra_name ? `${k.name} (${k.kra_name})` : k.name}
                    </Text>
                    <View style={[s.blockedTag, { backgroundColor: BLOCK_BG.invoiced }]}>
                      <Text style={[s.blockedTagTxt, { color: BLOCK_FG.invoiced }]}>
                        {k.not_billable_reason || 'already invoiced'}
                      </Text>
                    </View>
                  </View>
                )) : (
                  <Text style={s.boxEmpty}>No invoiced tasks yet.</Text>
                )}
              </View>
            </View>
          ) : null}

          <TouchableOpacity style={[s.createBtn, f.creating && { opacity: 0.6 }]} onPress={submitCreate} disabled={f.creating} activeOpacity={0.9}>
            {f.creating ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.createTxt}>Create Invoice</Text></>}
          </TouchableOpacity>
        </View>
      </ScrollView>
      {renderPickModal()}
      {datePick ? (
        <DateGridModal
          title={datePick.title}
          value={datePick.field === 'from' ? f.from : f.to}
          // Keep the range the right way round at the point of choosing, rather
          // than rejecting it after the fact: picking a From after the current
          // To (or vice versa) is almost always a mis-tap.
          maxDate={datePick.field === 'from' ? (f.to || undefined) : undefined}
          minDate={datePick.field === 'to' ? (f.from || undefined) : undefined}
          onCancel={() => setDatePick(null)}
          onPick={(iso) => {
            const field = datePick.field;
            setDatePick(null);
            setCForm((p) => ({ ...p, preset: 'custom', [field]: iso }));
          }}
        />
      ) : null}
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
  // Marking PAID asks how the money arrived, and its note is internal.
  //
  // Reverting asks WHY, and that answer is NOT optional: action_mark_unpaid raises
  // without one, because the client is told their invoice is due again and is shown
  // the reason. This field used to read "Note (optional)" — left blank, which is
  // exactly what "optional" invites, every revert failed on the server with a
  // message nobody could act on.
  // A function declaration, NOT a const arrow. This sits below the list-mode early
  // return, so a const binding here is still `undefined` when the screen is in list
  // mode — and Revert/Mark Paid are list-row buttons, so they would call it in
  // exactly the state where it had never been assigned. Declarations are hoisted
  // AND initialised, so they survive the early return.
  function paidFields(paid) {
    return paid
      ? [{ key: 'method', label: 'How was it paid?', val: 'bank_transfer', choices: svc.PAYMENT_METHODS },
         { key: 'note', label: 'Note (optional)', val: '',
           placeholder: 'e.g. cheque #4417, transfer ref…',
           hint: 'Internal only — not shown to the client.' }]
      : [{ key: 'note', label: 'Reason', val: '', required: true,
           placeholder: 'e.g. cheque returned unpaid by the bank',
           hint: 'The client is shown this on their invoice.' }];
  }

  // One builder for both callers — the list row and the detail screen must not be
  // able to ask for the same thing in two different ways.
  function markPaidPrompt(inv, paid, onDone) {
    setPrompt({
      title: paid ? `Mark ${inv.name} as paid` : `Revert ${inv.name} to Due`,
      body: paid
        ? 'Record how the payment arrived. The note is internal — the client never sees it.'
        : 'Use this when a payment bounced or was recorded in error. Any tasks this invoice archived come back.',
      okLabel: paid ? 'Mark Paid' : 'Revert to Due',
      fields: paidFields(paid),
      onOk: async (vals) => {
        // Checked here as well as server-side so the refusal is immediate, and
        // worded the way Revise already words it rather than inventing a second
        // sentence for the same rule.
        if (!paid && !(vals.note || '').trim()) { flash('err', 'A reason is required.'); return; }
        await onDone(vals);
      },
    });
  }

  // Finalizing locks the invoice and shows it to the client, so it asks first —
  // and asks twice when per-task lines are still priced at 0, because "billed as
  // free" is not something to discover after the fact.
  function confirmFinalize(d) {
    const unpriced = (d.lines || []).filter((l) => l.line_type === 'kpi' && !(Number(l.unit_price) > 0));
    const perTask = d.billing_method === 'per_task';
    const total = (d.lines || []).filter((l) => l.line_type === 'kpi').length;
    if (perTask && unpriced.length) {
      setPrompt({
        title: 'Some tasks have no price',
        body: `${unpriced.length} of ${total} tasks on this invoice are still priced at 0, so they `
          + 'will be billed as free. Finalizing locks that in.\n\n'
          + unpriced.slice(0, 5).map((l) => `• ${l.description}`).join('\n')
          + (unpriced.length > 5 ? `\n• …and ${unpriced.length - 5} more` : ''),
        okLabel: 'Finalize anyway', fields: [],
        onOk: async () => { doAction('finalize', () => svc.finalizeInvoice(d.id)); },
      });
      return;
    }
    setPrompt({
      title: 'Finalize this invoice?',
      body: 'It is locked from further edits and becomes visible to the client.',
      okLabel: 'Finalize', fields: [],
      onOk: async () => { doAction('finalize', () => svc.finalizeInvoice(d.id)); },
    });
  }

  function confirmResetDraft(d) {
    setPrompt({
      title: 'Reset to Draft?',
      body: 'The client loses sight of it until you finalize again.',
      okLabel: 'Reset to Draft', fields: [],
      onOk: async () => { doAction('reset', () => svc.resetInvoiceDraft(d.id)); },
    });
  }

  // The server reports how many tasks came back; say the number rather than a bare
  // "deleted", because freeing the work is the point of deleting the draft.
  function confirmDeleteDraft(d) {
    setPrompt({
      title: `Delete draft ${d.name}?`,
      body: 'Any tasks it is holding are freed for a future invoice. This cannot be undone.',
      okLabel: 'Delete', fields: [],
      onOk: async () => {
        setBusy('delete');
        try {
          const r = await svc.deleteInvoice(d.id);
          if (r?.status) {
            flash('ok', `${d.name} deleted. ${r.freed_tasks || 0} task(s) are free to bill again.`);
            setMode('list'); loadList(statusFilter);
          } else flash('err', r?.message || 'Could not delete the draft.');
        } catch (e) { flash('err', 'Could not delete the draft.'); }
        finally { setBusy(null); }
      },
    });
  }

  // Revise: reason required, because the client is told the figure changed.
  function openRevise(d) {
    setPrompt({
      title: `Revise ${d.name}?`,
      fields: [{ key: 'reason', label: 'Why is it being revised? (required)', val: '' }],
      onOk: async (vals) => {
        if (!(vals.reason || '').trim()) { flash('err', 'A reason is required.'); return; }
        doAction('revise', () => svc.reviseInvoice(d.id, vals.reason));
      },
    });
  }

  // Dismiss a claim the client made by mistake. Confirmed because it removes
  // something the client did, and they are not told it happened — the honest
  // follow-up is a conversation, not a silent tap.
  function openClearClaim(d) {
    setPrompt({
      title: 'Clear the payment claim?',
      body: `${d.name}: the client said they paid. Clearing this removes their claim so it `
        + 'no longer shows as awaiting confirmation. It does not change whether the invoice is paid.',
      fields: [],
      onOk: async () => { doAction('clear_claim', () => svc.clearPaidClaim(d.id)); },
    });
  }

  // From the detail screen — refreshes the open invoice.
  function openMarkPaid(d, paid) {
    markPaidPrompt(d, paid, async (vals) => {
      doAction(paid ? 'paid' : 'unpaid', () => svc.markInvoicePaid(d.id, paid, vals.note || '', vals.method));
    });
  }
  // Mark paid/unpaid straight from a list row (refreshes the list, not a detail).
  function openMarkPaidList(inv, paid) {
    markPaidPrompt(inv, paid, async (vals) => {
      const r = await svc.markInvoicePaid(inv.id, paid, vals.note || '', vals.method);
      if (r?.status) { flash('ok', paid ? 'Marked paid' : 'Marked unpaid'); loadList(statusFilter); }
      else flash('err', r?.message || 'Action failed.');
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
              data={pick?.options || []} keyExtractor={(o) => o.key || String(o.value)} keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                // A group heading. Inert on purpose — the web uses optgroup, whose
                // labels cannot be chosen; a heading that answers to a tap would
                // pick whichever client happened to sit behind it.
                if (item.header) return <Text style={s.ccGroup}>{item.label}</Text>;
                const on = item.value === pick.current;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} activeOpacity={0.8}
                    onPress={() => { const fn = pick.onPick; setPick(null); if (fn) fn(item.value, item.label); }}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.ccRowName}>{item.label}</Text>
                      {/* Counts and the no-client-user warning. Its own line rather
                          than appended to the name the way the web appends it: a
                          select option is one line by necessity, a touch row is not,
                          and the name must stay readable when it is long. */}
                      {!!item.meta && <Text style={s.ccRowMeta}>{item.meta}</Text>}
                    </View>
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

// Month-grid date picker. Hand-rolled because the app ships no date library and
// no native picker module; the calendar maths lives in utils/dateGrid so it can
// be tested without rendering. Reuses the same modal chrome as the client and
// currency pickers so the create form has one consistent way to choose things.
function PromptModal({ prompt, onClose }) {
  const [vals, setVals] = useState(() => {
    const o = {}; (prompt.fields || []).forEach((fld) => { o[fld.key] = fld.val || ''; }); return o;
  });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={[s.modalSheet, { padding: 18 }]}>
          <Text style={[s.modalTitle, { marginBottom: prompt.body ? 6 : 12 }]}>{prompt.title}</Text>
          {/* Optional explanation. Some confirmations need to say what they will
              and will not do — a bare title is not enough when the action removes
              something a client did. */}
          {prompt.body ? <Text style={s.promptBody}>{prompt.body}</Text> : null}
          {(prompt.fields || []).map((fld) => (
            <View key={fld.key} style={{ marginBottom: 10 }}>
              {/* A required field says so on the label, the way the web marks it
                  with a red asterisk. Reverting a payment is the case that matters:
                  the server refuses without a reason, so a field that looks optional
                  is a dead end dressed up as a choice. */}
              <Text style={s.miniLbl}>
                {fld.label}{fld.required ? <Text style={s.reqStar}> *</Text> : null}
              </Text>
              {/* A field with `choices` renders as tappable chips instead of a text
                  box — payment method has to be one of a fixed set, and free text
                  would let "gpay"/"g-pay"/"GPay" all mean the same thing. Chips wrap,
                  so five of them fit a 360dp screen. */}
              {fld.choices ? (
                <View style={s.chipWrap}>
                  {fld.choices.map((c) => {
                    const on = vals[fld.key] === c.code;
                    return (
                      <TouchableOpacity
                        key={c.code} style={[s.chip, on && s.chipOn]} activeOpacity={0.85}
                        onPress={() => setVals((p) => ({ ...p, [fld.key]: c.code }))}
                      >
                        <Text style={[s.chipTxt, on && s.chipTxtOn]}>{c.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <TextInput
                  style={s.input} value={vals[fld.key]} keyboardType={fld.numeric ? 'decimal-pad' : 'default'}
                  placeholder={fld.placeholder || ''} placeholderTextColor={COLORS.faint}
                  onChangeText={(t) => setVals((p) => ({ ...p, [fld.key]: t }))}
                />
              )}
              {/* Says who reads it. "Internal only" and "the client is shown this"
                  are the whole difference between the paid note and the revert
                  reason, and it cannot be inferred from the label. */}
              {fld.hint ? <Text style={s.fieldHint}>{fld.hint}</Text> : null}
            </View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 6 }}>
            <TouchableOpacity onPress={onClose}><Text style={s.promptCancel}>Cancel</Text></TouchableOpacity>
            {/* Named after what it does, not "OK". A dialog that can archive tasks or
                put an invoice back to Due should say so on the button. */}
            <TouchableOpacity onPress={() => { const fn = prompt.onOk; onClose(); if (fn) fn(vals); }}>
              <Text style={s.promptOk}>{prompt.okLabel || 'OK'}</Text>
            </TouchableOpacity>
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
  // flexWrap matters: five method chips do not fit one 360dp row, and every
  // unwrapped row in this app was originally sized for the tablet.
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

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
  paidHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: 9, borderRadius: 9, backgroundColor: COLORS.greenBg || '#DCFCE7', borderWidth: 1, borderColor: '#A7F3D0' },
  paidHintTxt: { fontSize: 11.5, fontWeight: '800', color: '#065F46', lineHeight: 16 },
  paidHintNote: { fontSize: 11.5, color: '#065F46', marginTop: 3, lineHeight: 16 },
  claimHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: 9, borderRadius: 9, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D' },
  claimHintTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: '#92400E', lineHeight: 16 },
  claimClear: { fontSize: 11.5, fontWeight: '800', color: '#B45309', textDecorationLine: 'underline', marginTop: 6 },
  claimConfirm: { fontSize: 11.5, fontWeight: '900', color: COLORS.green, textDecorationLine: 'underline', marginTop: 6 },
  claimBtns: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  claimNote: { fontSize: 11.5, color: '#92400E', marginTop: 4, lineHeight: 16 },
  // Payment reversed — red, and shown to the client too, unlike payment_notes.
  revHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: 9, borderRadius: 9, backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5' },
  revHintTxt: { fontSize: 11.5, fontWeight: '800', color: '#991B1B', lineHeight: 16 },
  revHintBody: { fontSize: 11.5, color: '#991B1B', marginTop: 3, lineHeight: 16 },
  revHintWhen: { fontSize: 10.5, color: '#B91C1C', marginTop: 3, fontWeight: '700' },
  revRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  revTxt: { flex: 1, fontSize: 11, fontWeight: '800', color: COLORS.red, lineHeight: 15 },
  lockNote: { fontSize: 11.5, color: COLORS.muted, fontStyle: 'italic', lineHeight: 16, marginTop: 2, marginBottom: 4 },
  emptyWhy: { backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D', borderRadius: 10, padding: 11, marginTop: 6 },
  emptyWhyHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  emptyWhyTitle: { fontSize: 12.5, fontWeight: '900', color: '#92400E' },
  emptyWhyItem: { fontSize: 11.5, color: '#92400E', lineHeight: 17, marginBottom: 2 },
  emptyWhyFoot: { fontSize: 11, color: '#B45309', lineHeight: 16, marginTop: 6 },
  noBillable: { fontSize: 12, color: COLORS.muted, lineHeight: 17, marginTop: 12 },
  taskBox: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, padding: 10, marginTop: 8, backgroundColor: '#fff' },
  taskBoxHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  taskBoxTitle: { flex: 1, fontSize: 12.5, fontWeight: '900', color: COLORS.ink },
  countPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  countPillTxt: { fontSize: 11, fontWeight: '900' },
  boxEmpty: { fontSize: 11.5, color: COLORS.muted, lineHeight: 16, paddingVertical: 4 },
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7 },
  tickTxt: { flex: 1, fontSize: 12.5, color: COLORS.ink, lineHeight: 17 },
  hiddenRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7 },
  hiddenTxt: { fontSize: 12, fontWeight: '800', color: COLORS.muted },
  blockedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingLeft: 20 },
  blockedName: { flex: 1, fontSize: 12, color: COLORS.ink, lineHeight: 16 },
  blockedTag: { borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3 },
  blockedTagTxt: { fontSize: 10.5, fontWeight: '800' },
  promptBody: { fontSize: 12.5, color: COLORS.muted, lineHeight: 18, marginBottom: 12 },
  reqStar: { color: COLORS.red, fontWeight: '900' },
  selectBad: { borderColor: COLORS.red, borderWidth: 1.5 },
  fieldErr: { fontSize: 11.5, color: COLORS.red, fontWeight: '700', marginTop: 5 },
  fieldHint: { fontSize: 11, color: COLORS.faint, marginTop: 4, lineHeight: 15 },
  revisedHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, padding: 9, borderRadius: 9, backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE' },
  revisedHintTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: COLORS.primary, lineHeight: 16 },
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
  ccRowMeta: { fontSize: 11.5, color: COLORS.muted, fontWeight: '600', marginTop: 2 },
  ccGroup: {
    fontSize: 11.5, fontWeight: '900', color: COLORS.muted, letterSpacing: 0.6,
    textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6,
    backgroundColor: '#F8FAFC',
  },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },
  promptCancel: { fontSize: 15, fontWeight: '700', color: COLORS.muted },
  promptOk: { fontSize: 15, fontWeight: '900', color: COLORS.primary },

  // Date grid. Cells are 1/7th of the row so the columns line up with the
  // weekday header on any width without measuring anything.
});
