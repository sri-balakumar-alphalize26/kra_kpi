// UPLOAD UPDATES & AMENDMENTS — mobile port of the Odoo OWL screen
// kpi_requirements_upload (docType='update'). Four sections:
//   1. Destination  — Client (Root KRA) → Project/Sub-KRA → Version
//   2. Source & Bulk Import — Source Document, Import XLSX/CSV, Paste Doc Text
//   3. Tasks — editable rows (name / hours / min / priority / developer), AI suggest
//   4. Defaults for new rows — hours / minutes / priority / developer
// plus Download Blank Template, Reset, Create All Tasks.
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
// SDK 54: the classic readAsStringAsync + EncodingType live under /legacy
// (the main entry now exports the new File/Directory API and throwing stubs).
import * as FileSystem from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';

// Excel / CSV MIME types for the Import Task List picker.
const EXCEL_CSV_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'text/csv',
  'text/comma-separated-values',
  'application/csv',
];
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import * as svc from '../services/uploadAmendments';
import { getClientProjects } from '../services/clientPortal';

const log = createLogger('UploadAmendments');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

// Per-mode config. One screen serves Requirements / Updates / Bug Reports —
// only the doc_type, titles, prefix and the "Linked Req" field differ.
const MODES = {
  requirement: { title: 'Upload Requirements', lead: 'Add new requirement tasks to a project', prefix: 'REQ', showLinkedReq: false },
  update:      { title: 'Upload Updates',      lead: 'Add update & amendment tasks to a project', prefix: 'UPT', showLinkedReq: true },
  bug:         { title: 'Upload Bug Reports',  lead: 'Add bug-report tasks to a project', prefix: 'BUG', showLinkedReq: true },
};

// Task names always start with a capital letter — matches the server, which
// enforces the same on create/write for every path. Only the first char changes.
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const pad3 = (n) => String(n).padStart(3, '0');
const emptyRow = (defaults) => ({
  name: '', external_ref: '', related_req_ref: '',
  estimate_hours: defaults.hours, estimate_minutes: defaults.minutes,
  priority: defaults.priority, primary_user_id: defaults.userId,
});

