// KPI Details — the app's mirror of the web detail pane (kpi_action.js's
// `state.view === 'detail'` swap). Same sections, same order, so someone who
// knows the web page can find things here:
//
//   KPI Details table · User Manual / Documentation (+ upload) · Submit Progress
//   Update (+ file, links) · Link a GitHub branch · Complete This Task ·
//   GitHub / Documents / Drive & Links · Progress History · Reassignment History
//
// It is a full screen, not a modal: the web replaces the whole page for this, and
// there is far too much here to sit politely in a dialog.
//
// WHO: admins + coordinators see any task, developers only their own, clients
// never. That is enforced by /kra_kpi/task/details on the SERVER — this screen
// only renders what the server already agreed to hand over.
//
// One deliberate omission: no image/video thumbnails. React Native's image loader
// does not send the Odoo session cookie, so an <Image> pointed at
// /kpi/manual/view/<id> silently renders the login page instead of the file (the
// same bug that broke the ZIP download). Files are listed by name + reason; the
// media itself opens on the web viewer.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, StatusBar as RNStatusBar,
  ActivityIndicator, Animated, Easing, Linking, KeyboardAvoidingView, Platform,
  Modal, Image, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
// SDK 54: the classic writeAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { COLORS } from '../theme';
import GradientBackground from '../components/GradientBackground';
import {
  fetchTaskDetails, submitProgressUpdate, addGithubLink, deleteGithubLink,
  deleteManual, completeTask, fetchProgressFile, fetchManualFile,
  CHECKLIST_ITEMS, MAX_PROGRESS_BYTES,
} from '../services/kpiActions';
import { uploadManual, humanSize } from '../services/uploadAmendments';
import { createLogger } from '../api/logger';

const log = createLogger('KpiDetail');

// Clear the Android status bar — same value the board's header uses, so the two
// screens line up when you swap between them.
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const KIND = {
  requirement: { label: 'Requirement', bg: '#EDE9FE', fg: '#6D28D9' },
  update:      { label: 'Update',      bg: '#DBEAFE', fg: '#1D4ED8' },
  bug:         { label: 'Bug',         bg: '#FEE2E2', fg: '#B91C1C' },
};
const PRIORITY = {
  regular:   { label: 'Regular',   bg: '#EEF2FF', fg: '#4F46E5' },
  important: { label: 'Important', bg: '#F3E8FF', fg: '#7C3AED' },
  urgent:    { label: 'Urgent',    bg: '#FEF3C7', fg: '#D97706' },
};

// related_links is stored as a JSON string; tolerate junk rather than crash the
// whole screen over one bad row.
function parseLinks(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch { return []; }
}

// Accept any REAL link, but only a real one: it must parse as a URL and be
// http(s). What KIND it is (Google Drive / Repository / …) is decided by the
// server's own classifier from the url itself, never claimed here — so a Drive
// link can only ever show as Drive, and a GitHub link as Repository.
function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

const isImageName = (n = '') => /\.(png|jpe?g|gif|webp|bmp)$/i.test(n);

function Section({ icon, title, subtitle, children, tint, right }) {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Ionicons name={icon} size={17} color={tint || COLORS.primary} />
        <Text style={[s.cardTitle, { flex: 1 }]}>{title}</Text>
        {right}
      </View>
      {!!subtitle && <Text style={s.cardSub}>{subtitle}</Text>}
      {children}
    </View>
  );
}

// Newest / Oldest / Name — the same three the web's resource panes offer.
const SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name']];

