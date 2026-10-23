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
  ActivityIndicator, Modal, Platform, ScrollView, StatusBar as RNStatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// SDK 54: the classic writeAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import DateGridModal from '../components/DateGridModal';
import { fmtYMD } from '../utils/dateGrid';
import {
  fetchKraFilters, fetchKraReport, fetchKraFilterCounts, fetchKraContext, saveKraState,
  fetchDownloadHistory, fetchStoredDownload, deleteStoredDownload, saveBuiltDownload,
} from '../services/kraReport';
import {
  typeStyle, totalTimeWorked, uniqueEmployeeCount, projectSummary,
  selectDownloadRows, weekKey, makeReportPdf, makeReportExcel, makeReportZip,
} from '../utils/kraExport';
import { createKpi, logManualTime, findNameMatches } from '../services/kraKpi';
import {
  validateNewTask, toSeconds, DOC_TYPES, prefixForDocType,
} from '../utils/newTaskValidation';
import { DELIVERABLE_TYPES, needsOtherText, DELIVERABLE_OTHER_MAX, DELIVERABLE_OTHER_PLACEHOLDER } from '../utils/deliverableType';
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

  // The working view's own edits, made on the web and now honoured here too:
  // employee_id -> the name to show INSTEAD of the real one, and tasks that
  // exist in this report and nowhere else.
  const [nameOverrides, setNameOverrides] = useState({});
  const [localRows, setLocalRows] = useState([]);
  // The on-screen KRA Summary. Open by default, as on the web.
  const [summaryOpen, setSummaryOpen] = useState(true);
  // Download options, asked AFTER the format is chosen (the ZIP menu picks the
  // flavour first, so this is the second question, not a replacement for it).
  // `include` is carried through untouched for the ZIP.
  const [dl, setDl] = useState(null);   // { kind, include, scope, employeeIds, period, day, week, month, sort, workedOnly }
  const [dlPicker, setDlPicker] = useState(null);   // 'employee' | 'period' | 'sort'
  // "Clear the report" confirm — it discards work that exists nowhere else.
  const [clearOpen, setClearOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // New Task. `nt` null = sheet closed. `ntMatches` is the advisory duplicate-name
  // hint; `ntCreatedId` survives a half-failed submit — see submitNewTask.
  const [nt, setNt] = useState(null);
  const [ntMatches, setNtMatches] = useState([]);
  const [ntBusy, setNtBusy] = useState(false);
  const [ntPicker, setNtPicker] = useState(null);   // 'kra' | 'user' | 'type' | 'priority'
  const [ntDate, setNtDate] = useState(false);
  const ntCreatedId = useRef(0);
  // A task was created but this report's filters hide it. { id, name }.
  const [createdHidden, setCreatedHidden] = useState(null);
  // Reports the WEB saved. null = sheet closed.
  const [history, setHistory] = useState(null);
  const [histBusy, setHistBusy] = useState(0);

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

  // Restoring the saved working view. `restored` gates the save effect — without
  // it the first render would persist an empty state over whatever was stored.
  const [restored, setRestored] = useState(false);
  // Keys of the saved view this screen does not itself use — the web keeps report
  // renames and report-only rows in the SAME res.users field. Held and written
  // back untouched, so saving from the phone cannot silently wipe work someone
  // did in the browser.
  const savedExtras = useRef({});
  const wantGenerate = useRef(false);

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

  // ---- Restore the working view, once ------------------------------------
  useEffect(() => {
    (async () => {
      const ctx = await fetchKraContext();
      // Already in the payload and thrown away until now. It gates the New Task
      // button, matching the web — note the server does NOT re-check it on
      // create_kpi, so this is parity, not a security boundary.
      setIsAdmin(!!ctx.is_admin);
      let saved = null;
      try { saved = ctx.saved_state ? JSON.parse(ctx.saved_state) : null; } catch (_) { saved = null; }
      if (saved && typeof saved === 'object') {
        const f = saved.filters || {};
        if (f.from_date) setFromDate(f.from_date);
        if (f.to_date) setToDate(f.to_date);
        if (f.from_date || f.to_date) setPreset('custom');
        setEmployeeIds(f.employee_ids || []);
        setKraIds(f.kra_ids || []);
        setExcludedKraIds(f.excluded_kra_ids || []);
        setTypes(f.task_types || []);
        setStates(f.task_states || []);
        setSearch(saved.searchQuery || '');
        setRemovedRowIds(saved.removedRowIds || []);
        // Two parts of the working view the screen used to hold and ignore. Both
        // are made on the web, and the phone round-tripped them untouched while
        // rendering as though they did not exist — so the same saved report
        // showed a smaller task count, a smaller grand TOTAL and fewer files in
        // the ZIP depending on which screen you opened it from.
        setNameOverrides(saved.nameOverrides || {});
        setLocalRows(saved.localRows || []);
        // Everything this screen does not own, kept verbatim.
        const {
          filters, searchQuery, removedRowIds, generatedSignature,
          nameOverrides: _n, localRows: _l, ...rest
        } = saved;
        savedExtras.current = rest;
        // Re-run rather than restoring the rows themselves: the report is a view
        // of live data, and handing back a week-old copy of it under today's
        // filters is a quieter kind of wrong than showing nothing.
        wantGenerate.current = !!saved.generatedSignature;
      }
      setRestored(true);
    })().catch((e) => { log.warn('restore failed', e?.message); setRestored(true); });
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

  // ---- Persist the working view ------------------------------------------
  // Debounced, fire-and-forget, and gated on `restored` — without that gate the
  // first render would write an empty view over whatever was stored.
  //
  // savedExtras goes in FIRST so this screen's own keys win: it carries the web's
  // report renames and report-only rows, which must survive a save from the phone
  // untouched rather than being dropped because this screen has no use for them.
  useEffect(() => {
    if (!restored) return undefined;
    const t = setTimeout(() => {
      saveKraState(JSON.stringify({
        ...savedExtras.current,
        filters: {
          from_date: fromDate,
          to_date: toDate,
          employee_ids: employeeIds,
          kra_ids: kraIds,
          excluded_kra_ids: excludedKraIds,
          task_types: types,
          task_states: states,
        },
        searchQuery: search,
        removedRowIds,
        // Written back from real state now, not carried blind through
        // savedExtras — otherwise the first save from the phone after a restore
        // would still be echoing whatever was read, and any future edit made
        // here could not survive.
        nameOverrides,
        localRows,
        generatedSignature,
      }));
    }, 600);
    return () => clearTimeout(t);
  }, [restored, fromDate, toDate, employeeIds, kraIds, excludedKraIds, types, states,
      search, removedRowIds, generatedSignature]);

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
  // `over` lets a caller run with filter values React has not flushed yet — the
  // New Task banner clears three filters and must re-run with them cleared, not
  // with the ones still in state. Returns the rows so the caller can ask whether
  // what it just created is actually in them.
  const generate = useCallback(async (over = {}) => {
    H.tap();
    setGenerating(true);
    setError(null);
    try {
      const res = await fetchKraReport({ ...paramsOf(), ...over });
      if (res.status === false) {
        setError(res.message || 'Could not generate the report.');
        setRows(null);
        return [];
      }
      setRows(res.data || []);
      setAppliedFilters(res.filters || {});
      setGeneratedSignature(signature);
      // A fresh report has nothing trimmed out of it yet.
      setRemovedRowIds([]);
      log.info('generated', { rows: (res.data || []).length });
      return res.data || [];
    } catch (e) {
      log.warn('generate failed', e?.message);
      setError(e?.message || 'Could not generate the report.');
      return [];
    } finally {
      setGenerating(false);
    }
  }, [paramsOf, signature]);

  useEffect(() => {
    if (!restored || !wantGenerate.current) return;
    wantGenerate.current = false;
    generate();
  }, [restored, generate]);

  // ---- The rows everything downstream reads -------------------------------
  // Every total, the summary, the table and all three exports go through here,
  // so a trimmed row cannot leave a stale number behind anywhere.
  const visibleRows = useMemo(() => {
    // Report-only rows FIRST, as the web orders them: they were added by hand,
    // so they belong where the person who added them can see them rather than
    // buried after two hundred real ones. Merged here, at the single source, so
    // the badges, the table, the totals and all three exports count them —
    // dropping them was what made the phone's grand TOTAL disagree with the
    // browser's for the very same saved report.
    const base = localRows.length ? localRows.concat(rows || []) : (rows || []);
    const kept = removedRowIds.length
      ? base.filter((r) => !removedRowIds.includes(r.id))
      : base;
    // Resolve a rename once, here, so nothing downstream has to know about the
    // override map. employee_name stays the REAL name — the sheets and PDFs
    // print it, exactly as the web's do; display_name is what the table shows
    // and what the ZIP files the folder under.
    const named = Object.keys(nameOverrides).length
      ? kept.map((r) => (nameOverrides[r.employee_id]
        ? { ...r, display_name: nameOverrides[r.employee_id] } : r))
      : kept;
    const q = search.trim().toLowerCase();
    if (!q) return named;
    return named.filter((r) =>
      (r.kra_path || '').toLowerCase().includes(q)
      || (r.sub_kra || '').toLowerCase().includes(q)
      || (r.kpi_name || '').toLowerCase().includes(q)
      || (r.employee_name || '').toLowerCase().includes(q)
      || (r.display_name || '').toLowerCase().includes(q)
      || (r.task_type || '').toLowerCase().includes(q)
      || (r.task_state_label || '').toLowerCase().includes(q));
  }, [rows, localRows, nameOverrides, removedRowIds, search]);

  // What the document builders need. Assembled here so the three export handlers
  // cannot each build a subtly different one — and it takes the rows as an
  // argument so the download dialog's narrower set flows through ONE source. The
  // web learned this the hard way: its dialog's rows reached the ZIP only, and
  // PDF and Excel silently rebuilt from the whole table, so a report saying
  // "A month" contained everything.
  const exportCtx = useCallback((rowsOverride) => ({
    rows: rowsOverride || visibleRows,
    fromDate,
    toDate,
    applied: appliedFilters,
    search: search.trim(),
    removedCount: removedRowIds.length,
  }), [visibleRows, fromDate, toDate, appliedFilters, search, removedRowIds]);

  // The rows a download should actually contain, after the dialog's own filters.
  // Starts from visibleRows, so the screen's filters, trims and search still
  // apply — this narrows, it never widens.
  const rowsForDownload = useCallback(
    (d) => (d ? selectDownloadRows(visibleRows, d, fromDate) : visibleRows),
    [visibleRows, fromDate],
  );

  // ---- Saving a built document --------------------------------------------
  // The recipe the app already uses in six places: ask WHERE first on Android and
  // write nothing until a folder is chosen, otherwise cache it and offer the
  // share sheet, which is where "Save to Files" lives on iOS.
  // Returns TRUE only if bytes actually reached the device. The caller uses that
  // to decide whether to record the download in the shared history — and it has
  // to be a return value rather than "did it throw", because cancelling the
  // Android folder picker is a normal outcome, not an error: it flashes a message
  // and returns. Before this, that normal return let runExport carry on and file
  // a full history row, bytes and all, for a download the user had just declined.
  async function save({ filename, mimeType, data_b64 }) {
    const name = String(filename).split(/[\\/]/).pop();
    const SAF = FileSystem.StorageAccessFramework;
    if (Platform.OS === 'android' && SAF) {
      const perm = await SAF.requestDirectoryPermissionsAsync();
      if (!perm.granted) { flash('err', 'Download cancelled — no folder chosen'); return false; }
      // SAF re-appends the extension from the mime type, so hand it the bare
      // name or the file lands as "X.zip.zip".
      const dot = name.lastIndexOf('.');
      const bare = dot > 0 ? name.slice(0, dot) : name;
      const uri = await SAF.createFileAsync(perm.directoryUri, bare, mimeType);
      await FileSystem.writeAsStringAsync(uri, data_b64, { encoding: FileSystem.EncodingType.Base64 });
      log.info('saved via SAF', { name });
      flash('ok', `Saved ${name}`);
      return true;
    }
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    const uri = `${dir}${name}`;
    await FileSystem.writeAsStringAsync(uri, data_b64, { encoding: FileSystem.EncodingType.Base64 });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType, dialogTitle: `Save ${name}` });
      flash('ok', `${name} ready`);
      return true;
    }
    flash('err', 'Saving is not available on this device.');
    return false;
  }

  // `meta` carries what the download history needs to describe this export. It is
  // recorded HERE and deliberately not inside save(): save() is also what
  // refetchStored() uses to write a file pulled back OUT of the history, and
  // recording there would add a fresh row every time someone re-downloaded an old
  // report — the history would grow by re-reading it.
  async function runExport(kind, build, meta) {
    if (exporting) return;
    H.tap();
    setExporting(kind);
    try {
      const doc = await build();
      const saved = await save(doc);
      // Only once the file is ACTUALLY on the device — which is what `saved`
      // answers and what merely reaching this line does not. Cancelling the
      // Android folder picker returns normally rather than throwing, so without
      // this guard a declined download was still filed in the shared history,
      // bytes included, as though it had happened.
      //
      // Not awaited and never allowed to throw: the export has already succeeded
      // and said so, and this is a copy for the shared history, not part of the
      // download.
      if (!saved) return;
      saveBuiltDownload({
        data_b64: doc.data_b64,
        filename: doc.filename,
        kind,
        from_date: meta?.from_date,
        to_date: meta?.to_date,
        row_count: meta?.row_count,
        filters_json: meta?.filters_json,
      });
    } catch (e) {
      log.error(`${kind} export failed`, e?.message);
      flash('err', e?.message || `Could not build the ${kind.toUpperCase()}.`);
    } finally {
      setExporting(null);
      setZipStep(null);
    }
  }

  // ---- Download history (what the web saved) ------------------------------
  async function openHistory() {
    H.tap();
    setHistory({ loading: true, rows: [], error: '' });
    const res = await fetchDownloadHistory();
    setHistory(res.status
      ? { loading: false, rows: res.downloads, error: '' }
      : { loading: false, rows: [], error: res.message });
  }

  // Re-fetch one and hand it to the same save path every other document here
  // uses, so a report a colleague generated on the web lands in a folder of your
  // choosing exactly like one built on this phone.
  async function refetchStored(row) {
    setHistBusy(row.id);
    try {
      const res = await fetchStoredDownload(row.id);
      if (!res?.status || !res.data_b64) { flash('err', res?.message || 'Could not fetch that file.'); return; }
      await save({
        filename: res.filename || row.filename,
        mimeType: row.kind === 'pdf' ? 'application/pdf'
          : row.kind === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/zip',
        data_b64: res.data_b64,
      });
    } catch (e) {
      flash('err', e?.message || 'Could not fetch that file.');
    } finally { setHistBusy(0); }
  }

  async function removeStored(row) {
    setHistBusy(row.id);
    try {
      const res = await deleteStoredDownload(row.id);
      if (res?.status === false) { flash('err', res.message || 'Could not delete that.'); return; }
      setHistory((h) => (h ? { ...h, rows: h.rows.filter((r) => r.id !== row.id) } : h));
    } finally { setHistBusy(0); }
  }

  // ---- New Task -----------------------------------------------------------
  const openNewTask = () => {
    H.tap();
    ntCreatedId.current = 0;
    setNtMatches([]);
    setNt({
      name: '', kra_id: kraIds.length === 1 ? kraIds[0] : '', user_id: '',
      doc_type: 'requirement', priority: 'regular',
      // Module / App / EXE / Other. Starts blank on purpose — unlike doc_type and
      // priority there is no sensible default, so validateNewTask asks for it.
      // Other also needs its text (deliverable_other).
      deliverable_type: '', deliverable_other: '',
      estimate_hours: '', estimate_minutes: '', worked_hours: '', worked_minutes: '',
      deadline: '', description: '', error: '',
    });
  };

  // The duplicate-name hint. Debounced 350ms like the web, and it needs BOTH a
  // name and a project — the server matches within one KRA, so asking without
  // one is meaningless.
  useEffect(() => {
    const name = (nt?.name || '').trim();
    if (!name || !nt?.kra_id) { setNtMatches([]); return undefined; }
    const t = setTimeout(async () => {
      const m = await findNameMatches({ name, kraId: nt.kra_id });
      setNtMatches(m);
    }, 350);
    return () => clearTimeout(t);
  }, [nt?.name, nt?.kra_id]);

  // "This report only" — a row that exists here and nowhere else. No server call
  // at all. Same shape the web builds, including the NEGATIVE id, which is what
  // keeps it from ever colliding with a real row in removedRowIds.
  function addLocalRow() {
    const err = validateNewTask(nt);
    if (err) { setNt((p) => ({ ...p, error: err })); return; }
    const kra = kras.find((k) => k.id === Number(nt.kra_id));
    const emp = employees.find((e) => e.id === Number(nt.user_id));
    const worked = toSeconds(nt.worked_hours, nt.worked_minutes);
    const h = Math.floor(worked / 3600), m = Math.floor((worked % 3600) / 60);
    setLocalRows((prev) => [{
      id: -(Date.now()),
      is_local: true,
      kra_id: Number(nt.kra_id),
      kra_path: kra?.display_name || kra?.name || '—',
      root_kra: kra?.name || '—',
      sub_kra: '-',
      kpi_name: nt.name.trim(),
      external_ref: '',
      task_type: prefixForDocType(nt.doc_type),
      task_state: 'assigned',
      task_state_label: 'Report only',
      priority: nt.priority,
      deadline: nt.deadline || '',
      employee_id: nt.user_id ? Number(nt.user_id) : 0,
      employee_name: emp?.name || '—',
      time_worked_seconds: worked,
      time_worked_hours: +(worked / 3600).toFixed(2),
      time_worked_display: `${h}h ${m}m`,
      user_breakdown: [],
    }, ...prev]);
    setNt(null);
    setNtMatches([]);
    flash('ok', 'Added to this report only.');
  }

  // "Everywhere" — a real task. Two calls, and they are NOT transactional: the
  // web leaves an orphan 0h task on the board when the second one fails, and
  // pressing the button again creates a SECOND task. ntCreatedId remembers what
  // was already made, so a retry only re-logs the time.
  async function submitNewTask() {
    const err = validateNewTask(nt);
    if (err) { setNt((p) => ({ ...p, error: err })); return; }
    setNtBusy(true);
    const worked = toSeconds(nt.worked_hours, nt.worked_minutes);
    const name = nt.name.trim();
    try {
      let kpiId = ntCreatedId.current;
      if (!kpiId) {
        const res = await createKpi({
          name,
          kraId: nt.kra_id,
          docType: nt.doc_type,
          deliverableType: nt.deliverable_type,
          deliverableOther: needsOtherText(nt.deliverable_type) ? nt.deliverable_other.trim() : '',
          estimateHours: nt.estimate_hours,
          estimateMinutes: nt.estimate_minutes,
          priority: nt.priority,
          userId: nt.user_id,
          deadline: nt.deadline || false,
          // Untrimmed, as the web sends it.
          description: nt.description,
        });
        kpiId = res?.id || 0;
        ntCreatedId.current = kpiId;
      }
      if (worked > 0 && kpiId) {
        await logManualTime({ kpiId, seconds: worked, userId: nt.user_id });
      }
      setNt(null);
      setNtMatches([]);
      ntCreatedId.current = 0;
      const fresh = await generate();
      // A new task starts as Pre-Approval Approved, so any State, Type or
      // Employee filter hides the thing that was just created — which reads as
      // "it didn't save".
      const shown = (fresh || []).some((r) => r.id === kpiId);
      if (kpiId && !shown) setCreatedHidden({ id: kpiId, name });
    } catch (e) {
      // The sheet STAYS OPEN on failure, holding what was typed.
      setNt((p) => (p ? { ...p, error: e?.message || 'Could not create the task.' } : p));
    } finally { setNtBusy(false); }
  }

  // The banner's "show it" link. Clears the three filters that hide a new task,
  // exactly as the web does — but the web stops there and leaves the banner up
  // even when the task is hidden by its KRA or by the date range instead, so the
  // link reads as broken. Re-check, and say which it is.
  async function showCreatedTask() {
    const id = createdHidden?.id;
    setStates([]); setTypes([]); setEmployeeIds([]);
    setCreatedHidden(null);
    const fresh = await generate({ task_states: [], task_types: [], employee_ids: [] });
    if (id && !(fresh || []).some((r) => r.id === id)) {
      flash('err', 'Still hidden — it sits outside this report\'s KRA filter or date range.');
    }
  }

  // Put the whole working view down: filters back to the default month, table
  // gone, and the SERVER copy wiped with the empty string saveKraState documents.
  // Without that last part the next open would restore everything this just
  // cleared, which is the opposite of what the button says.
  async function clearReport() {
    setClearOpen(false);
    H.tap();
    const init = presetRange('this_month');
    setPreset('this_month');
    setFromDate(init.from); setToDate(init.to);
    setEmployeeIds([]); setKraIds([]); setExcludedKraIds([]); setTypes([]); setStates([]);
    setSearch('');
    setRemovedRowIds([]);
    setNameOverrides({});
    setLocalRows([]);
    savedExtras.current = {};
    setRows(null);
    setGeneratedSignature('');
    try { await saveKraState(''); } catch (e) { log.warn('clear state failed', e?.message); }
    flash('ok', 'Report cleared.');
  }

  // Format first, then options — the ZIP menu asks the flavour, this asks the
  // rest. Seeded from the filters that produced the table, so the default answer
  // is "the report I am looking at".
  const openDownloadDialog = (kind, include = {}) => {
    setZipMenu(false);
    setDl({
      kind,
      include,
      scope: 'all',
      employeeIds: [...employeeIds],
      period: 'range',
      day: fromDate || '',
      week: weekKey(fromDate),
      month: (fromDate || '').slice(0, 7),
      sort: '',
      workedOnly: false,
    });
  };

  const confirmDownload = () => {
    const d = dl;
    setDl(null);
    if (!d) return;
    // ONE row source for every format. The whole point of the dialog.
    const chosen = rowsForDownload(d);
    if (!chosen.length) { flash('err', 'Those options leave no rows to export.'); return; }
    const ctx = exportCtx(chosen);
    // What the history row should say about this export. row_count is the rows
    // that actually went in, not what is on screen — the dialog's own filters
    // narrow it further (rowsForDownload).
    const meta = {
      from_date: fromDate,
      to_date: toDate,
      row_count: chosen.length,
      filters_json: JSON.stringify({ ...appliedFilters, search: search.trim(), include: d.include || null }),
    };
    if (d.kind === 'pdf') return runExport('pdf', async () => makeReportPdf(ctx), meta);
    if (d.kind === 'excel') return runExport('excel', () => makeReportExcel(ctx), meta);
    return runExport('zip', () => makeReportZip(ctx, d.include, (done, total) => setZipStep({ done, total })), meta);
  };

  const downloadPdf = () => openDownloadDialog('pdf');
  const downloadExcel = () => openDownloadDialog('excel');
  const downloadZip = (include) => openDownloadDialog('zip', include);

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
          {/* Wrapped, NOT onPress={generate}: RN hands onPress the press event as
              its first argument, which lands in generate's `over` parameter and
              gets spread into the request body. A SyntheticEvent points back at
              its own target, so the payload became circular and every tap died
              with "cyclical structure in JSON object" before leaving the device.
              The button looked wired the whole time — generate() itself was fine,
              and the two internal callers (restore, and the New Task banner) pass
              no argument, so the screen still filled on load. */}
          <TouchableOpacity style={s.genBtn} onPress={() => generate()} disabled={generating} activeOpacity={0.9}>
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

      {/* Saved, but this report cannot show it. Says WHY, because "it didn't
          save" is the natural conclusion otherwise. */}
      {createdHidden ? (
        <View style={s.createdBar}>
          <Ionicons name="checkmark-circle" size={16} color="#166534" />
          <View style={{ flex: 1 }}>
            <Text style={s.createdTxt}>
              <Text style={{ fontWeight: '900' }}>{createdHidden.name}</Text> was saved and is on the
              KPI Action Board, but this report's filters exclude it — a new task starts as
              Pre-Approval Approved, so any State, Type or Employee filter hides it.
            </Text>
            <TouchableOpacity onPress={showCreatedTask} activeOpacity={0.8}>
              <Text style={s.createdLink}>Clear those filters and show it</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => setCreatedHidden(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={16} color="#166534" />
          </TouchableOpacity>
        </View>
      ) : null}

      {rows !== null && !error ? (
        <>
          <View style={s.totals}>
            <View style={s.badge}><Text style={s.badgeTxt}>{visibleRows.length} tasks</Text></View>
            <View style={[s.badge, s.badgeAlt]}><Text style={s.badgeTxt}>{totalTimeWorked(visibleRows)}</Text></View>
            <View style={s.badge}><Text style={s.badgeTxt}>{uniqueEmployeeCount(visibleRows)} employees</Text></View>
            {/* Collapsible: on a phone the summary can be a dozen rows above the
                tasks, and someone who came here for one task should not have to
                scroll past it every time. */}
            <TouchableOpacity style={s.summaryToggle} onPress={() => { H.select(); setSummaryOpen((v) => !v); }} activeOpacity={0.8}>
              <Text style={s.summaryToggleTxt}>{summaryOpen ? 'Hide summary' : 'KRA summary'}</Text>
              <Ionicons name={summaryOpen ? 'chevron-up' : 'chevron-down'} size={13} color={COLORS.primary} />
            </TouchableOpacity>
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

          {/* The KRA Summary, on screen. The app has always computed this table
              for the Excel tab and the PDF's Section A, and thrown the on-screen
              version away — so the phone showed a list of tasks where the browser
              shows where the time actually went. Same projectSummary() the
              documents use, so the screen and the file cannot disagree, and it
              follows the search box and trimmed rows because it reads
              visibleRows. */}
          {summaryOpen && visibleRows.length ? (
            <View style={s.summaryCard}>
              {projectSummary(visibleRows).map((p) => (
                <View key={p.kra_path} style={s.summaryRow}>
                  <Text style={s.summaryPath} numberOfLines={2}>{p.kra_path}</Text>
                  <Text style={s.summaryMeta}>
                    {p.task_count} task{p.task_count === 1 ? '' : 's'} · {p.employee_count} employee{p.employee_count === 1 ? '' : 's'}
                  </Text>
                  <Text style={s.summaryTime}>{p.total_display}</Text>
                </View>
              ))}
            </View>
          ) : null}

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

          {/* Start a fresh report. The per-picker Clear buttons only drop one
              filter each, and nothing on the phone could clear the SAVED view —
              saveKraState('') has documented the empty-string contract all along
              and was never called with it, so a working view built on the web
              could be edited from here but never put down. */}
          <View style={s.footLinks}>
            {/* Reports saved from the WEB. Admin-gated by the route itself. */}
            {isAdmin ? (
              <TouchableOpacity style={s.clearRow} onPress={openHistory} activeOpacity={0.8}>
                <Ionicons name="time-outline" size={14} color={COLORS.primary} />
                <Text style={[s.clearTxt, { color: COLORS.primary }]}>Download history</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={s.clearRow} onPress={() => { H.select(); setClearOpen(true); }} activeOpacity={0.8}>
              <Ionicons name="trash-outline" size={14} color={COLORS.red} />
              <Text style={s.clearTxt}>Clear this report</Text>
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
          {/* Added by hand — it exists in this report and nowhere else, so it
              must not read as a task someone can go and look up. */}
          {!!item.is_local && (
            <View style={s.localBadge}><Text style={s.localBadgeTxt}>report only</Text></View>
          )}
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
          {item.display_name || item.employee_name || 'Unassigned'}
          {!!item.display_name && <Text style={s.renamedTxt}>  (renamed — really {item.employee_name})</Text>}
          {' · '}{item.task_state_label || '—'}
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
        {/* Admin only, matching the web. The report is where you notice work is
            missing from it, so this is where adding it belongs — otherwise it
            means leaving, creating it elsewhere, coming back and regenerating. */}
        {isAdmin ? (
          <TouchableOpacity style={s.iconBtn} onPress={openNewTask} activeOpacity={0.85}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="add-circle-outline" size={24} color={COLORS.primary} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
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

      {/* Reports the WEB saved, mirrored here. Read-only on purpose: the app
          builds its documents on the device and does not post them back, so this
          is what the browser stored — said plainly rather than leaving someone to
          wonder why the report they just built on this phone is missing. */}
      <Modal visible={!!history} transparent animationType="fade" onRequestClose={() => setHistory(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalSheet}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Download history</Text>
              <TouchableOpacity onPress={() => setHistory(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            {history?.loading ? (
              <View style={{ padding: 30, alignItems: 'center' }}><ActivityIndicator color={COLORS.primary} /></View>
            ) : history?.error ? (
              <Text style={[s.clearBody, { color: '#B91C1C', fontWeight: '700' }]}>{history.error}</Text>
            ) : !(history?.rows || []).length ? (
              <Text style={s.clearBody}>Nothing saved yet. Reports you download — here or on the web — appear in this list.</Text>
            ) : (
              <FlatList
                style={{ maxHeight: 380 }}
                data={history.rows}
                keyExtractor={(r) => String(r.id)}
                renderItem={({ item }) => (
                  <View style={s.histRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.histName} numberOfLines={1}>{item.filename}</Text>
                      <Text style={s.histMeta} numberOfLines={1}>
                        {item.user_name || '—'} · {item.generated_at || '—'}
                        {item.row_count ? ` · ${item.row_count} rows` : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => refetchStored(item)} disabled={histBusy === item.id}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ padding: 4 }}
                    >
                      {histBusy === item.id
                        ? <ActivityIndicator size="small" color={COLORS.primary} />
                        : <Ionicons name="download-outline" size={18} color={COLORS.primary} />}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => removeStored(item)} disabled={histBusy === item.id}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ padding: 4 }}
                    >
                      <Ionicons name="trash-outline" size={17} color={COLORS.red} />
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
            {/* Said the opposite of what the list above it shows, ever since
                07a866a taught runExport to call download_save: a report built on
                this phone IS recorded here now. The file itself still goes only
                to the folder you picked — that part was always true — so say
                that, and stop calling the whole list a web-only archive. */}
            <Text style={s.histFoot}>
              A copy of each report is kept here. The file itself is written only to the folder
              you chose, so re-download it from this list to save it again.
            </Text>
          </View>
        </View>
      </Modal>

      {/* New Task. Two ways out: a row that lives only in this report, or a real
          task on the board. Nothing is inferred — the button pressed decides. */}
      <Modal visible={!!nt} transparent animationType="fade" onRequestClose={() => setNt(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalSheet}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>New Task</Text>
              <TouchableOpacity onPress={() => setNt(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
              <View style={{ padding: 16, paddingTop: 12 }}>
                <Text style={s.ntLabel}>Task name <Text style={s.ntReq}>*</Text></Text>
                <TextInput
                  style={s.ntInput}
                  placeholder="e.g. Login screen"
                  placeholderTextColor={COLORS.faint}
                  value={nt?.name || ''}
                  onChangeText={(v) => setNt((p) => ({ ...p, name: v, error: '' }))}
                />

                {/* Advisory only — the server stopped refusing duplicates when
                    the web gained this, so nothing rejects one now. */}
                {ntMatches.length ? (
                  <View style={s.ntMatchBox}>
                    <Text style={s.ntMatchTitle}>
                      {ntMatches.length} task{ntMatches.length === 1 ? '' : 's'} here already use this name:
                    </Text>
                    {ntMatches.map((m) => (
                      <Text key={m.id} style={s.ntMatchRow} numberOfLines={1}>
                        {m.external_ref ? `${m.external_ref}  ` : ''}{m.name}
                        {m.assignee ? ` · ${m.assignee}` : ''}
                      </Text>
                    ))}
                    <Text style={s.ntMatchFoot}>You can still save — this is only a heads-up.</Text>
                  </View>
                ) : null}

                <Text style={s.ntLabel}>Project (KRA) <Text style={s.ntReq}>*</Text></Text>
                <TouchableOpacity style={s.ntSelect} onPress={() => setNtPicker('kra')} activeOpacity={0.8}>
                  <Text style={[s.ntSelectTxt, !nt?.kra_id && s.ntSelectEmpty]} numberOfLines={1}>
                    {kras.find((k) => k.id === Number(nt?.kra_id))?.display_name
                      || kras.find((k) => k.id === Number(nt?.kra_id))?.name
                      || '— pick a project —'}
                  </Text>
                  <Ionicons name="chevron-down" size={16} color={COLORS.muted} />
                </TouchableOpacity>

                <Text style={s.ntLabel}>Assignee <Text style={s.ntReq}>*</Text></Text>
                <TouchableOpacity style={s.ntSelect} onPress={() => setNtPicker('user')} activeOpacity={0.8}>
                  <Text style={[s.ntSelectTxt, !nt?.user_id && s.ntSelectEmpty]} numberOfLines={1}>
                    {employees.find((e) => e.id === Number(nt?.user_id))?.name || '— unassigned —'}
                  </Text>
                  <Ionicons name="chevron-down" size={16} color={COLORS.muted} />
                </TouchableOpacity>

                {/* What the task builds — a second axis, separate from the
                    REQ/UPT/BUG Type below. */}
                <Text style={s.ntLabel}>Type (Module / App / EXE / Other) <Text style={s.ntReq}>*</Text></Text>
                <View style={s.dlRow}>
                  {DELIVERABLE_TYPES.map((d) => (
                    <TouchableOpacity
                      key={d.code}
                      style={[s.dlChip, nt?.deliverable_type === d.code && s.dlChipOn]}
                      onPress={() => { H.select(); setNt((p) => ({ ...p, deliverable_type: d.code, error: '' })); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, nt?.deliverable_type === d.code && s.dlChipTxtOn]}>
                        {d.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {needsOtherText(nt?.deliverable_type) && (
                  <TextInput
                    style={[s.ntInput, { marginTop: 8 }]}
                    placeholder={DELIVERABLE_OTHER_PLACEHOLDER}
                    placeholderTextColor={COLORS.faint}
                    maxLength={DELIVERABLE_OTHER_MAX}
                    value={nt?.deliverable_other || ''}
                    onChangeText={(v) => setNt((p) => ({ ...p, deliverable_other: v, error: '' }))}
                  />
                )}

                {/* Type mints the REQ/UPT/BUG reference, which is what this
                    report's own Type filter matches on. */}
                <Text style={s.ntLabel}>Type <Text style={s.ntReq}>*</Text></Text>
                <View style={s.dlRow}>
                  {DOC_TYPES.map((d) => (
                    <TouchableOpacity
                      key={d.code}
                      style={[s.dlChip, nt?.doc_type === d.code && s.dlChipOn]}
                      onPress={() => { H.select(); setNt((p) => ({ ...p, doc_type: d.code })); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, nt?.doc_type === d.code && s.dlChipTxtOn]}>
                        {d.label} → {d.prefix}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={s.ntLabel}>Priority</Text>
                <View style={s.dlRow}>
                  {['regular', 'important', 'urgent'].map((p) => (
                    <TouchableOpacity
                      key={p}
                      style={[s.dlChip, nt?.priority === p && s.dlChipOn]}
                      onPress={() => { H.select(); setNt((v) => ({ ...v, priority: p })); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, nt?.priority === p && s.dlChipTxtOn]}>
                        {p[0].toUpperCase() + p.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={s.ntLabel}>Estimate <Text style={s.ntReq}>*</Text></Text>
                <View style={s.ntPairRow}>
                  <TextInput
                    style={s.ntNum} keyboardType="number-pad" placeholder="h"
                    placeholderTextColor={COLORS.faint}
                    value={String(nt?.estimate_hours ?? '')}
                    onChangeText={(v) => setNt((p) => ({ ...p, estimate_hours: v.replace(/[^0-9]/g, ''), error: '' }))}
                  />
                  <Text style={s.ntPairSep}>h</Text>
                  <TextInput
                    style={s.ntNum} keyboardType="number-pad" placeholder="m"
                    placeholderTextColor={COLORS.faint}
                    value={String(nt?.estimate_minutes ?? '')}
                    onChangeText={(v) => {
                      let m = parseInt(v.replace(/[^0-9]/g, ''), 10);
                      if (isNaN(m)) m = '';
                      else if (m > 59) m = 59;
                      setNt((p) => ({ ...p, estimate_minutes: String(m), error: '' }));
                    }}
                  />
                  <Text style={s.ntPairSep}>m</Text>
                </View>

                <Text style={s.ntLabel}>Time worked <Text style={s.ntReq}>*</Text></Text>
                <View style={s.ntPairRow}>
                  <TextInput
                    style={s.ntNum} keyboardType="number-pad" placeholder="h"
                    placeholderTextColor={COLORS.faint}
                    value={String(nt?.worked_hours ?? '')}
                    onChangeText={(v) => setNt((p) => ({ ...p, worked_hours: v.replace(/[^0-9]/g, ''), error: '' }))}
                  />
                  <Text style={s.ntPairSep}>h</Text>
                  <TextInput
                    style={s.ntNum} keyboardType="number-pad" placeholder="m"
                    placeholderTextColor={COLORS.faint}
                    value={String(nt?.worked_minutes ?? '')}
                    onChangeText={(v) => {
                      let m = parseInt(v.replace(/[^0-9]/g, ''), 10);
                      if (isNaN(m)) m = '';
                      else if (m > 59) m = 59;
                      setNt((p) => ({ ...p, worked_minutes: String(m), error: '' }));
                    }}
                  />
                  <Text style={s.ntPairSep}>m</Text>
                </View>
                <Text style={s.ntHint}>
                  Work already done, before the task existed. It is filed against today, not the
                  deadline.
                </Text>

                <Text style={s.ntLabel}>Deadline</Text>
                <TouchableOpacity style={s.ntSelect} onPress={() => setNtDate(true)} activeOpacity={0.8}>
                  <Text style={[s.ntSelectTxt, !nt?.deadline && s.ntSelectEmpty]}>
                    {nt?.deadline || '— none —'}
                  </Text>
                  <Ionicons name="calendar-outline" size={16} color={COLORS.muted} />
                </TouchableOpacity>

                <Text style={s.ntLabel}>Description</Text>
                <TextInput
                  style={[s.ntInput, { minHeight: 70, textAlignVertical: 'top' }]}
                  multiline
                  placeholder="Optional"
                  placeholderTextColor={COLORS.faint}
                  value={nt?.description || ''}
                  onChangeText={(v) => setNt((p) => ({ ...p, description: v }))}
                />

                {nt?.error ? <Text style={s.ntError}>{nt.error}</Text> : null}

                <Text style={s.ntFoot}>
                  <Text style={{ fontWeight: '900' }}>This report only</Text> adds a row here and
                  nowhere else — it reads 0h on the board because it is not there.{' '}
                  <Text style={{ fontWeight: '900' }}>Everywhere</Text> creates a real task.
                </Text>
              </View>
            </ScrollView>
            <View style={s.ntBtns}>
              <TouchableOpacity style={s.clearCancel} onPress={() => setNt(null)} disabled={ntBusy} activeOpacity={0.85}>
                <Text style={s.clearCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.ntLocalBtn, ntBusy && { opacity: 0.5 }]} onPress={addLocalRow} disabled={ntBusy} activeOpacity={0.85}>
                <Text style={s.ntLocalTxt}>This report only</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.clearConfirm, { backgroundColor: COLORS.primary, flex: 1.2 }, ntBusy && { opacity: 0.6 }]}
                onPress={submitNewTask} disabled={ntBusy} activeOpacity={0.85}
              >
                {ntBusy ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={s.clearConfirmTxt}>Everywhere</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Single-select pickers for the New Task sheet. MultiSelectPicker above is
          multi-select and belongs to the filter bar; bending it to do one-of-many
          would put the filters' behaviour at risk for the sake of two fields. */}
      <Modal visible={!!ntPicker} transparent animationType="fade" onRequestClose={() => setNtPicker(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setNtPicker(null)}>
          <View style={s.modalSheet}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>{ntPicker === 'kra' ? 'Pick a project' : 'Pick an assignee'}</Text>
              <TouchableOpacity onPress={() => setNtPicker(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <FlatList
              style={{ maxHeight: 380 }}
              data={ntPicker === 'kra' ? kras : employees}
              keyExtractor={(o) => String(o.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = Number(nt?.[ntPicker === 'kra' ? 'kra_id' : 'user_id']) === item.id;
                return (
                  <TouchableOpacity
                    style={s.ntOptRow}
                    onPress={() => {
                      H.select();
                      setNt((p) => ({ ...p, [ntPicker === 'kra' ? 'kra_id' : 'user_id']: item.id, error: '' }));
                      setNtPicker(null);
                    }}
                    activeOpacity={0.8}
                  >
                    {/* display_name, not `display` — the web reads a key the
                        server never sends, so its list shows flat names. */}
                    <Text style={[s.ntOptTxt, on && s.ntOptOn]} numberOfLines={2}>
                      {item.display_name || item.name}
                    </Text>
                    {on ? <Ionicons name="checkmark" size={17} color={COLORS.primary} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Rendered conditionally, NOT with a visible prop: DateGridModal hardcodes
          `<Modal visible ...>`, so it shows the moment it mounts — the sibling
          date picker below does the same. */}
      {ntDate ? (
        <DateGridModal
          title="Deadline"
          value={nt?.deadline || ''}
          onCancel={() => setNtDate(false)}
          onPick={(iso) => { setNt((p) => ({ ...p, deadline: iso })); setNtDate(false); }}
        />
      ) : null}

      {/* Download options. Every control here NARROWS the report already on
          screen; none of them widens it, so what you get is always a subset of
          what you were looking at. */}
      <Modal visible={!!dl} transparent animationType="fade" onRequestClose={() => setDl(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalSheet}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Download options</Text>
              <TouchableOpacity onPress={() => setDl(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              <View style={{ padding: 16, paddingTop: 12 }}>
                <Text style={s.dlLabel}>Who</Text>
                <View style={s.dlRow}>
                  {[{ k: 'all', t: 'Everyone' }, { k: 'employee', t: 'Pick people' }].map((o) => (
                    <TouchableOpacity
                      key={o.k}
                      style={[s.dlChip, dl?.scope === o.k && s.dlChipOn]}
                      onPress={() => {
                        H.select();
                        setDl((p) => ({ ...p, scope: o.k }));
                        if (o.k === 'employee') setDlPicker('employee');
                      }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, dl?.scope === o.k && s.dlChipTxtOn]}>{o.t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {dl?.scope === 'employee' ? (
                  <TouchableOpacity onPress={() => setDlPicker('employee')} activeOpacity={0.8}>
                    <Text style={s.dlHint}>
                      {dl.employeeIds.length
                        ? `${dl.employeeIds.length} selected — tap to change`
                        : 'Nobody selected — tap to choose'}
                    </Text>
                  </TouchableOpacity>
                ) : null}

                <Text style={[s.dlLabel, { marginTop: 14 }]}>Period</Text>
                <View style={s.dlRow}>
                  {[
                    { k: 'range', t: 'The whole range' },
                    { k: 'day', t: 'A day' },
                    { k: 'week', t: 'A week' },
                    { k: 'month', t: 'A month' },
                  ].map((o) => (
                    <TouchableOpacity
                      key={o.k}
                      style={[s.dlChip, dl?.period === o.k && s.dlChipOn]}
                      onPress={() => { H.select(); setDl((p) => ({ ...p, period: o.k })); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, dl?.period === o.k && s.dlChipTxtOn]}>{o.t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {dl?.period === 'day' ? (
                  <Text style={s.dlHint}>Rows dated {dl.day || '—'}</Text>
                ) : dl?.period === 'week' ? (
                  <Text style={s.dlHint}>ISO week {dl.week || '—'} (the week containing {fromDate})</Text>
                ) : dl?.period === 'month' ? (
                  <Text style={s.dlHint}>Rows in {dl.month || '—'}</Text>
                ) : null}

                <Text style={[s.dlLabel, { marginTop: 14 }]}>Sort by</Text>
                <View style={s.dlRow}>
                  {[
                    { k: '', t: 'As shown' },
                    { k: 'name', t: 'Task name' },
                    { k: 'kra', t: 'KRA path' },
                    { k: 'employee', t: 'Employee' },
                    { k: 'time', t: 'Time worked' },
                    { k: 'deadline', t: 'Deadline' },
                  ].map((o) => (
                    <TouchableOpacity
                      key={o.k || 'none'}
                      style={[s.dlChip, (dl?.sort || '') === o.k && s.dlChipOn]}
                      onPress={() => { H.select(); setDl((p) => ({ ...p, sort: o.k })); }}
                      activeOpacity={0.85}
                    >
                      <Text style={[s.dlChipTxt, (dl?.sort || '') === o.k && s.dlChipTxtOn]}>{o.t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={s.dlToggleRow}
                  onPress={() => { H.select(); setDl((p) => ({ ...p, workedOnly: !p.workedOnly })); }}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={dl?.workedOnly ? 'checkbox' : 'square-outline'}
                    size={19} color={dl?.workedOnly ? COLORS.primary : COLORS.faint}
                  />
                  <Text style={s.dlToggleTxt}>Only rows with time worked</Text>
                </TouchableOpacity>

                {/* Say the number before the file is built, not after. */}
                <Text style={s.dlCount}>
                  {rowsForDownload(dl).length} of {visibleRows.length} row{visibleRows.length === 1 ? '' : 's'} will be exported
                </Text>
              </View>
            </ScrollView>
            <View style={s.clearBtns}>
              <TouchableOpacity style={s.clearCancel} onPress={() => setDl(null)} activeOpacity={0.85}>
                <Text style={s.clearCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.clearConfirm, { backgroundColor: COLORS.primary }]} onPress={confirmDownload} activeOpacity={0.85}>
                <Text style={s.clearConfirmTxt}>Download {String(dl?.kind || '').toUpperCase()}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Who to include, reusing the screen's own picker so the dialog cannot
          drift from the filter bar's behaviour. */}
      <MultiSelectPicker
        visible={dlPicker === 'employee'}
        title="Include which people"
        options={employees}
        counts={counts.employees}
        selected={dl?.employeeIds || []}
        onToggle={(id) => setDl((p) => ({ ...p, employeeIds: toggleIn(p.employeeIds, id) }))}
        onClear={() => setDl((p) => ({ ...p, employeeIds: [] }))}
        onClose={() => setDlPicker(null)}
      />

      {/* Clearing discards trimmed rows, renames and report-only tasks — none of
          which exist anywhere else — so it counts them first rather than asking
          "are you sure?" about an amount nobody can see. */}
      <Modal visible={clearOpen} transparent animationType="fade" onRequestClose={() => setClearOpen(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setClearOpen(false)}>
          <View style={s.modalSheet}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Clear this report</Text>
              <TouchableOpacity onPress={() => setClearOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            {(() => {
              const n = removedRowIds.length + Object.keys(nameOverrides).length + localRows.length;
              return (
                <Text style={s.clearBody}>
                  {n
                    ? `This discards ${n} change${n === 1 ? '' : 's'} made to this report — trimmed rows, renames and report-only tasks. They exist nowhere else.`
                    : 'This clears the filters and the table so you can start a fresh report.'}
                </Text>
              );
            })()}
            <View style={s.clearBtns}>
              <TouchableOpacity style={s.clearCancel} onPress={() => setClearOpen(false)} activeOpacity={0.85}>
                <Text style={s.clearCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.clearConfirm} onPress={clearReport} activeOpacity={0.85}>
                <Text style={s.clearConfirmTxt}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

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
  renamedTxt: { fontSize: 10.5, color: COLORS.muted, fontStyle: 'italic' },
  localBadge: {
    backgroundColor: '#E0E7FF', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  localBadgeTxt: { fontSize: 9.5, fontWeight: '800', color: '#3730A3' },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyTxt: { fontSize: 13.5, color: COLORS.muted, fontWeight: '600' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  modalSheet: { width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 20, maxHeight: '75%', paddingBottom: 12, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },

  // KRA Summary — where the time went, above the list of what it went on.
  summaryToggle: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4 },
  summaryToggleTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },
  summaryCard: {
    backgroundColor: '#fff', borderRadius: 12, marginHorizontal: 14, marginBottom: 10,
    paddingVertical: 4, borderWidth: 1, borderColor: COLORS.line,
  },
  summaryRow: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  summaryPath: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy },
  summaryMeta: { fontSize: 11, color: COLORS.muted, marginTop: 2 },
  summaryTime: { fontSize: 12, fontWeight: '800', color: COLORS.primary, marginTop: 2 },

  // New Task
  ntLabel: { fontSize: 12, fontWeight: '900', color: COLORS.navy, marginBottom: 6, marginTop: 12 },
  ntReq: { color: COLORS.red },
  ntInput: {
    borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 14, color: COLORS.ink, backgroundColor: '#fff',
  },
  ntSelect: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12,
    height: 44, backgroundColor: '#fff',
  },
  ntSelectTxt: { flex: 1, fontSize: 14, color: COLORS.ink },
  ntSelectEmpty: { color: COLORS.faint },
  ntPairRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ntNum: {
    width: 66, borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: COLORS.ink,
    backgroundColor: '#fff', textAlign: 'center',
  },
  ntPairSep: { fontSize: 13, fontWeight: '800', color: COLORS.muted },
  ntHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 6, lineHeight: 17 },
  ntError: {
    fontSize: 12.5, fontWeight: '700', color: '#B91C1C', backgroundColor: '#FEE2E2',
    borderRadius: 10, padding: 10, marginTop: 14,
  },
  ntFoot: { fontSize: 11.5, color: COLORS.muted, lineHeight: 17, marginTop: 14 },
  ntBtns: { flexDirection: 'row', gap: 8, padding: 16, paddingTop: 12 },
  ntLocalBtn: {
    flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  ntLocalTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  ntOptRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  ntOptTxt: { flex: 1, fontSize: 13.5, color: COLORS.ink },
  ntOptOn: { fontWeight: '900', color: COLORS.primary },
  ntMatchBox: {
    backgroundColor: COLORS.amberBg, borderRadius: 10, padding: 10, marginTop: 8,
    borderWidth: 1, borderColor: '#F3DFA8',
  },
  ntMatchTitle: { fontSize: 12, fontWeight: '800', color: '#7a5200' },
  ntMatchRow: { fontSize: 11.5, color: '#7a5200', marginTop: 3 },
  ntMatchFoot: { fontSize: 11, color: '#7a5200', marginTop: 5, fontStyle: 'italic' },

  createdBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#DCFCE7',
    borderRadius: 12, marginHorizontal: 14, marginBottom: 8, padding: 10,
  },
  createdTxt: { fontSize: 12, color: '#166534', lineHeight: 17 },
  createdLink: { fontSize: 12.5, fontWeight: '900', color: '#166534', marginTop: 6 },

  // Download options
  dlLabel: { fontSize: 12, fontWeight: '900', color: COLORS.navy, marginBottom: 6 },
  dlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dlChip: {
    paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9,
    borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff',
  },
  dlChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  dlChipTxt: { fontSize: 12, fontWeight: '800', color: COLORS.muted },
  dlChipTxtOn: { color: '#fff' },
  dlHint: { fontSize: 11.5, color: COLORS.muted, marginTop: 6 },
  dlToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  dlToggleTxt: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  dlCount: { fontSize: 12, fontWeight: '800', color: COLORS.primary, marginTop: 14 },

  footLinks: { flexDirection: 'row', justifyContent: 'center', gap: 18 },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  histName: { fontSize: 13, fontWeight: '800', color: COLORS.navy },
  histMeta: { fontSize: 11, color: COLORS.muted, marginTop: 2 },
  histFoot: { fontSize: 11, color: COLORS.muted, lineHeight: 16, paddingHorizontal: 20, paddingVertical: 12 },
  clearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10 },
  clearTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.red },
  clearBody: { fontSize: 13.5, color: COLORS.muted, lineHeight: 20, paddingHorizontal: 20, paddingTop: 14 },
  clearBtns: { flexDirection: 'row', gap: 10, padding: 20, paddingTop: 16 },
  clearCancel: {
    flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center',
  },
  clearCancelTxt: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  clearConfirm: { flex: 1, height: 44, borderRadius: 12, backgroundColor: COLORS.red, alignItems: 'center', justifyContent: 'center' },
  clearConfirmTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },

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
