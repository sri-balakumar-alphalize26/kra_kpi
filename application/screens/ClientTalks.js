// CLIENT TALKS — 💬 Discussions · 📅 Meetings · ❓ Questions. Mobile port of the
// web's Client Talks pages (web/components/talks/*), over the same routes
// (controllers/kpi_talks_api.py, wrapped in services/talks.js).
//
//   Discussions — every task chat, waiting first. Tap one and its whole history
//                 opens: by date (each date closed until tapped), then in
//                 coloured talks — a new talk after an hour of quiet.
//   Meetings    — every meeting by date; tap a card for attendance, summary,
//                 action items and transcript; 🎥 Join opens the room as ME.
//   Questions   — developer questions, meeting requests and client Discuss
//                 questions, and who they are with now; grouped by date here
//                 (the web shows one table, which does not fit a phone).
//
// No gate of its own: every route is scoped server-side (admins everything,
// others only what they are on), and a refusal arrives as {status:false} whose
// message is shown as-is.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Modal, Image,
  ActivityIndicator, RefreshControl, Platform, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import * as T from '../services/talks';
import { joinMeeting, STATES } from '../services/meetings';
import { fetchChatFile } from '../services/kpiActions';

const log = createLogger('ClientTalks');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

const TABS = [
  { key: 'discussions', label: '💬 Discussions' },
  { key: 'meetings', label: '📅 Meetings' },
  { key: 'questions', label: '❓ Questions' },
];

// Meeting state → chip colours (the web's Lozenge tones).
const TONE = {
  paused: { bg: '#FEF3C7', fg: '#B45309' },
  review: { bg: '#DBEAFE', fg: '#1D4ED8' },
  progress: { bg: '#DCFCE7', fg: '#15803D' },
  done: { bg: '#E0E7FF', fg: '#4338CA' },
  neutral: { bg: '#F1F5F9', fg: '#475569' },
};
const toneOf = (state) => TONE[(STATES[state] || ['neutral'])[0]] || TONE.neutral;

// A question's `at` is UTC 'YYYY-MM-DD HH:MM:SS' → its local day key + label.
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function localDay(ts) {
  const d = ts ? new Date(String(ts).replace(' ', 'T') + 'Z') : null;
  if (!d || isNaN(d)) return { key: '', label: 'Unknown date' };
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { key, label: `${DAY[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MON[d.getMonth()]}` };
}

