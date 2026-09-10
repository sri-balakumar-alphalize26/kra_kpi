// KRA Report — the mobile counterpart of the Odoo web screen
// (static/src/components/kpi_kra_report/kpi_kra_report.js), matching it feature
// for feature: multi-select Employee and KRA filters with KRA exclusion, Type and
// State filters, live per-option counts, a stale-filter guard, row trimming, and
// the PDF / Excel / ZIP exports.
//
// The documents are built ON THE DEVICE by utils/kraExport.js — the same jsPDF,
// jspdf-autotable, JSZip and ExcelJS code the web runs in the browser. There is no
// server-side render to fetch, so this screen only ever fetches DATA and then
// hands a `ctx` object to those builders.
//
// Structure deliberately mirrors screens/WorkReport.js: same shell, same banner,
// one FlatList with the whole filter card in ListHeaderComponent. The one place it
// departs is the filter pickers — see MultiSelectPicker below.

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// SDK 54: the classic writeAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import DateGridModal from '../components/DateGridModal';
import { fmtYMD } from '../utils/dateGrid';
import { fetchKraFilters, fetchKraReport, fetchKraFilterCounts } from '../services/kraReport';
import {
  typeStyle, totalTimeWorked, uniqueEmployeeCount, makeReportPdf, makeReportExcel, makeReportZip,
} from '../utils/kraExport';
import * as H from '../utils/haptics';
import { createLogger } from '../api/logger';

const log = createLogger('KraReport');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This Week' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'custom', label: 'Custom' },
];

