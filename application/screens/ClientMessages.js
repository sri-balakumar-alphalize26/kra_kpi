// CLIENT MESSAGES (managers) — mobile port of the web Approvals desk's
// "Questions" tab (web/components/admin/Approvals.jsx, commit 605a535).
// Everything a client or a developer has asked the manager (kpi.doubt):
//   · 💬 Client message (a client's Discuss message): Reply to client, or
//     👨‍💻 Ask a developer — the same hand-off as the WhatsApp "👨‍💻 → name"
//     buttons (kpi.doubt.chat_dev_options / action_ask_developer).
//   · A developer's question: Answer (back to them), Send to client (the only
//     path to a client group), Make a meeting, Not now.
//
// The rule it serves: no developer talks to a client and no client talks to a
// developer; the manager is the only bridge. Who may decide is the module's
// call (kpi.doubt._decider), so a refusal shows the server's own words.
// A decision may end with a WhatsApp post that fails without the decision
// failing, so success here is "decided", never "sent on WhatsApp".
// Admin-only tile (the routing in App.js / HomeScreen.js gates it).
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch,
  Platform, ActivityIndicator, Modal, RefreshControl, KeyboardAvoidingView,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import useAppDialog from '../components/useAppDialog';
import { createLogger } from '../api/logger';
import {
  fetchDoubts, answerDoubt, releaseDoubt, rejectDoubt, meetingFromDoubt,
  devOptionsForDoubt, askDeveloper, doubtKindLabel, DOUBT_STATES,
} from '../services/clientMessages';

const log = createLogger('ClientMessagesScreen');
const TOP = (RNStatusBar.currentHeight || 0) + 12;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;

// Client-side kinds: what a CLIENT raised. Everything else came from the team.
const CLIENT_KINDS = ['client_msg', 'client_meet'];
const FILTERS = [
  { key: 'client', label: 'Client messages' },
  { key: 'team', label: 'Team questions' },
  { key: 'all', label: 'All' },
];