export default function ClientTalks({ onBack, initialTab, onOpenTask }) {
  const [tab, setTab] = useState(TABS.some((t) => t.key === initialTab) ? initialTab : 'discussions');
  // 📌 Task-oriented / 🌐 General — shared by Discussions and Meetings, as on the web.
  const [half, setHalf] = useState('task');
  const [discFilter, setDiscFilter] = useState('all');      // waiting | all
  const [meetFilter, setMeetFilter] = useState('all');      // upcoming | past | all
  const [qFilter, setQFilter] = useState('open');           // open | answered | all
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');

  const [data, setData] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [thread, setThread] = useState(null);       // the open chat (Discussions)
  const [threadBusy, setThreadBusy] = useState(false);
  const [banner, setBanner] = useState('');

  const flash = (text) => { setBanner(text); setTimeout(() => setBanner(''), 3500); };

  const load = useCallback(async () => {
    setError('');
    try {
      let res;
      if (tab === 'discussions') res = await T.fetchDiscussions(half, discFilter, search);
      else if (tab === 'meetings') res = await T.fetchTalkMeetings(half, meetFilter, search);
      else res = await T.fetchQuestions(qFilter, search);
      setIsMock(!!res.isMock);
      setData(res);
    } catch (e) {
      log.warn('load failed', e?.message);
      setError(e?.message || 'Could not load.');
      setData((d) => d || { rows: [], days: [], counts: {} });
    } finally {
      setRefreshing(false);
    }
  }, [tab, half, discFilter, meetFilter, qFilter, search]);

  useEffect(() => { setData(null); load(); }, [load]);

  const switchTab = (k) => { if (k !== tab) { setTab(k); setData(null); } };
  const submitSearch = () => { if (draft !== search) setSearch(draft); };

  const openThread = async (row) => {
    setThread({ ...row, days: [] });
    setThreadBusy(true);
    try {
      setThread(await T.fetchThread(row.kpi_id));
    } catch (e) {
      setThread(null);
      flash(e?.message || 'Could not load the chat.');
    } finally {
      setThreadBusy(false);
    }
  };

  const counts = data?.counts || {};
  const waitingCount = (counts.waiting_task || 0) + (counts.waiting_general || 0);

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <View style={s.hTitleWrap}>
          <Text style={s.hTitle} numberOfLines={1}>Client Talks</Text>
        </View>
        <TouchableOpacity onPress={() => { setRefreshing(true); load(); }} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.primary} />
            : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      </View>

      {/* Discussions · Meetings · Questions */}
      <View style={s.tabs}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <TouchableOpacity key={t.key} style={[s.tab, on && s.tabOn]} onPress={() => switchTab(t.key)} activeOpacity={0.85}>
              <Text style={[s.tabTxt, on && s.tabTxtOn]} numberOfLines={1}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline — connect to a server to see client talks</Text>
        </View>
      )}
      {!!banner && (
        <TouchableOpacity style={s.errBar} onPress={() => setBanner('')} activeOpacity={0.8}>
          <Ionicons name="alert-circle-outline" size={14} color="#B91C1C" />
          <Text style={s.errTxt}>{banner}  ✕</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: BOTTOM_PAD }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} colors={[COLORS.primary]} />}
      >
        {/* Filters: half (task / general), the tab's own filter, and search */}
        {tab !== 'questions' && (
          <View style={s.pillRow}>
            <Pill on={half === 'task'} onPress={() => setHalf('task')}
              label={`📌 Task-oriented${counts.task ? ` (${counts.task})` : ''}`} />
            <Pill on={half === 'general'} onPress={() => setHalf('general')}
              label={`🌐 General${counts.general ? ` (${counts.general})` : ''}`} />
          </View>
        )}
        <View style={s.pillRow}>
          {tab === 'discussions' && (
            <>
              <Pill small on={discFilter === 'waiting'} onPress={() => setDiscFilter('waiting')}
                label={`Waiting${waitingCount ? ` (${waitingCount})` : ''}`} danger={waitingCount > 0} />
              <Pill small on={discFilter === 'all'} onPress={() => setDiscFilter('all')} label="All" />
            </>
          )}
          {tab === 'meetings' && [['upcoming', `Upcoming${counts.upcoming ? ` (${counts.upcoming})` : ''}`], ['past', 'Past'], ['all', 'All']].map(([k, l]) => (
            <Pill key={k} small on={meetFilter === k} onPress={() => setMeetFilter(k)} label={l} />
          ))}
          {tab === 'questions' && [['open', `Open${counts.open ? ` (${counts.open})` : ''}`], ['answered', 'Answered'], ['all', 'All']].map(([k, l]) => (
            <Pill key={k} small on={qFilter === k} onPress={() => setQFilter(k)} label={l} />
          ))}
        </View>
        <View style={s.searchBox}>
          <Ionicons name="search" size={16} color={COLORS.muted} />
          <TextInput
            style={s.searchInput} value={draft} onChangeText={setDraft}
            placeholder={tab === 'meetings' ? 'Client, REQ, words in summary' : tab === 'discussions' ? 'Client, REQ, words' : 'Search'}
            placeholderTextColor={COLORS.faint} returnKeyType="search"
            onSubmitEditing={submitSearch} onEndEditing={submitSearch}
          />
          {!!draft && (
            <TouchableOpacity onPress={() => { setDraft(''); setSearch(''); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={COLORS.faint} />
            </TouchableOpacity>
          )}
        </View>

        {!!error && (
          <View style={s.errorCard}>
            <Ionicons name="alert-circle-outline" size={18} color="#B91C1C" />
            <Text style={s.errorTxt}>{error}</Text>
            <TouchableOpacity onPress={load} style={s.retryBtn}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
          </View>
        )}

        {!data ? (
          <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
        ) : tab === 'discussions' ? (
          <DiscussionList rows={data.rows || []} half={half} filter={discFilter} onOpen={openThread} />
        ) : tab === 'meetings' ? (
          <MeetingDays days={data.days || []} half={half} onOpenTask={onOpenTask} onError={flash} />
        ) : (
          <QuestionList rows={data.rows || []} onOpenTask={onOpenTask} />
        )}
      </ScrollView>

      <ThreadModal
        thread={thread} busy={threadBusy} onClose={() => setThread(null)}
        onOpenTask={onOpenTask}
      />
    </View>
  );
}

