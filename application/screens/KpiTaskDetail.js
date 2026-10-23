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
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, StatusBar as RNStatusBar,
  ActivityIndicator, Animated, Easing, Linking, KeyboardAvoidingView, Platform,
  Modal, Image, ScrollView, FlatList, Pressable, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
// SDK 54: the classic writeAsStringAsync + EncodingType live under /legacy.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { COLORS } from '../theme';
import GradientBackground from '../components/GradientBackground';
import GradientButton from '../components/GradientButton';
import AddTimeModal from '../components/AddTimeModal';
import AppDialog from '../components/AppDialog';
import {
  fetchTaskDetails, submitProgressUpdate, addGithubLink, deleteGithubLink,
  deleteManual, completeTask, createProgress, fetchProgressFile, fetchManualFile, addTaskTime, deleteProgressBulk,
  MAX_PROGRESS_BYTES,
  fetchActivity, updateProgress, deleteProgress, updateTaskMeta, fetchProjects,
  fetchLegacy, saveLegacy, legacyVoiceSource, fetchClientSends, parseServerTs,
  fetchChat, sendChat, sendChatFiles, retryChat, fetchChatFile, chatFileKind, CHAT_MAX_FILES, CHAT_MAX_BYTES,
  chatAct,
} from '../services/kpiActions';
import { uploadManual, humanSize, MAX_MANUAL_BYTES, MANUAL_EXTENSIONS } from '../services/uploadAmendments';
import { makeRateTracker, fmtSpeed, fmtEta } from '../utils/uploadRate';
import { resolveGithubLink } from '../utils/githubLink';
import { createLogger } from '../api/logger';
import useBackHandler from '../components/useBackHandler';
import { taskDeliverableLabel } from '../utils/deliverableType';
import { completeMissing, completeExtras, completeWarnings, warningText } from '../utils/completeMissing';
import CompleteRules from '../components/CompleteRules';
import FinishModeRadio, { PARTIAL_NOTE } from '../components/FinishModeRadio';
import { sendHeading, sendStatus, fileIcon, sendFileSource, hasClientSends } from '../utils/clientSends';

const log = createLogger('KpiDetail');

// The Logs picker on the Activity popup. 'all' is served from the details payload
// this screen already holds; the two narrower kinds each fetch their own 200-row
// window, which is why they are a server call and not a filter over 'all' — a
// pause log sliced out of the "all" window would quietly lose the older rows.
const ACTIVITY_KINDS = [
  { key: 'all', label: 'All activity' },
  { key: 'pause', label: 'Pause log' },
  { key: 'heading', label: 'Heading changes' },
];

// A 'meta_updated' row carries the old and new heading/KRA as JSON in `detail`.
// Unread, the row says only "Renamed" — that something changed, but not what,
// which is the one question a heading-change log exists to answer. Anything that
// doesn't parse falls back to no detail line rather than showing raw JSON.
// An entry's files as one list, whichever shape the server sent.
//
// `files` is the current shape: id 0 is the entry's own first file, the rest are
// kpi.file.attachment ids. has_file/file_name are the older single-file shape and
// are still what an un-upgraded server sends, so both are handled — a task detail
// that silently showed no attachments would look like a task with none.
function entryFiles(entry, kind = 'progress') {
  if (Array.isArray(entry.files) && entry.files.length) {
    return entry.files.map((f) => ({
      key: `${kind}-${entry.id}-${f.id}`,
      id: entry.id,
      attachment_id: f.id || 0,
      file_name: f.file_name || 'file',
    }));
  }
  // A progress entry says outright whether it has one (`has_file`); a manual
  // never had such a flag because it always has a file, so fall back to the name.
  const hasPrimary = entry.has_file !== undefined ? entry.has_file : !!entry.file_name;
  return hasPrimary
    ? [{ key: `${kind}-${entry.id}-0`, id: entry.id, attachment_id: 0, file_name: entry.file_name }]
    : [];
}

// "3 files  ·  12.4 MB of 50 MB".
//
// The chips say what each file costs; this says what the SET costs, which is the
// number the cap is actually applied to. Before multi-file the picker button
// carried it (one file, one size); making it multi-file lost it, so an oversized
// set was refused with nothing on screen explaining how close it had been.
function filesTotalLabel(files, cap) {
  const list = files || [];
  const total = list.reduce((n, f) => n + (f.size || 0), 0);
  return `${list.length} file${list.length === 1 ? '' : 's'}  ·  ${humanSize(total)} of ${humanSize(cap)}`;
}

