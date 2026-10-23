// TASK RELATED DOCUMENTS — every task you are on, and what is attached to it.
//
// The web has had this screen all along; the app had no equivalent, so a
// developer could only reach a task's files by opening that one task's detail.
// This is the same two endpoints the web uses, so the two stay in step:
//   /task_documents/list     — your tasks + counts
//   /task_documents/details  — one task's documents, grouped
//
// Both are scoped server-side (the list ORs over the stored contributor fields,
// the detail runs _may_view_kpi_details), so there is no filtering to redo here.
//
// Files open through the same base64 routes the task detail already uses, rather
// than a URL: the app has no session cookie for /web/content, so a direct link
// would 404 for everyone.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, TextInput, Linking, Modal, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchTaskDocuments, fetchTaskDocumentDetails } from '../services/taskDocuments';
import { fetchProgressFile, fetchManualFile } from '../services/kpiActions';
import KpiTaskDetail from './KpiTaskDetail';
import { createLogger } from '../api/logger';
import * as H from '../utils/haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

const log = createLogger('TaskDocuments');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// One row per document kind, so a task with only GitHub links still reads as
// "has something" rather than looking empty.
const KINDS = [
  { key: 'doc_count', label: 'Files', icon: 'file-document-outline', color: '#2563EB' },
  { key: 'link_count', label: 'Links', icon: 'link-variant', color: '#0891B2' },
  { key: 'github_count', label: 'GitHub', icon: 'github', color: '#111827' },
  { key: 'manual_count', label: 'Manuals', icon: 'book-open-variant', color: '#7C3AED' },
  { key: 'task_doc_count', label: 'Docs', icon: 'folder-outline', color: '#EA580C' },
];

function CountChips({ task }) {
  const shown = KINDS.filter((k) => (task[k.key] || 0) > 0);
  if (!shown.length) {
    return <Text style={s.noneTxt}>No documents yet</Text>;
  }
  return (
    <View style={s.chipRow}>
      {shown.map((k) => (
        <View key={k.key} style={s.chip}>
          <MaterialCommunityIcons name={k.icon} size={13} color={k.color} />
          <Text style={[s.chipTxt, { color: k.color }]}>{task[k.key]} {k.label}</Text>
        </View>
      ))}
    </View>
  );
}

