// The read-only body of a day's summary: totals, away time, the Workday Map and
// the tasks worked. Built from the _daily_summary_payload the server sends.
//
// Two readers, one layout:
//   viewer="self"  — the End Workday popup (screens/KpiActionBoard.js), the
//                    developer reading their own day before they end it;
//   viewer="admin" — Live Tracking (screens/LiveTracking.js), an admin tapping a
//                    person to read that day, live, at any hour.
// It used to live inline in the End Workday modal. Moved here so the admin sees
// exactly what the developer sees, not a second version that drifts from it.
import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import WorkdayTimeline from './WorkdayTimeline';

const IS_NARROW = Dimensions.get('window').width < 480;

// Presence no longer equals logout − login once part of the day was paused
// (frozen), and an unexplained mismatch between a figure and the two timestamps
// beside it is what made the raw clock the definition before this. So when
// something was paused, say the span and how much of it.
//
// logout_at is empty while the day is still open (the End Workday PREVIEW is
// rendered before the session closes), so the range degrades to just the start
// rather than printing a dangling dash. Empty when nothing was paused: with no
// pause Presence DOES equal the stamps, and there is nothing to explain.
export function presenceFootnote(sum) {
  if (!sum || !(sum.paused_seconds > 0)) return '';
  // HH:MM, not HH:MM:SS. The stamps arrive as '%Y-%m-%d %H:%M:%S' and the whole
  // line has to survive numberOfLines={1} in half a tile on a phone; seconds are
  // three characters twice over and say nothing. Same trim the PNG header uses.
  const hm = (stamp) => ((stamp || '').split(' ')[1] || stamp || '').slice(0, 5);
  const from = hm(sum.login_at);
  const to = hm(sum.logout_at);
  const span = from ? (to ? from + '–' + to : from) : '';
  return (span ? span + ' · ' : '') + (sum.paused_display || '0m') + ' paused';
}

/**
 * summary — the server payload (/kpi_workday/today_summary or /kpi_owner/employee_day)
 * viewer  — 'self' (the developer) or 'admin' (someone reading another's day)
 * now     — epoch ms for anything still running on the Map
 */