const m2o = (v) => (Array.isArray(v) ? v[1] : '') || '';
// Odoo datetimes are UTC 'YYYY-MM-DD HH:MM:SS' → the phone's local time.
function when(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(ts);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${mon}, ${hh}:${mm}`;
}

// The reply sheet's words per mode — the web's ReplyDialog cfg.
function replyCfg(d, mode) {
  if (mode === 'answer' && d.kind === 'client_msg') {
    return {
      title: 'Reply to the client', label: 'Your reply', required: true, button: 'Send reply',
      hint: 'The client gets a link in their WhatsApp group and reads your reply in their chat, as “Alphalize team”. It is also saved in the task\'s 💬 Chat.',
      ok: 'Sent to the client.',
    };
  }
  return {
    answer: { title: 'Answer the developer', label: 'Your answer', required: true, button: 'Send answer', hint: 'Goes back to the developer who asked.', ok: 'Answered.' },
    release: { title: 'Send to the client', label: 'What the client should read', required: false, button: 'Send to client', hint: 'This is the only way a question reaches a client. It goes to the client\'s group, in your words.', ok: 'Sent to the client.' },
    reject: { title: 'Not now', label: 'Note (optional)', required: false, button: 'Not now', hint: d.kind === 'client_msg' ? 'The client gets a holding line in their chat (yours, or “we\'ll get back to you soon”).' : 'The developer is told it is not being taken up now.', ok: 'Marked not now.' },
  }[mode];
}

export default function ClientMessages({ onBack }) {
  const { dialog, showError, confirm } = useAppDialog();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [doubts, setDoubts] = useState([]);
  const [all, setAll] = useState(false);         // show answered / sent / closed too
  const [filter, setFilter] = useState('client');
  const [banner, setBanner] = useState(null);    // { type, text }
  const [busyId, setBusyId] = useState(null);
  // Reply sheet: { doubt, mode: 'answer'|'release'|'reject' }
  const [reply, setReply] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  // Developer picker: { doubt, options }
  const [devPick, setDevPick] = useState(null);

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 4500); };
  // A failure inside a confirm()'s onConfirm: useAppDialog closes the dialog
  // once that promise settles, which would wipe an error raised inside it — so
  // the error is shown on the next tick, after the close.
  const failLater = (title, e) => setTimeout(() => showError(title, e?.message || 'Please try again.'), 0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchDoubts({ all });
      setIsMock(!!res.isMock);
      setDoubts(res.doubts || []);
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e?.message || 'Could not load the messages');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [all]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const counts = useMemo(() => {
    const open = doubts.filter((d) => d.state === 'open');
    return {
      client: open.filter((d) => CLIENT_KINDS.includes(d.kind)).length,
      team: open.filter((d) => !CLIENT_KINDS.includes(d.kind)).length,
      all: open.length,
    };
  }, [doubts]);

  const shown = useMemo(() => doubts.filter((d) => (
    filter === 'all' ? true
      : filter === 'client' ? CLIENT_KINDS.includes(d.kind)
        : !CLIENT_KINDS.includes(d.kind)
  )), [doubts, filter]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const openReply = (doubt, mode) => {
    // Send to client starts from the developer's own words, as on the web.
    setReplyText(mode === 'release' ? (doubt.question || '') : '');
    setReplyErr('');
    setReply({ doubt, mode });
  };

  const submitReply = async () => {
    if (!reply) return;
    const { doubt, mode } = reply;
    const cfg = replyCfg(doubt, mode);
    const text = replyText.trim();
    if (cfg.required && !text) { setReplyErr('Write the answer first.'); return; }
    setReplyBusy(true);
    try {
      if (mode === 'answer') await answerDoubt(doubt.id, text);
      else if (mode === 'release') await releaseDoubt(doubt.id, text);
      else await rejectDoubt(doubt.id, text);
      setReply(null);
      flash('ok', cfg.ok);
      await load();
    } catch (e) {
      log.warn('reply ' + mode, e?.message);
      setReplyErr(e?.message || 'Could not send. Please try again.');
    } finally {
      setReplyBusy(false);
    }
  };

  const onMeeting = (d) => {
    confirm({
      title: 'Make a meeting?',
      message: d.kind === 'meet_admin'
        ? 'An internal meeting with the developer is set up and opened now.'
        : d.kind === 'client_msg'
          ? 'The client is told you will talk it through in a meeting. It then waits under Meetings for you to confirm a time.'
          : 'A client meeting is requested. It then waits under Meetings for you to confirm a time.',
      confirmLabel: 'Make the meeting',
      tone: 'info',
      onConfirm: async () => {
        try {
          await meetingFromDoubt(d.id);
          flash('ok', 'Meeting made. See Meetings.');
          await load();
        } catch (e) {
          failLater("Couldn't make the meeting", e);
        }
      },
    });
  };

  // 👨‍💻 Ask a developer: who can take it, then hand it over.
  const onAsk = async (d) => {
    setBusyId(d.id);
    try {
      const opts = await devOptionsForDoubt(d.id);
      if (!opts.length) { showError('Nobody to ask', 'There is no developer to hand it to.'); return; }
      setDevPick({ doubt: d, options: opts });
    } catch (e) {
      showError("Couldn't load developers", e?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const pickDev = (dev) => {
    const d = devPick?.doubt;
    setDevPick(null);
    if (!d) return;
    confirm({
      title: `Ask ${dev.name} to reply?`,
      message: `${dev.name} gets the client's message privately, your group is told who was picked, and the client gets their chat link.`,
      confirmLabel: 'Ask',
      tone: 'info',
      onConfirm: async () => {
        try {
          const r = await askDeveloper(d.id, dev.id);
          const sent = (r?.sent_to || []).join(', ') || dev.name;
          const unreachable = (r?.unreachable || []).join(', ');
          flash('ok', `Sent to ${sent} privately; the client got their chat link.`
            + (unreachable ? ` ${unreachable} has no WhatsApp number — they can reply from the task's 💬 Chat.` : ''));
          await load();
        } catch (e) {
          failLater("Couldn't hand it over", e);
        }
      },
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <Header onBack={onBack} count={null} />
        <View style={s.center}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={s.centerTxt}>Loading messages…</Text>
        </View>
      </View>
    );
  }

  const cfg = reply ? replyCfg(reply.doubt, reply.mode) : null;

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <Header
        onBack={onBack} count={counts.all}
        onRefresh={() => { setRefreshing(true); load(); }} refreshing={refreshing}
      />

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to load live messages</Text>
        </View>
      )}

      {banner && (
        <View style={[s.banner, banner.type === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.type === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={16} color={banner.type === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.type === 'ok' ? COLORS.green : COLORS.red }]}>{banner.text}</Text>
        </View>
      )}

      {error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={() => { setLoading(true); load(); }}>
            <Text style={s.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 14, paddingBottom: BOTTOM_PAD + 20 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          <View style={s.info}>
            <Ionicons name="information-circle" size={17} color={COLORS.primary} style={{ marginTop: 1 }} />
            <Text style={s.infoTxt}>
              No developer talks to a client and no client talks to a developer —{' '}
              <Text style={s.infoBold}>you are the bridge</Text>. Reply to a client yourself, or tap{' '}
              <Text style={s.infoBold}>👨‍💻 Ask a developer</Text> to hand their message to one.
            </Text>
          </View>

          {/* Filter chips — open counts, like the web's tab badges. */}
          <View style={s.chips}>
            {FILTERS.map((f) => {
              const on = filter === f.key;
              const n = counts[f.key];
              return (
                <TouchableOpacity key={f.key} style={[s.chip, on && s.chipOn]} onPress={() => setFilter(f.key)} activeOpacity={0.8}>
                  <Text style={[s.chipTxt, on && s.chipTxtOn]}>{f.label}</Text>
                  {n > 0 && (
                    <View style={[s.chipCnt, on && s.chipCntOn]}><Text style={[s.chipCntTxt, on && { color: COLORS.primary }]}>{n}</Text></View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={s.allRow}>
            <Text style={s.allTxt}>Show answered, sent and closed too</Text>
            <Switch value={all} onValueChange={(v) => setAll(v)} trackColor={{ true: COLORS.primary }} />
          </View>

          {shown.length === 0 ? (
            <View style={[s.center, { paddingVertical: 50 }]}>
              <MaterialCommunityIcons name="chat-outline" size={46} color={COLORS.faint} />
              <Text style={s.centerTxt}>
                {filter === 'team' ? 'No questions waiting.' : 'No client messages waiting.'}
              </Text>
              <Text style={s.emptySub}>
                {filter === 'team'
                  ? 'When a developer asks the manager something from a task, it shows here.'
                  : 'When a client sends a 💬 Discuss message about a task, it shows here.'}
              </Text>
            </View>
          ) : shown.map((d) => (
            <DoubtCard
              key={d.id} d={d} busy={busyId === d.id}
              onReply={openReply} onAsk={onAsk} onMeeting={onMeeting}
            />
          ))}
        </ScrollView>
      )}

      {/* Reply / Send to client / Not now */}
      <Modal visible={!!reply} transparent animationType="fade" onRequestClose={() => !replyBusy && setReply(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => !replyBusy && setReply(null)}>
            <TouchableOpacity style={s.sheet} activeOpacity={1}>
              {reply && cfg && (
                <>
                  <View style={s.sheetHead}>
                    <Text style={s.sheetTitle} numberOfLines={1}>{cfg.title}</Text>
                    <TouchableOpacity onPress={() => !replyBusy && setReply(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Text style={s.sheetClose}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={s.quote}>
                    <Text style={s.quoteTask} numberOfLines={2}>
                      {reply.doubt.task_ref ? `${reply.doubt.task_ref} · ` : ''}{m2o(reply.doubt.kpi_id)}
                    </Text>
                    <Text style={s.quoteTxt}>“{reply.doubt.question}”</Text>
                    <Text style={s.quoteWho}>— {m2o(reply.doubt.raised_by_id) || reply.doubt.raised_by_name || '—'}</Text>
                  </View>
                  <Text style={s.label}>{cfg.label}{cfg.required ? ' *' : ''}</Text>
                  <TextInput
                    style={s.textArea} multiline autoFocus value={replyText}
                    onChangeText={(t) => { setReplyText(t); setReplyErr(''); }}
                    placeholder={reply.mode === 'reject' ? 'Why? (optional)' : 'Write it here…'}
                    placeholderTextColor={COLORS.faint} editable={!replyBusy}
                  />
                  <Text style={s.hint}>{cfg.hint}</Text>
                  {!!replyErr && <Text style={s.err}>{replyErr}</Text>}
                  <View style={s.sheetBtns}>
                    <TouchableOpacity style={s.btnGhost} onPress={() => setReply(null)} disabled={replyBusy}>
                      <Text style={s.btnGhostTxt}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.btnPri, reply.mode === 'reject' && { backgroundColor: COLORS.red }, replyBusy && { opacity: 0.7 }]}
                      onPress={submitReply} disabled={replyBusy} activeOpacity={0.85}
                    >
                      {replyBusy ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={s.btnPriTxt}>{cfg.button}</Text>}
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* 👨‍💻 Developer picker */}
      <Modal visible={!!devPick} transparent animationType="fade" onRequestClose={() => setDevPick(null)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setDevPick(null)}>
          <TouchableOpacity style={s.sheet} activeOpacity={1}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle} numberOfLines={1}>Ask a developer to reply</Text>
              <TouchableOpacity onPress={() => setDevPick(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.sheetClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={[s.hint, { marginTop: 0, marginBottom: 8 }]}>The people on the task come first.</Text>
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              {(devPick?.options || []).map((o) => (
                <TouchableOpacity key={o.id} style={s.devRow} onPress={() => pickDev(o)} activeOpacity={0.8}>
                  <View style={s.devAvatar}><Text style={s.devAvatarTxt}>{(o.name || '?').slice(0, 1).toUpperCase()}</Text></View>
                  <Text style={s.devName} numberOfLines={1}>{o.name}</Text>
                  <Ionicons name="chevron-forward" size={16} color={COLORS.faint} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {dialog}
    </View>
  );
}

// One message / question with the buttons the web shows for its state.
function DoubtCard({ d, busy, onReply, onAsk, onMeeting }) {
  const st = DOUBT_STATES[d.state] || { label: d.state, bg: '#F1F5F9', fg: '#475569' };
  const isClient = d.kind === 'client_msg';
  const live = d.state === 'open' || d.state === 'answered';
  const open = d.state === 'open';
  const who = m2o(d.raised_by_id) || (d.raised_by_name ? `${d.raised_by_name} (client)` : '—');
  return (
    <View style={[s.card, isClient && s.cardClient]}>
      <View style={s.cardTop}>
        {!!d.task_ref && <View style={s.refTag}><Text style={s.refTxt}>{d.task_ref}</Text></View>}
        <Text style={s.taskName} numberOfLines={1}>{m2o(d.kpi_id)}</Text>
        <View style={[s.statePill, { backgroundColor: st.bg }]}>
          <Text style={[s.stateTxt, { color: st.fg }]}>{st.label}</Text>
        </View>
      </View>
      <Text style={s.kind}>
        {doubtKindLabel(d.kind)}{m2o(d.client_kra_id) ? `  ·  ${m2o(d.client_kra_id)}` : ''}
      </Text>
      <Text style={s.question}>{d.question}</Text>
      {!!d.answer && (
        <Text style={s.answer}><Text style={{ fontWeight: '900' }}>Answer: </Text>{d.answer}</Text>
      )}
      {!!d.client_answer && (
        <Text style={s.answer}><Text style={{ fontWeight: '900' }}>Client: </Text>{d.client_answer}</Text>
      )}
      <Text style={s.meta}>{who}  ·  {when(d.create_date)}</Text>

      {live && (
        <View style={s.btnRow}>
          {open && (
            <TouchableOpacity style={s.actPri} onPress={() => onReply(d, 'answer')} activeOpacity={0.85}>
              <Ionicons name="chatbubble-ellipses-outline" size={14} color="#fff" />
              <Text style={s.actPriTxt}>{isClient ? 'Reply to client' : 'Answer'}</Text>
            </TouchableOpacity>
          )}
          {open && isClient && (
            <TouchableOpacity style={s.act} onPress={() => onAsk(d)} disabled={busy} activeOpacity={0.85}>
              {busy ? <ActivityIndicator size="small" color={COLORS.primary} />
                : <Text style={s.actTxt}>👨‍💻 Ask a developer</Text>}
            </TouchableOpacity>
          )}
          {!d.client_posted_at && !isClient && (
            <TouchableOpacity style={s.act} onPress={() => onReply(d, 'release')} activeOpacity={0.85}>
              <Text style={s.actTxt}>Send to client</Text>
            </TouchableOpacity>
          )}
          {!d.meeting_id && open && (
            <TouchableOpacity style={s.act} onPress={() => onMeeting(d)} activeOpacity={0.85}>
              <Text style={s.actTxt}>Make a meeting</Text>
            </TouchableOpacity>
          )}
          {open && (
            <TouchableOpacity style={s.act} onPress={() => onReply(d, 'reject')} activeOpacity={0.85}>
              <Text style={[s.actTxt, { color: COLORS.red }]}>Not now</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

function Header({ onBack, count, onRefresh, refreshing }) {
  return (
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <View style={s.hTitleWrap}>
        <Text style={s.hTitle} numberOfLines={1}>Client Messages</Text>
        {count != null && count > 0 && (
          <View style={s.hCount}><Text style={s.hCountTxt}>{count}</Text></View>
        )}
      </View>
      {onRefresh ? (
        <TouchableOpacity onPress={onRefresh} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.primary} />
            : <Ionicons name="refresh" size={20} color={COLORS.navy} />}
        </TouchableOpacity>
      ) : <View style={{ width: 40 }} />}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerTxt: { color: COLORS.muted, marginTop: 10, textAlign: 'center' },
  emptySub: { color: COLORS.faint, marginTop: 6, textAlign: 'center', fontSize: 12.5, lineHeight: 18 },
  retry: { marginTop: 14, backgroundColor: COLORS.primary, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10 },
  retryTxt: { color: '#fff', fontWeight: '800' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  hTitle: { fontSize: 17.5, fontWeight: '900', color: COLORS.navy },
  hCount: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: COLORS.amber, alignItems: 'center', justifyContent: 'center' },
  hCountTxt: { color: '#fff', fontSize: 11.5, fontWeight: '900' },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingVertical: 7, paddingHorizontal: 14 },
  mockTxt: { color: COLORS.amber, fontSize: 11.5, flex: 1 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { fontSize: 13, fontWeight: '600', flex: 1 },

  info: { flexDirection: 'row', gap: 9, backgroundColor: '#E0F2FE', borderRadius: 12, padding: 12, marginBottom: 12 },
  infoTxt: { flex: 1, fontSize: 12.5, color: '#075985', lineHeight: 18 },
  infoBold: { fontWeight: '900' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 17, backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipTxt: { fontSize: 12.5, fontWeight: '800', color: COLORS.ink },
  chipTxtOn: { color: '#fff' },
  chipCnt: { minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#EEF3FF', alignItems: 'center', justifyContent: 'center' },
  chipCntOn: { backgroundColor: '#fff' },
  chipCntTxt: { fontSize: 10.5, fontWeight: '900', color: COLORS.primary },

  allRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 12, ...SHADOW },
  allTxt: { flex: 1, fontSize: 12.5, fontWeight: '700', color: COLORS.ink },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: '#94A3B8', ...SHADOW },
  cardClient: { borderLeftColor: '#25D366' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  refTag: { backgroundColor: COLORS.navy, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  refTxt: { color: '#fff', fontSize: 10, fontWeight: '900' },
  taskName: { flex: 1, fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  statePill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  stateTxt: { fontSize: 10, fontWeight: '900' },
  kind: { fontSize: 11.5, color: COLORS.muted, fontWeight: '700', marginTop: 6 },
  question: { fontSize: 14, color: COLORS.ink, marginTop: 6, lineHeight: 20 },
  answer: { fontSize: 12.5, color: COLORS.green, marginTop: 6, lineHeight: 18 },
  meta: { fontSize: 11.5, color: COLORS.faint, marginTop: 8 },

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  actPri: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.primary, borderRadius: 9, paddingHorizontal: 12, height: 34 },
  actPriTxt: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  act: { alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 12, height: 34, borderWidth: 1.5, borderColor: COLORS.line, backgroundColor: '#fff', minWidth: 60 },
  actTxt: { color: COLORS.navy, fontSize: 12.5, fontWeight: '800' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 18 },
  sheet: { backgroundColor: '#fff', borderRadius: 16, padding: 16, ...SHADOW },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  sheetTitle: { flex: 1, fontSize: 16, fontWeight: '900', color: COLORS.navy },
  sheetClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  quote: { backgroundColor: '#F1F5FB', borderRadius: 10, padding: 10, marginBottom: 12 },
  quoteTask: { fontSize: 12, fontWeight: '800', color: COLORS.navy },
  quoteTxt: { fontSize: 13.5, color: COLORS.ink, marginTop: 4, lineHeight: 19 },
  quoteWho: { fontSize: 11.5, color: COLORS.muted, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  textArea: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, minHeight: 100, maxHeight: 200, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: COLORS.ink, textAlignVertical: 'top' },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 8, lineHeight: 17 },
  err: { fontSize: 12.5, color: COLORS.red, fontWeight: '700', marginTop: 8 },
  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btnGhost: { flex: 1, height: 46, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  btnGhostTxt: { fontSize: 14.5, fontWeight: '800', color: COLORS.muted },
  btnPri: { flex: 1.4, height: 46, borderRadius: 12, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  btnPriTxt: { fontSize: 14.5, fontWeight: '800', color: '#fff' },

  devRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  devAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#EEF3FF', alignItems: 'center', justifyContent: 'center' },
  devAvatarTxt: { fontSize: 13.5, fontWeight: '900', color: COLORS.primary },
  devName: { flex: 1, fontSize: 14.5, fontWeight: '700', color: COLORS.ink },
});