function SortChip({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const label = (SORTS.find((o) => o[0] === value) || SORTS[0])[1];
  return (
    <View>
      <TouchableOpacity style={s.sortChip} onPress={() => setOpen(!open)} activeOpacity={0.7}>
        <Text style={s.sortChipTxt}>{label}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={COLORS.muted} />
      </TouchableOpacity>
      {/* Rendered inline rather than absolutely: an absolute menu inside a
          ScrollView gets clipped by the card it sits in. */}
      {open && (
        <View style={s.sortMenu}>
          {SORTS.map(([k, l]) => (
            <TouchableOpacity key={k} style={[s.sortItem, value === k && s.sortItemOn]}
              onPress={() => { onChange(k); setOpen(false); }}>
              <Text style={[s.sortItemTxt, value === k && s.sortItemTxtOn]}>{l}</Text>
              {value === k && <Ionicons name="checkmark" size={13} color={COLORS.primary} />}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// Same rule as the web's sortItems(): by name, or by a date STRING (the dates
// arrive pre-formatted, and these formats compare correctly as text).
function sortItems(arr, mode, dateKey, nameKey) {
  const out = (arr || []).slice();
  if (mode === 'name') {
    out.sort((a, b) => String(a[nameKey] || '').localeCompare(String(b[nameKey] || '')));
  } else {
    out.sort((a, b) => String(a[dateKey] || '').localeCompare(String(b[dateKey] || '')));
    if (mode === 'newest') out.reverse();
  }
  return out;
}

function Row({ label, value, mono }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, mono && s.mono]} numberOfLines={3}>{value || '—'}</Text>
    </View>
  );
}

function Empty({ text }) {
  return <Text style={s.empty}>{text}</Text>;
}

export default function KpiTaskDetail({ task, onBack, onChanged }) {
  const [data, setData] = useState(null);       // { task, meta, manuals, progress, github, reassignments, files, links }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);   // { kind:'ok'|'err', msg }

  // Per-pane sort, mirroring the web's resSort. Newest first, like the web.
  const [sortFiles, setSortFiles] = useState('newest');
  const [sortGh, setSortGh] = useState('newest');
  const [sortDocs, setSortDocs] = useState('newest');
  const [sortDrive, setSortDrive] = useState('newest');

  const enter = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const enterStyle = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] };

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3500); };

  const load = useCallback(async (quiet) => {
    log.info('load details', { kpi_id: task.id, quiet: !!quiet });
    if (!quiet) setLoading(true);
    const res = await fetchTaskDetails(task.id);
    setLoading(false);
    if (!res.ok) {
      // Most likely the access rule refusing (admin/coordinator any, dev own,
      // client never) — log it as a warning, not an error: it's a valid answer.
      log.warn('details refused', { kpi_id: task.id, message: res.message });
      setError(res.message);
      return;
    }
    log.info('details loaded', {
      kpi_id: task.id,
      manuals: res.manuals?.length || 0,
      progress: res.progress?.length || 0,
      github: res.github?.length || 0,
      reassignments: res.reassignments?.length || 0,
      files: res.files?.length || 0,
      links: res.links?.length || 0,
      is_manager: res.meta?.is_manager,
      is_assignee: res.meta?.is_assignee,
      can_complete: res.meta?.can_complete,
    });
    setError(null);
    setData(res);
  }, [task.id]);

  useEffect(() => {
    log.info('open KPI detail', { kpi_id: task.id, name: task.name });
  }, [task.id, task.name]);

  useEffect(() => { load(); }, [load]);

  // ---- Manual upload ------------------------------------------------------
  const [manOpen, setManOpen] = useState(false);
  const [manFile, setManFile] = useState(null);
  const [manDesc, setManDesc] = useState('');
  const [manLink, setManLink] = useState('');
  const [manLinks, setManLinks] = useState([]);
  const [manPct, setManPct] = useState(0);
  const [manBusy, setManBusy] = useState(false);

  // Returns the file HANDLE only — no base64. The progress route takes the file
  // as multipart straight from this uri, so a 40 MB video never becomes a 53 MB
  // string in memory. Manual upload reads base64 on demand (its route is JSON).
  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
    if (res.canceled) { log.info('file pick cancelled'); return null; }
    const f = res.assets?.[0];
    if (!f) { log.warn('file pick returned no asset'); return null; }
    log.info('file picked', { name: f.name, size: f.size, mimeType: f.mimeType });
    return { uri: f.uri, name: f.name || 'file', size: f.size || 0, mimeType: f.mimeType };
  }

  async function onPickManual() {
    log.info('pick manual file');
    try {
      const f = await pickFile();
      if (f) setManFile(f);
    } catch (e) {
      log.error('manual file read failed', e?.message);
      flash('err', e?.message || 'Could not read that file');
    }
  }

  async function onPickProgressFile() {
    log.info('pick progress file');
    try {
      const f = await pickFile();
      if (!f) return;
      // Refuse at pick time — never start an upload that the server will reject.
      if (f.size && f.size > MAX_PROGRESS_BYTES) {
        log.warn('progress file too big', { name: f.name, size: f.size });
        flash('err', `${f.name} is ${humanSize(f.size)} — over the 50 MB limit. Add a Drive or GitHub link instead.`);
        return;
      }
      setPgFile(f);
    } catch (e) {
      log.error('progress file read failed', e?.message);
      flash('err', e?.message || 'Could not read that file');
    }
  }

  async function onUploadManual() {
    if (!manFile || !manDesc.trim()) return;

    // Same trap as the progress form: a link typed but not "+"-ed would be lost.
    let links = manLinks;
    if (manLink.trim()) {
      const url = normalizeUrl(manLink);
      if (!url) { flash('err', 'That link is not a valid URL — fix or clear it before uploading'); return; }
      if (!links.includes(url)) links = [...links, url];
      setManLinks(links); setManLink('');
      log.info('auto-added typed manual link on upload', { url });
    }

    log.info('upload manual →', { kpi_id: task.id, name: manFile.name, size: manFile.size, links: links.length });
    setManBusy(true); setManPct(0);
    try {
      // /kpi/manual/upload is a JSON route, so this one does need base64.
      const data64 = await FileSystem.readAsStringAsync(manFile.uri, { encoding: FileSystem.EncodingType.Base64 });
      log.info('manual read as base64', { name: manFile.name, bytesB64: data64.length });
      const res = await uploadManual(
        task.id,
        { fileData: data64, fileName: manFile.name, reason: manDesc.trim(), links },
        (sent, total) => { if (total) setManPct(Math.min(100, Math.round((sent / total) * 100))); },
      );
      if (res?.status === false) {
        log.warn('upload manual refused', { kpi_id: task.id, message: res.message });
        flash('err', res.message || 'Upload failed');
      } else {
        log.info('upload manual ← ok', { kpi_id: task.id, name: manFile.name });
        flash('ok', `Uploaded ${manFile.name}`);
        setManFile(null); setManDesc(''); setManLinks([]); setManLink(''); setManOpen(false);
        load(true);
      }
    } catch (e) {
      log.error('manual upload failed', e?.message);
      flash('err', 'Upload failed — check your connection and try again');
    } finally { setManBusy(false); setManPct(0); }
  }

  // ---- Progress update ----------------------------------------------------
  const [pgSummary, setPgSummary] = useState('');
  const [pgLink, setPgLink] = useState('');
  const [pgLinks, setPgLinks] = useState([]);
  const [pgFile, setPgFile] = useState(null);
  const [pgPct, setPgPct] = useState(0);
  const [pgBusy, setPgBusy] = useState(false);

  async function onSubmitProgress() {
    if (!pgSummary.trim()) { flash('err', 'Progress summary is required'); return; }

    // A link typed but not "+"-ed would otherwise be thrown away silently —
    // every related_links row in the database is '[]' because of exactly that.
    // Treat a filled input as intent to add it.
    let links = pgLinks;
    if (pgLink.trim()) {
      const url = normalizeUrl(pgLink);
      if (!url) {
        flash('err', 'That link is not a valid URL — fix or clear it before submitting');
        return;
      }
      if (!links.includes(url)) links = [...links, url];
      setPgLinks(links);
      setPgLink('');
      log.info('auto-added typed link on submit', { url });
    }

    log.info('submit progress →', {
      kpi_id: task.id, links: links.length,
      file: pgFile?.name || null, size: pgFile?.size || 0,
    });
    setPgBusy(true); setPgPct(0);
    try {
      const res = await submitProgressUpdate(
        task.id,
        { summary: pgSummary.trim(), links, file: pgFile },
        (sent, total) => { if (total) setPgPct(Math.min(100, Math.round((sent / total) * 100))); },
      );
      if (res?.status === false) {
        log.warn('submit progress refused', { kpi_id: task.id, message: res.message });
        flash('err', res.message || 'Could not submit');
        return;
      }
      log.info('submit progress ← ok', { kpi_id: task.id, progress_id: res?.progress_id });
      flash('ok', 'Progress update submitted');
      setPgSummary(''); setPgLink(''); setPgLinks([]); setPgFile(null);
      load(true);
      onChanged && onChanged();
    } catch (e) {
      log.error('progress submit failed', e?.message);
      flash('err', 'Could not submit — check your connection');
    } finally { setPgBusy(false); setPgPct(0); }
  }

  // ---- GitHub -------------------------------------------------------------
  const [ghUrl, setGhUrl] = useState('');
  const [ghBranch, setGhBranch] = useState('');
  const [ghBusy, setGhBusy] = useState(false);

  async function onAddGithub() {
    if (!ghUrl.trim() || !ghBranch.trim()) { flash('err', 'Repository URL and branch are both required'); return; }
    log.info('add github →', { kpi_id: task.id, url: ghUrl.trim(), branch: ghBranch.trim() });
    setGhBusy(true);
    // The server owns the rules (github.com only, branch required) — show what it says.
    const res = await addGithubLink(task.id, ghUrl.trim(), ghBranch.trim());
    setGhBusy(false);
    if (res?.status === false) {
      log.warn('add github refused', { message: res.message });
      flash('err', res.message || 'Could not add link');
      return;
    }
    log.info('add github ← ok', { link_id: res?.link_id });
    flash('ok', 'GitHub link added');
    setGhUrl(''); setGhBranch('');
    load(true);
  }

  // ---- Delete (always via a confirm) --------------------------------------
  // Deleting is irreversible and the trash icon sits next to View/Download, so
  // a mis-tap would silently destroy someone's upload. Ask first, and name what
  // is about to go.
  const [confirmDel, setConfirmDel] = useState(null); // { kind, id, name }
  const [delBusy, setDelBusy] = useState(false);

  async function doDelete() {
    if (!confirmDel) return;
    const { kind, id } = confirmDel;
    log.info('delete →', { kind, id });
    setDelBusy(true);
    const res = kind === 'manual' ? await deleteManual(id) : await deleteGithubLink(id);
    setDelBusy(false);
    setConfirmDel(null);
    if (res?.status === false) {
      log.warn('delete refused', { kind, id, message: res.message });
      flash('err', res.message || 'Could not delete');
      return;
    }
    log.info('delete ← ok', { kind, id });
    flash('ok', kind === 'manual' ? 'Manual deleted' : 'GitHub link deleted');
    load(true);
  }

  // ---- Attached files: View / Download / View note -------------------------
  const [viewer, setViewer] = useState(null);   // { name, uri, mimetype, isImage }
  const [fileBusy, setFileBusy] = useState(null); // progress id being fetched
  const [noteFocus, setNoteFocus] = useState(null); // progress id to highlight

  const scrollRef = useRef(null);
  const historyY = useRef(0);            // y of the Progress History section
  const noteY = useRef({});              // y of each history row, within that section
  const noteFlash = useRef(new Animated.Value(0)).current;

  // Progress files and manuals live in different models, so they have their own
  // routes — but everything downstream (cache, view, download) is identical, so
  // `kind` picks the fetcher and the rest is shared.
  const fetchBytes = (id, kind) => (kind === 'manual' ? fetchManualFile(id) : fetchProgressFile(id));

  // Pull the bytes over the authenticated JSON channel, drop them in the cache,
  // and hand back a file:// uri anything local can open.
  async function cacheFile(id, kind) {
    const res = await fetchBytes(id, kind);
    if (!res?.status) {
      flash('err', res?.message || 'Could not fetch the file');
      return null;
    }
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    // Names come back URL-encoded ("banner_2%20(1).jpg") and can carry
    // separators — decode, then keep only the basename so the write can't
    // wander outside the cache directory.
    let name = res.file_name || 'file';
    try { name = decodeURIComponent(name); } catch (_) {}
    name = name.split(/[\\/]/).pop() || 'file';
    const uri = `${dir}${Date.now()}_${name}`;
    await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
    log.info('file cached', { uri, size: res.size, mimetype: res.mimetype });
    return { ...res, uri, file_name: name };
  }

  async function onViewFile(f, kind = 'progress') {
    log.info('view file →', { id: f.id, kind, name: f.file_name });
    setFileBusy(`${kind}-${f.id}`);
    try {
      const c = await cacheFile(f.id, kind);
      if (!c) return;
      if (isImageName(c.file_name) || (c.mimetype || '').startsWith('image/')) {
        // Show it right here rather than punting to another app.
        setViewer({ name: c.file_name, uri: c.uri, mimetype: c.mimetype, isImage: true });
      } else if (await Sharing.isAvailableAsync()) {
        // PDFs/docs: hand to whatever the device uses to open them.
        await Sharing.shareAsync(c.uri, { mimeType: c.mimetype, dialogTitle: `Open ${c.file_name}` });
      } else {
        flash('err', 'No app available to open this file type');
      }
    } catch (e) {
      log.error('view file failed', e?.message);
      flash('err', 'Could not open that file');
    } finally { setFileBusy(null); }
  }

  async function onDownloadFile(f, kind = 'progress') {
    log.info('download file →', { id: f.id, kind, name: f.file_name });
    setFileBusy(`${kind}-${f.id}`);
    try {
      const res = await fetchBytes(f.id, kind);
      if (!res?.status) { flash('err', res?.message || 'Could not fetch the file'); return; }

      let name = res.file_name || 'file';
      try { name = decodeURIComponent(name); } catch (_) {}
      name = name.split(/[\\/]/).pop() || 'file';

      const SAF = FileSystem.StorageAccessFramework;
      if (Platform.OS === 'android' && SAF) {
        // Ask WHERE first — nothing is written until a folder is chosen.
        const perm = await SAF.requestDirectoryPermissionsAsync();
        if (!perm.granted) {
          log.info('download: folder pick cancelled');
          flash('err', 'Download cancelled — no folder chosen');
          return;
        }
        // SAF appends the extension from the mime type, so strip it off the name
        // first or the file lands as "photo.jpg.jpg".
        const dot = name.lastIndexOf('.');
        const bare = dot > 0 ? name.slice(0, dot) : name;
        const uri = await SAF.createFileAsync(perm.directoryUri, bare, res.mimetype || 'application/octet-stream');
        await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
        log.info('file saved via SAF', { uri, size: res.size });
        flash('ok', `Saved ${name}`);
        return;
      }

      // iOS: no folder picker — the share sheet is where "Save to Files" lives.
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: res.mimetype, dialogTitle: `Save ${name}` });
        flash('ok', `${name} ready`);
      } else {
        flash('err', 'Saving is not available on this device');
      }
    } catch (e) {
      log.error('download file failed', e?.message);
      flash('err', 'Could not download that file');
    } finally { setFileBusy(null); }
  }

  // "View note" — jump to the progress update this file came from and flash it.
  // The file's id IS its kpi.progress id, so they match directly.
  function onViewNote(f) {
    log.info('view note →', { progress_id: f.id });
    const y = historyY.current + (noteY.current[f.id] || 0);
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 70), animated: true });
    setNoteFocus(f.id);
    noteFlash.setValue(0);
    Animated.sequence([
      Animated.timing(noteFlash, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.delay(900),
      Animated.timing(noteFlash, { toValue: 0, duration: 420, easing: Easing.in(Easing.quad), useNativeDriver: false }),
    ]).start(() => setNoteFocus(null));
  }

  // ---- Complete -----------------------------------------------------------
  const [checks, setChecks] = useState({});
  const [cmpBusy, setCmpBusy] = useState(false);
  const allChecked = CHECKLIST_ITEMS.every((c) => checks[c.key]);
  const hasProgress = (data?.progress?.length || 0) > 0;

  async function onComplete() {
    setCmpBusy(true);
    const res = await completeTask(task.id, checks, false);
    setCmpBusy(false);
    if (res?.status === false) { flash('err', res.message || 'Could not complete'); return; }
    flash('ok', 'Sent for approval');
    onChanged && onChanged();
    load(true);
  }

  const meta = data?.meta || {};
  const t = data?.task || task;
  const kind = KIND[meta.kind] || KIND.requirement;
  const pr = PRIORITY[t.priority] || PRIORITY.regular;

  return (
    // GradientBackground renders NO children — it is an absolute-fill backdrop
    // that must sit as the first child of a transparent root (see its own docs).
    // Wrapping the screen in it silently drops the entire screen.
    <View style={s.root}>
      <GradientBackground />
      <View style={s.wrap}>
        {/* Header — back chip on the left, mirroring the web's "← Back to KPI Actions" */}
        <View style={s.head}>
          <TouchableOpacity style={s.backChip} onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="arrow-back" size={20} color={COLORS.navy} />
          </TouchableOpacity>
          <Text style={s.headTitle} numberOfLines={1}>KPI Details</Text>
        </View>

        {!!banner && (
          <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
            <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
              color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
            <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
          </View>
        )}

        {loading ? (
          <View style={s.center}><ActivityIndicator color={COLORS.primary} size="large" /><Text style={s.centerTxt}>Loading KPI details…</Text></View>
        ) : error ? (
          <View style={s.center}>
            <Ionicons name="lock-closed-outline" size={38} color={COLORS.red} />
            <Text style={[s.centerTxt, { color: COLORS.red, fontWeight: '800' }]}>{error}</Text>
          </View>
        ) : !data ? (
          <View style={s.center}><ActivityIndicator color={COLORS.primary} size="large" /><Text style={s.centerTxt}>Loading KPI details…</Text></View>
        ) : (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.ScrollView
            ref={scrollRef}
            style={enterStyle}
            contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* ── KPI Details ─────────────────────────────────────────── */}
            <Section icon="document-text-outline" title="KPI Details">
              <Text style={s.taskName}>{t.name}</Text>
              <View style={s.tagRow}>
                {!!meta.external_ref && <View style={s.refBadge}><Text style={s.refTxt}>{meta.external_ref}</Text></View>}
                <View style={[s.pill, { backgroundColor: kind.bg }]}><Text style={[s.pillTxt, { color: kind.fg }]}>{kind.label}</Text></View>
                <View style={[s.pill, { backgroundColor: pr.bg }]}><Text style={[s.pillTxt, { color: pr.fg }]}>{pr.label}</Text></View>
              </View>
              <Row label="KRA / Project" value={meta.kra} />
              <Row label="Estimate" value={t.estimate_display} mono />
              <Row label="Assignee" value={t.user_name || 'Unassigned'} />
              <Row label="Deadline" value={t.deadline} />
              {!!meta.points && <Row label="Points" value={String(meta.points)} />}
              {!!t.requested_by_name && <Row label="Requested by" value={t.requested_by_name} />}

              <View style={s.block}>
                <Text style={s.blockTitle}>Description</Text>
                <Text style={[s.body, !t.description && s.dim]}>{t.description || '—'}</Text>
              </View>
              <View style={s.block}>
                <Text style={s.blockTitle}>Checklist</Text>
                <Text style={[s.body, !meta.checklist && s.dim]}>{meta.checklist || '—'}</Text>
              </View>
              <View style={s.block}>
                <Text style={s.blockTitle}>Guidelines</Text>
                <Text style={[s.body, !meta.guidelines && s.dim]}>{meta.guidelines || '—'}</Text>
              </View>
            </Section>

            {/* ── User Manual / Documentation ─────────────────────────── */}
            <Section icon="book-outline" title="User Manual / Documentation"
              subtitle="Guides, documentation, screenshots or clips attached to this task">
              {(data.manuals || []).length === 0 ? (
                <Empty text="No manuals uploaded yet" />
              ) : (
                <>
                  <Text style={s.countLine}>Uploaded Manuals ({data.manuals.length})</Text>
                  {data.manuals.map((m) => (
                    <View key={m.id} style={s.attRow}>
                      <View style={s.attTop}>
                        <Ionicons name="document-attach-outline" size={16} color={COLORS.primary} style={{ marginTop: 2 }} />
                        <View style={{ flex: 1, marginLeft: 8 }}>
                          <Text style={s.fileName} numberOfLines={2}>{m.file_name}</Text>
                          <Text style={s.fileMeta}>
                            {[m.uploaded_by && `Uploaded by: ${m.uploaded_by}`, m.upload_date && `Date: ${m.upload_date}`].filter(Boolean).join(' | ')}
                          </Text>
                          {!!m.reason && (
                            <View style={s.kindRow}>
                              <Ionicons name="information-circle-outline" size={12} color={COLORS.muted} />
                              <Text style={s.fileReason}>{m.reason}</Text>
                            </View>
                          )}
                          {/* A manual can carry several links — list them all. */}
                          {parseLinks(m.related_links).length > 0 && (
                            <View style={{ marginTop: 6 }}>
                              <Text style={s.relTitle}>🔗  Related Links:</Text>
                              {parseLinks(m.related_links).map((l, i) => (
                                <TouchableOpacity key={`${m.id}-${i}`}
                                  onPress={() => {
                                    log.info('open manual link', { url: l });
                                    Linking.openURL(l).catch(() => flash('err', 'Could not open that link'));
                                  }}>
                                  <Text style={s.linkTxt} numberOfLines={1}>↗  {l}</Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                        </View>
                      </View>
                      <View style={s.attBtns}>
                        {fileBusy === `manual-${m.id}` ? (
                          <View style={s.attBusy}><ActivityIndicator size="small" color={COLORS.primary} /></View>
                        ) : (
                          <>
                            <TouchableOpacity style={s.attView} onPress={() => onViewFile(m, 'manual')}>
                              <Ionicons name="eye" size={13} color="#fff" />
                              <Text style={s.attBtnTxt}>View</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[s.attDl, { backgroundColor: COLORS.green }]} onPress={() => onDownloadFile(m, 'manual')}>
                              <Ionicons name="download" size={13} color="#fff" />
                              <Text style={s.attBtnTxt}>Download</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.attDel}
                              onPress={() => setConfirmDel({ kind: 'manual', id: m.id, name: m.file_name })}>
                              <Ionicons name="trash-outline" size={13} color="#fff" />
                            </TouchableOpacity>
                          </>
                        )}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {!manOpen ? (
                <TouchableOpacity style={s.addBtn} onPress={() => setManOpen(true)}>
                  <Ionicons name="add" size={16} color="#fff" />
                  <Text style={s.addBtnTxt}>Add New Manual</Text>
                </TouchableOpacity>
              ) : (
                <View style={s.form}>
                  <TouchableOpacity style={s.filePick} onPress={onPickManual}>
                    <Ionicons name="cloud-upload-outline" size={16} color={COLORS.primary} />
                    <Text style={s.filePickTxt} numberOfLines={1}>
                      {manFile ? `${manFile.name}  ·  ${humanSize(manFile.size)}` : 'Choose a file'}
                    </Text>
                  </TouchableOpacity>
                  <Text style={s.label}>Description <Text style={s.req}>*</Text></Text>
                  <TextInput style={s.input} placeholder="What is this file?" placeholderTextColor={COLORS.faint}
                    value={manDesc} onChangeText={setManDesc} />

                  {/* Related Links — as many as you like, same as the web. */}
                  <Text style={s.label}>Related Links (optional)</Text>
                  <View style={s.linkRow}>
                    <TextInput style={[s.input, { flex: 1 }]} placeholder="https://docs.google.com/…"
                      placeholderTextColor={COLORS.faint} value={manLink} onChangeText={setManLink}
                      autoCapitalize="none" keyboardType="url" />
                    <TouchableOpacity style={s.linkAdd} onPress={() => {
                      const url = normalizeUrl(manLink);
                      if (!url) { flash('err', 'That does not look like a link — paste a full URL'); return; }
                      if (manLinks.includes(url)) { flash('err', 'That link is already added'); return; }
                      log.info('add manual link', { url });
                      setManLinks([...manLinks, url]);
                      setManLink('');
                    }}>
                      <Ionicons name="add" size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                  {manLinks.map((l, i) => (
                    <View key={`${l}-${i}`} style={s.linkChip}>
                      <Ionicons name="link" size={13} color={COLORS.primary} />
                      <Text style={s.linkChipTxt} numberOfLines={1}>{l}</Text>
                      <TouchableOpacity onPress={() => setManLinks(manLinks.filter((_, x) => x !== i))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={15} color={COLORS.faint} />
                      </TouchableOpacity>
                    </View>
                  ))}

                  {manBusy && (
                    <View style={{ marginTop: 10 }}>
                      <View style={s.barTrack}><View style={[s.barFill, { width: `${manPct}%` }]} /></View>
                      <Text style={s.pctTxt}>{humanSize(manFile?.size || 0)} · {manPct}%</Text>
                    </View>
                  )}
                  <View style={s.formBtns}>
                    <TouchableOpacity style={s.ghostBtn} onPress={() => { setManOpen(false); setManFile(null); setManDesc(''); setManLinks([]); setManLink(''); }} disabled={manBusy}>
                      <Text style={s.ghostBtnTxt}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.primBtn, (!manFile || !manDesc.trim() || manBusy) && s.btnOff]}
                      onPress={onUploadManual} disabled={!manFile || !manDesc.trim() || manBusy}>
                      {manBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primBtnTxt}>Upload</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </Section>

            {/* ── Submit Progress Update ──────────────────────────────── */}
            <Section icon="create-outline" title="Submit Progress Update">
              <Text style={s.label}>Progress Summary <Text style={s.req}>*</Text></Text>
              <TextInput style={[s.input, s.textarea]} multiline placeholder="Describe the work done, issues found, next steps…"
                placeholderTextColor={COLORS.faint} value={pgSummary} onChangeText={setPgSummary} />

              <Text style={s.label}>Related Links (optional)</Text>
              <View style={s.linkRow}>
                <TextInput style={[s.input, { flex: 1 }]} placeholder="https://github.com/… or https://drive.google.com/…"
                  placeholderTextColor={COLORS.faint} value={pgLink} onChangeText={setPgLink}
                  autoCapitalize="none" keyboardType="url" />
                <TouchableOpacity style={s.linkAdd} onPress={() => {
                  const url = normalizeUrl(pgLink);
                  if (!url) { flash('err', 'That does not look like a link — paste a full URL, e.g. https://drive.google.com/…'); return; }
                  if (pgLinks.includes(url)) { flash('err', 'That link is already added'); return; }
                  log.info('add related link', { url });
                  setPgLinks([...pgLinks, url]);
                  setPgLink('');
                }}>
                  <Ionicons name="add" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
              {pgLinks.map((l, i) => (
                <View key={`${l}-${i}`} style={s.linkChip}>
                  <Ionicons name="link" size={13} color={COLORS.primary} />
                  <Text style={s.linkChipTxt} numberOfLines={1}>{l}</Text>
                  <TouchableOpacity onPress={() => setPgLinks(pgLinks.filter((_, x) => x !== i))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={15} color={COLORS.faint} />
                  </TouchableOpacity>
                </View>
              ))}
              <Text style={s.linkHint}>
                Google Drive, GitHub, or any related link. Tap + to add — a link left in the box
                is still included when you submit.
              </Text>

              <Text style={s.label}>Attach File (optional)</Text>
              <TouchableOpacity style={s.filePick} onPress={onPickProgressFile}>
                <Ionicons name="attach-outline" size={16} color={COLORS.primary} />
                <Text style={s.filePickTxt} numberOfLines={1}>
                  {pgFile ? `${pgFile.name}  ·  ${humanSize(pgFile.size)}` : 'Choose a file'}
                </Text>
                {!!pgFile && (
                  <TouchableOpacity onPress={() => setPgFile(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={16} color={COLORS.faint} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
              {/* Same warning the web shows under its file input (kpi_action.js). */}
              <Text style={s.fileWarn}>
                ⚠ Large files take time — keep this screen open until 100%. Max 50 MB.
                For bigger files, add a Drive or GitHub link instead.
              </Text>

              {pgBusy && !!pgFile && (
                <View style={{ marginTop: 10 }}>
                  <View style={s.barTrack}><View style={[s.barFill, { width: `${pgPct}%` }]} /></View>
                  <Text style={s.pctTxt}>{humanSize(pgFile.size)} · {pgPct}%</Text>
                </View>
              )}

              <TouchableOpacity style={[s.wideBtn, (!pgSummary.trim() || pgBusy) && s.btnOff]}
                onPress={onSubmitProgress} disabled={!pgSummary.trim() || pgBusy}>
                {pgBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                  <><Ionicons name="cloud-upload-outline" size={16} color="#fff" /><Text style={s.wideBtnTxt}>Submit Update</Text></>
                )}
              </TouchableOpacity>
            </Section>

            {/* ── GitHub ─────────────────────────────────────────────── */}
            <Section icon="logo-github" title="Link a GitHub branch" tint="#111827">
              <Text style={s.label}>Repository URL</Text>
              <TextInput style={s.input} placeholder="https://github.com/username/repository"
                placeholderTextColor={COLORS.faint} value={ghUrl} onChangeText={setGhUrl}
                autoCapitalize="none" keyboardType="url" />
              <Text style={s.label}>Branch</Text>
              <TextInput style={s.input} placeholder="main / feature/xyz"
                placeholderTextColor={COLORS.faint} value={ghBranch} onChangeText={setGhBranch} autoCapitalize="none" />
              <TouchableOpacity style={[s.wideBtn, { backgroundColor: COLORS.green }, ghBusy && s.btnOff]}
                onPress={onAddGithub} disabled={ghBusy}>
                {ghBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                  <><Ionicons name="logo-github" size={16} color="#fff" /><Text style={s.wideBtnTxt}>Add GitHub Link</Text></>
                )}
              </TouchableOpacity>
            </Section>

            {/* ── Complete This Task ─────────────────────────────────── */}
            {!!meta.can_complete && (
              <View style={[s.card, s.cardDanger]}>
                <View style={s.cardHead}>
                  <Ionicons name="checkmark-circle-outline" size={17} color={COLORS.red} />
                  <Text style={[s.cardTitle, { color: COLORS.red }]}>Complete This Task</Text>
                </View>

                {!hasProgress && (
                  <View style={s.warnBox}>
                    <Ionicons name="warning-outline" size={15} color="#92400E" />
                    <Text style={s.warnTxt}>Submit a Progress Summary above before you complete this task.</Text>
                  </View>
                )}

                <Text style={s.cardSub}>Confirm each item — all are required to send this task for approval.</Text>
                {CHECKLIST_ITEMS.map((c, i) => (
                  <TouchableOpacity key={c.key} style={s.checkRow} activeOpacity={0.7}
                    onPress={() => setChecks({ ...checks, [c.key]: !checks[c.key] })}>
                    <Ionicons name={checks[c.key] ? 'checkbox' : 'square-outline'} size={19}
                      color={checks[c.key] ? COLORS.green : COLORS.faint} />
                    <Text style={s.checkTxt}>{i + 1}. {c.label}</Text>
                  </TouchableOpacity>
                ))}

                <TouchableOpacity
                  style={[s.wideBtn, { backgroundColor: COLORS.red }, (!allChecked || !hasProgress || cmpBusy) && s.btnOff]}
                  onPress={onComplete} disabled={!allChecked || !hasProgress || cmpBusy}>
                  {cmpBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                    <><Ionicons name="flag" size={16} color="#fff" /><Text style={s.wideBtnTxt}>Complete &amp; Send for Approval</Text></>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* ── Attached Files ─────────────────────────────────────── */}
            <Section icon="folder-open-outline" title="Attached Files"
              right={(data.files || []).length > 1 ? <SortChip value={sortFiles} onChange={setSortFiles} /> : null}>
              {(data.files || []).length === 0 ? <Empty text="No documents yet" /> : (
                sortItems(data.files, sortFiles, 'upload_date', 'file_name').map((f) => (
                  <View key={f.id} style={s.attRow}>
                    <View style={s.attTop}>
                      <Ionicons name="document-outline" size={16} color={COLORS.primary} style={{ marginTop: 2 }} />
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={s.fileName} numberOfLines={1}>{f.file_name}</Text>
                        <Text style={s.fileMeta}>Uploaded by: {f.uploaded_by || '—'}</Text>
                        <Text style={s.fileMeta}>Date: {f.upload_date}</Text>
                      </View>
                    </View>
                    <View style={s.attBtns}>
                      {fileBusy === `progress-${f.id}` ? (
                        <View style={s.attBusy}><ActivityIndicator size="small" color={COLORS.primary} /></View>
                      ) : (
                        <>
                          <TouchableOpacity style={s.attGhost} onPress={() => onViewNote(f)}>
                            <Ionicons name="reader-outline" size={13} color={COLORS.muted} />
                            <Text style={s.attGhostTxt}>View note</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={s.attView} onPress={() => onViewFile(f)}>
                            <Ionicons name="eye" size={13} color="#fff" />
                            <Text style={s.attBtnTxt}>View</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={s.attDl} onPress={() => onDownloadFile(f)}>
                            <Ionicons name="download" size={13} color="#fff" />
                            <Text style={s.attBtnTxt}>Download</Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </View>
                ))
              )}
            </Section>

            {/* ── GitHub Repository Links ────────────────────────────── */}
            {/* Sits below Attached Files, matching the web's order. The form
                further up is for ADDING; this is what's already linked. */}
            <Section icon="logo-github" title="GitHub Repository Links" tint="#111827"
              right={(data.github || []).length > 1 ? <SortChip value={sortGh} onChange={setSortGh} /> : null}>
              {(data.github || []).length === 0 ? <Empty text="No repositories yet" /> : (
                sortItems(data.github, sortGh, 'create_date', 'github_url').map((g) => (
                  <View key={g.id} style={s.attRow}>
                    <View style={s.attTop}>
                      <Ionicons name="logo-github" size={16} color="#111827" style={{ marginTop: 2 }} />
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={s.linkTxt} numberOfLines={2}>{g.github_url}</Text>
                        <View style={s.kindRow}>
                          <Ionicons name="git-branch-outline" size={12} color={COLORS.green} />
                          <Text style={s.branchTxt}>{g.branch_name}</Text>
                        </View>
                        <Text style={s.fileMeta}>
                          {[g.employee_name && `Uploaded by: ${g.employee_name}`, g.create_date].filter(Boolean).join(' | ')}
                        </Text>
                      </View>
                    </View>
                    <View style={s.attBtns}>
                      <TouchableOpacity style={s.attOpen} onPress={() => {
                        log.info('open github link', { url: g.github_url });
                        Linking.openURL(g.github_url).catch(() => flash('err', 'Could not open that link'));
                      }}>
                        <Ionicons name="open-outline" size={13} color="#fff" />
                        <Text style={s.attBtnTxt}>Open GitHub link</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.attDel}
                        onPress={() => setConfirmDel({ kind: 'github', id: g.id, name: g.github_url })}>
                        <Ionicons name="trash-outline" size={13} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </Section>

            {/* ── Documents ──────────────────────────────────────────── */}
            {/* Same source as Attached Files (the web renders it twice too), kept
                as its own compact pane so the layout matches the web page. */}
            <Section icon="documents-outline" title="Documents"
              right={(data.files || []).length > 1 ? <SortChip value={sortDocs} onChange={setSortDocs} /> : null}>
              {(data.files || []).length === 0 ? <Empty text="No documents yet" /> : (
                sortItems(data.files, sortDocs, 'upload_date', 'file_name').map((f) => (
                  <View key={`doc-${f.id}`} style={s.fileRow}>
                    <Ionicons name="document-text-outline" size={15} color={COLORS.primary} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={s.fileName} numberOfLines={1}>{f.file_name}</Text>
                      <Text style={s.fileMeta}>{[f.uploaded_by, f.upload_date].filter(Boolean).join(' · ')}</Text>
                    </View>
                    <TouchableOpacity style={s.attView} onPress={() => onViewFile(f)} disabled={fileBusy === `progress-${f.id}`}>
                      <Text style={s.attBtnTxt}>View</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.attDl, { marginLeft: 6 }]} onPress={() => onDownloadFile(f)} disabled={fileBusy === `progress-${f.id}`}>
                      <Text style={s.attBtnTxt}>Download</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </Section>

            {/* ── Drive & Links ──────────────────────────────────────── */}
            {/* These DO open: they're external URLs (Drive, GitHub, …), so no
                Odoo session is involved. `kind` comes from the server's own
                classifier, not from anything guessed here. */}
            <Section icon="link-outline" title="Drive &amp; Links"
              right={(data.links || []).length > 1 ? <SortChip value={sortDrive} onChange={setSortDrive} /> : null}>
              {(data.links || []).length === 0 ? <Empty text="No links yet" /> : (
                sortItems(data.links, sortDrive, 'added_date', 'url').map((l, i) => (
                  <View key={`${l.url}-${i}`} style={s.attRow}>
                    <View style={s.attTop}>
                      <Ionicons name="link" size={16} color={COLORS.primary} style={{ marginTop: 2 }} />
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={s.linkTxt} numberOfLines={2}>{l.url}</Text>
                        <View style={s.kindRow}>
                          {/* `kind` is the server's classification of the url — a
                              Drive link can only ever read "Google Drive". */}
                          <View style={s.kindBadge}><Text style={s.kindTxt}>{l.kind}</Text></View>
                          <Text style={s.fileMeta}>{[l.added_by, l.added_date].filter(Boolean).join(' · ')}</Text>
                        </View>
                      </View>
                    </View>
                    <View style={s.attBtns}>
                      {/* Only when the link came from a progress update — a
                          task-level link has no note to jump to. */}
                      {!!l.progress_id && (
                        <TouchableOpacity style={s.attGhost} onPress={() => onViewNote({ id: l.progress_id })}>
                          <Ionicons name="reader-outline" size={13} color={COLORS.muted} />
                          <Text style={s.attGhostTxt}>View note</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity style={s.attOpen} onPress={() => {
                        log.info('open link', { url: l.url, kind: l.kind });
                        Linking.openURL(l.url).catch(() => flash('err', 'Could not open that link'));
                      }}>
                        <Ionicons name="open-outline" size={13} color="#fff" />
                        <Text style={s.attBtnTxt}>Open link</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </Section>

            {/* ── Progress History ───────────────────────────────────── */}
            {/* onLayout records where this section and each row sit, so "View
                note" can scroll straight to the update a file came from.
                onLayout (not measureLayout) — the New Architecture rejects
                findNodeHandle-based measurement. */}
            <View onLayout={(e) => { historyY.current = e.nativeEvent.layout.y; }}>
              <Section icon="time-outline" title="Progress History">
                {(data.progress || []).length === 0 ? (
                  <Empty text="No progress updates yet. Submit your first update above." />
                ) : (
                  data.progress.map((p) => (
                    <Animated.View
                      key={p.id}
                      onLayout={(e) => { noteY.current[p.id] = e.nativeEvent.layout.y; }}
                      style={[
                        s.histRow,
                        noteFocus === p.id && {
                          backgroundColor: noteFlash.interpolate({
                            inputRange: [0, 1], outputRange: ['#F8FAFC', '#FEF3C7'],
                          }),
                          borderColor: '#F5A623',
                          borderWidth: 1,
                        },
                      ]}
                    >
                      <View style={s.histTop}>
                        <Text style={s.histWho}>{p.employee_name || 'Someone'}</Text>
                        <Text style={s.histWhen}>{p.create_date}</Text>
                      </View>
                      <Text style={s.body}>{p.summary}</Text>
                      {parseLinks(p.related_links).map((l, i) => (
                        <TouchableOpacity key={i} onPress={() => Linking.openURL(l).catch(() => flash('err', 'Could not open link'))}>
                          <Text style={s.linkTxt} numberOfLines={1}>🔗 {l}</Text>
                        </TouchableOpacity>
                      ))}
                      {!!p.has_file && (
                        <TouchableOpacity style={s.histFile} onPress={() => onViewFile({ id: p.id, file_name: p.file_name })}>
                          <Ionicons name="download-outline" size={13} color={COLORS.primary} />
                          <Text style={s.histFileTxt} numberOfLines={1}>{p.file_name}</Text>
                        </TouchableOpacity>
                      )}
                    </Animated.View>
                  ))
                )}
              </Section>
            </View>

            {/* ── Reassignment History (only when it has one) ────────── */}
            {(data.reassignments || []).length > 0 && (
              <Section icon="swap-horizontal-outline" title="Reassignment History">
                {data.reassignments.map((h) => (
                  <View key={h.id} style={s.histRow}>
                    <View style={s.histTop}>
                      <Text style={s.histWho}>{h.previous_assignee} → {h.new_assignee}</Text>
                      <Text style={s.histWhen}>{h.reassignment_date}</Text>
                    </View>
                    {!!h.reason && <Text style={s.body}>{h.reason}</Text>}
                    <Text style={s.fileMeta}>
                      {[h.reassigned_by && `by ${h.reassigned_by}`, h.time_spent && `time ${h.time_spent}`].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </Section>
            )}
          </Animated.ScrollView>
          </KeyboardAvoidingView>
        )}

        {/* Delete confirm — names the exact file/link so you can see what you're
            about to lose. Nothing is deleted until this is confirmed. */}
        <Modal visible={!!confirmDel} transparent animationType="fade" onRequestClose={() => setConfirmDel(null)}>
          {!!confirmDel && (
            <View style={s.cWrap}>
              <View style={s.cCard}>
                <View style={s.cIcon}>
                  <Ionicons name="trash" size={26} color={COLORS.red} />
                </View>
                <Text style={s.cTitle}>
                  {confirmDel.kind === 'manual' ? 'Delete this manual?' : 'Delete this GitHub link?'}
                </Text>
                <Text style={s.cName} numberOfLines={2}>{confirmDel.name}</Text>
                <Text style={s.cMsg}>
                  {confirmDel.kind === 'manual'
                    ? 'The file and its description will be removed for everyone. This cannot be undone.'
                    : 'The repository link will be removed for everyone. This cannot be undone.'}
                </Text>
                <View style={s.cBtns}>
                  <TouchableOpacity style={s.ghostBtn} onPress={() => setConfirmDel(null)} disabled={delBusy}>
                    <Text style={s.ghostBtnTxt}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.primBtn, { backgroundColor: COLORS.red }, delBusy && s.btnOff]}
                    onPress={doDelete} disabled={delBusy}>
                    {delBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primBtnTxt}>Delete</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </Modal>

        {/* Image viewer — the bytes were fetched over the authenticated channel
            and cached, so this points at a local file:// uri. An <Image> aimed at
            /kpi/progress/view would render the login page instead. */}
        <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
          {!!viewer && (
            <View style={s.viewerWrap}>
              <View style={s.viewerHead}>
                <Text style={s.viewerName} numberOfLines={1}>{viewer.name}</Text>
                <TouchableOpacity onPress={() => setViewer(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={s.viewerBody}
                maximumZoomScale={4}
                minimumZoomScale={1}
                centerContent
              >
                <Image source={{ uri: viewer.uri }} style={s.viewerImg} resizeMode="contain" />
              </ScrollView>
            </View>
          )}
        </Modal>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // Transparent so the gradient behind it shows through — the board's root does
  // the same. A background colour here would hide the backdrop.
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  wrap: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingTop: TOP, paddingBottom: 8 },
  backChip: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 19, fontWeight: '900', color: COLORS.navy },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 6, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '700' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 30 },
  centerTxt: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12 },
  cardDanger: { borderWidth: 1.5, borderColor: COLORS.red },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  cardTitle: { fontSize: 15, fontWeight: '900', color: COLORS.navy },

  // Sort control — Newest / Oldest / Name, as on the web's resource panes.
  sortChip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 9, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  sortChipTxt: { fontSize: 11.5, fontWeight: '700', color: COLORS.ink },
  sortMenu: { marginTop: 4, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, backgroundColor: '#fff', overflow: 'hidden' },
  sortItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  sortItemOn: { backgroundColor: '#EEF3FF' },
  sortItemTxt: { fontSize: 12, color: COLORS.ink },
  sortItemTxtOn: { fontWeight: '800', color: COLORS.primary },
  cardSub: { fontSize: 12, color: COLORS.muted, marginBottom: 10, lineHeight: 17 },

  taskName: { fontSize: 16, fontWeight: '900', color: COLORS.ink, marginTop: 6 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 8, marginBottom: 4 },
  refBadge: { backgroundColor: '#E0ECFF', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 },
  refTxt: { fontSize: 12, fontWeight: '900', color: '#2563EB', letterSpacing: 0.4 },
  pill: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 },
  pillTxt: { fontSize: 11.5, fontWeight: '800' },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 13, color: COLORS.muted, fontWeight: '700' },
  rowValue: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '700', textAlign: 'right' },
  mono: { fontVariant: ['tabular-nums'] },

  block: { marginTop: 12 },
  blockTitle: { fontSize: 13, fontWeight: '900', color: COLORS.navy, marginBottom: 4 },
  body: { fontSize: 13.5, color: COLORS.ink, lineHeight: 19 },
  dim: { color: COLORS.faint, fontStyle: 'italic' },
  empty: { fontSize: 13, color: COLORS.faint, fontStyle: 'italic', paddingVertical: 6 },

  fileRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, marginBottom: 7 },
  fileName: { fontSize: 13, fontWeight: '800', color: COLORS.ink },
  fileReason: { fontSize: 12.5, color: COLORS.ink, marginTop: 2, lineHeight: 17 },
  fileMeta: { fontSize: 11, color: COLORS.faint, marginTop: 3 },
  linkTxt: { fontSize: 12.5, color: COLORS.primary, textDecorationLine: 'underline', marginTop: 2 },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  kindBadge: { backgroundColor: '#EEF3FF', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  kindTxt: { fontSize: 10.5, fontWeight: '800', color: COLORS.primary },

  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primary, height: 42, borderRadius: 10, marginTop: 10 },
  addBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5 },

  form: { marginTop: 10, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 },
  label: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginTop: 10, marginBottom: 5 },
  req: { color: COLORS.red },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 13.5, color: COLORS.ink, backgroundColor: '#fff' },
  textarea: { minHeight: 84, textAlignVertical: 'top' },

  filePick: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: COLORS.line, borderStyle: 'dashed', borderRadius: 9, paddingHorizontal: 11, height: 44, backgroundColor: '#fff' },
  filePickTxt: { flex: 1, fontSize: 12.5, color: COLORS.ink, fontWeight: '600' },
  fileWarn: { fontSize: 11.5, color: COLORS.red, marginTop: 6, lineHeight: 16 },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkAdd: { width: 44, height: 40, borderRadius: 9, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EEF3FF', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7, marginTop: 6 },
  linkChipTxt: { flex: 1, fontSize: 12, color: COLORS.ink },

  barTrack: { height: 6, borderRadius: 3, backgroundColor: '#E5E7EB', overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: COLORS.primary },
  pctTxt: { fontSize: 11, fontWeight: '800', color: COLORS.primary, marginTop: 4 },

  formBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  ghostBtn: { paddingHorizontal: 16, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F8' },
  ghostBtnTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 13 },
  primBtn: { paddingHorizontal: 20, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary },
  primBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 13 },

  wideBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: COLORS.primary, height: 46, borderRadius: 10, marginTop: 14 },
  wideBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
  btnOff: { opacity: 0.45 },

  warnBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: '#FEF3C7', borderRadius: 9, padding: 10, marginBottom: 10, marginTop: 4 },
  warnTxt: { flex: 1, fontSize: 12.5, color: '#92400E', fontWeight: '700', lineHeight: 17 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
  checkTxt: { flex: 1, fontSize: 13, color: COLORS.ink, fontWeight: '700' },

  histRow: { backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, marginBottom: 7 },
  histTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 8 },
  histWho: { flex: 1, fontSize: 12.5, fontWeight: '900', color: COLORS.navy },
  histWhen: { fontSize: 11, color: COLORS.faint },
  histFile: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 7, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: '#fff' },
  histFileTxt: { fontSize: 11.5, fontWeight: '700', color: COLORS.primary, maxWidth: 210 },

  // Attached Files rows — file meta stacked, actions on their own line so three
  // buttons fit a phone width without shrinking to unhittable slivers.
  attRow: { backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, marginBottom: 8 },
  attTop: { flexDirection: 'row', alignItems: 'flex-start' },
  attBtns: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 7, marginTop: 9 },
  attBusy: { height: 32, justifyContent: 'center', paddingHorizontal: 10 },
  attGhost: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  attGhostTxt: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted },
  attView: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 11, borderRadius: 8, backgroundColor: '#0EA5A4' },
  attDl: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 11, borderRadius: 8, backgroundColor: COLORS.primary },
  attOpen: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 11, borderRadius: 8, backgroundColor: COLORS.primary },
  attDel: { alignItems: 'center', justifyContent: 'center', height: 32, width: 34, borderRadius: 8, backgroundColor: COLORS.red },
  attBtnTxt: { fontSize: 11.5, fontWeight: '800', color: '#fff' },
  branchTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.green },
  linkHint: { fontSize: 11, color: COLORS.muted, marginTop: 5, lineHeight: 15 },
  countLine: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginBottom: 8 },
  relTitle: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary, marginBottom: 2 },

  // Delete confirm — the centered icon-alert used elsewhere in the app.
  cWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 26 },
  cCard: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: 18, padding: 20, alignItems: 'center' },
  cIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: COLORS.redBg, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  cTitle: { fontSize: 16, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  cName: { fontSize: 13, fontWeight: '700', color: COLORS.ink, textAlign: 'center', marginTop: 8 },
  cMsg: { fontSize: 12.5, color: COLORS.muted, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  cBtns: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 18 },

  // Full-screen image viewer
  viewerWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  viewerHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: TOP, paddingHorizontal: 16, paddingBottom: 12 },
  viewerName: { flex: 1, fontSize: 14, fontWeight: '800', color: '#fff' },
  viewerBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 10 },
  viewerImg: { width: '100%', height: undefined, aspectRatio: 1, maxHeight: '100%' },
});