export default function UploadAmendments({ onBack, docType = 'update' }) {
  const MODE = MODES[docType] || MODES.update;
  const DOC_TYPE = docType;
  // Destination
  const [clients, setClients] = useState([]);
  const [subKras, setSubKras] = useState([]);
  const [users, setUsers] = useState([]);
  const [clientId, setClientId] = useState('');
  const [subKraId, setSubKraId] = useState('');
  const [clientProjectName, setClientProjectName] = useState(''); // client's auto-filled project (read-only)
  const [version, setVersion] = useState('');

  // Role / ref preview
  const [isClientOnly, setIsClientOnly] = useState(false);
  // Only admins/owners/system can create kra.kpi records (matches the Odoo
  // ir.model.access rule: create is limited to Manager / Administrator). If the
  // logged-in user isn't one, we show a "restricted" screen instead of the form
  // so they never hit the server-side "not allowed to create" error.
  const [canCreate, setCanCreate] = useState(true);
  const [roleName, setRoleName] = useState('');
  const [refPrefix, setRefPrefix] = useState('UPT');
  const [refNext, setRefNext] = useState(1);

  // Source & import
  const [sourceDoc, setSourceDoc] = useState(null); // { data, name }
  const [pasteText, setPasteText] = useState('');

  // Tasks + defaults
  const [tasks, setTasks] = useState([]);
  const [defHours, setDefHours] = useState('0');
  const [defMinutes, setDefMinutes] = useState('0');
  const [defPriority, setDefPriority] = useState('regular');
  const [defUserId, setDefUserId] = useState('');

  // UI state
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);
  const [loadingSubKras, setLoadingSubKras] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [suggestionBadge, setSuggestionBadge] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [banner, setBanner] = useState(null); // { type:'ok'|'err', text }
  const [touched, setTouched] = useState(false); // show red outlines after a failed submit

  // Which dropdown modal is open: 'client' | 'project' | 'defPriority' |
  // 'defUser' | `rowPriority:<i>` | `rowUser:<i>` | null
  const [picker, setPicker] = useState(null);
  // Missing mandatory fields → styled popup (replaces the native Alert).
  const [missingPopup, setMissingPopup] = useState(null); // string[] | null

  // ---- Photos / video attachments -----------------------------------------
  // Hidden behind one button. Each attachment belongs to ONE task row (picked by
  // the task name typed above) and MUST carry a reason. Files are attached after
  // the tasks exist (they need a kpi_id), via kpi.user.manual.
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaKind, setMediaKind] = useState('image');   // 'image' | 'video' — image is the default
  const [mediaRow, setMediaRow] = useState(null);        // index of the task row it belongs to
  const [mediaReason, setMediaReason] = useState('');
  const [mediaPicked, setMediaPicked] = useState(null);  // { data, name, size, kind }
  const [mediaBusy, setMediaBusy] = useState(false);
  // [{ rowIndex, kind, data, name, size, reason, status, pct }]
  const [attachments, setAttachments] = useState([]);
  const [uploadPopup, setUploadPopup] = useState(null);  // { ok, done, total, failed:[] }

  const defaults = useMemo(() => ({
    hours: Number(defHours) || 0,
    minutes: Number(defMinutes) || 0,
    priority: defPriority,
    userId: defUserId,
  }), [defHours, defMinutes, defPriority, defUserId]);

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 4000); };

  // ---- Load on mount ------------------------------------------------------
  useEffect(() => {
    (async () => {
      log.info('mount: loading form (doc_type=%s)', DOC_TYPE);
      setLoading(true);
      try {
        const info = await svc.getUserInfo().catch((e) => { log.warn('getUserInfo failed, assuming not client-only', e?.message); return { is_client_only: false, isMock: false }; });
        setIsClientOnly(!!info.is_client_only);

        // Creating kra.kpi records is limited to Manager / Owner / Admin /
        // System in Odoo. Only these roles may use this screen; everyone else
        // sees a "restricted" message (mock mode always allows so it's
        // reviewable offline).
        const allowed = !!(info.isMock || info.is_system || info.is_owner || info.is_admin || info.is_client);
        setCanCreate(allowed);
        // KRA/KPI role ONLY (Admin / Client / User) — the app never shows the
        // Odoo role (Administrator/Manager). Mirrors res.users._compute_kpi_role,
        // order included.
        setRoleName(
          (info.is_system || info.is_owner || info.is_admin) ? 'Admin'
            : info.is_client ? 'Client'
            : 'User'
        );
        if (!allowed) {
          log.warn('mount: user not allowed to create tasks', { name: info.name, login: info.login });
          setLoading(false);
          return;
        }

        const ref = await svc.peekNextRef(DOC_TYPE);
        setRefPrefix(ref.prefix || 'UPT');
        setRefNext(ref.next_number || 1);

        if (info.is_client_only) {
          // Client: fetch ONLY their own project(s) (scoped server-side) and
          // auto-fill the destination read-only — no client/project pickers.
          const cp = await getClientProjects().catch((e) => { log.warn('getClientProjects failed', e?.message); return { projects: [] }; });
          const proj = (cp.projects || [])[0] || null;
          setClientProjectName(proj ? (proj.display || 'Your project') : '');
          if (proj) setSubKraId(String(proj.id));
          log.info('mount: loaded (client)', { hasProject: !!proj, project: proj?.display, refPrefix: ref.prefix });
        } else {
          const [c, u] = await Promise.all([
            svc.getClients(),
            svc.getUsers().catch((e) => { log.warn('getUsers failed', e?.message); return { users: [] }; }),
          ]);
          setClients(c.clients);
          setIsMock(!!c.isMock);
          setUsers(u.users);
          log.info('mount: loaded', { clients: c.clients.length, users: u.users.length, isMock: !!c.isMock, refPrefix: ref.prefix, refNext: ref.next_number });
        }
      } catch (err) {
        log.error('load failed', err?.message);
        flash('err', err?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---- Destination --------------------------------------------------------
  // Guards the dependent Client→Project fetch: only the latest selection's
  // response is applied, so a slow response for an old client can't overwrite
  // the project list of a newer one.
  const subKraReq = useRef(0);
  const onSelectClient = useCallback(async (id) => {
    log.info('select client', { id });
    const token = ++subKraReq.current;
    setClientId(String(id));
    setSubKraId('');
    setSubKras([]);
    setPicker(null);
    setLoadingSubKras(true);
    try {
      const res = await svc.getSubKras(id);
      if (token !== subKraReq.current) { log.info('sub-KRA response ignored (stale)', { id }); return; }
      setSubKras(res.kras);
      log.info('sub-KRAs loaded', { clientId: id, count: res.kras.length });
    } catch (err) {
      if (token !== subKraReq.current) return;
      log.error('sub-KRA load failed', err?.message);
      flash('err', err?.message || 'Could not load projects');
    } finally {
      if (token === subKraReq.current) setLoadingSubKras(false);
    }
  }, []);

  // ---- Tasks table --------------------------------------------------------
  const addRow = () => setTasks((t) => [...t, emptyRow(defaults)]);
  const removeRow = (i) => setTasks((t) => t.filter((_, idx) => idx !== i));
  const updateRow = (i, patch) => setTasks((t) => t.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Merge suggested/imported names into rows, skipping duplicates by name.
  const mergeTaskNames = (items) => {
    setTasks((prev) => {
      const seen = new Set(prev.map((r) => r.name.trim().toLowerCase()).filter(Boolean));
      const additions = [];
      for (const it of items) {
        const name = (typeof it === 'string' ? it : it.name || '').trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        additions.push({
          ...emptyRow(defaults),
          name: capFirst(name),
          external_ref: (typeof it === 'object' && it.external_ref) || '',
          related_req_ref: (typeof it === 'object' && it.related_req_ref) || '',
        });
      }
      return [...prev, ...additions];
    });
  };

  const refPreview = (idx) => `${refPrefix}-${pad3(refNext + idx)}`;

  // ---- File pickers -------------------------------------------------------
  // `type` limits the picker's file types (array of MIME types or '*/*').
  async function pickBase64(type = '*/*') {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type });
    if (res.canceled) { log.info('file pick cancelled'); return null; }
    const file = res.assets?.[0];
    if (!file) { log.warn('file pick returned no asset'); return null; }
    log.info('file picked', { name: file.name, size: file.size, mimeType: file.mimeType });
    const data = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
    log.info('file read as base64', { name: file.name, bytesB64: data.length });
    return { data, name: file.name || 'file' };
  }

  async function onPickSourceDoc() {
    log.info('pick source document');
    try {
      // Source Document: any document (pdf, doc, image, etc.).
      const f = await pickBase64('*/*');
      if (f) { setSourceDoc(f); flash('ok', `Attached: ${f.name}`); log.info('source document attached', { name: f.name }); }
    } catch (err) { log.error('source doc read failed', err?.message); flash('err', err?.message || 'Could not read file'); }
  }

  async function onImportList() {
    log.info('import task list');
    try {
      // Import Task List: Excel / CSV only.
      const f = await pickBase64(EXCEL_CSV_TYPES);
      if (!f) return;
      // Guard by extension too — some Android providers ignore the MIME filter.
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!['xlsx', 'xls', 'csv'].includes(ext)) {
        log.warn('import: rejected non-excel/csv file', { name: f.name, ext });
        flash('err', 'Please choose an Excel (.xlsx/.xls) or CSV (.csv) file');
        return;
      }
      setImporting(true);
      setImportStatus(`Parsing ${f.name}…`);
      const res = await svc.parseFile({ fileData: f.data, fileName: f.name, docType: DOC_TYPE });
      mergeTaskNames(res.tasks);
      log.info('import parsed', { name: f.name, count: res.tasks.length, matched_column: res.matched_column, source: res.source });
      setImportStatus(`Imported ${res.tasks.length} task(s)${res.matched_column ? ` from "${res.matched_column}"` : ''}`);
    } catch (err) {
      log.error('import failed', err?.message);
      setImportStatus('');
      flash('err', err?.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  // ---- AI suggest ---------------------------------------------------------
  async function onSuggest() {
    if (!pasteText.trim()) { log.info('suggest: no text'); flash('err', 'Paste some text first'); return; }
    log.info('suggest tasks', { textLen: pasteText.length });
    setSuggesting(true);
    setSuggestionBadge('');
    try {
      const res = await svc.suggestTasks(pasteText, DOC_TYPE);
      mergeTaskNames(res.tasks);
      const label = res.source && res.source.startsWith('ai') ? `AI (${res.source.replace('ai-', '')})` : (res.source || 'heuristic');
      log.info('suggest result', { source: res.source, count: res.tasks.length });
      setSuggestionBadge(`${res.tasks.length} suggested · ${label}`);
      if (!res.tasks.length) flash('err', 'No tasks suggested from that text');
    } catch (err) {
      log.error('suggest failed', err?.message);
      flash('err', err?.message || 'Suggestion failed');
    } finally {
      setSuggesting(false);
    }
  }

  // ---- Photos / video -----------------------------------------------------
  // Rows the client can attach to: only NAMED ones — the task name is what
  // identifies it in the picker.
  const namedRows = tasks.map((r, i) => ({ i, name: (r.name || '').trim() })).filter((r) => r.name);

  async function pickMedia() {
    setMediaBusy(true);
    try {
      const isVideo = mediaKind === 'video';
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: isVideo ? ['videos'] : ['images'],
        quality: 1,           // compressed below for images; video is passed through
      });
      if (res.canceled) { log.info('media pick cancelled'); return; }
      const asset = res.assets?.[0];
      if (!asset) return;

      let uri = asset.uri;
      let name = asset.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`);

      if (!isVideo) {
        // Shrink before base64 — a raw phone photo is several MB and there's no
        // reason to ship that through a JSON body.
        const m = await ImageManipulator.manipulateAsync(
          uri, [{ resize: { width: 1600 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
        );
        uri = m.uri;
        if (!/\.(jpg|jpeg)$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
      }

      const info = await FileSystem.getInfoAsync(uri);
      const size = info?.size || 0;

      // Refuse at PICK time, never mid-upload: an over-cap file can't finish
      // inside the 45s window and would just fail after a long wait.
      const cap = isVideo ? svc.MAX_VIDEO_BYTES : svc.MAX_IMAGE_BYTES;
      if (size > cap) {
        flash('err', `${isVideo ? 'Video' : 'Image'} is ${svc.humanSize(size)} — the limit is ${svc.humanSize(cap)}. ${isVideo ? 'Please record a shorter clip, or use a photo instead.' : 'Please pick a smaller image.'}`);
        log.warn('media rejected: too big', { name, size, cap });
        return;
      }

      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      setMediaPicked({ data, name, size, kind: mediaKind });
      log.info('media picked', { name, size, kind: mediaKind });
    } catch (err) {
      log.error('media pick failed', err?.message);
      flash('err', err?.message || 'Could not read that file');
    } finally {
      setMediaBusy(false);
    }
  }

  // Reason is mandatory, and it must belong to a task.
  const mediaReady = mediaPicked && mediaRow != null && mediaReason.trim().length > 0;

  function addAttachment() {
    if (!mediaReady) return;
    setAttachments((list) => [...list, {
      rowIndex: mediaRow,
      kind: mediaPicked.kind,
      data: mediaPicked.data,
      name: mediaPicked.name,
      size: mediaPicked.size,
      reason: mediaReason.trim(),
      status: 'idle',
      pct: 0,
    }]);
    setMediaPicked(null);
    setMediaReason('');
    log.info('attachment added', { row: mediaRow, kind: mediaKind });
  }

  const removeAttachment = (idx) => setAttachments((l) => l.filter((_, i) => i !== idx));

  // Upload one attachment, streaming its % into state.
  const sendOne = useCallback(async (att, index, kpiId) => {
    setAttachments((l) => l.map((a, i) => (i === index ? { ...a, status: 'uploading', pct: 0 } : a)));
    try {
      await svc.uploadManual(
        kpiId,
        { fileData: att.data, fileName: att.name, reason: att.reason },
        (sent, total) => {
          // `total` is the base64 body (~+33% of the file) — use it, not att.size,
          // or the bar stalls around 75%.
          const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
          setAttachments((l) => l.map((a, i) => (i === index ? { ...a, pct } : a)));
        },
      );
      setAttachments((l) => l.map((a, i) => (i === index ? { ...a, status: 'done', pct: 100 } : a)));
      return true;
    } catch (e) {
      log.error('attachment upload failed', { name: att.name, msg: e?.message });
      setAttachments((l) => l.map((a, i) => (i === index ? { ...a, status: 'failed' } : a)));
      return false;
    }
  }, []);

  // Re-send only the failures. The tasks already exist and the form is cleared,
  // so this attaches to the stored kpiId — it can never duplicate a task.
  const retryFailed = useCallback(async () => {
    setUploadPopup(null);
    setCreating(true);
    try {
      const list = attachments;
      const stillFailed = [];
      for (let i = 0; i < list.length; i++) {
        const att = list[i];
        if (att.status === 'done' || !att.kpiId) continue;
        const ok = await sendOne(att, i, att.kpiId);
        if (!ok) stillFailed.push(att);
      }
      const total = list.length;
      const done = total - stillFailed.length;
      if (stillFailed.length) {
        setAttachments(stillFailed);
        setUploadPopup({ ok: false, done, total, failed: stillFailed.map((f) => f.name) });
      } else {
        setAttachments([]);
        setMediaOpen(false);
        setUploadPopup({ ok: true, done, total, failed: [] });
      }
    } finally {
      setCreating(false);
    }
  }, [attachments, sendOne]);

  // ---- Template download --------------------------------------------------
  async function onDownloadTemplate() {
    log.info('download template', { docType: DOC_TYPE });
    const url = await svc.templateUrl(DOC_TYPE);
    if (!url) { log.warn('template download: no server'); flash('err', 'Connect to a server to download the template'); return; }
    try { log.info('opening template url', url); await WebBrowser.openBrowserAsync(url); }
    catch (err) { log.error('template open failed', err?.message); flash('err', err?.message || 'Could not open template'); }
  }

  // ---- Create All Tasks ---------------------------------------------------
  async function onCreate() {
    // Collect ALL missing mandatory fields and show them together in a popup,
    // and mark the offending fields with a red outline (touched=true).
    const missing = [];
    // A client never picks a Client/Project: the picker is hidden and their own
    // project is auto-filled into subKraId on mount. Only validate what they can
    // actually see, or they'd be blocked forever by a field they can't fill.
    if (!isClientOnly && !clientId) missing.push('Client (Root KRA)');
    if (!subKraId) missing.push(isClientOnly ? 'Project' : 'Project / Sub-KRA');
    const named = tasks.filter((r) => r.name.trim());
    if (!named.length) missing.push('At least one task with a name');

    if (missing.length) {
      setTouched(true);
      log.info('create: validation failed', { missing });
      setMissingPopup(missing);
      return;
    }

    log.info('create all tasks', { subKraId, docType: DOC_TYPE, count: named.length, hasFile: !!sourceDoc, version });
    setCreating(true);
    try {
      // A client sets their own estimate + priority; only the developer
      // assignment stays internal (they have no Developer picker).
      const rows = named.map((r) => svc.buildTaskRow(isClientOnly ? { ...r, primary_user_id: '' } : r));
      const res = await svc.createBulkTasks({
        subKraId,
        docType: DOC_TYPE,
        tasks: rows,
        fileData: sourceDoc?.data || '',
        fileName: sourceDoc?.name || '',
        requirementVersion: version,
      });
      log.info('create result', { created_count: res.created_count, isMock: res.isMock });

      // ---- Attachments -----------------------------------------------------
      // The tasks exist now, so each file can be hung off its kpi_id. Uploaded
      // ONE AT A TIME so the % means something and memory stays flat.
      // The tasks are NEVER rolled back: a failed photo must not cost the user
      // everything they typed. Failures are reported and retryable instead.
      const ids = res.kpi_ids || [];
      let failed = [];
      if (attachments.length && ids.length) {
        // `named` is the filtered list actually sent, so kpi_ids[n] lines up with
        // named[n]. Map each attachment's ORIGINAL row index onto that.
        const namedIdx = new Map(); // original tasks index -> sent index
        let k = 0;
        tasks.forEach((r, i) => { if (r.name.trim()) namedIdx.set(i, k++); });

        // Stamp each attachment with the task it now belongs to. Retry needs this
        // AFTER the form is cleared — without it a retry would have no kpi_id.
        const withIds = attachments.map((a) => {
          const sentIdx = namedIdx.get(a.rowIndex);
          return { ...a, kpiId: sentIdx != null ? ids[sentIdx] || null : null };
        });
        setAttachments(withIds);

        for (let i = 0; i < withIds.length; i++) {
          const att = withIds[i];
          if (!att.kpiId) { failed.push(att); continue; }
          const ok = await sendOne(att, i, att.kpiId);
          if (!ok) failed.push({ ...att, status: 'failed' });
        }
      }

      const total = attachments.length;
      const done = total - failed.length;

      // The TASKS are created either way — always clear the form so a retry can
      // never re-create them as duplicates. Only the failed FILES are kept (with
      // their kpiId) so "Retry failed" re-sends just those.
      setTasks([]);
      setSourceDoc(null);
      setPasteText('');
      setSuggestionBadge('');
      setImportStatus('');
      const ref = await svc.peekNextRef(DOC_TYPE).catch(() => null);
      if (ref) { setRefPrefix(ref.prefix); setRefNext(ref.next_number); }

      if (failed.length) {
        setAttachments(failed);                 // keep ONLY the failures, for retry
        setMediaOpen(true);
        setUploadPopup({ ok: false, done, total, failed: failed.map((f) => f.name) });
        flash('ok', `Created ${res.created_count} task(s)`);
        return;
      }

      setAttachments([]);
      setMediaOpen(false);
      if (total) setUploadPopup({ ok: true, done, total, failed: [] });
      flash('ok', `Created ${res.created_count} task(s)${res.isMock ? ' (offline mock)' : ''}`);
    } catch (err) {
      log.error('create failed', err?.message);
      flash('err', err?.message || 'Task creation failed');
    } finally {
      setCreating(false);
    }
  }

  function onReset() {
    log.info('reset form');
    setClientId(''); setSubKraId(''); setSubKras([]); setVersion('');
    setSourceDoc(null); setPasteText(''); setTasks([]);
    setDefHours('0'); setDefMinutes('0'); setDefPriority('regular'); setDefUserId('');
    setSuggestionBadge(''); setImportStatus(''); setBanner(null); setTouched(false);
  }

  const clientName = clients.find((c) => String(c.id) === clientId)?.name;
  const subKraName = subKras.find((k) => String(k.id) === subKraId)?.display
    || subKras.find((k) => String(k.id) === subKraId)?.name;
  const userName = (id) => users.find((u) => String(u.id) === String(id))?.name;
  const prioLabel = (v) => svc.PRIORITIES.find((p) => p.value === v)?.label || 'Regular';

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={s.loadingTxt}>Loading upload form…</Text>
      </View>
    );
  }

  // Non-admin/manager users can't create tasks — show a restricted notice
  // instead of the form so they never hit the server-side permission error.
  if (!canCreate) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <View style={[s.header, { paddingTop: TOP }]}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
          <Text style={s.hTitle} numberOfLines={1}>{MODE.title}</Text>
          <View style={s.hBtn} />
        </View>
        <View style={[s.center, { flex: 1, padding: 32 }]}>
          <View style={s.lockWrap}>
            <Ionicons name="lock-closed" size={40} color={COLORS.amber} />
          </View>
          <Text style={s.lockTitle}>Admins only</Text>
          <Text style={s.lockMsg}>
            Creating and uploading tasks is restricted to Admin, Owner and Manager
            accounts.{roleName ? `\n\nYou're signed in as: ${roleName}.` : ''}
            {'\n\n'}Ask your administrator for access if you need to upload.
          </Text>
          <TouchableOpacity style={s.lockBtn} onPress={onBack} activeOpacity={0.9}>
            <Ionicons name="arrow-back" size={18} color="#fff" />
            <Text style={s.lockBtnTxt}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <GradientBackground />
      <StatusBar style="dark" />

      {/* Header — back button matches the KPI Action Board (white, shadow) */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.hTitle} numberOfLines={1}>{MODE.title}</Text>
        <TouchableOpacity onPress={onDownloadTemplate} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="download-outline" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to load live records</Text>
        </View>
      )}
      {banner && (
        <View style={[s.banner, banner.type === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.type === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={16} color={banner.type === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.type === 'ok' ? COLORS.green : COLORS.red }]}>{banner.text}</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 18, paddingBottom: BOTTOM_PAD + 80 }}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
      >
        {/* ---- 1. Destination ---- */}
        <Section n="1" title="Destination" icon="folder-outline">
          {isClientOnly ? (
            <>
              <Label>Project</Label>
              <View style={[s.field, { opacity: 0.9 }]}>
                <Ionicons name="folder-outline" size={18} color={COLORS.muted} style={s.fIcon} />
                <Text style={[s.input, { color: COLORS.ink }]} numberOfLines={1}>
                  {clientProjectName || 'Your project'}
                </Text>
                <Ionicons name="lock-closed" size={15} color={COLORS.faint} />
              </View>
              <Text style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>
                Uploads go to your client's project automatically.
              </Text>
            </>
          ) : (
            <>
              <Label required>Client (Root KRA)</Label>
              <Selector
                placeholder="-- Select Client --"
                value={clientName}
                error={touched && !clientId}
                onPress={() => setPicker('client')}
              />
              {touched && !clientId && <Text style={s.errTxt}>Client is required</Text>}
              <Label required>Project / Sub-KRA</Label>
              <Selector
                placeholder={loadingSubKras ? 'Loading…' : (clientId ? '-- Select Project --' : 'Select a client first')}
                value={subKraName}
                disabled={!clientId || loadingSubKras}
                loading={loadingSubKras}
                error={touched && !subKraId}
                onPress={() => setPicker('project')}
              />
              {touched && !subKraId && <Text style={s.errTxt}>Project / Sub-KRA is required</Text>}
            </>
          )}
          <Label>Version (optional)</Label>
          <View style={s.field}>
            <Ionicons name="pricetag-outline" size={18} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              style={s.input} placeholder="v1.0" placeholderTextColor={COLORS.faint}
              value={version} onChangeText={setVersion} autoCapitalize="none"
            />
          </View>
        </Section>

        {/* ---- 2. Source & Bulk Import ---- */}
        <Section n="2" title="Source & Bulk Import" icon="cloud-upload-outline">
          <Label>Source Document (attached to every created task)</Label>
          <FileButton
            icon="document-attach-outline"
            label={sourceDoc ? sourceDoc.name : 'Choose file'}
            active={!!sourceDoc}
            onPress={onPickSourceDoc}
            onClear={sourceDoc ? () => setSourceDoc(null) : null}
          />

          <Label>Import Task List (XLSX / CSV)</Label>
          <FileButton
            icon="list-outline"
            label={importing ? 'Parsing…' : 'Choose file to import rows'}
            loading={importing}
            onPress={onImportList}
          />
          {!!importStatus && <Text style={s.hintTxt}>{importStatus}</Text>}

          <Label>Or Paste Doc Text (for AI suggestions)</Label>
          <TextInput
            style={s.textarea}
            placeholder="Paste requirement / update / bug text…"
            placeholderTextColor={COLORS.faint}
            value={pasteText} onChangeText={setPasteText}
            multiline textAlignVertical="top"
          />
        </Section>

        {/* ---- 3. Tasks ---- */}
        <View style={s.card}>
          <View style={s.tasksHead}>
            <View style={s.secTitleRow}>
              <View style={s.badge}><Text style={s.badgeTxt}>3</Text></View>
              <Text style={s.secTitle}>Tasks</Text>
            </View>
            <View style={s.tasksBtns}>
              <TouchableOpacity style={s.miniBtn} onPress={onSuggest} disabled={suggesting}>
                {suggesting
                  ? <ActivityIndicator size="small" color={COLORS.primary} />
                  : <Ionicons name="sparkles-outline" size={15} color={COLORS.primary} />}
                <Text style={s.miniTxt}>Suggest (AI)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.miniBtn, s.miniBtnSolid]} onPress={addRow}>
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={[s.miniTxt, { color: '#fff' }]}>Add Row</Text>
              </TouchableOpacity>
            </View>
          </View>
          {!!suggestionBadge && <Text style={s.hintTxt}>{suggestionBadge}</Text>}

          {tasks.length === 0 ? (
            <View style={s.emptyTasks}>
              <Ionicons name="list-outline" size={30} color={COLORS.faint} />
              <Text style={s.emptyTxt}>No tasks yet. Add a row, import a file, or use Suggest (AI).</Text>
            </View>
          ) : (
            tasks.map((row, i) => (
              <View key={i} style={s.taskRow}>
                {/* SN badge + remove */}
                <View style={s.taskTop}>
                  <View style={s.snBadge}><Text style={s.snTxt}>#{i + 1}</Text></View>
                  <TouchableOpacity onPress={() => removeRow(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={20} color={COLORS.red} />
                  </TouchableOpacity>
                </View>

                {/* Ref ID — editable (defaults to preview; server may re-number).
                    Linked Req shows only for update/bug modes. */}
                <View style={s.rowSplit}>
                  <View style={s.half}>
                    <Text style={s.miniLabel}>Ref ID</Text>
                    <TextInput
                      style={s.numInput} placeholder={refPreview(i)} placeholderTextColor={COLORS.faint}
                      value={row.external_ref} onChangeText={(t) => updateRow(i, { external_ref: t })}
                      autoCapitalize="characters"
                    />
                  </View>
                  {MODE.showLinkedReq ? (
                    <View style={s.half}>
                      <Text style={s.miniLabel}>Linked Req</Text>
                      <TextInput
                        style={s.numInput} placeholder="e.g. REQ-001" placeholderTextColor={COLORS.faint}
                        value={row.related_req_ref} onChangeText={(t) => updateRow(i, { related_req_ref: t })}
                        autoCapitalize="characters"
                      />
                    </View>
                  ) : <View style={s.half} />}
                </View>

                <Text style={[s.miniLabel, { marginTop: 8 }]}>Task Name</Text>
                <TextInput
                  style={s.taskName}
                  placeholder="Task name" placeholderTextColor={COLORS.faint}
                  value={row.name} onChangeText={(t) => updateRow(i, { name: capFirst(t) })}
                  autoCapitalize="sentences"
                  multiline
                />

                {/* Estimate + Priority are open to everyone (clients included).
                    Only the Developer picker stays internal. */}
                <View style={s.rowSplit}>
                  <View style={s.half}>
                    <Text style={s.miniLabel}>Hours</Text>
                    <TextInput
                      style={s.numInput} keyboardType="number-pad"
                      value={String(row.estimate_hours)} onChangeText={(t) => updateRow(i, { estimate_hours: t.replace(/[^0-9]/g, '') })}
                    />
                  </View>
                  <View style={s.half}>
                    <Text style={s.miniLabel}>Minutes</Text>
                    <TextInput
                      style={s.numInput} keyboardType="number-pad"
                      value={String(row.estimate_minutes)}
                      onChangeText={(t) => {
                        let m = parseInt(t.replace(/[^0-9]/g, ''), 10);
                        if (isNaN(m)) m = 0; if (m > 59) m = 59;
                        updateRow(i, { estimate_minutes: m });
                      }}
                    />
                  </View>
                </View>
                <View style={s.rowSplit}>
                  <View style={s.half}>
                    <Text style={s.miniLabel}>Priority</Text>
                    <Selector small value={prioLabel(row.priority)} onPress={() => setPicker(`rowPriority:${i}`)} />
                  </View>
                  {isClientOnly ? <View style={s.half} /> : (
                    <View style={s.half}>
                      <Text style={s.miniLabel}>Developer</Text>
                      <Selector small placeholder="None" value={userName(row.primary_user_id)} onPress={() => setPicker(`rowUser:${i}`)} />
                    </View>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* ---- 3b. Photos / video (hidden behind one button) ---- */}
        <View style={s.card}>
          {!mediaOpen ? (
            <TouchableOpacity style={s.mediaOpenBtn} onPress={() => setMediaOpen(true)} activeOpacity={0.85}>
              <Ionicons name="attach" size={18} color={COLORS.primary} />
              <Text style={s.mediaOpenTxt}>Add photos / video</Text>
            </TouchableOpacity>
          ) : (
            <>
              <View style={s.secTitleRow}>
                <View style={s.badge}><Ionicons name="attach" size={13} color="#fff" /></View>
                <Text style={s.secTitle}>Photos / video</Text>
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={() => setMediaOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="chevron-up" size={20} color={COLORS.muted} />
                </TouchableOpacity>
              </View>

              {namedRows.length === 0 ? (
                <Text style={s.hintTxt}>Type a task name above first — attachments are added to a task.</Text>
              ) : (
                <>
                  {/* Which task does this belong to — by the name typed above. */}
                  <Label required>Which task?</Label>
                  <View style={s.taskPickWrap}>
                    {namedRows.map((r) => {
                      const on = mediaRow === r.i;
                      return (
                        <TouchableOpacity
                          key={r.i}
                          style={[s.taskPick, on && s.taskPickOn]}
                          onPress={() => setMediaRow(r.i)}
                          activeOpacity={0.8}
                        >
                          <Text style={[s.taskPickTxt, on && s.taskPickTxtOn]} numberOfLines={1}>
                            #{r.i + 1} {r.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Image is the default; video is the exception. */}
                  <Label>Type</Label>
                  <View style={s.kindRow}>
                    {[['image', 'image-outline', 'Photo'], ['video', 'videocam-outline', 'Video']].map(([k, icon, label]) => {
                      const on = mediaKind === k;
                      return (
                        <TouchableOpacity
                          key={k}
                          style={[s.kindBtn, on && (k === 'video' ? s.kindBtnVideoOn : s.kindBtnOn)]}
                          onPress={() => { setMediaKind(k); setMediaPicked(null); }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name={icon} size={16} color={on ? '#fff' : COLORS.muted} />
                          <Text style={[s.kindTxt2, on && { color: '#fff' }]}>{label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {mediaKind === 'video' && (
                    <View style={s.warnBox}>
                      <Ionicons name="warning" size={15} color={COLORS.red} style={{ marginTop: 1 }} />
                      <Text style={s.warnTxt}>
                        Only upload a video if it's really needed — a photo is usually enough. Videos are
                        slow to upload and limited to {svc.humanSize(svc.MAX_VIDEO_BYTES)}.
                      </Text>
                    </View>
                  )}

                  <TouchableOpacity style={s.pickBtn} onPress={pickMedia} disabled={mediaBusy} activeOpacity={0.85}>
                    {mediaBusy ? <ActivityIndicator size="small" color={COLORS.primary} />
                      : <Ionicons name={mediaKind === 'video' ? 'videocam' : 'images'} size={17} color={COLORS.primary} />}
                    <Text style={s.pickTxt} numberOfLines={1}>
                      {mediaPicked ? `${mediaPicked.name} · ${svc.humanSize(mediaPicked.size)}`
                        : (mediaKind === 'video' ? 'Choose a video' : 'Choose photo')}
                    </Text>
                    {mediaPicked ? <Ionicons name="checkmark-circle" size={17} color={COLORS.green} /> : null}
                  </TouchableOpacity>

                  {/* Mandatory — an attachment with no explanation is noise. */}
                  <Label required>Reason</Label>
                  <TextInput
                    style={s.taskName}
                    placeholder="Why are you attaching this?"
                    placeholderTextColor={COLORS.faint}
                    value={mediaReason}
                    onChangeText={setMediaReason}
                    multiline
                  />

                  <TouchableOpacity
                    style={[s.addMediaBtn, !mediaReady && s.addMediaBtnOff]}
                    onPress={addAttachment}
                    disabled={!mediaReady}
                    activeOpacity={0.9}
                  >
                    <Ionicons name="add" size={17} color="#fff" />
                    <Text style={s.addMediaTxt}>Add attachment</Text>
                  </TouchableOpacity>
                  {!mediaReady && (mediaPicked || mediaReason) ? (
                    <Text style={s.hintTxt}>
                      {!mediaRow && mediaRow !== 0 ? 'Pick which task it belongs to.'
                        : !mediaPicked ? 'Choose a photo or video.'
                        : 'A reason is required.'}
                    </Text>
                  ) : null}
                </>
              )}

              {/* Queued / uploading attachments */}
              {attachments.length > 0 && (
                <View style={{ marginTop: 14 }}>
                  {attachments.map((a, i) => (
                    <View key={`${a.name}-${i}`} style={s.attRow}>
                      <Ionicons
                        name={a.kind === 'video' ? 'videocam' : 'image'}
                        size={16}
                        color={a.status === 'failed' ? COLORS.red : COLORS.primary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={s.attName} numberOfLines={1}>
                          {a.name} · {svc.humanSize(a.size)}
                          {tasks[a.rowIndex]?.name ? `  →  ${tasks[a.rowIndex].name}` : ''}
                        </Text>
                        <Text style={s.attReason} numberOfLines={1}>{a.reason}</Text>
                        {a.status === 'uploading' && (
                          <>
                            <View style={s.barTrack}><View style={[s.barFill, { width: `${a.pct}%` }]} /></View>
                            <Text style={s.attPct}>{svc.humanSize(a.size)} · {a.pct}%</Text>
                          </>
                        )}
                        {a.status === 'failed' && <Text style={s.attFail}>Upload failed</Text>}
                      </View>
                      {a.status === 'done' ? <Ionicons name="checkmark-circle" size={18} color={COLORS.green} />
                        : a.status === 'uploading' ? <ActivityIndicator size="small" color={COLORS.primary} />
                        : (
                          <TouchableOpacity onPress={() => removeAttachment(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="close-circle" size={18} color={COLORS.muted} />
                          </TouchableOpacity>
                        )}
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </View>

        {/* ---- 4. Defaults for new rows ---- */}
        <Section n="4" title="Defaults for new rows" icon="settings-outline">
          <Text style={s.hintTxt}>Applied when adding rows or importing — each row stays editable above.</Text>
          <View style={s.rowSplit}>
            <View style={s.half}>
              <Label>Default Hours</Label>
              <TextInput style={s.numInput} keyboardType="number-pad" value={defHours} onChangeText={(t) => setDefHours(t.replace(/[^0-9]/g, ''))} />
            </View>
            <View style={s.half}>
              <Label>Default Minutes</Label>
              <TextInput
                style={s.numInput} keyboardType="number-pad" value={defMinutes}
                onChangeText={(t) => { let m = parseInt(t.replace(/[^0-9]/g, ''), 10); if (isNaN(m)) m = 0; if (m > 59) m = 59; setDefMinutes(String(m)); }}
              />
            </View>
          </View>
          <View style={s.rowSplit}>
            <View style={s.half}>
              <Label>Default Priority</Label>
              <Selector small value={prioLabel(defPriority)} onPress={() => setPicker('defPriority')} />
            </View>
            {isClientOnly ? <View style={s.half} /> : (
              <View style={s.half}>
                <Label>Default Developer</Label>
                <Selector small placeholder="None" value={userName(defUserId)} onPress={() => setPicker('defUser')} />
              </View>
            )}
          </View>
        </Section>
      </ScrollView>

      {/* Sticky footer actions */}
      <View style={s.footer}>
        <TouchableOpacity style={s.resetBtn} onPress={onReset} disabled={creating}>
          <Ionicons name="close" size={18} color={COLORS.muted} />
          <Text style={s.resetTxt}>Reset</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.createBtn, creating && { opacity: 0.7 }]} onPress={onCreate} disabled={creating} activeOpacity={0.9}>
          {creating ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name="checkmark-circle" size={19} color="#fff" />
              <Text style={s.createTxt}>Create All Tasks</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Attachment result — the tasks are always safe by this point, so this is
          only ever about the FILES. */}
      <Modal visible={!!uploadPopup} transparent animationType="fade" onRequestClose={() => setUploadPopup(null)}>
        <View style={s.missWrap}>
          <View style={s.missCard}>
            <View style={[s.missHead, uploadPopup?.ok ? { backgroundColor: COLORS.green } : null]}>
              <Ionicons name={uploadPopup?.ok ? 'checkmark-circle' : 'alert-circle'} size={20} color="#fff" />
              <Text style={s.missTitle}>
                {uploadPopup?.ok ? 'All files uploaded' : `${uploadPopup?.done} of ${uploadPopup?.total} files uploaded`}
              </Text>
              <TouchableOpacity onPress={() => setUploadPopup(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <View style={s.missPad}>
              {uploadPopup?.ok ? (
                <Text style={s.missLead}>Your tasks and attachments were sent.</Text>
              ) : (
                <>
                  <Text style={s.missLead}>
                    Your tasks were created — nothing was lost. These files didn't upload:
                  </Text>
                  {(uploadPopup?.failed || []).map((n) => (
                    <View key={n} style={s.missRow}>
                      <View style={s.missDot} />
                      <Text style={s.missRowTxt} numberOfLines={1}>{n}</Text>
                    </View>
                  ))}
                </>
              )}
            </View>
            <View style={s.missFoot}>
              {uploadPopup?.ok ? (
                <TouchableOpacity style={[s.missBtn, { backgroundColor: COLORS.green }]} onPress={() => setUploadPopup(null)} activeOpacity={0.9}>
                  <Text style={s.missBtnTxt}>Done</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={s.missBtn} onPress={retryFailed} activeOpacity={0.9}>
                  <Text style={s.missBtnTxt}>Retry failed</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Styled "missing required fields" popup (replaces the native Alert) */}
      <Modal visible={!!missingPopup} transparent animationType="fade" onRequestClose={() => setMissingPopup(null)}>
        <View style={s.missWrap}>
          <View style={s.missCard}>
            <View style={s.missHead}>
              <Ionicons name="alert-circle" size={20} color="#fff" />
              <Text style={s.missTitle}>Missing required fields</Text>
              <TouchableOpacity onPress={() => setMissingPopup(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
            <View style={s.missPad}>
              <Text style={s.missLead}>
                Please fill {missingPopup && missingPopup.length === 1 ? 'in this field' : 'these in'} before creating tasks:
              </Text>
              {(missingPopup || []).map((m) => (
                <View key={m} style={s.missRow}>
                  <View style={s.missDot} />
                  <Text style={s.missRowTxt}>{m}</Text>
                </View>
              ))}
            </View>
            <View style={s.missFoot}>
              <TouchableOpacity style={s.missBtn} onPress={() => setMissingPopup(null)} activeOpacity={0.9}>
                <Text style={s.missBtnTxt}>Got it</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Picker modal */}
      <PickerModal
        picker={picker}
        onClose={() => setPicker(null)}
        clients={clients}
        subKras={subKras}
        users={users}
        priorities={svc.PRIORITIES}
        onSelectClient={onSelectClient}
        onSelectSubKra={(id) => { setSubKraId(String(id)); setPicker(null); }}
        onSelectDefPriority={(v) => { setDefPriority(v); setPicker(null); }}
        onSelectDefUser={(id) => { setDefUserId(id ? String(id) : ''); setPicker(null); }}
        onSelectRowPriority={(i, v) => { updateRow(i, { priority: v }); setPicker(null); }}
        onSelectRowUser={(i, id) => { updateRow(i, { primary_user_id: id ? String(id) : '' }); setPicker(null); }}
      />
    </KeyboardAvoidingView>
  );
}

// ---- Small presentational helpers ----------------------------------------

function Section({ n, title, icon, children }) {
  return (
    <View style={s.card}>
      <View style={s.secTitleRow}>
        <View style={s.badge}><Text style={s.badgeTxt}>{n}</Text></View>
        <Ionicons name={icon} size={17} color={COLORS.navy} style={{ marginRight: 6 }} />
        <Text style={s.secTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const Label = ({ children, required }) => (
  <Text style={s.label}>{children}{required ? <Text style={s.reqStar}> *</Text> : null}</Text>
);

function Selector({ value, placeholder, onPress, disabled, loading, small, error }) {
  return (
    <TouchableOpacity
      style={[s.field, small && s.fieldSmall, disabled && s.fieldDisabled, error && s.fieldErr]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={0.8}
    >
      <Text style={[s.input, { color: value ? COLORS.ink : COLORS.faint }]} numberOfLines={1}>
        {value || placeholder}
      </Text>
      {loading
        ? <ActivityIndicator size="small" color={COLORS.primary} />
        : <Ionicons name="chevron-down" size={18} color={COLORS.muted} />}
    </TouchableOpacity>
  );
}

function FileButton({ icon, label, active, loading, onPress, onClear }) {
  return (
    <View style={[s.field, active && s.fieldActive]}>
      <Ionicons name={icon} size={18} color={active ? COLORS.primary : COLORS.muted} style={s.fIcon} />
      <TouchableOpacity style={{ flex: 1 }} onPress={onPress} disabled={loading} activeOpacity={0.7}>
        <Text style={[s.input, { color: active ? COLORS.ink : COLORS.muted }]} numberOfLines={1}>{label}</Text>
      </TouchableOpacity>
      {loading && <ActivityIndicator size="small" color={COLORS.primary} />}
      {onClear && !loading && (
        <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close-circle" size={18} color={COLORS.muted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function PickerModal({
  picker, onClose, clients, subKras, users, priorities,
  onSelectClient, onSelectSubKra, onSelectDefPriority, onSelectDefUser,
  onSelectRowPriority, onSelectRowUser,
}) {
  if (!picker) return null;
  let title = 'Select';
  let items = []; // { key, label, onPress }
  const noneUser = { key: 'none', label: '-- None --', onPress: null };

  if (picker === 'client') {
    title = 'Select Client';
    items = clients.map((c) => ({ key: String(c.id), label: c.name, onPress: () => onSelectClient(c.id) }));
  } else if (picker === 'project') {
    title = 'Select Project / Sub-KRA';
    items = subKras.map((k) => ({ key: String(k.id), label: k.display || k.name, onPress: () => onSelectSubKra(k.id) }));
  } else if (picker === 'defPriority') {
    title = 'Default Priority';
    items = priorities.map((p) => ({ key: p.value, label: p.label, onPress: () => onSelectDefPriority(p.value) }));
  } else if (picker === 'defUser') {
    title = 'Default Developer';
    items = [{ ...noneUser, onPress: () => onSelectDefUser('') }, ...users.map((u) => ({ key: String(u.id), label: u.name, onPress: () => onSelectDefUser(u.id) }))];
  } else if (picker.startsWith('rowPriority:')) {
    const i = Number(picker.split(':')[1]);
    title = 'Priority';
    items = priorities.map((p) => ({ key: p.value, label: p.label, onPress: () => onSelectRowPriority(i, p.value) }));
  } else if (picker.startsWith('rowUser:')) {
    const i = Number(picker.split(':')[1]);
    title = 'Developer';
    items = [{ ...noneUser, onPress: () => onSelectRowUser(i, '') }, ...users.map((u) => ({ key: String(u.id), label: u.name, onPress: () => onSelectRowUser(i, u.id) }))];
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={s.modalSheet}>
          <Text style={s.modalTitle}>{title}</Text>
          {items.length === 0 ? (
            <Text style={s.modalEmpty}>Nothing to choose.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
              {items.map((it) => (
                <TouchableOpacity key={it.key} style={s.modalItem} onPress={it.onPress}>
                  <Text style={s.modalItemTxt}>{it.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <TouchableOpacity style={s.modalCancel} onPress={onClose}>
            <Text style={s.modalCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // gradient on top via GradientBackground
  center: { alignItems: 'center', justifyContent: 'center' },
  loadingTxt: { marginTop: 14, color: COLORS.muted, fontSize: 14 },

  lockWrap: { width: 88, height: 88, borderRadius: 26, backgroundColor: COLORS.amberBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  lockTitle: { fontSize: 22, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  lockMsg: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center', lineHeight: 21 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 26, backgroundColor: COLORS.primary, borderRadius: 13, paddingHorizontal: 24, height: 50 },
  lockBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },

  // Transparent heading — the gradient shows through. Only the icon buttons keep
  // their white square chip (see iconBtn below) so they stay readable.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 10,
  },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingHorizontal: 16, paddingVertical: 7 },
  mockTxt: { color: COLORS.amber, fontSize: 12, flex: 1 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { fontSize: 13, fontWeight: '600', flex: 1 },

  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14, ...SHADOW },
  secTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  badgeTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  secTitle: { fontSize: 16, fontWeight: '900', color: COLORS.navy },

  label: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginBottom: 6, marginTop: 10 },
  reqStar: { color: COLORS.red, fontWeight: '900' },
  errTxt: { color: COLORS.red, fontSize: 12.5, marginTop: 5, marginLeft: 2 },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F8FD',
    borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 13, height: 50,
  },
  fieldSmall: { height: 46, paddingHorizontal: 11 },
  fieldActive: { borderColor: COLORS.primary, backgroundColor: '#EEF3FF' },
  fieldErr: { borderColor: COLORS.red, backgroundColor: COLORS.redBg },
  fieldDisabled: { opacity: 0.55 },
  fIcon: { marginRight: 9 },
  input: { flex: 1, fontSize: 15, color: COLORS.ink },

  textarea: {
    backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12,
    padding: 13, fontSize: 14.5, color: COLORS.ink, minHeight: 96,
  },
  hintTxt: { fontSize: 12.5, color: COLORS.muted, marginTop: 6, lineHeight: 17 },

  tasksHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  tasksBtns: { flexDirection: 'row', gap: 8 },
  miniBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: '#DCE4F2',
    borderRadius: 10, paddingHorizontal: 11, height: 36, backgroundColor: '#fff',
  },
  miniBtnSolid: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  miniTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },

  emptyTasks: { alignItems: 'center', paddingVertical: 26, gap: 8 },
  emptyTxt: { color: COLORS.faint, fontSize: 13, textAlign: 'center', paddingHorizontal: 20 },

  taskRow: { borderWidth: 1.5, borderColor: '#EDF1F7', borderRadius: 12, padding: 11, marginTop: 10, backgroundColor: '#FCFDFF' },
  taskTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  taskRef: { fontSize: 12, fontWeight: '800', color: COLORS.primary, backgroundColor: '#EEF3FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  snBadge: { backgroundColor: COLORS.navy, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  snTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  taskName: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: COLORS.ink, marginBottom: 8, minHeight: 44,
  },

  rowSplit: { flexDirection: 'row', gap: 10, marginTop: 8 },
  half: { flex: 1 },
  miniLabel: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted, marginBottom: 5 },
  numInput: {
    backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 10,
    paddingHorizontal: 12, height: 46, fontSize: 15, color: COLORS.ink,
  },

  footer: {
    flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: BOTTOM_PAD,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: COLORS.line,
  },
  resetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, height: 52,
    borderRadius: 13, borderWidth: 1.5, borderColor: '#E7ECF3', justifyContent: 'center',
  },
  resetTxt: { fontSize: 15, fontWeight: '800', color: COLORS.muted },
  createBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    backgroundColor: COLORS.green, borderRadius: 13, height: 52,
    shadowColor: COLORS.green, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  createTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },

  // ── Photos / video ────────────────────────────────────────────────────────
  mediaOpenBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 48, borderRadius: 12, borderWidth: 1.5, borderColor: '#DCE4F2',
    borderStyle: 'dashed', backgroundColor: '#F7FAFF',
  },
  mediaOpenTxt: { fontSize: 14.5, fontWeight: '800', color: COLORS.primary },
  taskPickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  taskPick: {
    maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9,
    backgroundColor: '#F1F5FB', borderWidth: 1.5, borderColor: '#E7ECF3',
  },
  taskPickOn: { backgroundColor: '#EEF3FF', borderColor: COLORS.primary },
  taskPickTxt: { fontSize: 12.5, color: COLORS.muted, fontWeight: '700' },
  taskPickTxtOn: { color: COLORS.primary, fontWeight: '900' },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 42, borderRadius: 10, borderWidth: 1.5, borderColor: '#E7ECF3', backgroundColor: '#fff',
  },
  kindBtnOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  kindBtnVideoOn: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  kindTxt2: { fontSize: 13.5, fontWeight: '800', color: COLORS.muted },
  warnBox: {
    flexDirection: 'row', gap: 7, alignItems: 'flex-start', marginTop: 9,
    backgroundColor: COLORS.redBg, borderRadius: 10, padding: 10,
    borderLeftWidth: 3, borderLeftColor: COLORS.red,
  },
  warnTxt: { flex: 1, fontSize: 12, color: '#991B1B', lineHeight: 17, fontWeight: '600' },
  pickBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 10,
    backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3',
    borderRadius: 12, paddingHorizontal: 13, height: 48,
  },
  pickTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  addMediaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginTop: 12, height: 44, borderRadius: 11, backgroundColor: COLORS.primary,
  },
  addMediaBtnOff: { backgroundColor: '#A9BEDF' },
  addMediaTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
  attRow: {
    flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9,
    borderTopWidth: 1, borderTopColor: '#F1F5F9',
  },
  attName: { fontSize: 12.5, fontWeight: '800', color: COLORS.ink },
  attReason: { fontSize: 11.5, color: COLORS.muted, marginTop: 1 },
  attPct: { fontSize: 11, color: COLORS.primary, fontWeight: '800', marginTop: 3 },
  attFail: { fontSize: 11.5, color: COLORS.red, fontWeight: '800', marginTop: 2 },
  barTrack: { height: 5, borderRadius: 3, backgroundColor: '#E7ECF3', marginTop: 6, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3, backgroundColor: COLORS.primary },

  // "Missing required fields" popup — centered card, amber header.
  missWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  missCard: { width: '100%', maxWidth: 400, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  missHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.amber, paddingHorizontal: 16, paddingVertical: 13 },
  missTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#fff' },
  missPad: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  missLead: { fontSize: 13.5, color: COLORS.muted, marginBottom: 8, lineHeight: 19 },
  missRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  missDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.red },
  missRowTxt: { flex: 1, fontSize: 14.5, color: COLORS.ink, fontWeight: '700' },
  missFoot: { paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 8 },
  missBtn: { height: 48, borderRadius: 12, backgroundColor: COLORS.amber, alignItems: 'center', justifyContent: 'center' },
  missBtnTxt: { color: '#fff', fontWeight: '900', fontSize: 15 },

  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 26,
  },
  modalSheet: {
    width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 22, padding: 18,
  },
  modalTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  modalEmpty: { color: COLORS.muted, fontSize: 14, paddingVertical: 14 },
  modalItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  modalItemTxt: { fontSize: 15.5, color: COLORS.ink },
  modalCancel: { marginTop: 14, height: 50, borderRadius: 13, backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center' },
  modalCancelTxt: { fontSize: 15.5, fontWeight: '800', color: COLORS.muted },
});