function Pill({ on, onPress, label, small, danger }) {
  return (
    <TouchableOpacity
      style={[s.pill, small && s.pillSm, on && s.pillOn, danger && !on && s.pillDanger]}
      onPress={onPress} activeOpacity={0.85}
    >
      <Text style={[s.pillTxt, small && s.pillTxtSm, on && s.pillTxtOn, danger && !on && { color: '#B42318' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Empty({ text }) {
  return (
    <View style={s.emptyCard}>
      <Ionicons name="chatbubbles-outline" size={28} color={COLORS.faint} />
      <Text style={s.emptyTxt}>{text}</Text>
    </View>
  );
}

// ── 💬 Discussions ──────────────────────────────────────────────────────────
function DiscussionList({ rows, half, filter, onOpen }) {
  if (!rows.length) {
    return (
      <Empty text={half === 'general'
        ? 'No general questions yet. When a client picks "Something else" in WhatsApp 💬 Discuss, it shows here.'
        : `No task chats${filter === 'waiting' ? ' waiting for a reply' : ''}.`} />
    );
  }
  return rows.map((r) => (
    <TouchableOpacity key={r.kpi_id} style={s.card} onPress={() => onOpen(r)} activeOpacity={0.85}>
      <View style={s.rowTop}>
        {!r.is_general && <View style={s.refChip}><Text style={s.refTxt}>{r.ref}</Text></View>}
        <Text style={s.cardTitle} numberOfLines={1}>{r.is_general ? r.client : r.title}</Text>
        {r.waiting > 0 && <View style={s.badge}><Text style={s.badgeTxt}>{r.waiting}</Text></View>}
      </View>
      <Text style={[s.last, r.waiting ? s.lastWaiting : null]} numberOfLines={2}>{r.last_who}: {r.last}</Text>
      <View style={s.metaRow}>
        <Text style={s.meta}>{r.at_label}{!r.is_general && r.client ? ` · ${r.client}` : ''}</Text>
        <Text style={s.meta}>{r.count} msgs</Text>
      </View>
    </TouchableOpacity>
  ));
}

// One chat, full screen: dates (closed until tapped) → coloured talks → bubbles.
function ThreadModal({ thread, busy, onClose, onOpenTask }) {
  const [openDays, setOpenDays] = useState({});
  const [photo, setPhoto] = useState(null);   // { uri, name, who, time, body } | { loading }
  useEffect(() => {
    // The newest date starts open — it is almost always the one being looked at.
    const first = thread?.days?.[0]?.date;
    setOpenDays(first ? { [first]: true } : {});
  }, [thread?.kpi_id, thread?.days?.length]);

  const openFile = async (f, msg) => {
    if (f.kind !== 'image') return;
    setPhoto({ loading: true, name: f.name });
    const r = await fetchChatFile(f.url);
    if (!r.status) { setPhoto({ error: r.message || 'Could not open the photo.', name: f.name }); return; }
    setPhoto({
      uri: `data:${r.mimetype || 'image/jpeg'};base64,${r.data_b64}`, name: f.name,
      who: msg.side === 'client' ? `${msg.who} · client` : msg.who, time: msg.time, body: msg.body || '',
    });
  };

  return (
    <Modal visible={!!thread} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        <GradientBackground />
        <View style={[s.header, { paddingTop: TOP }]}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
          <View style={[s.hTitleWrap, { flexDirection: 'column', gap: 0 }]}>
            <Text style={s.hTitle} numberOfLines={1}>
              {thread?.is_general ? `🌐 General · ${thread?.client || ''}` : (thread?.title || '')}
            </Text>
            <Text style={s.hSub} numberOfLines={1}>
              {thread && !thread.is_general ? `${thread.ref} · ${thread.client} · ` : ''}{thread?.count || 0} messages
            </Text>
          </View>
          {onOpenTask && thread && !thread.is_general ? (
            <TouchableOpacity onPress={() => { const id = thread.kpi_id; onClose(); onOpenTask(id); }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
              <Ionicons name="open-outline" size={20} color={COLORS.navy} />
            </TouchableOpacity>
          ) : <View style={{ width: 40 }} />}
        </View>

        {busy ? (
          <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: BOTTOM_PAD }}>
            {!(thread?.days || []).length && <Empty text="No messages in this chat." />}
            {(thread?.days || []).map((day) => {
              const isOpen = !!openDays[day.date];
              const waiting = day.sessions.some((x) => x.status === 'waiting');
              const n = day.sessions.reduce((a, x) => a + x.count, 0);
              return (
                <View key={day.date}>
                  <TouchableOpacity style={s.dayHead} activeOpacity={0.85}
                    onPress={() => setOpenDays((o) => ({ ...o, [day.date]: !o[day.date] }))}>
                    <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.muted} />
                    <Text style={s.dayLabel}>{day.label}</Text>
                    <Text style={s.meta}>
                      {day.sessions.length} talk{day.sessions.length !== 1 ? 's' : ''} · {n} message{n !== 1 ? 's' : ''}
                    </Text>
                    {waiting && <Text style={s.waitingDot}>● waiting</Text>}
                  </TouchableOpacity>
                  {isOpen && day.sessions.map((ses, si) => {
                    const c = T.colour(si);
                    return (
                      <View key={ses.n}>
                        {ses.gap_min > 0 && (
                          <View style={s.gapRow}>
                            <View style={s.gapLine} />
                            <Text style={s.gapTxt}>{T.gapLabel(ses.gap_min)} gap</Text>
                            <View style={s.gapLine} />
                          </View>
                        )}
                        <View style={[s.talk, { backgroundColor: c.band, borderLeftColor: c.bar }]}>
                          <View style={s.talkHead}>
                            <Text style={[s.talkTitle, { color: c.text }]}>
                              Talk {ses.n} · {ses.start}{ses.end !== ses.start ? ` – ${ses.end}` : ''} · {ses.count} message{ses.count !== 1 ? 's' : ''}
                            </Text>
                            {ses.status === 'answered' && <Text style={s.answered}>✓ answered{ses.by ? ` by ${ses.by}` : ''}</Text>}
                            {ses.status === 'waiting' && <Text style={s.waitingDot}>● waiting for the team</Text>}
                          </View>
                          {ses.messages.map((msg) => {
                            const team = msg.side === 'team';
                            return (
                              <View key={msg.id} style={[s.bubble, team ? s.bubbleTeam : s.bubbleClient]}>
                                <View style={s.bubbleHead}>
                                  <Text style={[s.bubbleWho, { color: team ? '#1D4FA8' : '#B45309' }]} numberOfLines={1}>
                                    {msg.who}{msg.side === 'client' ? ' · client' : ''}
                                  </Text>
                                  <Text style={s.bubbleTime}>{msg.time}</Text>
                                </View>
                                {!!msg.body && <Text style={s.bubbleBody}>{msg.body}</Text>}
                                {(msg.files || []).map((f) => (
                                  <TouchableOpacity key={f.id} style={s.fileChip} activeOpacity={f.kind === 'image' ? 0.7 : 1}
                                    onPress={() => openFile(f, msg)}>
                                    <Text style={s.fileTxt} numberOfLines={1}>
                                      {f.kind === 'image' ? '🖼️' : f.kind === 'video' ? '🎬' : f.kind === 'document' ? '📄' : '🎤'} {f.name}
                                    </Text>
                                    {f.kind !== 'image' && <Text style={s.fileHint}>open on the web</Text>}
                                  </TouchableOpacity>
                                ))}
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </ScrollView>
        )}

        {/* A tapped photo, over the chat: who and when on top, its words below. */}
        <Modal visible={!!photo} transparent animationType="fade" onRequestClose={() => setPhoto(null)}>
          <TouchableOpacity style={s.photoBackdrop} activeOpacity={1} onPress={() => setPhoto(null)}>
            <View style={s.photoBar}>
              <View style={{ flex: 1 }}>
                <Text style={s.photoWho} numberOfLines={1}>{photo?.who || photo?.name || ''}</Text>
                {!!photo?.time && <Text style={s.photoTime}>{photo.time}</Text>}
              </View>
              <Ionicons name="close" size={24} color="#fff" />
            </View>
            {photo?.loading ? <ActivityIndicator color="#fff" />
              : photo?.error ? <Text style={s.photoErr}>{photo.error}</Text>
              : photo?.uri ? <Image source={{ uri: photo.uri }} style={s.photo} resizeMode="contain" /> : null}
            {!!photo?.body && <Text style={s.photoCap}>{photo.body}</Text>}
          </TouchableOpacity>
        </Modal>
      </View>
    </Modal>
  );
}

// ── 📅 Meetings ─────────────────────────────────────────────────────────────
function MeetingDays({ days, half, onOpenTask, onError }) {
  if (!days.length) {
    return (
      <Empty text={half === 'general'
        ? 'No general meetings. They are the ones a client asked for without picking a task ("Common, whole server" or "Other / a new topic").'
        : 'No meetings here.'} />
    );
  }
  return days.map((day) => (
    <View key={day.date}>
      <View style={s.dayRule}>
        <View style={s.gapLine} />
        <Text style={s.dayRuleTxt}>{day.label}{day.upcoming ? ' · upcoming' : ''}</Text>
        <View style={s.gapLine} />
      </View>
      {day.meetings.map((m, i) => (
        <MeetingCard key={m.id} m={m} tone={T.colour(i + 3)} onOpenTask={onOpenTask} onError={onError} />
      ))}
    </View>
  ));
}

// Closed: one row — time, task, status, Join. Open: everything saved on it.
export function MeetingCard({ m, tone, onOpenTask, onError }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [joining, setJoining] = useState(false);
  const st = toneOf(m.state);
  const join = async () => {
    setJoining(true);
    try { await joinMeeting(m.id); }
    catch (e) { onError && onError(e?.message || 'Could not open the meeting.'); }
    finally { setJoining(false); }
  };
  return (
    <View style={[s.card, { borderLeftWidth: 5, borderLeftColor: (tone || T.colour(3)).bar }]}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} activeOpacity={0.85}>
        <View style={s.rowTop}>
          <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={15} color={COLORS.muted} />
          <Text style={s.meetWhen}>{m.when}</Text>
          {m.minutes > 0 && <Text style={s.meta}>· {m.minutes} min</Text>}
          <View style={[s.stateChip, { backgroundColor: st.bg }]}><Text style={[s.stateTxt, { color: st.fg }]}>{m.state_label}</Text></View>
        </View>
        <View style={[s.rowTop, { marginTop: 6 }]}>
          {!!m.ref && <View style={s.refChip}><Text style={s.refTxt} numberOfLines={1}>{m.ref}</Text></View>}
          {m.internal && <View style={s.refChip}><Text style={s.refTxt}>Internal</Text></View>}
        </View>
        <Text style={s.cardTitle} numberOfLines={2}>{m.title || m.name}</Text>
        {!!m.title && m.name !== m.title && <Text style={s.meta} numberOfLines={1}>{m.name}</Text>}
      </TouchableOpacity>

      {(m.can_join || (onOpenTask && m.kpi_id && !m.is_general)) && (
        <View style={s.btnRow}>
          {m.can_join && (
            <TouchableOpacity style={s.joinBtn} onPress={join} disabled={joining} activeOpacity={0.85}>
              {joining ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="videocam" size={16} color="#fff" />}
              <Text style={s.joinTxt}>Join meeting</Text>
            </TouchableOpacity>
          )}
          {onOpenTask && m.kpi_id && !m.is_general && (
            <TouchableOpacity style={s.ghostBtn} onPress={() => onOpenTask(m.kpi_id)} activeOpacity={0.85}>
              <Text style={s.ghostTxt}>↗ Open task</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {open && (
        <View style={{ marginTop: 10, gap: 10 }}>
          <Text style={s.metaBlock}>
            {m.local_when ? `${m.local_when}\n` : ''}
            Organizer <Text style={{ fontWeight: '800', color: COLORS.ink }}>{m.organizer || 'nobody yet'}</Text>
            {m.asked_by ? `\nAsked by ${m.asked_by} (client)` : ''}
            {m.client ? `\nClient ${m.client}${m.db ? ` · ${m.db}` : ''}` : ''}
            {m.booked ? `\nBooked ${m.booked}` : ''}
          </Text>

          <View style={s.box}>
            <Text style={s.boxHead}>👥 Attendance</Text>
            {!(m.attendance || []).length && <Text style={s.boxLine}>Nobody joined yet.</Text>}
            {(m.attendance || []).map((p, i) => (
              <View key={i} style={s.attRow}>
                <Text style={s.attName} numberOfLines={1}>{p.name}{!p.staff ? ' (client)' : ''}</Text>
                <Text style={s.meta}>
                  {p.absent ? '❌ absent'
                    : `${p.joined ? `${p.joined} – ${p.left || 'now'} · ` : ''}${p.minutes} min${p.removed ? ' ⚠️' : ''}`}
                </Text>
              </View>
            ))}
          </View>

          <View style={s.soft}><Text style={s.softHead}>📝 Summary</Text><Text style={s.softTxt}>{m.summary || 'No summary yet.'}</Text></View>
          <View style={s.soft}><Text style={s.softHead}>✅ Action items</Text><Text style={s.softTxt}>{m.action_items || 'None written.'}</Text></View>
          {!!m.notes && <Text style={s.meta}>🔒 {m.notes}</Text>}

          <View style={s.box}>
            <Text style={s.boxHead}>🎧 Recording</Text>
            {!(m.recordings || []).length
              ? <Text style={s.boxLine}>No recording.</Text>
              : (m.recordings || []).map((r) => <Text key={r.id} style={s.boxLine}>{r.name} · listen on the web</Text>)}
          </View>

          <View style={s.box}>
            <Text style={s.boxHead}>💬 Transcript</Text>
            {!m.transcript ? <Text style={s.boxLine}>No transcript.</Text> : (
              <>
                <Text style={s.boxLine} numberOfLines={full ? undefined : 3}>{m.transcript}</Text>
                <TouchableOpacity onPress={() => setFull((v) => !v)}>
                  <Text style={s.linkTxt}>{full ? '▴ Show less' : '▸ Show full transcript'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ── ❓ Questions ────────────────────────────────────────────────────────────
function QuestionList({ rows, onOpenTask }) {
  const groups = useMemo(() => {
    const out = new Map();
    rows.forEach((q) => {
      const d = localDay(q.at);
      if (!out.has(d.key)) out.set(d.key, { ...d, rows: [] });
      out.get(d.key).rows.push(q);
    });
    return [...out.values()];
  }, [rows]);
  if (!rows.length) return <Empty text="Nothing here." />;
  return groups.map((g) => (
    <View key={g.key}>
      <View style={s.dayRule}>
        <View style={s.gapLine} />
        <Text style={s.dayRuleTxt}>{g.label} · {g.rows.length}</Text>
        <View style={s.gapLine} />
      </View>
      {g.rows.map((q) => (
        <View key={q.id} style={[s.card, !q.open && { backgroundColor: '#F8FAFC' }]}>
          <View style={s.rowTop}>
            <View style={s.refChip}><Text style={s.refTxt}>{q.is_general ? 'General' : q.ref || '—'}</Text></View>
            <Text style={s.kindTxt} numberOfLines={1}>{T.kindIcon(q.kind)} {q.kind_label}</Text>
            {q.open ? (
              <Text style={[s.age, q.age_min >= 10 && s.ageLate]}>{T.ageLabel(q.age_min)}</Text>
            ) : null}
          </View>
          <Text style={s.question}>{q.question}</Text>
          {!q.open && !!q.answer && <Text style={s.answer}>↳ {q.answer}</Text>}
          <Text style={s.metaBlock}>
            {[
              (q.raised_by || (q.is_general ? q.client : '')) && `Raised by ${q.raised_by || q.client}`,
              q.with_now && `With now: ${q.with_now}`,
            ].filter(Boolean).join('\n')}
          </Text>
          <View style={s.btnRow}>
            {q.open ? (
              <View style={[s.stateChip, { backgroundColor: TONE.paused.bg }]}><Text style={[s.stateTxt, { color: TONE.paused.fg }]}>{q.step}</Text></View>
            ) : (
              <View style={[s.stateChip, { backgroundColor: TONE.done.bg }]}><Text style={[s.stateTxt, { color: TONE.done.fg }]}>✓ {q.state_label}</Text></View>
            )}
            {onOpenTask && q.kpi_id && !q.is_general && !q.meeting_id && (
              <TouchableOpacity style={[s.ghostBtn, { marginLeft: 'auto' }]} onPress={() => onOpenTask(q.kpi_id)} activeOpacity={0.85}>
                <Text style={s.ghostTxt}>↗ Open task</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}
    </View>
  ));
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  center: { paddingVertical: 40, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 8 },
  hTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },
  hSub: { fontSize: 11.5, color: COLORS.muted, textAlign: 'center' },

  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 10, backgroundColor: '#fff', borderRadius: 12, padding: 4, ...SHADOW },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabOn: { backgroundColor: COLORS.primary },
  tabTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy },
  tabTxtOn: { color: '#fff' },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },
  errBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FEE2E2', paddingVertical: 8, paddingHorizontal: 14 },
  errTxt: { color: '#B91C1C', fontSize: 11.5, fontWeight: '700', flex: 1 },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line },
  pillSm: { paddingHorizontal: 12, paddingVertical: 5 },
  pillOn: { backgroundColor: COLORS.navy, borderColor: COLORS.navy },
  pillDanger: { borderColor: '#FCA5A5' },
  pillTxt: { fontSize: 13, fontWeight: '700', color: COLORS.navy },
  pillTxtSm: { fontSize: 12 },
  pillTxtOn: { color: '#fff' },

  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, paddingHorizontal: 12, height: 44, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.ink, paddingVertical: 0 },

  errorCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEE2E2', borderRadius: 12, padding: 12, marginBottom: 12 },
  errorTxt: { flex: 1, color: '#B91C1C', fontSize: 12.5, fontWeight: '600' },
  retryBtn: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  retryTxt: { color: '#B91C1C', fontWeight: '800', fontSize: 12 },

  emptyCard: { backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', gap: 8, ...SHADOW },
  emptyTxt: { fontSize: 13, color: COLORS.muted, textAlign: 'center', lineHeight: 18 },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 10, ...SHADOW },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '800', color: COLORS.navy, marginTop: 2 },
  refChip: { backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 220 },
  refTxt: { fontSize: 11.5, fontWeight: '800', color: '#475569' },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '900' },
  last: { fontSize: 12.5, color: COLORS.muted, marginTop: 6 },
  lastWaiting: { color: COLORS.ink, fontWeight: '700' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  meta: { fontSize: 11.5, color: COLORS.muted },
  metaBlock: { fontSize: 12, color: COLORS.muted, lineHeight: 18, marginTop: 4 },

  dayHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  dayLabel: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy },
  waitingDot: { marginLeft: 'auto', fontSize: 11.5, fontWeight: '700', color: '#B42318' },
  answered: { marginLeft: 'auto', fontSize: 11.5, fontWeight: '700', color: '#0F5E2D' },
  gapRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 4 },
  gapLine: { flex: 1, borderTopWidth: 1, borderStyle: 'dashed', borderColor: '#C9CED4' },
  gapTxt: { fontSize: 11, color: '#8A939E' },
  dayRule: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
  dayRuleTxt: { fontSize: 12, fontWeight: '800', color: COLORS.muted },

  talk: { borderRadius: 8, borderLeftWidth: 4, padding: 8, marginBottom: 8, gap: 8 },
  talkHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  talkTitle: { fontSize: 12, fontWeight: '800' },
  bubble: { maxWidth: '85%', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  bubbleTeam: { alignSelf: 'flex-end', backgroundColor: '#D9FDD3' },
  bubbleClient: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF' },
  bubbleHead: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  bubbleWho: { fontSize: 12, fontWeight: '800', flexShrink: 1 },
  bubbleTime: { marginLeft: 'auto', fontSize: 11, color: '#667085' },
  bubbleBody: { fontSize: 13.5, color: '#111', marginTop: 2 },
  fileChip: { marginTop: 4, backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  fileTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.ink },
  fileHint: { fontSize: 10.5, color: COLORS.muted },

  photoBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  photoBar: { position: 'absolute', top: TOP, left: 16, right: 16, flexDirection: 'row', alignItems: 'center' },
  photoWho: { color: '#fff', fontWeight: '800', fontSize: 14 },
  photoTime: { color: '#CBD5E1', fontSize: 12 },
  photo: { width: '100%', height: '70%' },
  photoErr: { color: '#FCA5A5', fontSize: 13, padding: 24, textAlign: 'center' },
  photoCap: { color: '#fff', fontSize: 13, padding: 16, textAlign: 'center' },

  meetWhen: { fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  stateChip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, marginLeft: 'auto' },
  stateTxt: { fontSize: 11, fontWeight: '800' },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  joinBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.green, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  joinTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  ghostBtn: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff' },
  ghostTxt: { color: COLORS.navy, fontWeight: '800', fontSize: 12.5 },
  box: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, overflow: 'hidden' },
  boxHead: { fontSize: 12, fontWeight: '800', color: COLORS.navy, backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 5 },
  boxLine: { fontSize: 12.5, color: COLORS.ink, paddingHorizontal: 8, paddingVertical: 5 },
  attRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 5, borderTopWidth: 1, borderTopColor: COLORS.line },
  attName: { flex: 1, fontSize: 12.5, color: COLORS.ink },
  soft: { backgroundColor: '#F1F5F9', borderRadius: 8, padding: 8 },
  softHead: { fontSize: 12.5, fontWeight: '800', color: COLORS.navy, marginBottom: 2 },
  softTxt: { fontSize: 12.5, color: COLORS.ink },
  linkTxt: { fontSize: 12, fontWeight: '700', color: COLORS.link, paddingHorizontal: 8, paddingBottom: 6 },

  kindTxt: { flex: 1, fontSize: 12.5, fontWeight: '700', color: COLORS.ink },
  age: { fontSize: 12, color: COLORS.muted },
  ageLate: { color: COLORS.red, fontWeight: '800' },
  question: { fontSize: 13.5, color: COLORS.ink, marginTop: 6 },
  answer: { fontSize: 12.5, color: COLORS.muted, marginTop: 4 },
});