function DocLine({ icon, color, title, subtitle, onPress }) {
  return (
    <TouchableOpacity
      style={s.docLine}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
      onPress={onPress}
    >
      <MaterialCommunityIcons name={icon} size={17} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={s.docTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={s.docSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {onPress ? <Ionicons name="open-outline" size={15} color={COLORS.faint} /> : null}
    </TouchableOpacity>
  );
}

function TaskRow({ task, expanded, onToggle, onOpenTask, details, detailsBusy }) {
  const docs = details?.documents || {};
  const openLink = (url) => { if (url) Linking.openURL(url).catch(() => {}); };

  // Open an attached file or a manual.
  //
  // The route hands back view_url / download_url, but those are http endpoints
  // that rely on a session cookie this app does not carry — following them would
  // get a login page. The base64 siblings already exist and are already used by
  // KPI Details; this screen simply never imported them, so every file row here
  // was inert while the header comment claimed otherwise.
  const openDoc = async (id, kind, fallbackName) => {
    H.tap();
    try {
      const res = await (kind === 'manual' ? fetchManualFile(id) : fetchProgressFile(id));
      if (!res?.status || !res.data_b64) return;
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      // Names arrive URL-encoded and can carry separators — decode, then keep
      // only the basename so the write cannot wander out of the cache directory.
      let name = res.file_name || fallbackName || 'file';
      try { name = decodeURIComponent(name); } catch (_) {}
      name = name.split(/[\\/]/).pop() || 'file';
      const uri = `${dir}${Date.now()}_${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data_b64, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: res.mimetype || undefined, dialogTitle: name });
      }
    } catch (e) {
      log.warn('open doc failed', e?.message);
    }
  };
  const openProgressFile = (f) => openDoc(f.id, 'progress', f.file_name);
  const openManualFile = (m) => openDoc(m.id, 'manual', m.file_name);

  return (
    <View style={s.card}>
      <TouchableOpacity style={s.cardHead} activeOpacity={0.8} onPress={onToggle}>
        <View style={{ flex: 1 }}>
          <View style={s.refRow}>
            {task.external_ref ? <Text style={s.ref}>{task.external_ref}</Text> : null}
            <Text style={s.prio}>{(task.priority || 'regular').toUpperCase()}</Text>
          </View>
          <Text style={s.name} numberOfLines={2}>{task.name}</Text>
          <Text style={s.assignee} numberOfLines={1}>
            <Ionicons name="person-outline" size={11} color={COLORS.muted} /> {task.assignee || 'Unassigned'}
          </Text>
          <CountChips task={task} />
          {/* Opens the full task. A NESTED touchable inside the row's own
              touchable, so it needs its own hit area — otherwise the press falls
              through to the accordion. Same nesting the board's list row uses
              for its name link. */}
          <TouchableOpacity
            style={s.viewBtn}
            activeOpacity={0.7}
            onPress={onOpenTask}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Ionicons name="open-outline" size={13} color={COLORS.primary} />
            <Text style={s.viewBtnTxt}>View task</Text>
          </TouchableOpacity>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={20} color={COLORS.muted}
        />
      </TouchableOpacity>

      {expanded ? (
        <View style={s.cardBody}>
          {detailsBusy ? (
            <View style={s.bodyCenter}><ActivityIndicator color={COLORS.primary} /></View>
          ) : !details ? (
            <Text style={s.noneTxt}>Could not load this task's documents.</Text>
          ) : (
            <>
              {/* Every field below is named as the route names it. They were not:
                  files looked for employee_name/create_date, manuals for
                  uploader_name, github for repo_name/url, task docs for label/name
                  — none of which the server sends. Nothing threw, so the screen
                  looked populated while saying almost nothing: file subtitles were
                  blank, every repo read "Repository", and every task document read
                  "Document" instead of Requirement or Signed Certificate. */}
              {(docs.files || []).length ? (
                <Text style={s.sectionTxt}>Attached Files ({docs.files.length})</Text>
              ) : null}
              {(docs.files || []).map((f) => (
                <DocLine
                  key={`f${f.id}`} icon="file-document-outline" color="#2563EB"
                  title={f.file_name || 'File'}
                  subtitle={[f.uploaded_by, f.upload_date].filter(Boolean).join(' · ')}
                  onPress={() => openProgressFile(f)}
                />
              ))}
              {(docs.manuals || []).length ? (
                <Text style={s.sectionTxt}>User Manuals ({docs.manuals.length})</Text>
              ) : null}
              {(docs.manuals || []).map((m) => (
                <DocLine
                  key={`m${m.id}`} icon="book-open-variant" color="#7C3AED"
                  title={m.file_name || 'Manual'}
                  subtitle={[m.description, m.uploaded_by, m.upload_date].filter(Boolean).join(' · ')}
                  onPress={() => openManualFile(m)}
                />
              ))}
              {(docs.github || []).length ? (
                <Text style={s.sectionTxt}>GitHub Repositories ({docs.github.length})</Text>
              ) : null}
              {(docs.github || []).map((g) => (
                <DocLine
                  key={`g${g.id}`} icon="github" color="#111827"
                  title={g.github_url || 'Repository'}
                  subtitle={[g.branch_name ? `Branch: ${g.branch_name}` : '', g.uploaded_by, g.upload_date].filter(Boolean).join(' · ')}
                  onPress={g.github_url ? () => openLink(g.github_url) : undefined}
                />
              ))}
              {(docs.links || []).length ? (
                <Text style={s.sectionTxt}>Links ({docs.links.length})</Text>
              ) : null}
              {(docs.links || []).map((l, i) => (
                <DocLine
                  key={`l${i}`} icon="link-variant" color="#0891B2"
                  title={l.url || 'Link'}
                  subtitle={[l.kind, l.added_by, l.added_date].filter(Boolean).join(' · ')}
                  onPress={l.url ? () => openLink(l.url) : undefined}
                />
              ))}
              {(docs.task_docs || []).length ? (
                <Text style={s.sectionTxt}>Task Documents ({docs.task_docs.length})</Text>
              ) : null}
              {/* No onPress: these come from /kpi_completion_cert/download_doc,
                  which is an http route relying on a session cookie the app does
                  not carry, and there is no base64 sibling. Better an inert row
                  that names the document than a button that cannot work. */}
              {(docs.task_docs || []).map((d, i) => (
                <DocLine
                  key={`t${i}`} icon="folder-outline" color="#EA580C"
                  title={d.kind || 'Document'}
                  subtitle={[d.file_name, d.note].filter(Boolean).join(' · ')}
                />
              ))}
              {!(docs.files || []).length && !(docs.manuals || []).length
                && !(docs.github || []).length && !(docs.links || []).length
                && !(docs.task_docs || []).length ? (
                  <Text style={s.noneTxt}>Nothing attached to this task yet.</Text>
                ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

export default function TaskDocuments({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [isMock, setIsMock] = useState(false);
  const [query, setQuery] = useState('');
  // Who to show. The list route has always returned `assignees[]` and accepted an
  // `assignee_id`, and services/taskDocuments.js has always passed it through —
  // the screen simply never offered the control, so an admin could see everyone's
  // documents in one undivided list and nobody's in particular.
  const [assignees, setAssignees] = useState([]);
  const [assigneeId, setAssigneeId] = useState(null);
  const [pickAssignee, setPickAssignee] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({});     // taskId -> payload
  const [detailsBusy, setDetailsBusy] = useState(null);
  // The full task screen, rendered in place rather than routed through App.js —
  // the same thing KpiActionBoard does. Keeping it local means Back returns to
  // this list with its scroll position and open row intact.
  const [detailTask, setDetailTask] = useState(null);

  const load = useCallback(async (who = assigneeId) => {
    try {
      const res = await fetchTaskDocuments(who || undefined);
      if (res && res.status === false) {
        setError(res.message || 'Could not load your task documents.');
        return;
      }
      setTasks(res.tasks || []);
      // Only refresh the dropdown from an UNFILTERED read. Narrowing to one
      // developer narrows this list too, and rebuilding it from that would leave
      // you unable to pick anyone else.
      if (!who && res.assignees) setAssignees(res.assignees);
      setIsMock(!!res.isMock);
      setError(null);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load your task documents.');
    }
  }, [assigneeId]);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  const chooseAssignee = useCallback(async (id) => {
    H.select();
    setPickAssignee(false);
    setAssigneeId(id);
    setOpenId(null);          // the open row belongs to the old list
    setLoading(true);
    await load(id);
    setLoading(false);
  }, [load]);
  const assigneeName = assigneeId
    ? (assignees.find((a) => a.id === assigneeId)?.name || 'Selected developer')
    : 'All assignees';

  // Fetch a task's documents the first time it is opened, then keep them.
  const toggle = useCallback(async (task) => {
    H.select();
    if (openId === task.id) { setOpenId(null); return; }
    setOpenId(task.id);
    if (details[task.id]) return;
    setDetailsBusy(task.id);
    try {
      const res = await fetchTaskDocumentDetails(task.id);
      setDetails((d) => ({ ...d, [task.id]: res && res.status !== false ? res : null }));
    } catch (e) {
      log.warn('details failed', e?.message);
      setDetails((d) => ({ ...d, [task.id]: null }));
    } finally {
      setDetailsBusy(null);
    }
  }, [openId, details]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) =>
      String(t.name || '').toLowerCase().includes(q)
      || String(t.external_ref || '').toLowerCase().includes(q)
      || String(t.assignee || '').toLowerCase().includes(q));
  }, [tasks, query]);

  // After every hook, so the hook order never changes between renders.
  if (detailTask) {
    return (
      <KpiTaskDetail
        task={detailTask}
        onBack={() => setDetailTask(null)}
        onChanged={load}
      />
    );
  }

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>Task Documents</Text>
        <TouchableOpacity onPress={load} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server for real documents</Text>
        </View>
      )}

      <View style={s.searchWrap}>
        <Ionicons name="search" size={16} color={COLORS.muted} />
        <TextInput
          style={s.searchInput}
          placeholder="Search by ref, name or developer…"
          placeholderTextColor={COLORS.faint}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={COLORS.faint} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Whose documents these are, and how many of them you are looking at. The
          count matters once a filter exists: without it a narrowed list and a
          short one are indistinguishable. */}
      {assignees.length ? (
        <View style={s.filterRow}>
          <TouchableOpacity
            style={[s.filterPill, assigneeId && s.filterPillOn]}
            onPress={() => { H.tap(); setPickAssignee(true); }}
            activeOpacity={0.85}
          >
            <Ionicons name="person-outline" size={13} color={assigneeId ? '#fff' : COLORS.primary} />
            <Text style={[s.filterTxt, assigneeId && s.filterTxtOn]} numberOfLines={1}>{assigneeName}</Text>
            <Ionicons name="chevron-down" size={13} color={assigneeId ? '#fff' : COLORS.primary} />
          </TouchableOpacity>
          {assigneeId ? (
            <TouchableOpacity onPress={() => chooseAssignee(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.clearTxt}>Clear</Text>
            </TouchableOpacity>
          ) : null}
          <Text style={s.countTxt}>Showing {shown.length} of {tasks.length} task{tasks.length === 1 ? '' : 's'}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={38} color={COLORS.red} />
          <Text style={s.errTxt}>{error}</Text>
          <TouchableOpacity onPress={load} style={s.retry}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : shown.length === 0 ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="file-search-outline" size={44} color={COLORS.faint} />
          <Text style={s.empty}>
            {query ? `Nothing matches "${query.trim()}".` : 'No tasks assigned to you yet.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(t) => String(t.id)}
          renderItem={({ item }) => (
            <TaskRow
              task={item}
              expanded={openId === item.id}
              onToggle={() => toggle(item)}
              onOpenTask={() => { H.tap(); setDetailTask(item); }}
              details={details[item.id]}
              detailsBusy={detailsBusy === item.id}
            />
          )}
          contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onScroll={(e) => H.scrollTick(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
        />
      )}

      {/* Assignee picker. "All assignees" leads, because clearing a filter should
          be the easiest thing in the list, not something to hunt for. */}
      <Modal visible={pickAssignee} transparent animationType="fade" onRequestClose={() => setPickAssignee(false)}>
        <TouchableOpacity style={s.pickBackdrop} activeOpacity={1} onPress={() => setPickAssignee(false)}>
          <TouchableOpacity style={s.pickSheet} activeOpacity={1}>
            <View style={s.pickHead}>
              <Text style={s.pickTitle}>Assignee</Text>
              <TouchableOpacity onPress={() => setPickAssignee(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={COLORS.muted} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={[{ id: null, name: 'All assignees' }, ...assignees]}
              keyExtractor={(a) => String(a.id ?? 'all')}
              renderItem={({ item }) => {
                const on = (item.id ?? null) === assigneeId;
                return (
                  <TouchableOpacity style={[s.pickRow, on && s.pickRowOn]} activeOpacity={0.8}
                    onPress={() => chooseAssignee(item.id ?? null)}>
                    <Text style={s.pickRowTxt}>{item.name}</Text>
                    {on ? <Text style={s.pickTick}>✓</Text> : null}
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
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: TOP, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '800', color: COLORS.navy },

  // Assignee filter + result count.
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 8 },
  filterPill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: COLORS.primary, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 5, maxWidth: 220 },
  filterPillOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterTxt: { fontSize: 12, fontWeight: '800', color: COLORS.primary, flexShrink: 1 },
  filterTxtOn: { color: '#fff' },
  clearTxt: { fontSize: 12, fontWeight: '800', color: COLORS.muted, textDecorationLine: 'underline' },
  countTxt: { flex: 1, textAlign: 'right', fontSize: 11.5, color: COLORS.muted, fontWeight: '600' },
  pickBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  pickSheet: { width: '100%', maxWidth: 380, maxHeight: '70%', backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden' },
  pickHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  pickTitle: { fontSize: 15, fontWeight: '900', color: COLORS.navy },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#F1F4F9' },
  pickRowOn: { backgroundColor: '#F0F5FF' },
  pickRowTxt: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  pickTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },
  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: 12, marginHorizontal: 14, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 9, ...SHADOW,
  },
  searchInput: { flex: 1, fontSize: 13.5, color: COLORS.ink, padding: 0 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  errTxt: { color: COLORS.red, textAlign: 'center', fontSize: 13.5 },
  retry: { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },
  retryTxt: { color: '#fff', fontWeight: '800' },
  empty: { color: COLORS.muted, fontSize: 14, textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, ...SHADOW },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 13 },
  refRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  ref: { fontSize: 12, fontWeight: '900', color: COLORS.primary },
  prio: { fontSize: 10, fontWeight: '800', color: COLORS.muted },
  name: { fontSize: 14.5, fontWeight: '700', color: COLORS.navy, lineHeight: 19 },
  assignee: { fontSize: 11.5, color: COLORS.muted, marginTop: 3 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3,
  },
  chipTxt: { fontSize: 11, fontWeight: '800' },
  viewBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    marginTop: 8, paddingVertical: 4, paddingHorizontal: 9,
    borderRadius: 8, borderWidth: 1, borderColor: COLORS.primary,
  },
  viewBtnTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },
  noneTxt: { fontSize: 12, color: COLORS.faint, marginTop: 6, fontStyle: 'italic' },
  // Counted section headings, as the web has them. Without these the five kinds
  // ran together as one undifferentiated stack with only the icon colour to tell
  // a manual from a repo.
  sectionTxt: {
    fontSize: 10.5, fontWeight: '900', color: COLORS.muted, letterSpacing: 0.4,
    textTransform: 'uppercase', marginTop: 10, marginBottom: 2,
  },

  cardBody: { borderTopWidth: 1, borderTopColor: COLORS.line, paddingHorizontal: 13, paddingVertical: 6 },
  bodyCenter: { paddingVertical: 16, alignItems: 'center' },
  docLine: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9 },
  docTitle: { fontSize: 13, fontWeight: '600', color: COLORS.ink },
  docSub: { fontSize: 11, color: COLORS.muted, marginTop: 1 },
});