function actDetail(e) {
  if (!e || e.event !== 'meta_updated' || !e.detail) return null;
  let d;
  try { d = JSON.parse(e.detail); } catch (_) { return null; }
  const parts = [];
  if (d.name_from || d.name_to) parts.push(`"${d.name_from || '—'}" → "${d.name_to || '—'}"`);
  if (d.kra_from || d.kra_to) parts.push(`KRA: ${d.kra_from || '—'} → ${d.kra_to || '—'}`);
  return parts.length ? parts.join('   ·   ') : null;
}

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
//
// Checked with a pattern, not React Native's URL: that polyfill never throws
// on junk ("foo bar.com" passed), and it appends "/" to any link with no
// query or fragment, so "https://host/spec.pdf" was saved as ".../spec.pdf/"
// and direct file links broke. The trimmed original is stored as typed.
function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const m = /^https?:\/\/([^/?#]+)(?:[/?#]\S*)?$/i.exec(withScheme);
  if (!m) return null;
  const host = m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  if (!host.includes('.') || /^\.|\.$/.test(host) || !/^[a-z0-9.-]+$/i.test(host)) return null;
  return withScheme;
}

const isImageName = (n = '') => /\.(png|jpe?g|gif|webp|bmp)$/i.test(n);

// The server's UTC 'YYYY-MM-DD HH:MM:SS' as the phone's local "22 Oct, 10:15".
function localWhen(utc) {
  const ms = parseServerTs(utc);
  if (!ms) return utc || '';
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// 💬 Chat: the server's UTC 'YYYY-MM-DD HH:MM:SS' as a local Date (or null).
function chatDate(utc) {
  if (!utc) return null;
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
// The day pill: "Today" / "Yesterday" / "12 Oct 2026".
function chatDayLabel(d) {
  if (!d) return '';
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day === today) return 'Today';
  if (day === today - 86400000) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const chatHhmm = (d) => (d
  ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '');
const CHAT_KIND_ICON = { image: '🖼', video: '🎬', audio: '🎵' };
// A row's text for a ↩ quote / reply banner: its words, or what it carries.
function chatSnippet(m) {
  const t = String(m?.text ?? m?.body ?? '').trim();
  if (t) return t;
  const n = (m?.files || []).length;
  return n ? `📎 ${n} file${n > 1 ? 's' : ''}` : '';
}
// The long-press card: six quick reactions, and the full grid behind "+".
const CHAT_QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const CHAT_ALL_EMOJI = [
  '👍', '👎', '❤️', '🔥', '🎉', '👏', '🙏', '💯', '😂', '🤣', '😅', '😊', '😍', '😎', '🤔', '😐',
  '😮', '😢', '😭', '😡', '🥳', '🤝', '💪', '✅', '❌', '⚠️', '👀', '🚀', '⭐', '💡', '⏰', '📌',
];
// Info popup: a UTC stamp as a full local date-time, or "—" when it never happened.
function chatWhenFull(utc) {
  const d = chatDate(utc);
  return d ? d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : '—';
}

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

  // Add time to the estimate. The fields, their validation and the write all live
  // in AddTimeModal, shared with the board — this screen only decides when to open
  // it and what to do once it succeeds.
  const [addOpen, setAddOpen] = useState(false);
  // Activity popup, and which day groups are open inside it.
  const [actOpen, setActOpen] = useState(false);
  const [actDays, setActDays] = useState(() => new Set());
  const [actKind, setActKind] = useState('all');
  const [actRows, setActRows] = useState([]);        // rows for a NON-'all' kind
  const [actRowsTotal, setActRowsTotal] = useState(0);
  const [actLoading, setActLoading] = useState(false);

  // Editing one already-submitted progress entry. Its own modal rather than
  // re-using the Submit form above: that form lives further up the page, and
  // scrolling someone away from the row they tapped to edit it is disorienting.
  const [pgEdit, setPgEdit] = useState(null);   // { id, summary, links, linkInput, fileName, clearFile }
  const [pgEditBusy, setPgEditBusy] = useState(false);

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
    loadLegacy();
  }, [task.id]);

  // ---- 🗄️ From the old system (KPI Details card) --------------------------
  // A bug / update raised about a requirement in the OLD database. Its own
  // route, so an ordinary task costs one tiny call that answers legacy: false.
  const [legacy, setLegacy] = useState(null);       // the card, or null
  const [legacyCanEdit, setLegacyCanEdit] = useState(false);
  const [legacyEdit, setLegacyEdit] = useState(null); // { ref, name, note } while editing
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyErr, setLegacyErr] = useState('');
  // 👤 Client — every time the client sent it, oldest first. The same call
  // brings the old-system card, so it is one round trip; an older server
  // without the route still gets the card from fetchLegacy.
  const [clientSends, setClientSends] = useState([]);
  async function loadLegacy() {
    let r = await fetchClientSends(task.id);
    if (r?.status) {
      setClientSends(Array.isArray(r.sends) ? r.sends : []);
    } else {
      log.warn('client sends not loaded', r?.message);
      r = await fetchLegacy(task.id);
    }
    if (!r?.status) { log.warn('legacy card not loaded', r?.message); return; }
    setLegacy(r.legacy || null);
    setLegacyCanEdit(!!r.can_edit);
  }
  async function onSaveLegacy() {
    if (!legacyEdit) return;
    setLegacyBusy(true);
    setLegacyErr('');
    try {
      const res = await saveLegacy(task.id, legacyEdit);
      if (!res?.status) { setLegacyErr(res?.message || 'Could not save the KPI Details'); return; }
      log.info('legacy details saved', { kpi_id: task.id, ref: res.ref });
      setLegacy(res.legacy || null);
      setLegacyEdit(null);
      flash('ok', res.message || 'KPI Details saved.');
      // A Request ID renumbers the task (BUG-031 → BUG001-REQ-012): reload it,
      // and tell the list it came from.
      load(true);
      onChanged?.();
    } catch (e) {
      log.error('legacy save failed', e?.message);
      setLegacyErr(e?.message || 'Could not save the KPI Details');
    } finally {
      setLegacyBusy(false);
    }
  }

  // ---- 💬 Chat with the client ---------------------------------------------
  // Same thread as the web task panel's Chat tab: the client's 💬 Discuss
  // messages, and the team's replies (sent to the client's WhatsApp group).
  // Refreshed every 3 s while the screen is open; the screen being open marks
  // the client's messages as seen (blue ✓✓ on their page).
  const [chat, setChat] = useState(null);           // the route's answer
  const [chatText, setChatText] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatBusyRef = useRef(false);                // a send in flight: the poll stands aside
  const [chatFiles, setChatFiles] = useState([]);   // 📎 picked, not yet sent
  const [chatReply, setChatReply] = useState(null); // ↩ the row being answered
  const [chatPct, setChatPct] = useState(null);     // upload progress 0..100
  const [chatSheet, setChatSheet] = useState(null); // { title, options:[{label, onPress}] }
  const [chatCard, setChatCard] = useState(null);   // { m, grid } the long-pressed row's action card
  const [chatInfo, setChatInfo] = useState(null);   // the row whose ⓘ Info popup is open
  const [chatEdit, setChatEdit] = useState(null);   // ✎ the row being edited (the box holds its words)
  // The send button: while editing only words count (no files go with an edit).
  const chatSendOff = chatBusy || (chatEdit ? !chatText.trim() : (!chatText.trim() && !chatFiles.length));
  useEffect(() => {
    let live = true;
    const pull = () => {
      if (chatBusyRef.current) return;
      fetchChat(task.id, { markSeen: true }).then((r) => { if (live && !chatBusyRef.current) setChat(r); });
    };
    pull();
    const t = setInterval(pull, 3000);
    return () => { live = false; clearInterval(t); };
  }, [task.id]);
  async function onSendChat() {
    const text = chatText.trim();
    if (chatSendOff) return;
    setChatBusy(true);
    chatBusyRef.current = true;
    // ✎ Editing: the same box and button, but the words replace an old row.
    if (chatEdit) {
      try {
        const r = await chatAct(task.id, chatEdit.id, 'edit', { text });
        if (!r?.status) { flash('err', r?.message || 'Could not edit it'); return; }
        log.info('chat edited', { kpi_id: task.id, msg_id: chatEdit.id });
        setChatEdit(null);
        setChatText('');
        setChat(r);
      } catch (e) {
        flash('err', e?.message || 'Could not edit it');
      } finally {
        setChatBusy(false);
        chatBusyRef.current = false;
      }
      return;
    }
    const replyTo = chatReply?.id || 0;
    const reply = chatReply;
    // A text message shows at once with a single ✓ and the box clears; the
    // server's answer replaces it. Files keep the progress bar.
    let temp = null;
    if (!chatFiles.length) {
      temp = {
        id: `tmp${Date.now()}`, side: 'team', who: 'You', body: text, files: [], status: 'pending', error: '',
        at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        reply: reply ? { id: reply.id, side: reply.side, who: reply.who, text: reply.body || '' } : false,
      };
      setChat((c) => ({ ...(c || {}), messages: [...(c?.messages || []), temp] }));
      setChatText('');
      setChatReply(null);
    }
    const unsend = () => {
      if (!temp) return;
      setChat((c) => ({ ...(c || {}), messages: (c?.messages || []).filter((m) => m.id !== temp.id) }));
      setChatText(text);
      setChatReply(reply);
    };
    try {
      let r;
      if (chatFiles.length) {
        setChatPct(0);
        r = await sendChatFiles(task.id, { text, replyTo, files: chatFiles },
          (loaded, total) => { if (total) setChatPct(Math.min(100, Math.round((loaded / total) * 100))); });
      } else {
        r = await sendChat(task.id, text, replyTo);
      }
      if (!r?.status) { unsend(); flash('err', r?.message || 'Could not send it'); return; }
      log.info('chat sent', { kpi_id: task.id, files: chatFiles.length, reply_to: replyTo });
      setChatText('');
      setChatFiles([]);
      setChatReply(null);
      setChat(r);
    } catch (e) {
      unsend();
      flash('err', e?.message || 'Could not send it');
    } finally {
      setChatBusy(false);
      chatBusyRef.current = false;
      setChatPct(null);
    }
  }
  // ⚠ on a bubble: WhatsApp refused the note; send it again.
  async function onChatRetry(m) {
    const r = await retryChat(task.id, m.id);
    if (!r?.status) { flash('err', r?.message || 'Could not retry'); return; }
    setChat(r);
  }

  // 📎 Add picked files to the chips, holding the chat's limits: image / video /
  // audio only, 50 MB each, 10 at a time. Refused here, before any upload.
  function addChatFiles(picked) {
    const ok = [];
    const refused = [];
    for (const f of picked) {
      if (!chatFileKind(f.mimeType)) refused.push(`${f.name} is not a photo, video or audio file`);
      else if (f.size && f.size > CHAT_MAX_BYTES) refused.push(`${f.name} is over 50 MB`);
      else ok.push(f);
    }
    setChatFiles((cur) => {
      const room = Math.max(0, CHAT_MAX_FILES - cur.length);
      if (ok.length > room) refused.push(`Up to ${CHAT_MAX_FILES} files at a time`);
      return [...cur, ...ok.slice(0, room)];
    });
    if (refused.length) flash('err', refused[0]);
  }
  // An image-picker asset as a chip. Some providers leave mimeType / fileName
  // empty, so fall back on the asset type.
  const assetToFile = (a) => {
    const isVideo = a.type === 'video' || (a.mimeType || '').startsWith('video/');
    const mimeType = a.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
    const name = a.fileName || `${isVideo ? 'video' : 'photo'}_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`;
    return { uri: a.uri, name, size: a.fileSize || 0, mimeType };
  };
  async function onChatCamera() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
      if (!perm?.granted) { flash('err', 'Camera permission is needed'); return; }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
      if (res.canceled || !res.assets?.length) return;
      addChatFiles(res.assets.map(assetToFile));
    } catch (e) {
      log.warn('chat camera failed', e?.message);
      flash('err', 'Could not open the camera');
    }
  }
  async function onChatLibrary() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], allowsMultipleSelection: true,
        selectionLimit: Math.max(1, CHAT_MAX_FILES - chatFiles.length), quality: 0.8,
      });
      if (res.canceled || !res.assets?.length) return;
      addChatFiles(res.assets.map(assetToFile));
    } catch (e) {
      log.warn('chat library failed', e?.message);
      flash('err', 'Could not open your photos');
    }
  }
  async function onChatAudio() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: 'audio/*', multiple: true });
      if (res.canceled) return;
      addChatFiles((res.assets || []).filter(Boolean).map((f) => ({
        uri: f.uri, name: f.name || 'audio', size: f.size || 0, mimeType: f.mimeType || 'audio/mpeg',
      })));
    } catch (e) {
      log.warn('chat audio pick failed', e?.message);
      flash('err', 'Could not open your files');
    }
  }
  const openChatPin = () => setChatSheet({
    title: 'Attach',
    options: [
      { label: '📷 Camera', onPress: onChatCamera },
      { label: '🖼 Photos & videos', onPress: onChatLibrary },
      { label: '🎵 Audio', onPress: onChatAudio },
    ],
  });
  // Long-press on a bubble → the action card (reactions · Reply · Edit · Info ·
  // Delete). Not for a withdrawn row, nor for a message still on its way up.
  const openChatRowMenu = (m) => {
    if (m.deleted || String(m.id).startsWith('tmp')) return;
    setChatCard({ m, grid: false });
  };
  // One per-message action; the server answers with the whole chat again.
  async function onChatAct(m, action, extra = {}) {
    const r = await chatAct(task.id, m.id, action, extra);
    if (!r?.status) { flash('err', r?.message || 'Could not do that'); return; }
    log.info('chat act', { kpi_id: task.id, msg_id: m.id, action });
    setChat(r);
  }
  const onChatReact = (m, emoji) => { setChatCard(null); onChatAct(m, 'react', { emoji }); };
  // The card is a Modal: let it close before the Alert / keyboard comes up, as
  // the attach sheet does, or iOS can swallow the second presentation.
  const onChatDelete = (m) => {
    setChatCard(null);
    setTimeout(() => Alert.alert('Delete message', 'Delete this message for everyone?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onChatAct(m, 'delete') },
    ]), 250);
  };
  const startChatEdit = (m) => {
    setChatCard(null);
    setChatReply(null);
    setChatEdit(m);
    setChatText(m.body || '');
  };
  const cancelChatEdit = () => { setChatEdit(null); setChatText(''); };
  const startChatReply = (m) => {
    setChatCard(null);
    if (chatEdit) cancelChatEdit();
    setChatReply(m);
  };
  const openChatInfo = (m) => { setChatCard(null); setTimeout(() => setChatInfo(m), 250); };

  // ↩ Tap a quote → scroll to the message it answers (if it is on screen).
  const chatY = useRef(0);             // y of the chat section in the scroll view
  const chatRowY = useRef({});         // y of each bubble, within that section
  const [chatFocus, setChatFocus] = useState(null);
  function onChatQuote(id) {
    const y = chatRowY.current[id];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, chatY.current + y - 70), animated: true });
    setChatFocus(id);
    setTimeout(() => setChatFocus(null), 1500);
  }

  useEffect(() => {
    log.info('open KPI detail', { kpi_id: task.id, name: task.name });
  }, [task.id, task.name]);

  useEffect(() => { load(); }, [load]);

  // ---- Manual upload ------------------------------------------------------
  const [manOpen, setManOpen] = useState(false);
  const [manFiles, setManFiles] = useState([]);
  const [manDesc, setManDesc] = useState('');
  const [manLink, setManLink] = useState('');
  const [manLinks, setManLinks] = useState([]);
  const [manPct, setManPct] = useState(0);
  const [manBusy, setManBusy] = useState(false);
  // True while the file is being base64-encoded, before any bytes move. Its own
  // flag because manPct is meaningless during that phase.
  // Live transfer figures — bytes moved, speed, seconds remaining.
  const [manRate, setManRate] = useState(null);

  // Returns the file HANDLE only — no base64. The progress route takes the file
  // as multipart straight from this uri, so a 40 MB video never becomes a 53 MB
  // string in memory. Manual upload reads base64 on demand (its route is JSON).
  // Several handles at once, for a progress update that carries more than one
  // document. Same no-base64 contract as pickFile.
  async function pickFiles() {
    const res = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true, type: '*/*', multiple: true,
    });
    if (res.canceled) { log.info('file pick cancelled'); return []; }
    const out = (res.assets || [])
      .filter(Boolean)
      .map((f) => ({ uri: f.uri, name: f.name || 'file', size: f.size || 0, mimeType: f.mimeType }));
    log.info('files picked', { count: out.length });
    return out;
  }

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*' });
    if (res.canceled) { log.info('file pick cancelled'); return null; }
    const f = res.assets?.[0];
    if (!f) { log.warn('file pick returned no asset'); return null; }
    log.info('file picked', { name: f.name, size: f.size, mimeType: f.mimeType });
    return { uri: f.uri, name: f.name || 'file', size: f.size || 0, mimeType: f.mimeType };
  }

  async function onPickManual() {
    log.info('pick manual files');
    try {
      const picked = await pickFiles();
      if (!picked.length) return;
      // Every file is checked, not just the first: one bad extension in a set of
      // four should name itself rather than failing the whole upload anonymously.
      for (const f of picked) {
        // Refuse at pick time, exactly like the progress path — this route
        // base64s the WHOLE file into a JS string before any request starts, so an
        // oversized pick froze (or killed) the app before it could show an error.
        // The server enforces the same two rules.
        const ext = (f.name || '').toLowerCase();
        if (!MANUAL_EXTENSIONS.some((x) => ext.endsWith(x))) {
          log.warn('manual file wrong type', { name: f.name });
          flash('err', `${f.name} is not a PDF, DOC or DOCX — only those can be uploaded as a manual.`);
          return;
        }
        if (f.size && f.size > MAX_MANUAL_BYTES) {
          log.warn('manual file too big', { name: f.name, size: f.size });
          flash('err', `${f.name} is ${humanSize(f.size)} — over the ${MAX_MANUAL_BYTES / (1024 * 1024)} MB limit. Add a Drive link instead.`);
          return;
        }
      }
      // Same file twice is a slip, not an intent.
      const merged = [...manFiles];
      for (const f of picked) {
        if (!merged.some((x) => x.uri === f.uri)) merged.push(f);
      }
      setManFiles(merged);
    } catch (e) {
      log.error('manual file read failed', e?.message);
      flash('err', e?.message || 'Could not read that file');
    }
  }

  async function onPickProgressFile() {
    log.info('pick progress files');
    try {
      const picked = await pickFiles();
      if (!picked.length) return;
      // Refuse at pick time — never start an upload the server will reject. Both
      // limits are checked: one oversized file, and a set that only goes over
      // when added to what is already staged.
      const tooBig = picked.find((f) => f.size && f.size > MAX_PROGRESS_BYTES);
      if (tooBig) {
        log.warn('progress file too big', { name: tooBig.name, size: tooBig.size });
        flash('err', `${tooBig.name} is ${humanSize(tooBig.size)} — over the 50 MB limit. Add a Drive or GitHub link instead.`);
        return;
      }
      // Same file picked twice is a slip, not an intent — drop the duplicate
      // rather than uploading it and listing it on the entry twice.
      const merged = [...pgFiles];
      for (const f of picked) {
        if (!merged.some((x) => x.uri === f.uri)) merged.push(f);
      }
      const total = merged.reduce((n, f) => n + (f.size || 0), 0);
      if (total > MAX_PROGRESS_BYTES) {
        log.warn('progress files too big together', { count: merged.length, total });
        flash('err', `Those files come to ${humanSize(total)} — over the 50 MB limit for one update. Send them as two updates, or add a link.`);
        return;
      }
      setPgFiles(merged);
    } catch (e) {
      log.error('progress file read failed', e?.message);
      flash('err', e?.message || 'Could not read that file');
    }
  }

  async function onUploadManual() {
    if (!manFiles.length || !manDesc.trim()) return;

    // Same trap as the progress form: a link typed but not "+"-ed would be lost.
    let links = manLinks;
    if (manLink.trim()) {
      const url = normalizeUrl(manLink);
      if (!url) { flash('err', 'That link is not a valid URL — fix or clear it before uploading'); return; }
      if (!links.includes(url)) links = [...links, url];
      setManLinks(links); setManLink('');
      log.info('auto-added typed manual link on upload', { url });
    }

    const manTotal = manFiles.reduce((n, f) => n + (f.size || 0), 0);
    log.info('upload manual →', { kpi_id: task.id, count: manFiles.length, size: manTotal, links: links.length });
    setManBusy(true); setManPct(0); setManRate(null);
    try {
      // MULTIPART: the picked files stream straight from disk to
      // /kpi/manual/upload_file, the twin of the route the progress side has
      // always used. There is no base64 step any more — that read happened
      // BEFORE a single byte went out and took real seconds on a 25MB manual
      // (which is what the old "Preparing…" bar was apologising for), put a third
      // more bytes on the wire, and turned a proxy's 413 into a bare
      // "Failed to upload".
      const rate = makeRateTracker();
      const res = await uploadManual(
        task.id,
        { picked: manFiles, reason: manDesc.trim(), links },
        (sent, total) => {
          const r = rate(sent, total);
          setManPct(r.percent);
          setManRate({ sent: r.loaded, total: r.total, speed: r.speed, eta: r.eta });
        },
      );
      if (res?.status === false) {
        log.warn('upload manual refused', { kpi_id: task.id, message: res.message });
        flash('err', res.message || 'Upload failed');
      } else {
        log.info('upload manual ← ok', { kpi_id: task.id, count: manFiles.length });
        flash('ok', manFiles.length === 1 ? `Uploaded ${manFiles[0].name}` : `Uploaded ${manFiles.length} files`);
        setManFiles([]); setManDesc(''); setManLinks([]); setManLink(''); setManOpen(false);
        load(true);
      }
    } catch (e) {
      // uploadManual THROWS on a server refusal (services/uploadAmendments.js),
      // so this catch — not the res.status===false branch above — is where
      // "Only PDF, DOC and DOCX…" or "Not authorized" actually lands. It used to
      // replace every one of them with a fixed connection message, which sent
      // people to check their wifi over a rejected file type.
      log.error('manual upload failed', e?.message);
      flash('err', e?.message || 'Upload failed — check your connection and try again');
    } finally { setManBusy(false); setManPct(0); setManRate(null); }
  }

  // ---- Progress update ----------------------------------------------------
  const [pgSummary, setPgSummary] = useState('');
  const [pgLink, setPgLink] = useState('');
  const [pgLinks, setPgLinks] = useState([]);
  const [pgFiles, setPgFiles] = useState([]);
  const [pgPct, setPgPct] = useState(0);
  const [pgRate, setPgRate] = useState(null);
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
      files: pgFiles.length, size: pgFiles.reduce((n, f) => n + (f.size || 0), 0),
    });
    setPgBusy(true); setPgPct(0); setPgRate(null);
    try {
      // Multipart, so `total` here IS the file — unlike the manual route.
      const rate = makeRateTracker();
      const res = await submitProgressUpdate(
        task.id,
        { summary: pgSummary.trim(), links, files: pgFiles },
        (sent, total) => {
          const r = rate(sent, total);
          setPgPct(r.percent);
          setPgRate({ sent: r.loaded, total: r.total, speed: r.speed, eta: r.eta });
        },
      );
      if (res?.status === false) {
        log.warn('submit progress refused', { kpi_id: task.id, message: res.message });
        flash('err', res.message || 'Could not submit');
        return;
      }
      log.info('submit progress ← ok', { kpi_id: task.id, progress_id: res?.progress_id });
      flash('ok', 'Progress update submitted');
      setPgSummary(''); setPgLink(''); setPgLinks([]); setPgFiles([]);
      load(true);
      onChanged && onChanged();
    } catch (e) {
      log.error('progress submit failed', e?.message);
      flash('err', 'Could not submit — check your connection');
    } finally { setPgBusy(false); setPgPct(0); setPgRate(null); }
  }

  // ---- GitHub -------------------------------------------------------------
  const [ghUrl, setGhUrl] = useState('');
  const [ghBranch, setGhBranch] = useState('');
  const [ghBusy, setGhBusy] = useState(false);

  async function onAddGithub() {
    if (!ghUrl.trim() || !ghBranch.trim()) { flash('err', 'Repository URL and branch are both required'); return; }
    // Tidy the URL one last time in case it was pasted and submitted without the
    // field ever losing focus. The branch is whatever is visibly in the box — the
    // web fills that box with a "Use main" button rather than defaulting behind the
    // reader's back, and a field that says one thing while another is saved is worse
    // than a little typing.
    const { url } = resolveGithubLink(ghUrl, ghBranch);
    const branch = ghBranch.trim();
    setGhUrl(url);
    log.info('add github →', { kpi_id: task.id, url, branch });
    setGhBusy(true);
    // The server owns the rules (github.com only, branch required) — show what it says.
    const res = await addGithubLink(task.id, url, branch);
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

  // ---- Rename / retype / move a task (manager only) ------------------------
  // The web has had this since the heading log was added; without it the app could
  // READ the "Heading changes" log and never write to it, which is a strange thing
  // to ship — a viewer for an action the same app cannot perform.
  const [metaEdit, setMetaEdit] = useState(null);   // { name, type, kraId, kraLabel }
  const [metaBusy, setMetaBusy] = useState(false);
  const [projects, setProjects] = useState([]);     // [{ id, display }]
  const [projectPick, setProjectPick] = useState(false);
  // The server refuses a cross-client move until it is confirmed; this holds its
  // answer while we ask.
  const [clientMove, setClientMove] = useState(null);

  function openMetaEdit() {
    setMetaEdit({
      name: t.name || '',
      type: meta.kind || 'requirement',
      kraId: null,                       // null = leave the KRA alone
      // meta.kra is the KRA's own name, which is what the details row shows —
      // so the button starts out reading exactly what is on screen above it.
      kraLabel: meta.kra || '',
    });
    // Lazily, and only once: the tree is 180+ nodes and most opens of this screen
    // never touch it.
    if (!projects.length) {
      fetchProjects().then(setProjects).catch((e) => log.warn('projects failed', e?.message));
    }
  }

  async function saveMetaEdit(confirmClientMove = false) {
    if (!metaEdit) return;
    const name = metaEdit.name.trim();
    if (!name) { flash('err', 'The task needs a name'); return; }
    log.info('update meta →', { kpi_id: task.id, type: metaEdit.type, kraId: metaEdit.kraId, confirmClientMove });
    setMetaBusy(true);
    const res = await updateTaskMeta(task.id, {
      name, type: metaEdit.type, kraId: metaEdit.kraId, confirmClientMove,
    });
    setMetaBusy(false);

    // Not a failure — the server is asking. Moving a task under a different client
    // root is refused once on purpose, because a mis-tap in a long project list is
    // indistinguishable from a deliberate move.
    if (res?.needs_confirm) {
      log.info('meta needs client-move confirm', { from: res.from_client, to: res.to_client });
      setClientMove({ from: res.from_client, to: res.to_client, message: res.message });
      return;
    }
    if (res?.status === false) {
      log.warn('update meta refused', { message: res.message });
      flash('err', res.message || 'Could not save the changes');
      return;
    }
    log.info('update meta ← ok', { updated: res?.updated });
    setMetaEdit(null); setClientMove(null);
    // Reload rather than trusting what we sent: changing the type rewrites the
    // name's [Bug]/[Update] prefix and the REQ/UPD/BUG token in the reference, so
    // what comes back is not always what went out.
    flash('ok', 'Task updated');
    load(true);
    onChanged && onChanged();
  }

  // ---- Delete (always via a confirm) --------------------------------------
  // Deleting is irreversible and the trash icon sits next to View/Download, so
  // a mis-tap would silently destroy someone's upload. Ask first, and name what
  // is about to go.
  const [confirmDel, setConfirmDel] = useState(null); // { kind, id, name }
  const [delBusy, setDelBusy] = useState(false);
  // Bulk delete on Progress History. deleteProgressBulk has existed in the
  // service with no caller at all, so clearing a run of updates meant confirming
  // them one at a time.
  const [selMode, setSelMode] = useState(false);
  const [selIds, setSelIds] = useState([]);

  // Back closes this detail and returns to the list it was opened from — the
  // board and Task Documents both show it as a view inside themselves, so App's
  // back would have left the whole screen. Selecting updates cancels first,
  // the same as its Cancel link.
  useBackHandler(() => {
    if (selMode) { setSelMode(false); setSelIds([]); return true; }
    if (onBack) { onBack(); return true; }
    return false;
  });

  async function doDelete() {
    if (!confirmDel) return;
    const { kind, id } = confirmDel;
    // The bulk case has its own route and its own per-id reporting.
    if (kind === 'bulk') { setConfirmDel(null); await doBulkDelete(); return; }
    log.info('delete →', { kind, id });
    setDelBusy(true);
    const res = kind === 'manual' ? await deleteManual(id)
      : kind === 'progress' ? await deleteProgress(id)
      : await deleteGithubLink(id);
    setDelBusy(false);
    setConfirmDel(null);
    if (res?.status === false) {
      log.warn('delete refused', { kind, id, message: res.message });
      flash('err', res.message || 'Could not delete');
      return;
    }
    log.info('delete ← ok', { kind, id });
    flash('ok', kind === 'manual' ? 'Manual deleted' : kind === 'progress' ? 'Update deleted' : 'GitHub link deleted');
    load(true);
  }

  // Delete a selection in one go. The route answers PER ID — deleted / refused /
  // missing — rather than failing the batch, so a selection that happens to span
  // someone else's entry still removes your own. Report what actually happened
  // instead of a flat "done".
  async function doBulkDelete() {
    if (!selIds.length) return;
    setDelBusy(true);
    try {
      const res = await deleteProgressBulk(selIds);
      if (res?.status === false) { flash('err', res.message || 'Could not delete those'); return; }
      const gone = res?.deleted ?? selIds.length;
      const refused = res?.refused ?? 0;
      flash(refused ? 'err' : 'ok',
        refused
          ? `Deleted ${gone}; ${refused} were not yours to delete.`
          : `Deleted ${gone} update${gone === 1 ? '' : 's'}.`);
      setSelMode(false);
      setSelIds([]);
      load(true);
    } catch (e) {
      flash('err', e?.message || 'Could not delete those');
    } finally { setDelBusy(false); }
  }

  // ---- Edit one progress entry --------------------------------------------
  // Seeded from the row as the server sent it, so an edit that changes only the
  // summary re-sends the links unchanged rather than blanking them.
  function openProgressEdit(entry) {
    setPgEdit({
      id: entry.id,
      summary: entry.summary || '',
      links: parseLinks(entry.related_links),
      linkInput: '',
      fileName: entry.has_file ? (entry.file_name || 'the attached file') : '',
      clearFile: false,
    });
  }

  async function saveProgressEdit() {
    if (!pgEdit) return;
    // A link left in the box counts, exactly as the Submit form promises above —
    // otherwise typing one and tapping Save silently drops it.
    const pending = normalizeUrl(pgEdit.linkInput);
    const links = pending && !pgEdit.links.includes(pending)
      ? [...pgEdit.links, pending] : pgEdit.links;
    log.info('edit progress →', { id: pgEdit.id, links: links.length, clearFile: pgEdit.clearFile });
    setPgEditBusy(true);
    const res = await updateProgress(pgEdit.id, {
      summary: pgEdit.summary, links, clearFile: pgEdit.clearFile,
    });
    setPgEditBusy(false);
    if (res?.status === false) {
      log.warn('edit refused', { id: pgEdit.id, message: res.message });
      flash('err', res.message || 'Could not save the changes');
      return;
    }
    setPgEdit(null);
    flash('ok', 'Update saved');
    load(true);
  }

  // ---- Activity: switch which log is shown ---------------------------------
  async function chooseActKind(k) {
    setActKind(k);
    setActDays(new Set());          // day groups belong to the old list
    if (k === 'all') return;        // already in hand, no round-trip
    setActLoading(true);
    const res = await fetchActivity(task.id, k);
    setActLoading(false);
    if (res?.status === false) {
      log.warn('activity refused', { kind: k, message: res.message });
      flash('err', res.message || 'Could not load the log');
      setActRows([]); setActRowsTotal(0);
      return;
    }
    setActRows(res.activity_log || []);
    setActRowsTotal(res.activity_total || 0);
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
  // attId reaches BOTH branches. It used to be dropped on the manual one, so a
  // manual carrying spec.pdf + appendix.pdf listed both and served spec.pdf for
  // either — saved under the other file's name, which made it look like the
  // right file until someone opened it. The server has had the attachment_id
  // branch since manuals learned to carry more than one document, and
  // fetchManualFile has always accepted the argument.
  const fetchBytes = (id, kind, attId = 0) => (kind === 'manual' ? fetchManualFile(id, attId) : fetchProgressFile(id, attId));

  // Pull the bytes over the authenticated JSON channel, drop them in the cache,
  // and hand back a file:// uri anything local can open.
  async function cacheFile(id, kind, attId = 0) {
    const res = await fetchBytes(id, kind, attId);
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
    log.info('view file →', { id: f.id, kind, name: f.file_name, att: f.attachment_id || 0 });
    // `key` distinguishes several files hanging off ONE entry; anything without
    // it (the task-level Documents list) keeps the original entry-wide key.
    setFileBusy(f.key || `${kind}-${f.id}`);
    try {
      const c = await cacheFile(f.id, kind, f.attachment_id || 0);
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
    log.info('download file →', { id: f.id, kind, name: f.file_name, att: f.attachment_id || 0 });
    setFileBusy(f.key || `${kind}-${f.id}`);
    try {
      const res = await fetchBytes(f.id, kind, f.attachment_id || 0);
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

  // ▶ A voice note in the old-system card. Fetched over the JSON door like every
  // other file here, then played in place with expo-audio. A build made before
  // expo-audio was added has no player, so it hands the file to the device's own
  // instead — still playable, never a dead button.
  const playerRef = useRef(null);
  const [playing, setPlaying] = useState(null);   // the url being played
  const stopVoice = () => {
    try { playerRef.current?.remove(); } catch (_) {}
    playerRef.current = null;
    setPlaying(null);
  };
  useEffect(() => () => { try { playerRef.current?.remove(); } catch (_) {} }, []);
  async function onPlayVoice(v) {
    if (playing === v.url) { stopVoice(); return; }
    const src = legacyVoiceSource(v.url);
    if (!src) { flash('err', 'Could not find that voice note'); return; }
    stopVoice();
    setFileBusy(`voice-${v.url}`);
    try {
      const c = await cacheFile(src.progressId, 'progress', src.attachmentId);
      if (!c) return;
      let audio = null;
      try {
        // eslint-disable-next-line global-require
        audio = require('expo-audio');
        await audio.setAudioModeAsync({ playsInSilentMode: true });
      } catch (e) {
        log.warn('in-app audio not available', e?.message);
        audio = null;
      }
      if (audio) {
        const p = audio.createAudioPlayer(c.uri);
        playerRef.current = p;
        p.addListener('playbackStatusUpdate', (st) => { if (st?.didJustFinish) stopVoice(); });
        p.play();
        setPlaying(v.url);
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(c.uri, { mimeType: c.mimetype, dialogTitle: `Play ${c.file_name}` });
      } else {
        flash('err', 'No app available to play this voice note');
      }
    } catch (e) {
      log.error('play voice failed', e?.message);
      flash('err', 'Could not play that voice note');
    } finally { setFileBusy(null); }
  }

  // 📎 Chat files. f.url is a type='http' route; fetchChatFile pulls the bytes
  // with the session and they are cached as a local file, like every other file
  // on this screen. Photos load as thumbnails on their own; videos and audio wait
  // for a tap.
  const [chatMedia, setChatMedia] = useState({});   // file id -> local file:// uri
  const chatMediaPending = useRef(new Set());
  async function cacheChatFile(f, quiet = false) {
    if (chatMedia[f.id]) return chatMedia[f.id];
    const res = await fetchChatFile(f.url);
    if (!res?.status) {
      if (!quiet) flash('err', res?.message || 'Could not fetch the file');
      return null;
    }
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    let name = f.name || 'file';
    try { name = decodeURIComponent(name); } catch (_) {}
    name = name.split(/[\\/]/).pop() || 'file';
    const uri = `${dir}chat_${f.id}_${name}`;
    await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
    setChatMedia((cur) => ({ ...cur, [f.id]: uri }));
    return uri;
  }
  useEffect(() => {
    const imgs = [];
    for (const m of chat?.messages || []) {
      for (const f of m.files || []) {
        if (f.kind === 'image' && f.url && !chatMedia[f.id] && !chatMediaPending.current.has(f.id)) imgs.push(f);
      }
    }
    if (!imgs.length) return;
    imgs.forEach((f) => chatMediaPending.current.add(f.id));
    (async () => {
      // One at a time: a chat full of photos should not fire twenty downloads.
      for (const f of imgs) {
        try { await cacheChatFile(f, true); } catch (e) { log.warn('chat thumb failed', e?.message); }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.messages]);

  async function onOpenChatFile(f) {
    if (f.kind === 'audio' && playing === f.url) { stopVoice(); return; }
    setFileBusy(`chat-${f.id}`);
    try {
      const uri = await cacheChatFile(f);
      if (!uri) return;
      if (f.kind === 'image') {
        setViewer({ name: f.name, uri, mimetype: f.mime, isImage: true });
        return;
      }
      if (f.kind === 'audio') {
        let audio = null;
        try {
          // eslint-disable-next-line global-require
          audio = require('expo-audio');
          await audio.setAudioModeAsync({ playsInSilentMode: true });
        } catch (e) {
          log.warn('in-app audio not available', e?.message);
          audio = null;
        }
        if (audio) {
          stopVoice();
          const p = audio.createAudioPlayer(uri);
          playerRef.current = p;
          p.addListener('playbackStatusUpdate', (st) => { if (st?.didJustFinish) stopVoice(); });
          p.play();
          setPlaying(f.url);
          return;
        }
      }
      // Video (no in-app player in this build), or audio without expo-audio:
      // hand it to the device's own player.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: f.mime || undefined, dialogTitle: `Open ${f.name}` });
      } else {
        flash('err', 'No app available to open this file');
      }
    } catch (e) {
      log.error('open chat file failed', e?.message);
      flash('err', 'Could not open that file');
    } finally { setFileBusy(null); }
  }

  // A file chip in the 👤 Client card. Its url is the web's type='http' route,
  // so read the ids out of it and open it like any other file here.
  function onViewSendFile(f, key) {
    const src = sendFileSource(f);
    if (!src) { flash('err', 'Could not find that file'); return; }
    onViewFile({ key, id: src.progressId, attachment_id: src.attachmentId, file_name: f.name || 'file' });
  }

  // "View note" — jump to the progress update this file came from and flash it.
  // The file's id IS its kpi.progress id, so they match directly.
  function onViewNote(f) {
    log.info('view note →', { progress_id: f.id });
    // Client-raised rows live in their own card, not in Progress History, so
    // they have no recorded offset — don't scroll to a row that isn't there.
    if (noteY.current[f.id] === undefined) {
      log.warn('view note: no history row for', { progress_id: f.id });
      return;
    }
    const y = historyY.current + noteY.current[f.id];
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
  // What this task's type needs (server rules) and what the form filled in for
  // it — app link, manual link, website URL, database details.
  const [cmpFilled, setCmpFilled] = useState({});
  const [cmpBusy, setCmpBusy] = useState(false);
  // Files a CLIENT attached when raising the task come back as progress / file
  // rows flagged `from_client`. They get their own read-only card and never
  // count as the team's progress summary (the server refuses Complete on them).
  const teamProgress = (data?.progress || []).filter((p) => !p.from_client);
  const clientProgress = (data?.progress || []).filter((p) => p.from_client);
  // 👤 Client: only when the client sent something (files or text).
  const showClientSends = hasClientSends(clientSends);
  const teamFiles = (data?.files || []).filter((f) => !f.from_client);
  const clientProgressIds = new Set(clientProgress.map((p) => p.id));
  const hasProgress = teamProgress.length > 0;
  // What a full Complete needs depends on the task type (server rules): a
  // Module needs the manual + GitHub, a Database task the four database
  // details, a Bug fix only the summary. Partial Finish needs only the summary.
  const cmpRules = data?.meta?.completion_rules || [];
  const summaryRequired = !cmpRules.length || cmpRules.some((r) => r.key === 'summary' && r.required);
  // The popup on the Complete button: null, { kind: 'missing', items } or
  // { kind: 'confirm' }. The button stays pressable so a tap explains everything
  // still missing at once, instead of sitting greyed-out and silent.
  const [cmpDlg, setCmpDlg] = useState(null);

  function onCompletePress() {
    if (cmpBusy) return;
    const items = completeMissing(cmpRules, { hasSummary: hasProgress, filled: cmpFilled });
    setCmpDlg(items.length ? { kind: 'missing', items } : { kind: 'confirm' });
  }

  // ✅ Completed / 🏁 Partially completed (FinishModeRadio). Partial sends only
  // a summary — typed here, or the last update — and the client is sent it.
  const [cmpPartial, setCmpPartial] = useState(false);
  const [cmpSummary, setCmpSummary] = useState('');

  function onPartialPress() {
    if (cmpBusy) return;
    if (!cmpSummary.trim() && !hasProgress) {
      flash('err', 'Write a summary of what you did before sending a partial finish.');
      return;
    }
    setCmpDlg({ kind: 'partial' });
  }

  async function onComplete(partial = false) {
    setCmpDlg(null);
    setCmpBusy(true);
    if (partial && cmpSummary.trim()) {
      const pr = await createProgress(task.id, cmpSummary.trim());
      if (pr?.status === false) {
        setCmpBusy(false);
        flash('err', pr.message || 'Could not save your summary');
        return;
      }
    }
    const res = await completeTask(task.id, partial ? {} : completeExtras(cmpFilled), partial);
    setCmpBusy(false);
    if (res?.status === false) { flash('err', res.message || 'Could not complete'); return; }
    setCmpFilled({});
    setCmpSummary('');
    flash('ok', partial ? 'Partial finish sent — the client is sent your summary' : 'Sent for approval');
    onChanged && onChanged();
    load(true);
  }

  const meta = data?.meta || {};
  const t = data?.task || task;
  const estHistory = data?.estimate_history || [];
  const activityTotal = data?.activity_total || 0;
  // Newest day first, grouped on the date half of the server's timestamp — the
  // same grouping the web's popup uses, so the two read identically.
  // 'all' is served from the details payload already in hand; a narrower kind has
  // its own fetched window. Deciding it in ONE place keeps the slice note, the day
  // groups and the empty state from ever disagreeing about what is on screen.
  const actEffectiveRows = actKind === 'all' ? (data?.activity_log || []) : actRows;
  const actEffectiveTotal = actKind === 'all' ? activityTotal : actRowsTotal;
  const actGroups = useMemo(() => {
    const by = new Map();
    for (const e of actEffectiveRows) {
      const day = String(e.at || '').slice(0, 10) || '—';
      if (!by.has(day)) by.set(day, []);
      by.get(day).push(e);
    }
    return Array.from(by, ([day, rows]) => ({ day, rows }));
  }, [actEffectiveRows]);
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
            <Section icon="document-text-outline" title="KPI Details"
              right={meta.is_manager ? (
                <TouchableOpacity style={s.metaEditBtn} onPress={openMetaEdit}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="create-outline" size={14} color={COLORS.primary} />
                  <Text style={s.metaEditTxt}>Edit</Text>
                </TouchableOpacity>
              ) : null}>
              <Text style={s.taskName}>{t.name}</Text>
              <View style={s.tagRow}>
                {!!meta.external_ref && <View style={s.refBadge}><Text style={s.refTxt}>{meta.external_ref}</Text></View>}
                <View style={[s.pill, { backgroundColor: kind.bg }]}><Text style={[s.pillTxt, { color: kind.fg }]}>{kind.label}</Text></View>
                {/* Module / App / EXE / Other — what the task builds. Older tasks have
                    none, so the badge only appears once one is set. */}
                {!!taskDeliverableLabel(t) && (
                  <View style={[s.pill, { backgroundColor: '#EEF3FF' }]}>
                    <Text style={[s.pillTxt, { color: COLORS.primary }]}>{taskDeliverableLabel(t)}</Text>
                  </View>
                )}
                <View style={[s.pill, { backgroundColor: pr.bg }]}><Text style={[s.pillTxt, { color: pr.fg }]}>{pr.label}</Text></View>
              </View>
              <Row label="KRA / Project" value={meta.kra} />
              <Row label="Estimate" value={t.estimate_display} mono />
              {/* Why the estimate grew, next to the number it grew to. The web
                  puts this on the card for the same reason: an estimate that
                  changed with nothing explaining it is how overruns get argued
                  about later. */}
              {/* The whole chain, not just the latest reason. estimate_extend_reason
                  is overwritten on every extension, so on its own it can say an
                  estimate grew three times without saying what the first two
                  reasons were — which is exactly the argument it exists to settle.
                  Falls back to the single latest line on an older server that does
                  not send estimate_history. */}
              {estHistory.length ? (
                <View style={s.estChain}>
                  {estHistory.map((h) => (
                    <Text key={`${h.seq}`} style={s.estChainRow}>
                      {h.kind === 'original' ? (
                        <Text style={s.estChainOrig}>{h.value} — original</Text>
                      ) : (
                        <>
                          <Text style={s.estChainAdd}>{h.value}</Text>
                          <Text style={s.estChainTo}> → {h.running_total}</Text>
                          {!!h.reason && <Text style={s.estChainWhy}> · "{h.reason}"</Text>}
                          {!!(h.actor || h.at) && (
                            <Text style={s.estChainWho}> — {[h.actor, h.at].filter(Boolean).join(', ')}</Text>
                          )}
                        </>
                      )}
                    </Text>
                  ))}
                </View>
              ) : !!t.estimate_extend_reason && (
                <Text style={s.estExtend}>
                  Extended{t.estimate_extension_count > 1 ? ` ${t.estimate_extension_count}×` : ''} — {t.estimate_extend_reason}
                </Text>
              )}
              <View style={s.estActions}>
                <TouchableOpacity onPress={() => setAddOpen(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={s.addTimeLink}>+ Add time to the estimate</Text>
                </TouchableOpacity>
                {/* Everything that has happened to this task — starts, pauses,
                    switches, extensions — grouped by day, as the web's Activity
                    popup does. The trail was already being written; the app just
                    had no reader for it. */}
                {activityTotal > 0 && (
                  <TouchableOpacity onPress={() => setActOpen(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={s.actLink}>Activity ({activityTotal})</Text>
                  </TouchableOpacity>
                )}
              </View>
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
                      {entryFiles(m, 'manual').slice(1).map((f) => (
                        <View key={f.key} style={s.extraFile}>
                          <Ionicons name="document-outline" size={13} color={COLORS.primary} />
                          <Text style={s.extraFileTxt} numberOfLines={1}>{f.file_name}</Text>
                          {fileBusy === f.key ? (
                            <ActivityIndicator size="small" color={COLORS.primary} />
                          ) : (
                            <>
                              <TouchableOpacity onPress={() => onViewFile(f, 'manual')}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="eye-outline" size={15} color={COLORS.primary} />
                              </TouchableOpacity>
                              <TouchableOpacity onPress={() => onDownloadFile(f, 'manual')}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="download-outline" size={15} color={COLORS.green} />
                              </TouchableOpacity>
                            </>
                          )}
                        </View>
                      ))}
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
                  {/* One manual entry can carry several documents — a spec and its
                      two appendices belong together, not as three entries. */}
                  <TouchableOpacity style={s.filePick} onPress={onPickManual}>
                    <Ionicons name="cloud-upload-outline" size={16} color={COLORS.primary} />
                    <Text style={s.filePickTxt} numberOfLines={1}>
                      {manFiles.length ? 'Add another file' : 'Choose files'}
                    </Text>
                  </TouchableOpacity>
                  {manFiles.map((f, i) => (
                    <View key={`${f.uri}-${i}`} style={s.linkChip}>
                      <Ionicons name="document-outline" size={13} color={COLORS.primary} />
                      <Text style={s.linkChipTxt} numberOfLines={1}>
                        {f.name}  ·  {humanSize(f.size)}
                      </Text>
                      <TouchableOpacity
                        onPress={() => setManFiles(manFiles.filter((_, x) => x !== i))}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={15} color={COLORS.faint} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {manFiles.length ? (
                    <Text style={s.fileTotal}>{filesTotalLabel(manFiles, MAX_MANUAL_BYTES)}</Text>
                  ) : null}
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
                      {/* No "Preparing…" phase any more: multipart streams from
                          disk, so bytes move from the first tick and the bar is
                          honest for the whole upload rather than the second half. */}
                      {(
                        <>
                          <View style={s.barTrack}><View style={[s.barFill, { width: `${manPct}%` }]} /></View>
                          {/* Bytes moved, live speed and time left. A percentage on
                              its own cannot tell "slow" from "stalled", which is the
                              only thing anyone wants to know while waiting. */}
                          <Text style={s.pctTxt}>
                            {manRate
                              ? `${humanSize(manRate.sent)} / ${humanSize(manRate.total)} · ${manPct}%`
                              : `${humanSize(manFiles.reduce((n, f) => n + (f.size || 0), 0))} · ${manPct}%`}
                            {manRate && fmtSpeed(manRate.speed) ? `  ·  ${fmtSpeed(manRate.speed)}` : ''}
                            {manRate && fmtEta(manRate.eta) ? `  ·  ${fmtEta(manRate.eta)} left` : ''}
                          </Text>
                        </>
                      )}
                    </View>
                  )}
                  <View style={s.formBtns}>
                    <TouchableOpacity style={s.ghostBtn} onPress={() => { setManOpen(false); setManFile(null); setManDesc(''); setManLinks([]); setManLink(''); }} disabled={manBusy}>
                      <Text style={s.ghostBtnTxt}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.primBtn, (!manFiles.length || !manDesc.trim() || manBusy) && s.btnOff]}
                      onPress={onUploadManual} disabled={!manFiles.length || !manDesc.trim() || manBusy}>
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

              <Text style={s.label}>Attach Files (optional)</Text>
              {/* One update can carry several documents. They go up as a single
                  request, so the entry either gets all of them or none — never
                  half a set, which is what N separate uploads would risk. */}
              <TouchableOpacity style={s.filePick} onPress={onPickProgressFile}>
                <Ionicons name="attach-outline" size={16} color={COLORS.primary} />
                <Text style={s.filePickTxt} numberOfLines={1}>
                  {pgFiles.length ? 'Add another file' : 'Choose files'}
                </Text>
              </TouchableOpacity>
              {pgFiles.map((f, i) => (
                <View key={`${f.uri}-${i}`} style={s.linkChip}>
                  <Ionicons name="document-outline" size={13} color={COLORS.primary} />
                  <Text style={s.linkChipTxt} numberOfLines={1}>
                    {f.name}  ·  {humanSize(f.size)}
                  </Text>
                  <TouchableOpacity
                    onPress={() => setPgFiles(pgFiles.filter((_, x) => x !== i))}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={15} color={COLORS.faint} />
                  </TouchableOpacity>
                </View>
              ))}
              {pgFiles.length ? (
                <Text style={s.fileTotal}>{filesTotalLabel(pgFiles, MAX_PROGRESS_BYTES)}</Text>
              ) : null}
              {/* Same warning the web shows under its file input (kpi_action.js), but
                  saying "each" AND "together": the cap is enforced both ways, and a
                  bare "Max 50 MB" reads as per-file — which would contradict the
                  total line directly above it. */}
              <Text style={s.fileWarn}>
                ⚠ Large files take time — keep this screen open until 100%. Max 50 MB each,
                and 50 MB together. For bigger files, add a Drive or GitHub link instead.
              </Text>

              {pgBusy && pgFiles.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <View style={s.barTrack}><View style={[s.barFill, { width: `${pgPct}%` }]} /></View>
                  <Text style={s.pctTxt}>
                    {pgRate
                      ? `${humanSize(pgRate.sent)} / ${humanSize(pgRate.total)} · ${pgPct}%`
                      : `${humanSize(pgFiles.reduce((n, f) => n + (f.size || 0), 0))} · ${pgPct}%`}
                    {pgRate && fmtSpeed(pgRate.speed) ? `  ·  ${fmtSpeed(pgRate.speed)}` : ''}
                    {pgRate && fmtEta(pgRate.eta) ? `  ·  ${fmtEta(pgRate.eta)} left` : ''}
                  </Text>
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
              {/* On blur, not on every keystroke: transforming mid-type would trim
                  the URL the moment "…/tree/m" matched and then append the rest of
                  the branch onto the trimmed URL. Blur is when a paste has settled. */}
              <TextInput style={s.input} placeholder="https://github.com/username/repository"
                placeholderTextColor={COLORS.faint} value={ghUrl} onChangeText={setGhUrl}
                onBlur={() => {
                  const r = resolveGithubLink(ghUrl, ghBranch);
                  // A changed URL means /tree/<branch> was stripped off it, so the
                  // branch it named goes in the box where it can be seen and edited.
                  if (r.url !== ghUrl.trim()) {
                    setGhUrl(r.url);
                    if (!ghBranch.trim()) setGhBranch(r.branch);
                  }
                }}
                autoCapitalize="none" keyboardType="url" />
              <Text style={s.label}>Branch</Text>
              <TextInput style={s.input} placeholder="main / feature/xyz"
                placeholderTextColor={COLORS.faint} value={ghBranch} onChangeText={setGhBranch} autoCapitalize="none" />
              {/* The same shortcut the web offers, and for the same reason: the branch
                  is required and is "main" most of the time, so typing it on every link
                  was pure friction. Shown only once there is a repo to branch off, and
                  only while the box is empty, so it stops nagging the moment a real
                  branch is typed. Deliberately a button rather than a silent default —
                  it puts "main" where it can be seen and changed before saving. */}
              {ghUrl.trim() && !ghBranch.trim() ? (
                <TouchableOpacity style={s.useMainBtn} onPress={() => setGhBranch('main')}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.8}>
                  <Ionicons name="git-branch-outline" size={13} color={COLORS.primary} />
                  <Text style={s.useMainTxt}>Use main</Text>
                </TouchableOpacity>
              ) : null}
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

                <FinishModeRadio partial={cmpPartial} onChange={setCmpPartial} />

                {cmpPartial ? (
                  <>
                    <Text style={s.cardSub}>Progress summary *</Text>
                    <TextInput
                      style={[s.oldInput, { minHeight: 90, textAlignVertical: 'top', paddingTop: 9 }]} multiline
                      value={cmpSummary} onChangeText={setCmpSummary}
                      placeholder={hasProgress ? 'Leave empty to use your last update' : "What was done, what's left, why you're finishing now…"}
                      placeholderTextColor={COLORS.faint}
                    />
                    <View style={[s.warnBox, { backgroundColor: '#EEF2FF' }]}>
                      <Text style={[s.warnTxt, { color: COLORS.navy }]}>{PARTIAL_NOTE}</Text>
                    </View>
                    <TouchableOpacity
                      style={[s.wideBtn, { backgroundColor: COLORS.amber }, cmpBusy && s.btnOff]}
                      onPress={onPartialPress} disabled={cmpBusy}>
                      {cmpBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                        <><Ionicons name="flag-outline" size={16} color="#fff" /><Text style={s.wideBtnTxt}>🏁 Send partial finish</Text></>
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    {!hasProgress && summaryRequired && (
                      <View style={s.warnBox}>
                        <Ionicons name="warning-outline" size={15} color="#92400E" />
                        <Text style={s.warnTxt}>Submit a Progress Summary above before you complete this task.</Text>
                      </View>
                    )}

                    <Text style={s.cardSub}>What this task needs — the user manual file and the GitHub link are added in their sections above.</Text>
                    <CompleteRules rules={cmpRules} filled={cmpFilled} onChange={setCmpFilled} hasSummary={hasProgress} />

                    <TouchableOpacity
                      style={[s.wideBtn, { backgroundColor: COLORS.red }, cmpBusy && s.btnOff]}
                      onPress={onCompletePress} disabled={cmpBusy}>
                      {cmpBusy ? <ActivityIndicator color="#fff" size="small" /> : (
                        <><Ionicons name="flag" size={16} color="#fff" /><Text style={s.wideBtnTxt}>Complete &amp; Send for Approval</Text></>
                      )}
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}

            {/* ── 🗄️ From the old system — KPI Details ────────────────── */}
            {/* Shown whenever the task was raised "from the old system", even
                with no client files: the voice notes, the message, and the old
                Request ID / Task name the team confirms with the client. */}
            {!!legacy && (
              <Section icon="server-outline" tint={COLORS.amber} title="🗄️ KPI Details — old system"
                right={legacyCanEdit && !legacyEdit ? (
                  <TouchableOpacity style={s.attView} onPress={() => {
                    setLegacyErr('');
                    setLegacyEdit({ ref: legacy.ref || '', name: legacy.name || '', note: legacy.note || '' });
                  }}>
                    <Ionicons name="create-outline" size={13} color="#fff" />
                    <Text style={s.attBtnTxt}>Edit</Text>
                  </TouchableOpacity>
                ) : null}>
                <View style={s.oldBadges}>
                  <View style={s.oldBadge}><Text style={s.oldBadgeTxt}>🗄️ Old DB Requirement</Text></View>
                  <View style={[s.oldBadge, legacy.status === 'confirmed' ? s.oldBadgeOk : s.oldBadgeWait]}>
                    <Text style={[s.oldBadgeTxt, { color: legacy.status === 'confirmed' ? COLORS.green : '#92400E' }]}>
                      {legacy.status_label || (legacy.status === 'confirmed' ? 'Confirmed with client' : 'Pending')}
                    </Text>
                  </View>
                </View>

                {(legacy.voice_notes || []).map((v) => (
                  <View key={v.url} style={s.fileRow}>
                    <Ionicons name="mic-outline" size={15} color={COLORS.primary} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={s.fileName} numberOfLines={1}>{v.name}</Text>
                    </View>
                    {fileBusy === `voice-${v.url}` ? (
                      <ActivityIndicator size="small" color={COLORS.primary} />
                    ) : (
                      <TouchableOpacity style={s.attView} onPress={() => onPlayVoice(v)}>
                        <Ionicons name={playing === v.url ? 'stop' : 'play'} size={13} color="#fff" />
                        <Text style={s.attBtnTxt}>{playing === v.url ? 'Stop' : 'Play'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
                {!!(legacy.transcript || '').trim() && (
                  <>
                    <Text style={s.oldLbl}>Voice note says</Text>
                    <Text style={s.body}>{legacy.transcript}</Text>
                  </>
                )}

                {legacyEdit ? (
                  <>
                    <Text style={s.oldLbl}>Message</Text>
                    <TextInput
                      style={[s.oldInput, { minHeight: 70, textAlignVertical: 'top', paddingTop: 9 }]} multiline
                      value={legacyEdit.note} onChangeText={(t) => setLegacyEdit({ ...legacyEdit, note: t })}
                      placeholder="What the client said it is about" placeholderTextColor={COLORS.faint}
                    />
                    <Text style={s.oldLbl}>Request ID</Text>
                    <TextInput
                      style={s.oldInput} autoCapitalize="characters"
                      value={legacyEdit.ref} onChangeText={(t) => setLegacyEdit({ ...legacyEdit, ref: t })}
                      placeholder="e.g. REQ-012" placeholderTextColor={COLORS.faint}
                    />
                    <Text style={s.oldLbl}>Task name</Text>
                    <TextInput
                      style={s.oldInput}
                      value={legacyEdit.name} onChangeText={(t) => setLegacyEdit({ ...legacyEdit, name: t })}
                      placeholder="The old task's name" placeholderTextColor={COLORS.faint}
                    />
                    <Text style={s.cardSub}>Saving a Request ID files this task under that old requirement and marks it Confirmed with client.</Text>
                    {!!legacyErr && <Text style={s.oldErr}>{legacyErr}</Text>}
                    <View style={s.oldBtns}>
                      <TouchableOpacity style={s.attGhost} onPress={() => { setLegacyEdit(null); setLegacyErr(''); }} disabled={legacyBusy}>
                        <Text style={s.attGhostTxt}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.attDl, legacyBusy && s.btnOff]} onPress={onSaveLegacy} disabled={legacyBusy}>
                        {legacyBusy ? <ActivityIndicator size="small" color="#fff" /> : (
                          <><Ionicons name="checkmark" size={13} color="#fff" /><Text style={s.attBtnTxt}>Save</Text></>
                        )}
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    {!!(legacy.note || '').trim() && (
                      <>
                        <Text style={s.oldLbl}>Message</Text>
                        <Text style={s.body}>{legacy.note}</Text>
                      </>
                    )}
                    <Text style={s.oldLbl}>Request ID</Text>
                    <Text style={[s.body, !legacy.ref && s.oldPending]}>{legacy.ref || 'Pending — confirm with client'}</Text>
                    <Text style={s.oldLbl}>Task name</Text>
                    <Text style={[s.body, !legacy.name && s.oldPending]}>{legacy.name || 'Pending — confirm with client'}</Text>
                    {!!legacy.confirmed_by && (
                      <Text style={s.cardSub}>
                        Confirmed by {legacy.confirmed_by}{legacy.confirmed_on ? ` on ${legacy.confirmed_on}` : ''}
                      </Text>
                    )}
                  </>
                )}
              </Section>
            )}

            {/* ── 👤 Client — every send, oldest first ───────────────── */}
            {/* Same as the web task panel's Client tab: each time the client
                sent this request, its files, and what became of it. */}
            {showClientSends && (() => {
              const sends = clientSends;
              const single = sends.length === 1;
              return (
                <Section icon="person-outline" title={`👤 Client${single ? '' : ` (${sends.length} sends)`}`}>
                  {sends.map((sd, i) => {
                    const isNew = !single && i === sends.length - 1;
                    const st = sendStatus(sd, localWhen);
                    return (
                      <View key={`send-${sd.round}-${i}`} style={[s.histRow, isNew && s.sendNew]}>
                        <View style={s.histTop}>
                          <Text style={[s.histWhen, { flex: 1 }]}>
                            {single ? [localWhen(sd.sent_at), sd.sent_by ? `by ${sd.sent_by}` : ''].filter(Boolean).join(' · ') : sendHeading(sd, localWhen)}
                          </Text>
                          {isNew && <View style={s.sendNewTag}><Text style={s.sendNewTagTxt}>NEW</Text></View>}
                        </View>
                        {(!!sd.ref || sd.old_db) && (
                          <Text style={s.cardSub}>{[sd.ref, sd.old_db ? '🗄️ Old DB' : ''].filter(Boolean).join(' · ')}</Text>
                        )}
                        {!!(sd.name || '').trim() && <Text style={s.sendName}>{sd.name}</Text>}
                        {!!(sd.description || '').trim() && <Text style={s.body}>{sd.description}</Text>}
                        {(sd.files || []).length > 0 && (
                          <View style={s.sendFiles}>
                            {sd.files.map((f, j) => {
                              const key = `send-${i}-${j}`;
                              return (
                                <TouchableOpacity key={key} style={[s.linkChip, s.sendFile]}
                                  onPress={() => onViewSendFile(f, key)} disabled={fileBusy === key}>
                                  <Text>{fileIcon(f.name)}</Text>
                                  <Text style={s.sendFileTxt} numberOfLines={1}>{f.name || 'file'}</Text>
                                  {fileBusy === key && <ActivityIndicator size="small" color={COLORS.primary} />}
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        )}
                        <Text style={[s.sendStatus, sd.status === 'refused' && { color: COLORS.red }, sd.status === 'accepted' && { color: COLORS.green }]}>
                          {st.icon} {st.text}
                        </Text>
                        {!!st.reason && <Text style={s.sendReason}>Reason: {st.reason}</Text>}
                      </View>
                    );
                  })}
                </Section>
              );
            })()}

            {/* ── 💬 Chat with the client ─────────────────────────────── */}
            {/* Team side only (a reply posts as the team). Shown once there is a
                message, or when a reply can be sent. */}
            {(data?.meta?.is_manager || data?.meta?.is_assignee) && chat?.status
              && ((chat.messages || []).length > 0 || (chat.can_send && !chat.locked)) && (
              <View onLayout={(e) => { chatY.current = e.nativeEvent.layout.y; }}>
              <Section icon="chatbubbles-outline" title={`💬 Chat with ${chat.client || 'the client'}`}
                subtitle="The client sees team messages as “Reply from our team”. Long-press a message to react, reply, edit or delete.">
                {(chat.messages || []).length === 0 && (
                  <Text style={s.cardSub}>No messages yet. When the client sends 💬 Discuss from their WhatsApp group, it shows here.</Text>
                )}
                {(() => {
                  // A date pill at the top of each day, then that day's bubbles.
                  const out = [];
                  let lastDay = null;
                  for (const m of chat.messages || []) {
                    const d = chatDate(m.at);
                    const day = chatDayLabel(d);
                    if (day && day !== lastDay) {
                      out.push(
                        <View key={`chatday-${m.id}`} style={s.chatDayPill}>
                          <Text style={s.chatDayTxt}>{day}</Text>
                        </View>,
                      );
                      lastDay = day;
                    }
                    const team = m.side === 'team';
                    const reacts = m.deleted ? [] : (m.reactions || []);
                    out.push(
                      <View
                        key={`chat-${m.id}`}
                        onLayout={(e) => { chatRowY.current[m.id] = e.nativeEvent.layout.y; }}
                        style={[s.chatRow, team ? s.chatRowOut : s.chatRowIn, reacts.length > 0 && s.chatRowReacted]}
                      >
                      <Pressable
                        delayLongPress={220} onLongPress={() => openChatRowMenu(m)}
                        style={({ pressed }) => [s.chatBubble, team ? s.chatOut : s.chatIn,
                          chatFocus === m.id && s.chatFocus, pressed && { opacity: 0.85 }]}
                      >
                        <Text style={s.chatWho}>{team ? m.who : `${m.who} · client`}</Text>
                        {m.deleted ? (
                          <Text style={s.chatDeleted}>⊘ This message was deleted</Text>
                        ) : (
                        <>
                        {!!m.reply && (
                          <TouchableOpacity activeOpacity={0.7} onPress={() => onChatQuote(m.reply.id)}
                            style={[s.chatQuote, { borderLeftColor: m.reply.side === 'team' ? '#16A34A' : COLORS.primary }]}>
                            <Text style={s.chatQuoteWho} numberOfLines={1}>{m.reply.who}</Text>
                            <Text style={s.chatQuoteTxt} numberOfLines={2}>{m.reply.text}</Text>
                          </TouchableOpacity>
                        )}
                        {(m.files || []).map((f) => {
                          const busy = fileBusy === `chat-${f.id}`;
                          const meta = [f.name, f.size ? humanSize(f.size) : ''].filter(Boolean).join(' · ');
                          if (f.kind === 'image') {
                            const uri = chatMedia[f.id];
                            return (
                              <View key={`cf-${f.id}`} style={s.chatFile}>
                                <TouchableOpacity activeOpacity={0.85} onPress={() => onOpenChatFile(f)}>
                                  {uri ? (
                                    <Image source={{ uri }} style={s.chatThumb} resizeMode="cover" />
                                  ) : (
                                    <View style={[s.chatThumb, s.chatThumbWait]}><ActivityIndicator color={COLORS.primary} /></View>
                                  )}
                                </TouchableOpacity>
                                <Text style={s.chatFileMeta} numberOfLines={1}>{meta}</Text>
                              </View>
                            );
                          }
                          const isPlaying = f.kind === 'audio' && playing === f.url;
                          const label = f.kind === 'video' ? '▶ Play video'
                            : f.kind === 'audio' ? (isPlaying ? '⏸ Pause' : '▶ Play audio')
                              : `${CHAT_KIND_ICON[f.kind] || '📎'} Open`;
                          return (
                            <View key={`cf-${f.id}`} style={s.chatFile}>
                              <TouchableOpacity style={s.chatMediaRow} activeOpacity={0.7} disabled={busy}
                                onPress={() => onOpenChatFile(f)}>
                                {busy ? <ActivityIndicator size="small" color={COLORS.primary} />
                                  : <Text style={s.chatMediaIcon}>{CHAT_KIND_ICON[f.kind] || '📎'}</Text>}
                                <Text style={s.chatMediaTxt}>{label}</Text>
                              </TouchableOpacity>
                              <Text style={s.chatFileMeta} numberOfLines={1}>{meta}</Text>
                            </View>
                          );
                        })}
                        {!!m.body && (
                          <Text style={s.body}>
                            {m.body}
                            {!!m.edited && <Text style={s.chatEdited}>  edited</Text>}
                          </Text>
                        )}
                        </>
                        )}
                        <View style={s.chatMeta}>
                          <Text style={s.chatTime}>{chatHhmm(d) || localWhen(m.at)}</Text>
                          {/* ✓ saved · ✓✓ reached the client's group · blue ✓✓ the client
                              opened the chat · ⚠ WhatsApp refused it (tap to retry) */}
                          {team && !m.deleted && !!m.status && (
                            <Text onPress={m.status === 'failed' ? () => onChatRetry(m) : undefined}
                              style={[s.chatTick, m.status === 'seen' && { color: '#53BDEB' }, m.status === 'failed' && { color: '#DC2626' }]}>
                              {m.status === 'failed' ? ' ⚠' : m.status === 'pending' ? ' ✓' : ' ✓✓'}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                      {/* Reaction chips, overlapping the bubble's bottom edge on its
                          side. Tap one to add / take back your own. */}
                      {reacts.length > 0 && (
                        <View style={[s.chatReacts, team ? { right: 6 } : { left: 6 }]}>
                          {reacts.map((r) => (
                            <TouchableOpacity key={`${m.id}-${r.emoji}`} activeOpacity={0.7}
                              disabled={!chat.can_act} onPress={() => onChatAct(m, 'react', { emoji: r.emoji })}
                              style={[s.chatReact, r.mine && s.chatReactMine]}>
                              <Text style={s.chatReactTxt}>{r.emoji}{r.count > 1 ? ` ${r.count}` : ''}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                      </View>,
                    );
                  }
                  return out;
                })()}
                {chat.locked ? (
                  <Text style={[s.cardSub, { marginTop: 6 }]}>🔒 {chat.locked}</Text>
                ) : !chat.can_send ? (
                  <Text style={[s.cardSub, { marginTop: 6 }]}>This client has no WhatsApp group linked, so messages can't be sent.</Text>
                ) : (
                  <View>
                    {/* ↩ Replying to … / ✎ Editing message — the same banner; ✕ drops it. */}
                    {(!!chatReply || !!chatEdit) && (
                      <View style={s.chatReplyBar}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.chatQuoteWho} numberOfLines={1}>
                            {chatEdit ? '✎ Editing message' : `↩ Replying to ${chatReply.who}`}
                          </Text>
                          <Text style={s.chatQuoteTxt} numberOfLines={1}>{chatSnippet(chatEdit || chatReply)}</Text>
                        </View>
                        <TouchableOpacity onPress={() => (chatEdit ? cancelChatEdit() : setChatReply(null))}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Ionicons name="close" size={18} color={COLORS.faint} />
                        </TouchableOpacity>
                      </View>
                    )}
                    {chatFiles.length > 0 && (
                      <View style={s.chatChips}>
                        {chatFiles.map((f, i) => (
                          <View key={`${f.uri}-${i}`} style={s.chatChip}>
                            <Text style={s.chatChipTxt} numberOfLines={1}>
                              {CHAT_KIND_ICON[chatFileKind(f.mimeType)] || '📎'} {f.name}{f.size ? ` · ${humanSize(f.size)}` : ''}
                            </Text>
                            {!chatBusy && (
                              <TouchableOpacity onPress={() => setChatFiles((cur) => cur.filter((_, j) => j !== i))}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="close" size={15} color={COLORS.faint} />
                              </TouchableOpacity>
                            )}
                          </View>
                        ))}
                      </View>
                    )}
                    {chatPct !== null && (
                      <View style={{ marginTop: 6 }}>
                        <View style={s.barTrack}><View style={[s.barFill, { width: `${chatPct}%` }]} /></View>
                        <Text style={s.pctTxt}>Uploading… {chatPct}%</Text>
                      </View>
                    )}
                    <View style={s.chatFoot}>
                      <TouchableOpacity style={s.chatPin} onPress={openChatPin}
                        disabled={chatBusy || !!chatEdit || chatFiles.length >= CHAT_MAX_FILES}>
                        <Text style={{ fontSize: 18, opacity: chatBusy || chatEdit || chatFiles.length >= CHAT_MAX_FILES ? 0.4 : 1 }}>📎</Text>
                      </TouchableOpacity>
                      <TextInput
                        style={[s.oldInput, { flex: 1, minHeight: 42, textAlignVertical: 'top', paddingTop: 9 }]} multiline
                        value={chatText} onChangeText={setChatText}
                        placeholder={chatEdit ? 'Edit your message' : chatFiles.length ? 'Add a caption (optional)' : 'Type a message'}
                        placeholderTextColor={COLORS.faint}
                      />
                      <TouchableOpacity
                        style={[s.attDl, { height: 42 }, chatSendOff && s.btnOff]}
                        onPress={onSendChat} disabled={chatSendOff}>
                        {chatBusy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={15} color="#fff" />}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </Section>
              </View>
            )}

            {/* ── From the client (only when there is any) ───────────── */}
            {/* What the client attached when raising the task. Read-only: no
                edit / delete / select — and kept out of Attached Files,
                Documents and Progress History so it is never mistaken for the
                team's own work (nor counted as the progress summary). */}
            {clientProgress.length > 0 && (
              <Section icon="person-circle-outline" title={`📎 From the client (${clientProgress.length})`}>
                {clientProgress.map((p) => (
                  <View key={`client-${p.id}`} style={s.histRow}>
                    <View style={s.histTop}>
                      <Text style={s.histWho}>{p.employee_name || 'Client'}</Text>
                      <Text style={s.histWhen}>{p.create_date}</Text>
                    </View>
                    {!!(p.summary || '').trim() && <Text style={s.body}>{p.summary}</Text>}
                    {parseLinks(p.related_links).map((l, i) => (
                      <TouchableOpacity key={i} onPress={() => Linking.openURL(l).catch(() => flash('err', 'Could not open link'))}>
                        <Text style={s.linkTxt} numberOfLines={1}>🔗 {l}</Text>
                      </TouchableOpacity>
                    ))}
                    {entryFiles(p).map((f) => (
                      <View key={f.key} style={s.fileRow}>
                        <Ionicons name="document-text-outline" size={15} color={COLORS.primary} style={{ marginTop: 2 }} />
                        <View style={{ flex: 1, marginLeft: 8 }}>
                          <Text style={s.fileName} numberOfLines={1}>{f.file_name}</Text>
                        </View>
                        {fileBusy === f.key ? (
                          <ActivityIndicator size="small" color={COLORS.primary} />
                        ) : (
                          <>
                            <TouchableOpacity style={s.attView} onPress={() => onViewFile(f)}>
                              <Text style={s.attBtnTxt}>View</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[s.attDl, { marginLeft: 6 }]} onPress={() => onDownloadFile(f)}>
                              <Text style={s.attBtnTxt}>Download</Text>
                            </TouchableOpacity>
                          </>
                        )}
                      </View>
                    ))}
                  </View>
                ))}
              </Section>
            )}

            {/* ── Attached Files ─────────────────────────────────────── */}
            <Section icon="folder-open-outline" title="Attached Files"
              right={teamFiles.length > 1 ? <SortChip value={sortFiles} onChange={setSortFiles} /> : null}>
              {teamFiles.length === 0 ? <Empty text="No documents yet" /> : (
                sortItems(teamFiles, sortFiles, 'upload_date', 'file_name').map((f) => (
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
              right={teamFiles.length > 1 ? <SortChip value={sortDocs} onChange={setSortDocs} /> : null}>
              {teamFiles.length === 0 ? <Empty text="No documents yet" /> : (
                sortItems(teamFiles, sortDocs, 'upload_date', 'file_name').map((f) => (
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
                      {!!l.progress_id && !clientProgressIds.has(l.progress_id) && (
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
                {/* Only offered when there is something you could actually delete
                    — the row checkboxes are gated on the server's own can_edit,
                    so a list of other people's updates would give a Select button
                    that selects nothing. */}
                {teamProgress.some((p) => p.can_edit) ? (
                  <View style={s.bulkBar}>
                    {selMode ? (
                      <>
                        <TouchableOpacity onPress={() => { setSelMode(false); setSelIds([]); }}>
                          <Text style={s.bulkCancel}>Cancel</Text>
                        </TouchableOpacity>
                        <View style={{ flex: 1 }} />
                        <TouchableOpacity
                          onPress={() => {
                            const all = teamProgress.filter((p) => p.can_edit).map((p) => p.id);
                            setSelIds(selIds.length === all.length ? [] : all);
                          }}
                        >
                          <Text style={s.bulkLink}>
                            {selIds.length === teamProgress.filter((p) => p.can_edit).length
                              ? 'Select none' : 'Select all'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.bulkDelBtn, (!selIds.length || delBusy) && { opacity: 0.5 }]}
                          disabled={!selIds.length || delBusy}
                          onPress={() => setConfirmDel({ kind: 'bulk', id: 0, name: `${selIds.length} update${selIds.length === 1 ? '' : 's'}` })}
                        >
                          <Text style={s.bulkDelTxt}>Delete ({selIds.length})</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <View style={{ flex: 1 }} />
                        <TouchableOpacity onPress={() => { setSelMode(true); setSelIds([]); }}>
                          <Text style={s.bulkLink}>Select</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                ) : null}
                {teamProgress.length === 0 ? (
                  <Empty text="No progress updates yet. Submit your first update above." />
                ) : (
                  teamProgress.map((p) => (
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
                        {selMode && p.can_edit ? (
                          <TouchableOpacity
                            onPress={() => setSelIds((prev) => (prev.includes(p.id)
                              ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ marginRight: 8 }}
                          >
                            <Ionicons
                              name={selIds.includes(p.id) ? 'checkbox' : 'square-outline'}
                              size={18} color={selIds.includes(p.id) ? COLORS.primary : COLORS.faint}
                            />
                          </TouchableOpacity>
                        ) : null}
                        <Text style={s.histWho}>{p.employee_name || 'Someone'}</Text>
                        <Text style={s.histWhen}>{p.create_date}</Text>
                      </View>
                      <Text style={s.body}>{p.summary}</Text>
                      {parseLinks(p.related_links).map((l, i) => (
                        <TouchableOpacity key={i} onPress={() => Linking.openURL(l).catch(() => flash('err', 'Could not open link'))}>
                          <Text style={s.linkTxt} numberOfLines={1}>🔗 {l}</Text>
                        </TouchableOpacity>
                      ))}
                      {entryFiles(p).map((f) => (
                        <TouchableOpacity key={f.key} style={s.histFile}
                          onPress={() => onViewFile(f)} disabled={fileBusy === f.key}>
                          <Ionicons name="download-outline" size={13} color={COLORS.primary} />
                          <Text style={s.histFileTxt} numberOfLines={1}>{f.file_name}</Text>
                        </TouchableOpacity>
                      ))}
                      {/* Gated on the server's own answer (can_edit off the row),
                          never re-derived here — the record rules are what actually
                          decide, and a button offering what the route refuses is
                          worse than no button. Own entry, or manager/admin. */}
                      {p.can_edit ? (
                        <View style={s.histActions}>
                          <TouchableOpacity style={s.histAct} onPress={() => openProgressEdit(p)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="create-outline" size={13} color={COLORS.primary} />
                            <Text style={s.histActTxt}>Edit</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={s.histAct}
                            onPress={() => setConfirmDel({
                              kind: 'progress', id: p.id,
                              name: (p.summary || '').trim().slice(0, 80) || 'this update',
                            })}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Ionicons name="trash-outline" size={13} color={COLORS.red} />
                            <Text style={[s.histActTxt, { color: COLORS.red }]}>Delete</Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}
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
                  {confirmDel.kind === 'manual' ? 'Delete this manual?'
                    : confirmDel.kind === 'progress' ? 'Delete this update?'
                    : 'Delete this GitHub link?'}
                </Text>
                <Text style={s.cName} numberOfLines={2}>{confirmDel.name}</Text>
                <Text style={s.cMsg}>
                  {confirmDel.kind === 'manual'
                    ? 'The file and its description will be removed for everyone. This cannot be undone.'
                    : confirmDel.kind === 'progress'
                    ? 'The update, its links and any attached file will be removed for everyone. This cannot be undone.'
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

        {/* Edit an already-submitted update. Its own modal rather than re-using
            the Submit form: that form sits further up the page, and scrolling
            somebody away from the row they tapped to edit it is disorienting. */}
        <Modal visible={!!pgEdit} transparent animationType="fade" onRequestClose={() => setPgEdit(null)}>
          {!!pgEdit && (
            <View style={s.cWrap}>
              <View style={s.editCard}>
                <Text style={s.editTitle}>Edit update</Text>
                <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                  <Text style={s.label}>Progress Summary <Text style={s.req}>*</Text></Text>
                  <TextInput style={[s.input, s.textarea]} multiline
                    placeholder="Describe the work done, issues found, next steps…"
                    placeholderTextColor={COLORS.faint}
                    value={pgEdit.summary}
                    onChangeText={(v) => setPgEdit({ ...pgEdit, summary: v })} />

                  <Text style={s.label}>Related Links</Text>
                  <View style={s.linkRow}>
                    <TextInput style={[s.input, { flex: 1 }]} placeholder="https://github.com/… or https://drive.google.com/…"
                      placeholderTextColor={COLORS.faint} autoCapitalize="none" keyboardType="url"
                      value={pgEdit.linkInput}
                      onChangeText={(v) => setPgEdit({ ...pgEdit, linkInput: v })} />
                    <TouchableOpacity style={s.linkAdd} onPress={() => {
                      const url = normalizeUrl(pgEdit.linkInput);
                      if (!url) { flash('err', 'That does not look like a link — paste a full URL, e.g. https://drive.google.com/…'); return; }
                      if (pgEdit.links.includes(url)) { flash('err', 'That link is already added'); return; }
                      setPgEdit({ ...pgEdit, links: [...pgEdit.links, url], linkInput: '' });
                    }}>
                      <Ionicons name="add" size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                  {pgEdit.links.map((l, i) => (
                    <View key={`${l}-${i}`} style={s.linkChip}>
                      <Ionicons name="link" size={13} color={COLORS.primary} />
                      <Text style={s.linkChipTxt} numberOfLines={1}>{l}</Text>
                      <TouchableOpacity
                        onPress={() => setPgEdit({ ...pgEdit, links: pgEdit.links.filter((_, x) => x !== i) })}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={15} color={COLORS.faint} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <Text style={s.linkHint}>
                    A link left in the box is still included when you save.
                  </Text>

                  {/* Removing the file is its OWN decision: "leave it alone" and
                      "take it off" are different intents, and an absent field
                      cannot express the second. Replacing a file is a new update. */}
                  {pgEdit.fileName ? (
                    <TouchableOpacity style={s.clearFileRow} activeOpacity={0.8}
                      onPress={() => setPgEdit({ ...pgEdit, clearFile: !pgEdit.clearFile })}>
                      <Ionicons name={pgEdit.clearFile ? 'checkbox' : 'square-outline'} size={17}
                        color={pgEdit.clearFile ? COLORS.red : COLORS.muted} />
                      <Text style={s.clearFileTxt} numberOfLines={2}>Remove {pgEdit.fileName}</Text>
                    </TouchableOpacity>
                  ) : null}
                </ScrollView>
                <View style={s.cBtns}>
                  <TouchableOpacity style={s.ghostBtn} onPress={() => setPgEdit(null)} disabled={pgEditBusy}>
                    <Text style={s.ghostBtnTxt}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.primBtn, (!pgEdit.summary.trim() || pgEditBusy) && s.btnOff]}
                    onPress={saveProgressEdit} disabled={!pgEdit.summary.trim() || pgEditBusy}>
                    {pgEditBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primBtnTxt}>Save</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </Modal>

        {/* Rename / retype / move. Manager-only, matching the server's own gate —
            update_kpi_meta refuses anyone else, so offering it here would only
            produce a refusal. */}
        <Modal visible={!!metaEdit} transparent animationType="fade" onRequestClose={() => setMetaEdit(null)}>
          {!!metaEdit && (
            <View style={s.cWrap}>
              <View style={s.editCard}>
                <Text style={s.editTitle}>Edit task</Text>
                <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
                  <Text style={s.label}>Task name <Text style={s.req}>*</Text></Text>
                  <TextInput style={s.input} placeholder="What is this task?"
                    placeholderTextColor={COLORS.faint}
                    value={metaEdit.name}
                    onChangeText={(v) => setMetaEdit({ ...metaEdit, name: v })} />

                  {/* Changing this is not cosmetic: the server rewrites the name's
                      [Bug]/[Update] prefix and the REQ/UPD/BUG token in the task
                      reference to match. */}
                  <Text style={s.label}>Type</Text>
                  <View style={s.typeRow}>
                    {['requirement', 'update', 'bug'].map((k) => {
                      const on = metaEdit.type === k;
                      return (
                        <TouchableOpacity key={k}
                          style={[s.typeChip, on && { backgroundColor: KIND[k].bg, borderColor: KIND[k].fg }]}
                          onPress={() => setMetaEdit({ ...metaEdit, type: k })} activeOpacity={0.8}>
                          <Text style={[s.typeChipTxt, on && { color: KIND[k].fg, fontWeight: '900' }]}>
                            {KIND[k].label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={s.label}>KRA / Project</Text>
                  <TouchableOpacity style={s.select} onPress={() => setProjectPick(true)} activeOpacity={0.8}>
                    <Text style={s.selectTxt} numberOfLines={1}>
                      {metaEdit.kraLabel || 'Choose a project'}
                    </Text>
                    <Ionicons name="chevron-down" size={18} color={COLORS.muted} />
                  </TouchableOpacity>
                  <Text style={s.linkHint}>
                    Leave this alone to keep the task where it is. Moving it to another
                    client's project asks for confirmation first.
                  </Text>
                </ScrollView>
                <View style={s.cBtns}>
                  <TouchableOpacity style={s.ghostBtn} onPress={() => setMetaEdit(null)} disabled={metaBusy}>
                    <Text style={s.ghostBtnTxt}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.primBtn, (!metaEdit.name.trim() || metaBusy) && s.btnOff]}
                    onPress={() => saveMetaEdit(false)} disabled={!metaEdit.name.trim() || metaBusy}>
                    {metaBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primBtnTxt}>Save</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </Modal>

        {/* Project picker for the edit modal. A flat list of "Client `>` Project `>` Sub"
            paths rather than a tree: the paths are already unambiguous, and a
            collapsible tree inside a modal inside a modal is a lot of chrome for
            something picked once. */}
        <Modal visible={projectPick} transparent animationType="fade" onRequestClose={() => setProjectPick(false)}>
          <TouchableOpacity style={s.cWrap} activeOpacity={1} onPress={() => setProjectPick(false)}>
            <TouchableOpacity style={s.pickerSheet} activeOpacity={1}>
              <View style={s.pickerHead}>
                <Text style={s.editTitle}>Choose a project</Text>
                <TouchableOpacity onPress={() => setProjectPick(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={COLORS.muted} />
                </TouchableOpacity>
              </View>
              <FlatList
                data={projects}
                keyExtractor={(p) => String(p.id)}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <TouchableOpacity style={s.projRow} activeOpacity={0.7}
                    onPress={() => {
                      setMetaEdit((prev) => ({ ...prev, kraId: item.id, kraLabel: item.display }));
                      setProjectPick(false);
                    }}>
                    <Text style={s.projTxt} numberOfLines={2}>{item.display}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={<Text style={s.actEmpty}>Loading projects…</Text>}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

        {/* The cross-client confirmation. Names both clients, because "are you sure"
            without saying what changes is not a question anybody can answer. */}
        <Modal visible={!!clientMove} transparent animationType="fade" onRequestClose={() => setClientMove(null)}>
          {!!clientMove && (
            <View style={s.cWrap}>
              <View style={s.cCard}>
                <View style={s.cIcon}>
                  <Ionicons name="swap-horizontal" size={26} color={COLORS.amber} />
                </View>
                <Text style={s.cTitle}>Move to another client?</Text>
                <Text style={s.cName} numberOfLines={2}>
                  {clientMove.from} → {clientMove.to}
                </Text>
                <Text style={s.cMsg}>
                  This files the task under a different client. Everything reported for
                  either client changes with it.
                </Text>
                <View style={s.cBtns}>
                  <TouchableOpacity style={s.ghostBtn} onPress={() => setClientMove(null)} disabled={metaBusy}>
                    <Text style={s.ghostBtnTxt}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.primBtn, metaBusy && s.btnOff]}
                    onPress={() => saveMetaEdit(true)} disabled={metaBusy}>
                    {metaBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primBtnTxt}>Move it</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </Modal>

        {/* 💬 Long-pressed message: the action card. Quick reactions (or the full
            grid behind "+"), then Reply · Edit · Info · Delete — each only when
            the server allows it. Tap the dimmed scrim to close. */}
        <Modal visible={!!chatCard} transparent animationType="fade" onRequestClose={() => setChatCard(null)}>
          <Pressable style={s.chatCardBg} onPress={() => setChatCard(null)}>
            {!!chatCard?.m && (() => {
              const m = chatCard.m;
              const canAct = !!chat?.can_act;
              const rows = [];
              if (canAct && chat?.can_send && !chat?.locked) rows.push({ label: '↩  Reply', onPress: () => startChatReply(m) });
              if (canAct && m.can_edit) rows.push({ label: '✎  Edit', onPress: () => startChatEdit(m) });
              if (m.info) rows.push({ label: 'ⓘ  Info', onPress: () => openChatInfo(m) });
              if (canAct && m.can_delete) rows.push({ label: '🗑  Delete', red: true, onPress: () => onChatDelete(m) });
              return (
                <Pressable style={s.chatCard} onPress={() => {}}>
                  <Text style={s.chatCardWho} numberOfLines={1}>{m.who}</Text>
                  {!!chatSnippet(m) && <Text style={s.chatCardSnip} numberOfLines={2}>{chatSnippet(m)}</Text>}
                  {canAct && !chatCard.grid && (
                    <View style={s.chatQuickRow}>
                      {CHAT_QUICK_EMOJI.map((e) => (
                        <TouchableOpacity key={e} style={s.chatQuick} activeOpacity={0.6} onPress={() => onChatReact(m, e)}>
                          <Text style={s.chatQuickTxt}>{e}</Text>
                        </TouchableOpacity>
                      ))}
                      <TouchableOpacity style={[s.chatQuick, s.chatQuickMore]} activeOpacity={0.6}
                        onPress={() => setChatCard({ m, grid: true })}>
                        <Ionicons name="add" size={20} color={COLORS.navy} />
                      </TouchableOpacity>
                    </View>
                  )}
                  {canAct && chatCard.grid && (
                    <View>
                      <TouchableOpacity style={s.chatGridBack} activeOpacity={0.6} onPress={() => setChatCard({ m, grid: false })}>
                        <Ionicons name="arrow-back" size={16} color={COLORS.navy} />
                        <Text style={s.chatGridBackTxt}>Back</Text>
                      </TouchableOpacity>
                      <View style={s.chatGrid}>
                        {CHAT_ALL_EMOJI.map((e) => (
                          <TouchableOpacity key={e} style={s.chatGridCell} activeOpacity={0.6} onPress={() => onChatReact(m, e)}>
                            <Text style={s.chatQuickTxt}>{e}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  )}
                  {rows.length > 0 && !chatCard.grid && (
                    <View style={s.chatCardRows}>
                      {rows.map((o, i) => (
                        <TouchableOpacity key={o.label} activeOpacity={0.7} onPress={o.onPress}
                          style={[s.chatSheetOpt, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
                          <Text style={[s.chatSheetOptTxt, o.red && { color: '#DC2626' }]}>{o.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {!canAct && rows.length === 0 && (
                    <Text style={[s.cardSub, { marginTop: 8 }]}>Nothing to do with this message.</Text>
                  )}
                </Pressable>
              );
            })()}
          </Pressable>
        </Modal>

        {/* ⓘ Message info: when it was sent, reached the client's group, and was seen. */}
        <Modal visible={!!chatInfo} transparent animationType="fade" onRequestClose={() => setChatInfo(null)}>
          <Pressable style={s.chatCardBg} onPress={() => setChatInfo(null)}>
            {!!chatInfo && (
              <Pressable style={s.chatCard} onPress={() => {}}>
                <Text style={s.chatCardWho}>Message info</Text>
                {[
                  ['Sent', chatWhenFull(chatInfo.at)],
                  ['Delivered', chatWhenFull(chatInfo.info?.delivered_at)],
                  ['Seen', chatWhenFull(chatInfo.info?.seen_at)],
                ].map(([k, v]) => (
                  <View key={k} style={s.chatInfoRow}>
                    <Text style={s.chatInfoKey}>{k}</Text>
                    <Text style={s.chatInfoVal}>{v}</Text>
                  </View>
                ))}
                <TouchableOpacity style={[s.chatSheetOpt, { borderBottomWidth: 0, alignItems: 'center' }]} onPress={() => setChatInfo(null)}>
                  <Text style={[s.chatSheetOptTxt, { color: COLORS.primary }]}>Close</Text>
                </TouchableOpacity>
              </Pressable>
            )}
          </Pressable>
        </Modal>

        {/* 💬 Chat attach menu: 📎 Camera / Photos & videos / Audio. */}
        <Modal visible={!!chatSheet} transparent animationType="fade" onRequestClose={() => setChatSheet(null)}>
          <TouchableOpacity style={s.chatSheetBg} activeOpacity={1} onPress={() => setChatSheet(null)}>
            <View style={s.chatSheet}>
              {!!chatSheet?.title && <Text style={s.chatSheetTitle} numberOfLines={1}>{chatSheet.title}</Text>}
              {(chatSheet?.options || []).map((o) => (
                <TouchableOpacity key={o.label} style={s.chatSheetOpt} activeOpacity={0.7}
                  onPress={() => { setChatSheet(null); setTimeout(o.onPress, 250); }}>
                  <Text style={s.chatSheetOptTxt}>{o.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={[s.chatSheetOpt, { borderBottomWidth: 0 }]} onPress={() => setChatSheet(null)}>
                <Text style={[s.chatSheetOptTxt, { color: COLORS.faint }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
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

        {/* Add time to the estimate — the same component the board uses, so the
            required reason cannot be enforced one way here and another there.
            Staying on this screen afterwards is the right answer HERE, exactly as
            staying on the board is the right answer there. */}
        {/* Complete — one popup listing everything still missing (offering
            Partial Finish when there is a summary to send), or the final
            "submit for approval?" confirm when nothing is. */}
        <AppDialog
          visible={cmpDlg?.kind === 'missing'}
          tone="warn"
          title="Before completing, you still need:"
          message={(cmpDlg?.items || []).map((m) => `• ${m}`).join('\n')}
          cancelLabel="OK, I'll add them"
          confirmLabel="Partially completed instead"
          onConfirm={() => { setCmpDlg(null); setCmpPartial(true); }}
          onClose={() => setCmpDlg(null)}
        />
        <AppDialog
          visible={cmpDlg?.kind === 'partial'}
          tone="warn"
          title={`Send ${meta.external_ref || t?.name || 'this task'} as a partial finish?`}
          message={`The client is sent this summary:\n\n${cmpSummary.trim() || 'Your last update.'}`}
          confirmLabel="Yes, send"
          onConfirm={() => onComplete(true)}
          onClose={() => setCmpDlg(null)}
        />
        <AppDialog
          visible={cmpDlg?.kind === 'confirm'}
          tone="info"
          title={`Submit ${meta.external_ref || t?.name || 'this task'} for approval?`}
          message={(() => {
            const warns = completeWarnings(cmpRules, { filled: cmpFilled });
            return (warns.length ? `${warningText(warns)}\n\n` : '')
              + 'Your manager will review it and approve or send it back.';
          })()}
          confirmLabel="Submit"
          onConfirm={() => onComplete(false)}
          onClose={() => setCmpDlg(null)}
        />

        <AddTimeModal
          visible={addOpen}
          task={data?.task || task}
          onClose={() => setAddOpen(false)}
          onDone={async (msg) => {
            flash('ok', msg);
            await load(true);
            if (onChanged) onChanged();
          }}
        />

        {/* Activity — everything that happened to this task, newest day first.
            Days collapse so a long-running task does not open as a wall; the
            newest is expanded because it is the one being asked about. */}
        <Modal visible={actOpen} transparent animationType="fade" onRequestClose={() => setActOpen(false)}>
          <View style={s.actBackdrop}>
            <View style={s.actCard}>
              <View style={s.actHead}>
                <Text style={s.actTitle}>Activity</Text>
                <TouchableOpacity onPress={() => setActOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={COLORS.muted} />
                </TouchableOpacity>
              </View>
              {/* Which log. The narrower two each fetch their own window, so a
                  pause that scrolled out of the "all" slice is still reachable. */}
              <View style={s.actKindRow}>
                {ACTIVITY_KINDS.map((k) => (
                  <TouchableOpacity key={k.key} activeOpacity={0.85}
                    style={[s.actKindChip, actKind === k.key && s.actKindChipOn]}
                    onPress={() => chooseActKind(k.key)} disabled={actLoading}>
                    <Text style={[s.actKindTxt, actKind === k.key && s.actKindTxtOn]}>{k.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* Say when it is a slice. A capped list that looks complete is how
                  somebody concludes an event never happened. */}
              {actEffectiveTotal > actEffectiveRows.length ? (
                <Text style={s.actSlice}>
                  {actEffectiveTotal} entries — showing the most recent {actEffectiveRows.length}.
                </Text>
              ) : null}
              <ScrollView style={{ maxHeight: 420 }}>
                {actLoading ? (
                  <View style={{ paddingVertical: 24 }}>
                    <ActivityIndicator color={COLORS.primary} />
                  </View>
                ) : null}
                {actGroups.map((g, gi) => {
                  const open = actDays.has(g.day) || (gi === 0 && !actDays.size);
                  return (
                    <View key={g.day}>
                      <TouchableOpacity style={s.actDay} activeOpacity={0.8}
                        onPress={() => setActDays((prev) => {
                          const next = new Set(prev.size ? prev : [actGroups[0].day]);
                          next.has(g.day) ? next.delete(g.day) : next.add(g.day);
                          return next;
                        })}>
                        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={15} color={COLORS.muted} />
                        <Text style={s.actDayTxt}>{g.day}</Text>
                        <View style={s.actDayCount}><Text style={s.actDayCountTxt}>{g.rows.length}</Text></View>
                      </TouchableOpacity>
                      {open ? g.rows.map((e) => (
                        <View key={String(e.id)} style={s.actRow}>
                          <Text style={s.actTime}>{String(e.at || '').slice(11, 16)}</Text>
                          <View style={{ flex: 1 }}>
                            <Text style={s.actLabel}>{e.label || e.event}</Text>
                            {(() => {
                              const d = actDetail(e);
                              return d ? <Text style={s.actDetail}>{d}</Text> : null;
                            })()}
                            {!!e.actor && <Text style={s.actActor}>{e.actor}</Text>}
                          </View>
                        </View>
                      )) : null}
                    </View>
                  );
                })}
                {!actGroups.length && !actLoading ? <Text style={s.actEmpty}>Nothing recorded yet.</Text> : null}
              </ScrollView>
            </View>
          </View>
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

  // Estimate extension
  estExtend: { fontSize: 11.5, color: '#B45309', fontWeight: '700', marginTop: -4, marginBottom: 4, lineHeight: 16 },
  addTimeLink: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary, marginTop: 2, marginBottom: 6 },
  estActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  actLink: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted, marginTop: 2, marginBottom: 6 },
  // The estimate chain: original, then every extension with its running total.
  estChain: { marginTop: 2, marginBottom: 6, gap: 3 },
  estChainRow: { fontSize: 11.5, lineHeight: 17 },
  estChainOrig: { color: COLORS.muted, fontWeight: '700' },
  estChainAdd: { color: '#0891B2', fontWeight: '900' },
  estChainTo: { color: COLORS.ink, fontWeight: '800' },
  estChainWhy: { color: '#B45309', fontStyle: 'italic' },
  estChainWho: { color: COLORS.faint },
  // Activity popup
  actBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  actCard: { width: '100%', maxWidth: 460, backgroundColor: '#fff', borderRadius: 16, padding: 16 },
  actHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  actTitle: { fontSize: 16, fontWeight: '900', color: COLORS.ink },
  actSlice: { fontSize: 11.5, color: COLORS.muted, marginBottom: 8 },
  actDay: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 9, borderTopWidth: 1, borderTopColor: '#F1F4F9' },
  actDayTxt: { flex: 1, fontSize: 12.5, fontWeight: '900', color: COLORS.ink },
  actDayCount: { backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1 },
  actDayCountTxt: { fontSize: 10.5, fontWeight: '800', color: COLORS.muted },
  actRow: { flexDirection: 'row', gap: 10, paddingVertical: 5, paddingLeft: 22 },
  actTime: { width: 44, fontSize: 11, color: COLORS.faint, fontWeight: '700' },
  actLabel: { fontSize: 12, color: COLORS.ink, fontWeight: '700' },
  actActor: { fontSize: 11, color: COLORS.muted, marginTop: 1 },
  actEmpty: { fontSize: 12, color: COLORS.muted, paddingVertical: 12 },

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
  sendNew: { borderWidth: 1.5, borderColor: COLORS.primary, backgroundColor: '#F5F8FF' },
  sendNewTag: { backgroundColor: COLORS.primary, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  sendNewTagTxt: { fontSize: 10.5, fontWeight: '900', color: '#fff' },
  sendName: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy, marginBottom: 3 },
  sendFiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sendFile: { maxWidth: '100%' },
  sendFileTxt: { fontSize: 12, color: COLORS.ink, flexShrink: 1 },
  sendStatus: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginTop: 8 },
  sendReason: { fontSize: 12.5, color: COLORS.ink, marginTop: 2, lineHeight: 17 },
  // A row holds the bubble and its reaction chips; the chips hang over the
  // bubble's bottom edge, so a reacted row leaves them room underneath.
  chatRow: { maxWidth: '88%', marginBottom: 7 },
  chatRowIn: { alignSelf: 'flex-start' },
  chatRowOut: { alignSelf: 'flex-end' },
  chatRowReacted: { marginBottom: 20 },
  chatBubble: { borderRadius: 12, padding: 9 },
  chatIn: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E5E7EB' },
  chatOut: { backgroundColor: '#DCF8C6' },
  chatFocus: { borderWidth: 2, borderColor: '#F59E0B' },
  chatDeleted: { fontSize: 13, fontStyle: 'italic', color: COLORS.faint, lineHeight: 19 },
  chatEdited: { fontSize: 10.5, color: COLORS.faint },
  chatReacts: { position: 'absolute', bottom: -13, flexDirection: 'row', gap: 4 },
  chatReact: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E7EB',
    borderRadius: 11, paddingHorizontal: 6, paddingVertical: 2, shadowColor: '#000', shadowOpacity: 0.08,
    shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  chatReactMine: { borderColor: COLORS.primary, backgroundColor: '#EEF3FF' },
  chatReactTxt: { fontSize: 12, color: COLORS.navy, fontWeight: '800' },
  // The long-press action card and the ⓘ Info popup: centred over a dim scrim.
  chatCardBg: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  chatCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  chatCardWho: { fontSize: 13, fontWeight: '900', color: COLORS.navy },
  chatCardSnip: { fontSize: 12.5, color: COLORS.faint, marginTop: 2 },
  chatQuickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  chatQuick: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center' },
  chatQuickMore: { backgroundColor: '#E2E8F0' },
  chatQuickTxt: { fontSize: 21 },
  chatGridBack: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 10, paddingVertical: 4, paddingRight: 8 },
  chatGridBackTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy },
  chatGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, marginBottom: 6 },
  chatGridCell: { width: '12.5%', height: 40, alignItems: 'center', justifyContent: 'center' },
  chatCardRows: { marginTop: 8 },
  chatInfoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#EEF2F8' },
  chatInfoKey: { fontSize: 13, fontWeight: '800', color: COLORS.navy },
  chatInfoVal: { fontSize: 12.5, color: COLORS.ink },
  chatWho: { fontSize: 11.5, fontWeight: '900', color: COLORS.navy, marginBottom: 2 },
  chatTime: { fontSize: 10.5, color: COLORS.faint, marginTop: 3, alignSelf: 'flex-end' },
  chatMeta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end' },
  chatTick: { fontSize: 11, color: COLORS.faint, marginTop: 3, letterSpacing: -1.5 },
  chatFoot: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 6 },
  chatDayPill: { alignSelf: 'center', backgroundColor: '#E2E8F0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 6 },
  chatDayTxt: { fontSize: 11, fontWeight: '800', color: COLORS.navy },
  chatQuote: { backgroundColor: 'rgba(15,23,42,0.06)', borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, marginBottom: 5 },
  chatQuoteWho: { fontSize: 11.5, fontWeight: '900', color: COLORS.navy },
  chatQuoteTxt: { fontSize: 12, color: COLORS.ink, marginTop: 1 },
  chatFile: { marginBottom: 5 },
  chatThumb: { width: 200, height: 150, borderRadius: 8, backgroundColor: '#E5E7EB' },
  chatThumbWait: { alignItems: 'center', justifyContent: 'center' },
  chatFileMeta: { fontSize: 10.5, color: COLORS.faint, marginTop: 2, maxWidth: 220 },
  chatMediaRow: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(15,23,42,0.06)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, minWidth: 160 },
  chatMediaIcon: { fontSize: 16 },
  chatMediaTxt: { fontSize: 13, fontWeight: '800', color: COLORS.navy },
  chatReplyBar: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F1F5F9', borderLeftWidth: 3, borderLeftColor: COLORS.primary, borderRadius: 8, padding: 8, marginTop: 6 },
  chatChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chatChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EEF3FF', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, maxWidth: '100%' },
  chatChipTxt: { fontSize: 12, color: COLORS.ink, flexShrink: 1 },
  chatPin: { width: 40, height: 42, borderRadius: 9, backgroundColor: '#EEF2F8', alignItems: 'center', justifyContent: 'center' },
  chatSheetBg: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  chatSheet: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  chatSheetTitle: { fontSize: 13, fontWeight: '900', color: COLORS.faint, marginBottom: 4 },
  chatSheetOpt: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF2F8' },
  chatSheetOptTxt: { fontSize: 15.5, fontWeight: '700', color: COLORS.navy },

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
  // 🗄️ From the old system card
  oldBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  oldBadge: { backgroundColor: COLORS.amberBg, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4 },
  oldBadgeOk: { backgroundColor: COLORS.greenBg },
  oldBadgeWait: { backgroundColor: '#FFF7ED' },
  oldBadgeTxt: { fontSize: 11.5, fontWeight: '800', color: '#92400E' },
  oldLbl: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted, marginTop: 10, marginBottom: 4 },
  oldPending: { color: COLORS.amber, fontStyle: 'italic' },
  oldInput: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 12, minHeight: 44, fontSize: 14, color: COLORS.ink,
  },
  oldErr: { fontSize: 12.5, color: COLORS.red, fontWeight: '600', marginBottom: 8 },
  oldBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },

  // Edit / Delete on a progress-history row, and the edit modal they open.
  // A manual's 2nd..Nth document, listed under its own entry.
  // Tabular figures so the total does not jitter as files are added and removed.
  fileTotal: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted, marginTop: 8, fontVariant: ['tabular-nums'] },

  useMainBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  useMainTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },

  metaEditBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaEditTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary },
  typeRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
  typeChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff' },
  typeChipTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, height: 44, backgroundColor: '#fff' },
  selectTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  pickerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  pickerSheet: { width: '100%', maxWidth: 460, maxHeight: '75%', backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  projRow: { paddingHorizontal: 18, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  projTxt: { fontSize: 13.5, color: COLORS.ink, fontWeight: '600' },

  extraFile: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginLeft: 24, paddingHorizontal: 9, paddingVertical: 6, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, backgroundColor: '#fff' },
  extraFileTxt: { flex: 1, fontSize: 11.5, fontWeight: '700', color: COLORS.ink },

  histActions: { flexDirection: 'row', gap: 14, marginTop: 8 },
  histAct: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  bulkBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8 },
  bulkLink: { fontSize: 12.5, fontWeight: '800', color: COLORS.primary },
  bulkCancel: { fontSize: 12.5, fontWeight: '800', color: COLORS.muted },
  bulkDelBtn: { backgroundColor: COLORS.red, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  bulkDelTxt: { fontSize: 12, fontWeight: '800', color: '#fff' },
  histActTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },
  // Wider and left-aligned where cCard is a narrow centred confirm — this one
  // holds a form, not a sentence.
  editCard: { width: '100%', maxWidth: 460, backgroundColor: '#fff', borderRadius: 18, padding: 18 },
  editTitle: { fontSize: 16, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  clearFileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  clearFileTxt: { flex: 1, fontSize: 12.5, fontWeight: '700', color: COLORS.muted },

  // Which activity log is on screen.
  actKindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  actKindChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: '#EEF2F8' },
  actKindChipOn: { backgroundColor: COLORS.primary },
  actKindTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.muted },
  actKindTxtOn: { color: '#fff' },
  actDetail: { fontSize: 11.5, color: COLORS.ink, marginTop: 2 },

  warnBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: '#FEF3C7', borderRadius: 9, padding: 10, marginBottom: 10, marginTop: 4 },
  warnTxt: { flex: 1, fontSize: 12.5, color: '#92400E', fontWeight: '700', lineHeight: 17 },
  warnBoxSoft: { backgroundColor: '#FEFCE8' },
  warnTxtSoft: { color: '#A16207', fontWeight: '600' },
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