export default function WorkdaySummaryBody({ summary, viewer = 'self', now = Date.now() }) {
  const sum = summary || {};
  const self = viewer === 'self';
  const who = sum.dev || 'They';
  const missing = sum.missing_progress || [];
  const tasks = sum.tasks || [];

  return (
    <View>
      {/* The day was already closed by the cron. Worth saying: the figures below
          are of a day that ended without them, and without this the popup reads
          as though they are ending it now. */}
      {sum.auto_closed ? (
        <View style={st.autoClosedBox}>
          <Ionicons name="moon-outline" size={15} color="#7a5200" />
          <Text style={st.autoClosedTxt}>Auto-closed earlier by the system.</Text>
        </View>
      ) : null}

      {/* Tasks worked today with no progress note. A day's hours with nothing
          written about them is invisible to everyone downstream. REQUIRED: the
          End button stays locked and /kpi_workday/end refuses until each has one. */}
      {missing.length ? (
        <View style={st.missingBox}>
          <Text style={st.missingTitle}>
            {missing.length === 1
              ? `1 task ${self ? 'you' : who} worked on today has no progress update`
              : `${missing.length} tasks ${self ? 'you' : who} worked on today have no progress update`}
          </Text>
          <Text style={self ? st.missingHintRed : st.missingHint}>
            {self
              ? 'Add a summary for each task you worked on today (from the task) — the day ends only after that.'
              : 'They must add one before the day can end.'}
          </Text>
          {missing.map((m) => (
            <Text key={m.id || m.name} style={st.missingRow} numberOfLines={2}>
              {m.external_ref ? `${m.external_ref}  ` : ''}{m.name || 'Untitled task'}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={st.statTiles}>
        <View style={st.statTile}>
          <Text style={st.statTileLbl}>Login</Text>
          {/* On a phone the server's full stamp clips; the date is redundant in
              a summary of one day, so keep the time. */}
          <Text style={st.statTileVal} numberOfLines={1}>
            {IS_NARROW
              ? ((sum.login_at || '—').split(' ')[1] || sum.login_at || '—')
              : (sum.login_at || '—')}
          </Text>
        </View>
        <View style={st.statTile}>
          <Text style={st.statTileLbl}>{IS_NARROW ? 'Productive' : 'Productive (task time)'}</Text>
          <Text style={[st.statTileBig, { color: COLORS.green }]}>{sum.productive_display || '0m'}</Text>
        </View>
        {/* Presence and Accounted share ONE box: Presence is time at work (the
            pause is OFF it), Accounted is the whole day explained (the pause is
            IN it), so the gap between the two IS the pause. Two free tiles could
            wrap onto different lines, which is when that comparison is lost. */}
        <View style={st.pairTile}>
          <View style={st.pairHalf}>
            <Text style={st.statTileLbl}>{IS_NARROW ? 'Presence' : 'Presence (at work)'}</Text>
            {/* Green at/over the standard day, red under it. Decided server-side
                (met_standard) so the app, the web popup and the image agree. */}
            <Text style={[st.statTileBig, { color: sum.met_standard ? COLORS.green : COLORS.red }]}>
              {sum.presence_display || '0m'}
            </Text>
            {sum.standard_display ? (
              <Text style={[st.statTileFoot, { color: sum.met_standard ? COLORS.green : COLORS.red }]}>
                {sum.met_standard ? '✓ ' : '▾ '}{sum.standard_display} standard
              </Text>
            ) : null}
            {presenceFootnote(sum) ? (
              <Text style={st.pairFoot} numberOfLines={1}>{presenceFootnote(sum)}</Text>
            ) : null}
          </View>
          <View style={st.pairRule} />
          {/* Accounted + Other/Idle = the clock, always. */}
          <View style={st.pairHalf}>
            <Text style={st.statTileLbl}>Accounted</Text>
            <Text style={[st.statTileBig, { color: COLORS.blue || '#2563EB' }]}>
              {sum.accounted_display || '0m'}
            </Text>
            <Text style={st.statTileFoot}>
              {IS_NARROW ? '+ paused' : 'task + meeting + lunch + break + no-tasks + paused'}
            </Text>
          </View>
        </View>
        {/* Only when the day was actually frozen: outside Presence, inside
            Accounted, so this is exactly the gap between those two figures. */}
        {(sum.paused_seconds || 0) > 0 ? (
          <View style={st.statTile}>
            <Text style={st.statTileLbl}>Workday paused</Text>
            <Text style={[st.statTileBig, { color: '#B45309' }]}>{sum.paused_display || '0m'}</Text>
            <Text style={st.statTileFoot}>
              {IS_NARROW ? 'not in Presence' : 'outside Presence, not worked time'}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Every start and end of the day (admin view: /kpi_owner/employee_day
          sends `sessions`). Attendance is the FIRST start; a restart or a reopen
          later shows here rather than changing it. */}
      {(sum.sessions || []).length ? (
        <View style={st.logBox}>
          <Text style={st.awayTitle}>🕘  Start / end log</Text>
          <Text style={[st.logArrival, sum.late ? { color: COLORS.amber } : { color: COLORS.green }]}>
            First start {sum.first_login} · {sum.late ? 'Late' : 'On time'}
          </Text>
          {sum.sessions.map((x) => (
            <View key={x.n} style={st.logRow}>
              <Text style={st.logNum}>{x.n}</Text>
              <View style={{ flex: 1 }}>
                <Text style={st.logTxt}>
                  {x.login} → {x.open ? 'now' : (x.logout || '—')}
                  <Text style={st.logDur}>  ·  {x.duration_display}</Text>
                </Text>
                {x.reopened ? (
                  <Text style={st.logReopen} numberOfLines={3}>
                    ↩ Reopened{x.reopened_at ? ` ${x.reopened_at}` : ''}{x.reopened_by ? ` by ${x.reopened_by}` : ''}
                    {x.reopen_reason ? ` — ${x.reopen_reason}` : ''}
                  </Text>
                ) : null}
              </View>
              <Text style={[st.logTag, x.open ? st.logTagOpen : x.auto_closed ? st.logTagAuto : null]}>
                {x.open ? '● Open' : x.auto_closed ? 'Auto-closed' : 'Ended'}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={st.awayBox}>
        <Text style={st.awayTitle}>☕  Away time <Text style={st.awaySub}>(inside Presence — never Productive)</Text></Text>
        <View style={st.awayGrid}>
          {[
            ['Break', sum.break_display],
            ['Lunch', sum.lunch_display],
            ['Meeting', sum.meeting_display],
            // Its own bucket: time with nothing assigned is not the developer's
            // fault and must not read as idling.
            ['No tasks', sum.no_tasks_display],
            ['Other', sum.other_display],
            // Time a task was stopped by the system: Pause Workday, or the
            // midnight close.
            ['Away (system)', sum.away_display],
            ['Other/Idle', sum.other_idle_display],
          ].map(([lbl, val]) => (
            <View key={lbl} style={st.awayCell}>
              <Text style={st.awayCellLbl}>{lbl}</Text>
              <Text style={st.awayCellVal}>{val || '0m'}</Text>
            </View>
          ))}
        </View>
        {(sum.away_events || []).map((e, i) => {
          // Urgent breaks are highlighted yellow, matching the web module. The
          // payload key is `note`, not `reason`.
          const urgent = /urgent/i.test(e.label || '') || /urgent/i.test(e.note || '') || e.is_urgent === true;
          return (
            <View key={i} style={st.awayEvent}>
              <View style={[st.awayTag, urgent && st.awayTagUrgent]}>
                <Text style={[st.awayTagTxt, urgent && st.awayTagTxtUrgent]}>{e.label}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.awayEventTxt} numberOfLines={1}>
                  {e.start}–{e.end} ({e.duration_display}){e.from ? ` from "${e.from}"` : ''}
                </Text>
                {(e.with || e.note) ? (
                  <Text style={st.awayEventNote} numberOfLines={2}>
                    {e.with ? `with ${e.with}` : ''}
                    {e.with && e.note ? ' — ' : ''}
                    {e.note || ''}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      <View style={st.mapBox}>
        <Text style={st.mapTitle}>
          🗺  Workday Map <Text style={st.awaySub}>({self ? 'your day' : `${who}'s day`} in order)</Text>
        </Text>
        <WorkdayTimeline timeline={sum.timeline} now={now} />
      </View>

      {self ? (
        <Text style={st.endHint}>⚠  Use Complete for finished tasks — Pause is only for breaks/interruptions.</Text>
      ) : null}

      <Text style={st.tasksTitle}>Tasks worked today ({tasks.length})</Text>
      <View style={st.taskTableHead}>
        <Text style={st.thRef}>Ref</Text>
        <Text style={st.thTitle}>Title</Text>
        <Text style={st.thTime}>Time</Text>
      </View>
      {tasks.length === 0 ? (
        <Text style={st.centerTxt}>No task time logged.</Text>
      ) : tasks.map((t) => (
        <View key={t.kpi_id} style={st.taskRow}>
          <Text style={st.tdRef}>{t.concurrent ? '⚡ ' : ''}{t.ref}</Text>
          <View style={{ flex: 1 }}>
            <Text style={st.tdTitle} numberOfLines={1}>{t.name}</Text>
            {/* Spelled out only when a task was worked BOTH alone and alongside
                another — the case a single total gets wrong. */}
            {t.concurrent && (t.solo_seconds || 0) > 0 ? (
              <Text style={[st.tdTitle, { fontSize: 11, opacity: 0.7 }]} numberOfLines={1}>
                {t.solo_display} alone · {t.shared_display} shared
              </Text>
            ) : null}
          </View>
          <Text style={st.tdTime}>{t.duration_display}</Text>
        </View>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  autoClosedBox: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg,
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 12,
  },
  autoClosedTxt: { fontSize: 12.5, fontWeight: '700', color: '#7a5200' },
  missingBox: {
    backgroundColor: COLORS.amberBg, borderRadius: 10, padding: 10, marginBottom: 12,
    borderWidth: 1, borderColor: '#F3DFA8',
  },
  missingTitle: { fontSize: 13, fontWeight: '800', color: '#7a5200' },
  missingHint: { fontSize: 11.5, color: '#7a5200', marginTop: 2, marginBottom: 6 },
  missingHintRed: { fontSize: 12, color: '#DC2626', fontWeight: '800', marginTop: 2, marginBottom: 6 },
  missingRow: { fontSize: 12, color: '#7a5200', marginTop: 3, lineHeight: 17 },

  // MUST WRAP: up to five tiles. flexBasis is the wrap threshold, not a fixed
  // width — 128 puts two per row on a 320dp phone and all five across a tablet.
  statTiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  statTile: { flexGrow: 1, flexBasis: 128, minWidth: 128, backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 10 },
  // Sized as TWO statTiles so it flows inline beside Login and Productive, and
  // can never be split across lines because it is a single element.
  pairTile: { flexGrow: 1, flexBasis: 264, minWidth: 240, flexDirection: 'row', backgroundColor: '#F7F9FC', borderRadius: 12, borderWidth: 1, borderColor: COLORS.line },
  pairHalf: { flex: 1, padding: 10 },
  pairRule: { width: 1, backgroundColor: COLORS.line, marginVertical: 8 },
  pairFoot: { fontSize: 10, color: COLORS.muted, fontWeight: '700', marginTop: 3 },
  statTileLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  statTileVal: { fontSize: 13, color: COLORS.ink, fontWeight: '800', marginTop: 4 },
  statTileBig: { fontSize: IS_NARROW ? 17 : 19, fontWeight: '900', marginTop: 4 },
  statTileFoot: { fontSize: 10.5, fontWeight: '800', marginTop: 2 },

  logBox: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginTop: 14, borderWidth: 1, borderColor: COLORS.line },
  logArrival: { fontSize: 12.5, fontWeight: '800', marginTop: 4, marginBottom: 4 },
  logRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#F0F3F8' },
  logNum: { width: 18, fontSize: 12, fontWeight: '900', color: COLORS.muted, marginTop: 1 },
  logTxt: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  logDur: { color: COLORS.muted, fontWeight: '800' },
  logReopen: { fontSize: 11.5, color: COLORS.amber, fontWeight: '700', marginTop: 2 },
  logTag: { fontSize: 11, fontWeight: '800', color: COLORS.muted, backgroundColor: '#F1F5F9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  logTagOpen: { color: '#1D4ED8', backgroundColor: '#DBEAFE' },
  logTagAuto: { color: '#B45309', backgroundColor: '#FEF3C7' },
  awayBox: { backgroundColor: '#FEF9E7', borderRadius: 12, padding: 12, marginTop: 14 },
  awayTitle: { fontSize: 13.5, fontWeight: '900', color: COLORS.ink },
  awaySub: { fontSize: 11.5, fontWeight: '600', color: COLORS.muted },
  awayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  awayCell: { width: '31.5%', backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 8, alignItems: 'center' },
  awayCellLbl: { fontSize: 10.5, color: COLORS.muted, fontWeight: '700' },
  awayCellVal: { fontSize: 14, color: COLORS.ink, fontWeight: '900', marginTop: 2 },
  awayEvent: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  awayTag: { backgroundColor: '#E7ECF3', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  awayTagTxt: { fontSize: 11, fontWeight: '800', color: COLORS.ink },
  awayTagUrgent: { backgroundColor: '#F6C244' },   // yellow, like the web module
  awayTagTxtUrgent: { color: '#5c4400' },
  awayEventTxt: { fontSize: 11.5, color: COLORS.muted },
  awayEventNote: { fontSize: 11, color: COLORS.faint, fontStyle: 'italic', marginTop: 1 },

  mapBox: { marginTop: 12, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10 },
  mapTitle: { fontSize: 14, fontWeight: '800', color: COLORS.navy, marginBottom: 8 },

  endHint: { fontSize: 12.5, color: COLORS.red, fontWeight: '700', marginTop: 12 },
  tasksTitle: { fontSize: 14.5, fontWeight: '900', color: COLORS.navy, marginTop: 16, marginBottom: 6 },
  taskTableHead: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: COLORS.line, paddingBottom: 6 },
  thRef: { width: 50, fontSize: 12, fontWeight: '800', color: COLORS.muted },
  thTitle: { flex: 1, fontSize: 12, fontWeight: '800', color: COLORS.muted },
  thTime: { width: 64, fontSize: 12, fontWeight: '800', color: COLORS.muted, textAlign: 'right' },
  centerTxt: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center', paddingVertical: 12 },
  taskRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  tdRef: { width: 50, fontSize: 13, fontWeight: '800', color: COLORS.ink },
  tdTitle: { flex: 1, fontSize: 13, color: COLORS.ink },
  tdTime: { width: 64, fontSize: 13, fontWeight: '800', color: COLORS.navy, textAlign: 'right' },
});
