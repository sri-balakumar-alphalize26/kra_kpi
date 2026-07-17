// WORK REPORT (admin) — completed tasks over a period, task-wise or client-wise.
// Mirrors the Odoo web Work Report: presets/custom range, group toggle, optional
// client filter, show-hours, and a branded PDF (rendered server-side, opened via
// the OS viewer). Admin-only (Home tile + the server routes both gate it).

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Switch,
  ActivityIndicator, Modal, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchWorkReport, fetchWorkReportClients, fetchWorkReportPdf } from '../services/workReport';
import { createLogger } from '../api/logger';

const log = createLogger('WorkReport');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This Week' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'custom', label: 'Custom' },
];

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function presetRange(key) {
  const now = new Date();
  const sod = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (key === 'today') return { from: fmt(sod(now)), to: fmt(sod(now)) };
  if (key === 'this_week') {
    const dow = (now.getDay() + 6) % 7;  // Mon = 0
    return { from: fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)), to: fmt(sod(now)) };
  }
  if (key === 'this_month') return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(sod(now)) };
  if (key === 'last_month') {
    return {
      from: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: fmt(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return null;  // custom
}

export default function WorkReport({ onBack }) {
  const init = presetRange('this_month');
  const [preset, setPreset] = useState('this_month');
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate, setToDate] = useState(init.to);
  const [groupBy, setGroupBy] = useState('task');
  const [showHours, setShowHours] = useState(true);
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(false);
  const [pickClient, setPickClient] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);   // web parity: results/hours/PDF only after Generate
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState({});   // client-wise collapse
  const [pdfBusy, setPdfBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [banner, setBanner] = useState(null);      // { kind:'ok'|'err', msg }

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };

  const paramsOf = (over = {}) => ({
    from_date: over.from ?? fromDate,
    to_date: over.to ?? toDate,
    group_by: over.group ?? groupBy,
    client_kra_id: (over.client ?? clientId) || false,
  });

  const generate = useCallback(async (over = {}) => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetchWorkReport(paramsOf(over));
      if (res?.status === false) { setError(res.message || 'Could not generate the report.'); setResult(null); }
      else { setResult(res); setExpanded({}); }
    } catch (e) {
      log.warn('generate failed', e?.message);
      setError(e?.message || 'Could not generate the report.');
    } finally {
      setGenerating(false);
      setRanOnce(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, groupBy, clientId]);

  // Web parity: DON'T auto-generate on mount — only load the client dropdown.
  // Results appear only after the user taps Generate.
  useEffect(() => {
    (async () => {
      try {
        const c = await fetchWorkReportClients();
        if (c?.status) setClients(c.clients || []);
      } catch (_) {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preset / From / To / Client changes only update the filters — the user must
  // press Generate (matches the web). Task-wise/Client-wise toggle DOES re-run,
  // but only once a report has already been generated.
  const choosePreset = (key) => {
    setPreset(key);
    const r = presetRange(key);
    if (r) { setFromDate(r.from); setToDate(r.to); }
  };
  const chooseGroup = (g) => { setGroupBy(g); if (ranOnce) generate({ group: g }); };
  const chooseClient = (id) => { setPickClient(false); setClientId(id); };

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const res = await fetchWorkReportPdf(paramsOf());
      if (!res?.status || !res.data_b64) { flash('err', res?.message || 'Could not build the PDF.'); return; }
      const name = (res.file_name || 'Work_Report.pdf').split(/[\\/]/).pop();

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
    } catch (e) {
      log.warn('pdf failed', e?.message);
      flash('err', 'Could not build the PDF.');
    } finally {
      setPdfBusy(false);
    }
  };

  // Share = the all-apps OS share sheet (send the PDF to WhatsApp/Gmail/etc.),
  // as opposed to Download which saves it to a chosen folder.
  const sharePdf = async () => {
    setShareBusy(true);
    log.info('share: start');
    try {
      const res = await fetchWorkReportPdf(paramsOf());
      if (!res?.status || !res.data_b64) { flash('err', res?.message || 'Could not build the PDF.'); return; }
      const name = (res.file_name || 'Work_Report.pdf').split(/[\\/]/).pop();
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
    } catch (e) {
      log.warn('share failed', e?.message);
      flash('err', 'Could not share the PDF.');
    } finally {
      setShareBusy(false);
    }
  };

  const clientName = (() => {
    if (!clientId) return 'All clients';
    const c = clients.find((x) => x.id === clientId);
    return c ? c.name : 'All clients';
  })();

  const TaskRow = ({ t, showClient }) => (
    <View style={s.taskCard}>
      <View style={s.taskTop}>
        <Text style={s.taskRef}>{t.ref}</Text>
        {showHours ? <Text style={s.taskHours}>{t.hours_display}</Text> : null}
      </View>
      <Text style={s.taskName} numberOfLines={2}>{t.name}</Text>
      <Text style={s.taskMeta} numberOfLines={1}>
        {showClient && t.client_name ? `${t.client_name} · ` : ''}{t.project_name || '—'}
      </Text>
      <Text style={s.taskMeta2} numberOfLines={1}>
        {t.assignee || '—'} · Completed {t.completion_date}
      </Text>
    </View>
  );

  const Header = (
    <View>
      {/* Filters */}
      <View style={s.card}>
        <Text style={s.filterLbl}>Period</Text>
        <View style={s.pillWrap}>
          {PRESETS.map((p) => (
            <TouchableOpacity key={p.key} style={[s.pill, preset === p.key && s.pillOn]} onPress={() => choosePreset(p.key)} activeOpacity={0.85}>
              <Text style={[s.pillTxt, preset === p.key && s.pillTxtOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.dateRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.miniLbl}>From</Text>
            <TextInput
              style={s.dateInput} value={fromDate} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.faint}
              onChangeText={(t) => { setPreset('custom'); setFromDate(t); }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.miniLbl}>To</Text>
            <TextInput
              style={s.dateInput} value={toDate} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.faint}
              onChangeText={(t) => { setPreset('custom'); setToDate(t); }}
            />
          </View>
        </View>

        <View style={s.rowBetween}>
          <View style={s.toggle}>
            <TouchableOpacity style={[s.toggleBtn, groupBy === 'task' && s.toggleOn]} onPress={() => chooseGroup('task')} activeOpacity={0.85}>
              <Text style={[s.toggleTxt, groupBy === 'task' && s.toggleTxtOn]}>Task-wise</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.toggleBtn, groupBy === 'client' && s.toggleOn]} onPress={() => chooseGroup('client')} activeOpacity={0.85}>
              <Text style={[s.toggleTxt, groupBy === 'client' && s.toggleTxtOn]}>Client-wise</Text>
            </TouchableOpacity>
          </View>
          {ranOnce ? (
            <View style={s.hoursToggle}>
              <Text style={s.miniLbl}>Hours</Text>
              <Switch value={showHours} onValueChange={setShowHours} trackColor={{ true: COLORS.primary }} />
            </View>
          ) : null}
        </View>

        <Text style={[s.miniLbl, { marginTop: 12 }]}>Client</Text>
        <TouchableOpacity style={s.select} onPress={() => setPickClient(true)} activeOpacity={0.8}>
          <Text style={s.selectTxt} numberOfLines={1}>{clientName}</Text>
          <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
        </TouchableOpacity>

        <View style={s.actionRow}>
          <TouchableOpacity style={s.genBtn} onPress={() => generate()} disabled={generating} activeOpacity={0.9}>
            {generating ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="refresh" size={16} color="#fff" />}
            <Text style={s.genTxt}>Generate</Text>
          </TouchableOpacity>
          {ranOnce ? (
            <TouchableOpacity
              style={[s.pdfBtn, (pdfBusy || !result || result.total_tasks === 0) && { opacity: 0.5 }]}
              onPress={downloadPdf} disabled={pdfBusy || !result || result.total_tasks === 0} activeOpacity={0.9}
            >
              {pdfBusy ? <ActivityIndicator size="small" color={COLORS.primary} /> : <Ionicons name="document-text-outline" size={16} color={COLORS.primary} />}
              <Text style={s.pdfTxt}>PDF</Text>
            </TouchableOpacity>
          ) : null}
          {ranOnce ? (
            <TouchableOpacity
              style={[s.pdfBtn, (shareBusy || !result || result.total_tasks === 0) && { opacity: 0.5 }]}
              onPress={sharePdf} disabled={shareBusy || !result || result.total_tasks === 0} activeOpacity={0.9}
            >
              {shareBusy ? <ActivityIndicator size="small" color={COLORS.primary} /> : <Ionicons name="share-social-outline" size={16} color={COLORS.primary} />}
              <Text style={s.pdfTxt}>Share</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Totals */}
      {result && result.status !== false ? (
        <View style={s.totals}>
          <View style={s.badge}><Text style={s.badgeTxt}>{result.total_tasks} completed</Text></View>
          {showHours ? <View style={[s.badge, s.badgeAlt]}><Text style={s.badgeTxt}>{result.total_hours_display}</Text></View> : null}
          <Text style={s.range}>{result.from_date} → {result.to_date}</Text>
        </View>
      ) : null}

      {error ? <Text style={s.err}>{error}</Text> : null}
    </View>
  );

  // Client-wise → a collapsible card per client. Task-wise → a flat list of tasks.
  const listData = result
    ? (groupBy === 'client' ? (result.clients || []) : (result.tasks || []))
    : [];

  const renderItem = ({ item }) => {
    if (groupBy === 'client') {
      const open = !!expanded[item.client_id ?? item.client_name];
      const key = item.client_id ?? item.client_name;
      return (
        <View style={s.clientCard}>
          <TouchableOpacity style={s.clientHead} onPress={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))} activeOpacity={0.85}>
            <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={18} color={COLORS.muted} />
            <Text style={s.clientName} numberOfLines={1}>{item.client_name || '—'}</Text>
            <View style={s.clientBadge}>
              <Text style={s.clientBadgeTxt}>{item.task_count}{showHours ? ` · ${item.total_display}` : ''}</Text>
            </View>
          </TouchableOpacity>
          {open ? (item.tasks || []).map((t) => <TaskRow key={t.task_id} t={t} showClient={false} />) : null}
        </View>
      );
    }
    return <TaskRow t={item} showClient />;
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Work Report</Text>
        <View style={{ width: 40 }} />
      </View>

      {!!banner && (
        <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
            color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
        </View>
      )}

      <FlatList
        style={{ flex: 1 }}
        data={listData}
        keyExtractor={(it, i) => String(groupBy === 'client' ? (it.client_id ?? it.client_name ?? i) : (it.task_id ?? i))}
        renderItem={renderItem}
        ListHeaderComponent={Header}
        contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          !generating && result ? (
            <View style={s.emptyBox}>
              <Ionicons name="checkbox-outline" size={36} color={COLORS.faint} />
              <Text style={s.emptyTxt}>No completed tasks in this period.</Text>
            </View>
          ) : null
        }
      />

      {/* Client picker */}
      <Modal visible={pickClient} transparent animationType="fade" onRequestClose={() => setPickClient(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPickClient(false)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Select client</Text>
              <TouchableOpacity onPress={() => setPickClient(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={[{ id: false, name: 'All clients' }, ...clients]}
              keyExtractor={(c) => String(c.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = item.id === clientId;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} onPress={() => chooseClient(item.id)} activeOpacity={0.8}>
                    <Text style={s.ccRowName}>{item.name}</Text>
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy, marginHorizontal: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 6, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 },
  bannerOk: { backgroundColor: COLORS.greenBg },
  bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, ...SHADOW },
  filterLbl: { fontSize: 12, fontWeight: '800', color: COLORS.muted, marginBottom: 8 },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  pillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pillTxt: { fontSize: 12, fontWeight: '700', color: COLORS.muted },
  pillTxtOn: { color: '#fff' },

  dateRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  miniLbl: { fontSize: 11, fontWeight: '700', color: COLORS.muted, marginBottom: 5 },
  dateInput: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 42, paddingHorizontal: 10, fontSize: 14, color: COLORS.ink, backgroundColor: '#fff' },

  rowBetween: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 14 },
  toggle: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, overflow: 'hidden' },
  toggleBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff' },
  toggleOn: { backgroundColor: COLORS.primary },
  toggleTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted },
  toggleTxtOn: { color: '#fff' },
  hoursToggle: { alignItems: 'center' },

  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 44, backgroundColor: '#fff' },
  selectTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  genBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primary, borderRadius: 10, paddingVertical: 11 },
  genTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
  pdfBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 18, backgroundColor: '#fff' },
  pdfTxt: { color: COLORS.primary, fontWeight: '800', fontSize: 13.5 },

  totals: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  badge: { backgroundColor: '#E0E7FF', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  badgeAlt: { backgroundColor: '#DCFCE7' },
  badgeTxt: { fontSize: 12, fontWeight: '800', color: COLORS.ink },
  range: { fontSize: 11.5, color: COLORS.muted, fontWeight: '700' },
  err: { color: COLORS.red, fontSize: 13, marginBottom: 10 },

  taskCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 12, marginBottom: 8 },
  taskTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  taskRef: { fontSize: 12, fontWeight: '900', color: COLORS.primary },
  taskHours: { fontSize: 12, fontWeight: '800', color: COLORS.ink },
  taskName: { fontSize: 14, fontWeight: '700', color: COLORS.ink, marginTop: 4 },
  taskMeta: { fontSize: 12, color: COLORS.muted, marginTop: 4 },
  taskMeta2: { fontSize: 11.5, color: COLORS.faint, marginTop: 2 },

  clientCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, marginBottom: 8, overflow: 'hidden' },
  clientHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  clientName: { flex: 1, fontSize: 14, fontWeight: '900', color: COLORS.ink },
  clientBadge: { backgroundColor: COLORS.line, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  clientBadgeTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyTxt: { fontSize: 13.5, color: COLORS.muted, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  modalSheet: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 20, maxHeight: '70%', paddingBottom: 12, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  ccRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },
});