function presetRange(key) {
  const now = new Date();
  const sod = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (key === 'today') return { from: fmtYMD(sod(now)), to: fmtYMD(sod(now)) };
  if (key === 'this_week') {
    const dow = (now.getDay() + 6) % 7;  // Mon = 0
    return { from: fmtYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)), to: fmtYMD(sod(now)) };
  }
  if (key === 'this_month') return { from: fmtYMD(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmtYMD(sod(now)) };
  if (key === 'last_month') {
    return {
      from: fmtYMD(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: fmtYMD(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return null;  // custom
}

// The Type badge, taken from the SAME palette the PDF and the spreadsheet use
// (utils/kraExport.js) rather than a second set of hex codes here — so a REQ badge
// on screen is the exact colour of the REQ badge in the exported file.
function badgeColours(taskType) {
  const st = typeStyle(taskType);
  return { bg: `rgb(${st.rgb.join(',')})`, fg: `rgb(${st.text.join(',')})` };
}

// Counts arrive from JSON-RPC with their integer keys turned into strings, so
// every lookup goes through String(). Absent means nothing matched, i.e. 0 rather
// than "unknown" — the web makes the same call.
const countOf = (counts, id) => (counts || {})[String(id)] || 0;

/**
 * One checkbox list, shared by the KRA / Employee / Type / State filters.
 *
 * Deliberately a Modal rather than the absolutely-positioned dropdown the board
 * uses (FilterDropdown in KpiActionBoard.js): this screen puts its filters inside
 * a FlatList ListHeaderComponent, where an absolute panel is clipped by the list.
 * It is also strictly single-select, which is the thing this screen cannot be.
 *
 * `onToggleExcept` is passed only by the KRA filter — it is what renders the ⊘
 * column, so the other three get no exclude affordance at all.
 */
function MultiSelectPicker({
  visible, title, options, counts, selected, excluded,
  onToggle, onToggleExcept, onClear, onClose,
}) {
  const isSel = (id) => selected.includes(id);
  const isExc = (id) => (excluded || []).includes(id);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
          <View style={s.modalHead}>
            <Text style={s.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={s.pickerBar}>
            <Text style={s.pickerCount}>
              {selected.length ? `${selected.length} selected` : 'All'}
              {(excluded || []).length ? ` · ${excluded.length} excluded` : ''}
            </Text>
            <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.pickerClear}>Clear</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            data={options}
            keyExtractor={(o) => String(o.id)}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const n = countOf(counts, item.id);
              const sel = isSel(item.id);
              const exc = isExc(item.id);
              // Zero-count rows stay in place, greyed, rather than disappearing —
              // a list that reshuffles itself as you tick things is far harder to
              // work through than one where a dead end is simply dim.
              const dead = n === 0 && !sel && !exc;
              return (
                <View style={[s.optRow, sel && s.optRowOn, dead && s.optRowDead]}>
                  <TouchableOpacity
                    style={s.optMain}
                    activeOpacity={dead ? 1 : 0.7}
                    disabled={dead}
                    onPress={() => { H.select(); onToggle(item.id); }}
                  >
                    <Ionicons
                      name={sel ? 'checkbox' : 'square-outline'}
                      size={19}
                      color={sel ? COLORS.primary : COLORS.faint}
                    />
                    <Text
                      style={[
                        s.optName,
                        exc && s.optNameExc,
                        // `level` indents a child KRA. The server also sends a
                        // pre-indented display_name for a flat HTML <select>;
                        // it is ignored here in favour of real indentation.
                        item.level ? { marginLeft: 10 * item.level } : null,
                      ]}
                      numberOfLines={2}
                    >
                      {item.level ? '↳ ' : ''}{item.name}
                    </Text>
                    <Text style={s.optCount}>{n}</Text>
                  </TouchableOpacity>
                  {onToggleExcept ? (
                    <TouchableOpacity
                      style={[s.optExcept, exc && s.optExceptOn]}
                      onPress={() => { H.select(); onToggleExcept(item.id); }}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                    >
                      <Text style={[s.optExceptTxt, exc && s.optExceptTxtOn]}>⊘</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            }}
            ListEmptyComponent={<Text style={s.optEmpty}>Nothing to choose from.</Text>}
          />
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

export default function KraReport({ onBack }) {
  const init = presetRange('this_month');

  const [preset, setPreset] = useState('this_month');
  const [datePick, setDatePick] = useState(null);      // { field: 'from'|'to' } | null
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate, setToDate] = useState(init.to);

  // Filter OPTIONS, and the live counts that hang off them.
  const [kras, setKras] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [taskTypes, setTaskTypes] = useState([]);
  const [taskStates, setTaskStates] = useState([]);
  const [counts, setCounts] = useState({ kras: {}, employees: {}, task_types: {}, task_states: {} });

  // Filter SELECTIONS.
  const [kraIds, setKraIds] = useState([]);
  const [excludedKraIds, setExcludedKraIds] = useState([]);
  const [employeeIds, setEmployeeIds] = useState([]);
  const [types, setTypes] = useState([]);
  const [states, setStates] = useState([]);
  const [picker, setPicker] = useState(null);          // 'kra' | 'employee' | 'type' | 'state' | null

  // Results.
  const [rows, setRows] = useState(null);              // null until the first Generate
  const [appliedFilters, setAppliedFilters] = useState({});
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [generatedSignature, setGeneratedSignature] = useState(null);

  const [search, setSearch] = useState('');
  const [removedRowIds, setRemovedRowIds] = useState([]);

  const [exporting, setExporting] = useState(null);    // 'pdf' | 'excel' | 'zip' | null
  const [zipMenu, setZipMenu] = useState(false);
  const [zipStep, setZipStep] = useState(null);        // { done, total }
  const [banner, setBanner] = useState(null);

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };

  // ---- Filter identity, and the stale guard built on it --------------------
  // Ids are sorted so ticking A-then-B reads the same as B-then-A. time_frame is
  // deliberately absent: it only ever writes from/to, which are compared already.
  const signature = useMemo(() => JSON.stringify({
    from_date: fromDate,
    to_date: toDate,
    employee_ids: [...employeeIds].sort((a, b) => a - b),
    kra_ids: [...kraIds].sort((a, b) => a - b),
    excluded_kra_ids: [...excludedKraIds].sort((a, b) => a - b),
    task_types: [...types].sort(),
    task_states: [...states].sort(),
  }), [fromDate, toDate, employeeIds, kraIds, excludedKraIds, types, states]);

  const isStale = rows !== null && signature !== generatedSignature;

  const paramsOf = useCallback(() => ({
    from_date: fromDate,
    to_date: toDate,
    employee_ids: employeeIds,
    kra_ids: kraIds,
    excluded_kra_ids: excludedKraIds,
    task_types: types,
    task_states: states,
  }), [fromDate, toDate, employeeIds, kraIds, excludedKraIds, types, states]);

  // ---- Options load once; counts follow every filter change ---------------
  useEffect(() => {
    (async () => {
      const res = await fetchKraFilters();
      setKras(res.kras || []);
      setEmployees(res.employees || []);
      setTaskTypes(res.task_types || []);
      setTaskStates(res.task_states || []);
    })().catch((e) => log.warn('filters failed', e?.message));
  }, []);

  // Debounced, and guarded against a slower earlier reply overwriting a newer
  // one — ticking three boxes quickly fires three requests that can land in any
  // order, and the counts would then describe a selection nobody is looking at.
  const sigRef = useRef(signature);
  sigRef.current = signature;
  useEffect(() => {
    const issuedFor = signature;
    const t = setTimeout(async () => {
      const res = await fetchKraFilterCounts(paramsOf());
      if (!res.status || issuedFor !== sigRef.current) return;
      setCounts({
        kras: res.kras, employees: res.employees,
        task_types: res.task_types, task_states: res.task_states,
      });
    }, 250);
    return () => clearTimeout(t);
  }, [signature, paramsOf]);

  // ---- Filter toggles ------------------------------------------------------
  const toggleIn = (list, value) => (
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
  );

  // Include and exclude are mutually cancelling, in both directions — a KRA that
  // is both would be a contradiction the server has to break arbitrarily.
  const toggleKra = (id) => {
    setKraIds((prev) => {
      const next = toggleIn(prev, id);
      if (next.includes(id)) setExcludedKraIds((ex) => ex.filter((x) => x !== id));
      return next;
    });
  };
  const toggleKraExcept = (id) => {
    setExcludedKraIds((prev) => {
      const next = toggleIn(prev, id);
      if (next.includes(id)) setKraIds((inc) => inc.filter((x) => x !== id));
      return next;
    });
  };

  // ---- Generate ------------------------------------------------------------
  const generate = useCallback(async () => {
    H.tap();
    setGenerating(true);
    setError(null);
    try {
      const res = await fetchKraReport(paramsOf());
      if (res.status === false) {
        setError(res.message || 'Could not generate the report.');
        setRows(null);
        return;
      }
      setRows(res.data || []);
      setAppliedFilters(res.filters || {});
      setGeneratedSignature(signature);
      // A fresh report has nothing trimmed out of it yet.
      setRemovedRowIds([]);
      log.info('generated', { rows: (res.data || []).length });
    } catch (e) {
      log.warn('generate failed', e?.message);
      setError(e?.message || 'Could not generate the report.');
    } finally {
      setGenerating(false);
    }
  }, [paramsOf, signature]);

  // ---- The rows everything downstream reads -------------------------------
  // Every total, the summary, the table and all three exports go through here,
  // so a trimmed row cannot leave a stale number behind anywhere.
  const visibleRows = useMemo(() => {
    const kept = removedRowIds.length
      ? (rows || []).filter((r) => !removedRowIds.includes(r.id))
      : (rows || []);
    const q = search.trim().toLowerCase();
    if (!q) return kept;
    return kept.filter((r) =>
      (r.kra_path || '').toLowerCase().includes(q)
      || (r.sub_kra || '').toLowerCase().includes(q)
      || (r.kpi_name || '').toLowerCase().includes(q)
      || (r.employee_name || '').toLowerCase().includes(q)
      || (r.task_type || '').toLowerCase().includes(q)
      || (r.task_state_label || '').toLowerCase().includes(q));
  }, [rows, removedRowIds, search]);

  // What the document builders need. Assembled here so the three export handlers
  // cannot each build a subtly different one.
  const exportCtx = useCallback(() => ({
    rows: visibleRows,
    fromDate,
    toDate,
    applied: appliedFilters,
    search: search.trim(),
    removedCount: removedRowIds.length,
  }), [visibleRows, fromDate, toDate, appliedFilters, search, removedRowIds]);

  // ---- Saving a built document --------------------------------------------
  // The recipe the app already uses in six places: ask WHERE first on Android and
  // write nothing until a folder is chosen, otherwise cache it and offer the
  // share sheet, which is where "Save to Files" lives on iOS.
  async function save({ filename, mimeType, data_b64 }) {
    const name = String(filename).split(/[\\/]/).pop();
    const SAF = FileSystem.StorageAccessFramework;
    if (Platform.OS === 'android' && SAF) {
      const perm = await SAF.requestDirectoryPermissionsAsync();
      if (!perm.granted) { flash('err', 'Download cancelled — no folder chosen'); return; }
      // SAF re-appends the extension from the mime type, so hand it the bare
      // name or the file lands as "X.zip.zip".
      const dot = name.lastIndexOf('.');
      const bare = dot > 0 ? name.slice(0, dot) : name;
      const uri = await SAF.createFileAsync(perm.directoryUri, bare, mimeType);
      await FileSystem.writeAsStringAsync(uri, data_b64, { encoding: FileSystem.EncodingType.Base64 });
      log.info('saved via SAF', { name });
      flash('ok', `Saved ${name}`);
      return;
    }
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    const uri = `${dir}${name}`;
    await FileSystem.writeAsStringAsync(uri, data_b64, { encoding: FileSystem.EncodingType.Base64 });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType, dialogTitle: `Save ${name}` });
      flash('ok', `${name} ready`);
    } else {
      flash('err', 'Saving is not available on this device.');
    }
  }

  async function runExport(kind, build) {
    if (exporting) return;
    H.tap();
    setExporting(kind);
    try {
      await save(await build());
    } catch (e) {
      log.error(`${kind} export failed`, e?.message);
      flash('err', e?.message || `Could not build the ${kind.toUpperCase()}.`);
    } finally {
      setExporting(null);
      setZipStep(null);
    }
  }

  const downloadPdf = () => runExport('pdf', async () => makeReportPdf(exportCtx()));
  const downloadExcel = () => runExport('excel', () => makeReportExcel(exportCtx()));
  const downloadZip = (include) => {
    setZipMenu(false);
    return runExport('zip', () => makeReportZip(exportCtx(), include, (done, total) => setZipStep({ done, total })));
  };

  // ---- Derived display -----------------------------------------------------
  const summaryLabel = (list, all) => (list.length ? `${list.length} selected` : all);
  const kraLabel = kraIds.length || excludedKraIds.length
    ? `${kraIds.length || 'All'} selected${excludedKraIds.length ? ` · ${excludedKraIds.length} excluded` : ''}`
    : 'All KRAs';

  const exportsDisabled = !!exporting || isStale || !visibleRows.length;

  const FilterButton = ({ label, value, onPress }) => (
    <View style={{ marginTop: 12 }}>
      <Text style={s.miniLbl}>{label}</Text>
      <TouchableOpacity style={s.select} onPress={() => { H.select(); onPress(); }} activeOpacity={0.8}>
        <Text style={s.selectTxt} numberOfLines={1}>{value}</Text>
        <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
      </TouchableOpacity>
    </View>
  );

  const Header = (
    <View>
      <View style={s.card}>
        <Text style={s.filterLbl}>Period</Text>
        <View style={s.pillWrap}>
          {PRESETS.map((p) => (
            <TouchableOpacity key={p.key} style={[s.pill, preset === p.key && s.pillOn]}
              onPress={() => {
                H.select();
                setPreset(p.key);
                const r = presetRange(p.key);
                if (r) { setFromDate(r.from); setToDate(r.to); }
              }} activeOpacity={0.85}>
              <Text style={[s.pillTxt, preset === p.key && s.pillTxtOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={s.dateRow}>
          {['from', 'to'].map((field) => (
            <View key={field} style={{ flex: 1 }}>
              <Text style={s.miniLbl}>{field === 'from' ? 'From' : 'To'}</Text>
              <TouchableOpacity style={s.dateBtn} activeOpacity={0.8}
                onPress={() => setDatePick({ field })}>
                <Text style={s.dateBtnTxt} numberOfLines={1}>
                  {(field === 'from' ? fromDate : toDate) || 'Pick a date'}
                </Text>
                <Ionicons name="calendar-outline" size={16} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        <FilterButton label="KRA" value={kraLabel} onPress={() => setPicker('kra')} />
        <FilterButton label="Employee" value={summaryLabel(employeeIds, 'All Employees')} onPress={() => setPicker('employee')} />
        <FilterButton label="Type" value={types.length ? types.join(', ') : 'All Types'} onPress={() => setPicker('type')} />
        <FilterButton label="State" value={summaryLabel(states, 'All States')} onPress={() => setPicker('state')} />

        <View style={s.actionRow}>
          <TouchableOpacity style={s.genBtn} onPress={generate} disabled={generating} activeOpacity={0.9}>
            {generating ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="refresh" size={16} color="#fff" />}
            <Text style={s.genTxt}>Generate</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* The guard. Without it you can move a filter, download, and hand someone a
          file whose contents do not match the screen it came from. */}
      {isStale ? (
        <View style={s.staleBar}>
          <Ionicons name="alert-circle" size={15} color="#92400E" />
          <Text style={s.staleTxt}>Filters changed — Generate again before downloading.</Text>
        </View>
      ) : null}

      {error ? <Text style={s.err}>{error}</Text> : null}

      {rows !== null && !error ? (
        <>
          <View style={s.totals}>
            <View style={s.badge}><Text style={s.badgeTxt}>{visibleRows.length} tasks</Text></View>
            <View style={[s.badge, s.badgeAlt]}><Text style={s.badgeTxt}>{totalTimeWorked(visibleRows)}</Text></View>
            <View style={s.badge}><Text style={s.badgeTxt}>{uniqueEmployeeCount(visibleRows)} employees</Text></View>
          </View>

          {/* Exactly which filters produced what is on screen, in the server's own
              words — the same line that heads the PDF and both spreadsheet tabs. */}
          <Text style={s.scope} numberOfLines={3}>
            Showing {appliedFilters.kra_name || 'All KRAs'} · {appliedFilters.employee_name || 'All Employees'}
            {' · '}{appliedFilters.task_type_name || 'All Types'} · {appliedFilters.task_state_name || 'All States'}
            {'\n'}{appliedFilters.from_date} → {appliedFilters.to_date}
          </Text>

          <View style={s.searchRow}>
            <Ionicons name="search" size={16} color={COLORS.faint} />
            <TextInput
              style={s.searchInput}
              placeholder="Filter these rows…"
              placeholderTextColor={COLORS.faint}
              value={search}
              onChangeText={setSearch}
            />
            {search ? (
              <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={16} color={COLORS.faint} />
              </TouchableOpacity>
            ) : null}
          </View>

          {removedRowIds.length ? (
            <View style={s.trimBar}>
              <Text style={s.trimTxt}>
                {removedRowIds.length} row{removedRowIds.length === 1 ? '' : 's'} removed from this report —
                the tasks themselves are untouched.
              </Text>
              <TouchableOpacity onPress={() => { H.select(); setRemovedRowIds([]); }}>
                <Text style={s.trimLink}>Restore all</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={s.actionRow}>
            <TouchableOpacity style={[s.pdfBtn, exportsDisabled && { opacity: 0.5 }]}
              onPress={downloadPdf} disabled={exportsDisabled} activeOpacity={0.9}>
              {exporting === 'pdf' ? <ActivityIndicator size="small" color={COLORS.primary} />
                : <Ionicons name="document-text-outline" size={16} color={COLORS.primary} />}
              <Text style={s.pdfTxt}>PDF</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.pdfBtn, exportsDisabled && { opacity: 0.5 }]}
              onPress={downloadExcel} disabled={exportsDisabled} activeOpacity={0.9}>
              {exporting === 'excel' ? <ActivityIndicator size="small" color={COLORS.primary} />
                : <Ionicons name="grid-outline" size={16} color={COLORS.primary} />}
              <Text style={s.pdfTxt}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.pdfBtn, exportsDisabled && { opacity: 0.5 }]}
              onPress={() => { H.select(); setZipMenu(true); }} disabled={exportsDisabled} activeOpacity={0.9}>
              {exporting === 'zip' ? <ActivityIndicator size="small" color={COLORS.primary} />
                : <Ionicons name="archive-outline" size={16} color={COLORS.primary} />}
              <Text style={s.pdfTxt}>ZIP</Text>
            </TouchableOpacity>
          </View>

          {/* Hundreds of per-task PDFs take far longer on a phone than in a
              browser, and a screen that just sits there reads as a crash. */}
          {zipStep ? (
            <Text style={s.zipProgress}>
              Building {zipStep.done} of {zipStep.total} files…
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );

  const renderRow = ({ item, index }) => {
    const c = badgeColours(item.task_type);
    return (
      <View style={s.taskCard}>
        <View style={s.taskTop}>
          <Text style={s.taskRef}>{item.external_ref || `#${index + 1}`}</Text>
          <View style={[s.typeBadge, { backgroundColor: c.bg }]}>
            <Text style={[s.typeBadgeTxt, { color: c.fg }]}>{item.task_type || '—'}</Text>
          </View>
          <Text style={s.taskHours}>{item.time_worked_display}</Text>
          <TouchableOpacity onPress={() => {
            H.select();
            setRemovedRowIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
          }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close-circle-outline" size={17} color={COLORS.faint} />
          </TouchableOpacity>
        </View>
        <Text style={s.taskName} numberOfLines={2}>{item.kpi_name}</Text>
        <Text style={s.taskMeta} numberOfLines={1}>{item.kra_path}</Text>
        <Text style={s.taskMeta2} numberOfLines={1}>
          {item.employee_name || 'Unassigned'} · {item.task_state_label || '—'}
        </Text>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>KRA Report</Text>
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
        data={visibleRows}
        keyExtractor={(it, i) => String(it.id ?? i)}
        renderItem={renderRow}
        ListHeaderComponent={Header}
        contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          !generating && rows !== null ? (
            <View style={s.emptyBox}>
              <Ionicons name="clipboard-outline" size={36} color={COLORS.faint} />
              <Text style={s.emptyTxt}>
                {rows.length ? 'Nothing matches that search.' : 'No tasks for these filters.'}
              </Text>
            </View>
          ) : null
        }
      />

      <MultiSelectPicker
        visible={picker === 'kra'}
        title="Select KRAs"
        options={kras}
        counts={counts.kras}
        selected={kraIds}
        excluded={excludedKraIds}
        onToggle={toggleKra}
        onToggleExcept={toggleKraExcept}
        onClear={() => { setKraIds([]); setExcludedKraIds([]); }}
        onClose={() => setPicker(null)}
      />
      <MultiSelectPicker
        visible={picker === 'employee'}
        title="Select employees"
        options={employees}
        counts={counts.employees}
        selected={employeeIds}
        onToggle={(id) => setEmployeeIds((p) => toggleIn(p, id))}
        onClear={() => setEmployeeIds([])}
        onClose={() => setPicker(null)}
      />
      <MultiSelectPicker
        visible={picker === 'type'}
        title="Select types"
        options={taskTypes}
        counts={counts.task_types}
        selected={types}
        onToggle={(id) => setTypes((p) => toggleIn(p, id))}
        onClear={() => setTypes([])}
        onClose={() => setPicker(null)}
      />
      <MultiSelectPicker
        visible={picker === 'state'}
        title="Select states"
        options={taskStates}
        counts={counts.task_states}
        selected={states}
        onToggle={(id) => setStates((p) => toggleIn(p, id))}
        onClear={() => setStates([])}
        onClose={() => setPicker(null)}
      />

      {/* The ZIP menu picks the FLAVOUR of the archive, not merely extras: asking
          for Excel used to still bury one workbook under a PDF per task. */}
      <Modal visible={zipMenu} transparent animationType="fade" onRequestClose={() => setZipMenu(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setZipMenu(false)}>
          <TouchableOpacity style={[s.modalSheet, { maxHeight: undefined }]} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Download ZIP</Text>
              <TouchableOpacity onPress={() => setZipMenu(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {[
              { key: 'pdf', title: 'PDF pack', hint: 'Full report, one summary per project, and a PDF per task.', include: { pdf: true } },
              { key: 'excel', title: 'Excel pack', hint: 'Full workbook plus one workbook per project.', include: { excel: true } },
              { key: 'both', title: 'Both packs', hint: 'Everything above, in one archive.', include: { pdf: true, excel: true } },
            ].map((o) => (
              <TouchableOpacity key={o.key} style={s.zipItem} onPress={() => downloadZip(o.include)} activeOpacity={0.8}>
                <Text style={s.zipItemTitle}>{o.title}</Text>
                <Text style={s.zipItemHint}>{o.hint}</Text>
              </TouchableOpacity>
            ))}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {datePick ? (
        <DateGridModal
          title={datePick.field === 'from' ? 'Report from' : 'Report to'}
          value={datePick.field === 'from' ? fromDate : toDate}
          // Keep the range the right way round while choosing rather than
          // rejecting it afterwards — a backwards range returns an empty report
          // with no clue as to why.
          maxDate={datePick.field === 'from' ? (toDate || undefined) : undefined}
          minDate={datePick.field === 'to' ? (fromDate || undefined) : undefined}
          onCancel={() => setDatePick(null)}
          onPick={(iso) => {
            const field = datePick.field;
            setDatePick(null);
            setPreset('custom');
            if (field === 'from') setFromDate(iso); else setToDate(iso);
          }}
        />
      ) : null}
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
  dateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 42, paddingHorizontal: 10, backgroundColor: '#fff' },
  dateBtnTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },

  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 44, backgroundColor: '#fff' },
  selectTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  genBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primary, borderRadius: 10, paddingVertical: 11 },
  genTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
  pdfBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingVertical: 11, backgroundColor: '#fff' },
  pdfTxt: { color: COLORS.primary, fontWeight: '800', fontSize: 13.5 },

  staleBar: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.amberBg, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 10 },
  staleTxt: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#92400E' },

  totals: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  badge: { backgroundColor: '#E0E7FF', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  badgeAlt: { backgroundColor: '#DCFCE7' },
  badgeTxt: { fontSize: 12, fontWeight: '800', color: COLORS.ink },
  scope: { fontSize: 11.5, color: COLORS.muted, fontWeight: '600', marginBottom: 10, lineHeight: 16 },
  err: { color: COLORS.red, fontSize: 13, marginBottom: 10 },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 42, backgroundColor: '#fff', marginBottom: 10 },
  searchInput: { flex: 1, fontSize: 13.5, color: COLORS.ink },

  trimBar: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FEF3C7', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 10 },
  trimTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: '#92400E' },
  trimLink: { fontSize: 11.5, fontWeight: '900', color: COLORS.primary },

  zipProgress: { fontSize: 11.5, color: COLORS.muted, fontWeight: '700', marginTop: 8 },

  taskCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 12, marginBottom: 8 },
  taskTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  taskRef: { fontSize: 12, fontWeight: '900', color: COLORS.primary },
  typeBadge: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  typeBadgeTxt: { fontSize: 10.5, fontWeight: '900' },
  taskHours: { flex: 1, textAlign: 'right', fontSize: 12, fontWeight: '800', color: COLORS.ink },
  taskName: { fontSize: 14, fontWeight: '700', color: COLORS.ink, marginTop: 6 },
  taskMeta: { fontSize: 12, color: COLORS.muted, marginTop: 4 },
  taskMeta2: { fontSize: 11.5, color: COLORS.faint, marginTop: 2 },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyTxt: { fontSize: 13.5, color: COLORS.muted, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  modalSheet: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 20, maxHeight: '75%', paddingBottom: 12, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },

  pickerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#F8FAFF' },
  pickerCount: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted },
  pickerClear: { fontSize: 11.5, fontWeight: '900', color: COLORS.primary },

  optRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  optRowOn: { backgroundColor: '#F0F5FF' },
  optRowDead: { opacity: 0.4 },
  optMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 13 },
  optName: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  optNameExc: { textDecorationLine: 'line-through', color: COLORS.muted },
  // Tabular figures so a column of counts lines up rather than jittering.
  optCount: { fontSize: 11.5, fontWeight: '800', color: COLORS.faint, fontVariant: ['tabular-nums'] },
  optExcept: { paddingHorizontal: 14, paddingVertical: 13 },
  optExceptOn: { backgroundColor: COLORS.redBg },
  optExceptTxt: { fontSize: 15, fontWeight: '900', color: COLORS.faint },
  optExceptTxtOn: { color: COLORS.red },
  optEmpty: { fontSize: 13, color: COLORS.muted, textAlign: 'center', paddingVertical: 30 },

  zipItem: { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  zipItemTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.ink },
  zipItemHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 3 },
});
