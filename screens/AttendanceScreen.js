// ATTENDANCE — what the floating bubble on Home opens.
//
// The HR attendance behind Start / End Workday, read from hr_attendance_369
// through kra_kpi_attendance_bridge. Two views on one screen:
//
//   Me   — today (a blue card), this week (7 tiles), the month's counts, and
//          a day-by-day history with 7 / 30 / 90-day chips. Self-scoped
//          server-side: /kpi_attendance/mine never takes a user id.
//   Team — admins and HR only (the server says who, via can_view_team): the
//          same blue card showing the team's counts for one day, a day
//          stepper, and one row per person.
//
// Read-only on purpose. Checking in and out stays with the workday buttons;
// this screen only shows what those produced. Layout follows the approved
// design (artboard E on the "Attendance UI Options" canvas).

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
  RefreshControl, Modal, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { fetchMyAttendance, fetchTeamAttendance, statusStyle } from '../services/attendance';
import { fmtYMD, parseYMD, MONTH_NAMES } from '../utils/dateGrid';
import { createLogger } from '../api/logger';

const log = createLogger('Attendance');

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animate = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

const BLUE = COLORS.primary;
const WEEK_HEAD = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// "Late by 12 min" for the headline; '' when there is nothing to say.
function lateLine(row) {
  if (!row?.is_late || !row.late_minutes_display) return '';
  return `by ${row.late_minutes_display}`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Pill({ status, text }) {
  const st = statusStyle(status);
  return (
    <View style={[s.pill, { backgroundColor: st.bg }]}>
      <Text style={[s.pillTxt, { color: st.fg }]}>{text || st.label}</Text>
    </View>
  );
}

// The blue card at the top of "Me": one person's day.
function TodayCard({ row }) {
  const st = statusStyle(row?.status);
  const late = lateLine(row);
  const dateLabel = row?.date ? (parseYMD(row.date) || new Date()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) : '';
  return (
    <View style={s.blue}>
      <View style={s.blueTop}>
        <Text style={s.blueDate}>Today · {dateLabel}</Text>
        {row?.is_wfh ? <View style={s.blueTag}><Text style={s.blueTagTxt}>WFH</Text></View> : null}
      </View>
      <View style={s.blueHead}>
        <Text style={s.blueStatus} numberOfLines={1}>{st.label}</Text>
        {late ? <Text style={s.blueLate}>{late}</Text> : null}
        {row?.open ? (
          <View style={s.working}>
            <View style={s.workingDot} />
            <Text style={s.workingTxt}>Working</Text>
          </View>
        ) : null}
      </View>
      <View style={s.blueCells}>
        <View style={s.blueCell}><Text style={s.blueCellLbl}>CHECK-IN</Text><Text style={s.blueCellVal}>{row?.check_in_office_time || '—'}</Text></View>
        <View style={s.blueCell}><Text style={s.blueCellLbl}>CHECK-OUT</Text><Text style={[s.blueCellVal, !row?.check_out_office_time && s.blueCellDim]}>{row?.check_out_office_time || '—'}</Text></View>
        <View style={s.blueCell}><Text style={s.blueCellLbl}>WORKED</Text><Text style={s.blueCellVal}>{row?.worked_display || '—'}</Text></View>
      </View>
      {row?.from_kra ? (
        <View style={s.blueFoot}>
          <Ionicons name="link-outline" size={13} color="rgba(255,255,255,0.7)" />
          <Text style={s.blueFootTxt}>From your KRA workday</Text>
        </View>
      ) : null}
    </View>
  );
}

// The same blue card for "Team": the day's counts instead of one person's times.
function TeamCard({ label, counts, isToday }) {
  const c = counts || {};
  const cells = [
    ['Present', c.present, '#86EFAC'], ['Late', c.late, '#FCD34D'], ['Half', c.half_day, '#FCD34D'],
    ['Absent', c.absent, '#FCA5A5'], ['WFH', c.wfh, '#BFDBFE'], ['Leave', c.leave, '#BFDBFE'],
  ];
  return (
    <View style={s.blue}>
      <View style={s.blueTop}>
        <Text style={s.blueDate}>{isToday ? 'Team · Today' : 'Team'} · {label || ''}</Text>
        {(c.not_checked_in || 0) > 0 && isToday ? (
          <View style={s.blueTag}><Text style={s.blueTagTxt}>{c.not_checked_in} not in yet</Text></View>
        ) : null}
      </View>
      <View style={s.teamGrid}>
        {cells.map(([lbl, n, color]) => (
          <View key={lbl} style={s.teamCell}>
            <Text style={[s.teamNum, { color }]}>{n || 0}</Text>
            <Text style={s.teamLbl}>{lbl}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// This week — seven tiles, Monday first, today outlined.
function WeekStrip({ week, onPick, onCalendar }) {
  return (
    <View style={s.card}>
      <View style={s.cardHeadRow}>
        <Text style={s.eyebrow}>THIS WEEK</Text>
        <TouchableOpacity onPress={onCalendar} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={s.link}>Open calendar</Text>
        </TouchableOpacity>
      </View>
      <View style={s.weekRow}>
        {(week || []).map((d, i) => {
          const st = statusStyle(d.status);
          const future = d.status === 'upcoming';
          return (
            <TouchableOpacity
              key={d.date || i}
              style={[s.weekTile, { backgroundColor: st.bg }, d.is_today && s.weekTileToday, future && s.weekTileFuture]}
              onPress={() => (!future ? onPick(d) : null)}
              activeOpacity={future ? 1 : 0.8}
            >
              <Text style={[s.weekDow, { color: d.is_today ? BLUE : st.fg }]}>{WEEK_HEAD[i] || d.weekday}</Text>
              <Text style={[s.weekNum, { color: d.is_today ? BLUE : st.fg }]}>{d.day_number}</Text>
              <View style={[s.weekDot, { backgroundColor: st.dot }]} />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function MonthTiles({ month }) {
  const m = month || {};
  const tiles = [
    ['Present', m.present, '#15803D'], ['Late', m.late, '#B45309'], ['Half day', m.half_day, '#B45309'],
    ['Absent', m.absent, '#B91C1C'], ['Leave', m.leave, '#1D4ED8'],
  ];
  return (
    <View>
      <Text style={[s.eyebrow, s.eyebrowPad]}>{(m.label || 'THIS MONTH').toUpperCase()}</Text>
      <View style={s.tileRow}>
        {tiles.map(([lbl, n, color]) => (
          <View key={lbl} style={s.tile}>
            <Text style={[s.tileNum, { color }]}>{n || 0}</Text>
            <Text style={s.tileLbl}>{lbl}</Text>
          </View>
        ))}
      </View>
      {(m.deduction_total || 0) > 0 ? (
        <View style={s.deduct}>
          <MaterialCommunityIcons name="cash-minus" size={16} color="#B91C1C" />
          <Text style={s.deductTxt}>₹ {Number(m.deduction_total).toLocaleString('en-IN')} deducted this month (half days)</Text>
        </View>
      ) : null}
    </View>
  );
}

// One history / team row. `left` is the date column for Me and the name for Team.
function DayRow({ row, left, sub, open, onPress, flash, last }) {
  const st = statusStyle(row.status);
  const times = row.check_in_office_time
    ? `${row.check_in_office_time} → ${row.check_out_office_time || (row.open ? 'Working…' : '—')}`
    : (row.status === 'leave' ? 'Approved leave' : row.status_label);
  const bits = [];
  if (row.worked_display) bits.push(`${row.worked_display} worked`);
  if (row.is_late && row.late_minutes_display) bits.push(`late by ${row.late_minutes_display}`);
  if ((row.deduction_amount || 0) > 0) bits.push(`₹ ${row.deduction_amount} deducted`);
  if (row.status === 'leave' && row.status_display && row.status_display !== 'Leave') bits.push(row.status_display);
  const pillTxt = row.status === 'late' && row.late_minutes_display ? `Late ${row.late_minutes_display}` : undefined;
  return (
    <TouchableOpacity style={[s.row, !last && s.rowLine, flash && s.rowFlash]} onPress={onPress} activeOpacity={0.75}>
      <View style={s.rowMain}>
        {left}
        <View style={{ flex: 1 }}>
          <Text style={s.rowTimes} numberOfLines={1}>{times}</Text>
          {bits.length ? <Text style={s.rowSub} numberOfLines={1}>{bits.join(' · ')}</Text> : (sub ? <Text style={s.rowSub}>{sub}</Text> : null)}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Pill status={row.status} text={pillTxt} />
          {row.is_wfh ? <Text style={s.wfhMini}>WFH</Text> : null}
        </View>
      </View>
      {open ? (
        <View style={s.rowMore}>
          {row.status_display ? <Text style={s.rowMoreTxt}><Text style={s.rowMoreKey}>Status: </Text>{row.status_display}</Text> : null}
          {row.late_reason ? <Text style={s.rowMoreTxt}><Text style={s.rowMoreKey}>Late reason: </Text>{row.late_reason}</Text> : null}
          {row.from_kra ? <Text style={s.rowMoreTxt}><Text style={s.rowMoreKey}>Source: </Text>KRA workday (Start / End Workday)</Text> : null}
          {!row.status_display && !row.late_reason && !row.from_kra ? <Text style={s.rowMoreTxt}>Nothing more recorded for this day.</Text> : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// The month grid behind "Open calendar". Built from the rows already loaded,
// so it costs no extra call; a day outside the loaded range is just a number.
function MonthSheet({ visible, onClose, days, today }) {
  const byDate = useMemo(() => {
    const m = {};
    (days || []).forEach((r) => { m[r.date] = r; });
    return m;
  }, [days]);
  const ref = parseYMD(today) || new Date();
  const y = ref.getFullYear(); const mo = ref.getMonth();
  const first = new Date(y, mo, 1);
  const lead = (first.getDay() + 6) % 7;      // Monday-first
  const count = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= count; d += 1) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const legend = ['present', 'late', 'half_day', 'leave', 'absent', 'day_off'];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.sheetBack} activeOpacity={1} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.sheetGrip} />
        <Text style={s.sheetTitle}>{MONTH_NAMES[mo]} {y}</Text>
        <View style={s.calHead}>{WEEK_HEAD.map((h) => <Text key={h} style={s.calHeadTxt}>{h}</Text>)}</View>
        <View style={s.calGrid}>
          {cells.map((d, i) => {
            if (!d) return <View key={`e${i}`} style={s.calCell} />;
            const key = fmtYMD(new Date(y, mo, d));
            const row = byDate[key];
            const st = row ? statusStyle(row.status) : null;
            const isToday = key === today;
            const future = new Date(y, mo, d) > new Date();
            return (
              <View key={key} style={[s.calCell, isToday && s.calToday, row && row.status !== 'upcoming' && { backgroundColor: st.bg }]}>
                <Text style={[s.calNum, future && { color: COLORS.faint }, isToday && { color: BLUE }, row && !isToday && { color: st.fg }]}>{d}</Text>
                <View style={[s.calDot, { backgroundColor: st ? st.dot : 'transparent' }]} />
              </View>
            );
          })}
        </View>
        <View style={s.legend}>
          {legend.map((k) => { const st = statusStyle(k); return (
            <View key={k} style={s.legendItem}><View style={[s.legendDot, { backgroundColor: st.dot }]} /><Text style={s.legendTxt}>{st.label}</Text></View>
          ); })}
        </View>
        <TouchableOpacity style={s.sheetClose} onPress={onClose}><Text style={s.sheetCloseTxt}>Close</Text></TouchableOpacity>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function AttendanceScreen({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState(null);
  const [rangeDays, setRangeDays] = useState(30);
  const [expanded, setExpanded] = useState({});
  const [flashDate, setFlashDate] = useState(null);
  const [calOpen, setCalOpen] = useState(false);

  const [mode, setMode] = useState('me');         // 'me' | 'team'
  const [team, setTeam] = useState(null);
  const [teamDate, setTeamDate] = useState(null); // YYYY-MM-DD; null = today
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState(null);
  const [teamOpen, setTeamOpen] = useState({});
  const [missingOpen, setMissingOpen] = useState(false);

  const canViewTeam = !!mine?.can_view_team;
  const todayKey = mine?.today?.date || fmtYMD(new Date());

  const loadMine = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchMyAttendance(rangeDays);
      if (!res || res.status === false) {
        setError(res?.message || 'Could not load your attendance.');
        return;
      }
      setMine(res);
    } catch (e) {
      log.warn('mine failed', e?.message);
      setError(e?.message || 'Could not load your attendance.');
    }
  }, [rangeDays]);

  const loadTeam = useCallback(async () => {
    setTeamError(null);
    setTeamLoading(true);
    try {
      const res = await fetchTeamAttendance(teamDate);
      if (!res || res.status === false) {
        setTeamError(res?.message || 'Could not load the team.');
        setTeam(null);
      } else {
        setTeam(res);
      }
    } catch (e) {
      log.warn('team failed', e?.message);
      setTeamError(e?.message || 'Could not load the team.');
    } finally {
      setTeamLoading(false);
    }
  }, [teamDate]);

  useEffect(() => { (async () => { setLoading(true); await loadMine(); setLoading(false); })(); }, [loadMine]);
  useEffect(() => { if (mode === 'team') loadTeam(); }, [mode, loadTeam]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await (mode === 'team' ? Promise.all([loadMine(), loadTeam()]) : loadMine());
    setRefreshing(false);
  }, [mode, loadMine, loadTeam]);

  const toggle = (date) => { animate(); setExpanded((e) => ({ ...e, [date]: !e[date] })); };
  const toggleTeam = (uid) => { animate(); setTeamOpen((e) => ({ ...e, [uid]: !e[uid] })); };

  // A week tile opens that day's row in the history and flashes it, the way a
  // notification tap flashes a task on the board.
  const pickWeekDay = (d) => {
    if (!d?.date) return;
    animate();
    setExpanded((e) => ({ ...e, [d.date]: true }));
    setFlashDate(d.date);
    setTimeout(() => setFlashDate((f) => (f === d.date ? null : f)), 1400);
  };

  const stepTeamDay = (delta) => {
    const cur = parseYMD(teamDate || team?.date || todayKey) || new Date();
    cur.setDate(cur.getDate() + delta);
    const key = fmtYMD(cur);
    setTeamDate(key >= todayKey ? null : key);
  };
  const teamIsToday = !teamDate || teamDate >= todayKey;

  // ── Render ──────────────────────────────────────────────────────────────
  const header = (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <Text style={s.title} numberOfLines={1}>Attendance</Text>
      <TouchableOpacity onPress={onRefresh} style={s.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="refresh" size={20} color={COLORS.navy} />
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <View style={s.root}><GradientBackground />{header}
        <View style={s.center}><ActivityIndicator size="large" color={BLUE} /></View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.root}><GradientBackground />{header}
        <ScrollView contentContainerStyle={s.center} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <Ionicons name="alert-circle-outline" size={40} color={COLORS.red} />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity onPress={onRefresh} style={s.retry}><Text style={s.retryText}>Retry</Text></TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (mine && mine.has_employee === false) {
    return (
      <View style={s.root}><GradientBackground />{header}
        <ScrollView contentContainerStyle={s.center} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <MaterialCommunityIcons name="account-question-outline" size={46} color={COLORS.faint} />
          <Text style={s.emptyTitle}>Not linked to HR yet</Text>
          <Text style={s.empty}>{mine.message || 'Your login is not linked to an HR employee, so there is no attendance to show.'}</Text>
        </ScrollView>
      </View>
    );
  }

  const days = mine?.days || [];

  return (
    <View style={s.root}>
      <GradientBackground />
      {header}

      {canViewTeam ? (
        <View style={s.segment}>
          {[['team', 'Team'], ['me', 'Me']].map(([k, lbl]) => (
            <TouchableOpacity key={k} style={[s.segBtn, mode === k && s.segBtnOn]} onPress={() => setMode(k)} activeOpacity={0.85}>
              <Text style={[s.segTxt, mode === k && s.segTxtOn]}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {mode === 'team' ? (
          <>
            <View style={s.stepper}>
              <TouchableOpacity style={s.stepBtn} onPress={() => stepTeamDay(-1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-back" size={18} color={COLORS.navy} />
              </TouchableOpacity>
              <Text style={s.stepLbl}>{teamIsToday ? 'Today' : ''}{teamIsToday && team?.label ? ', ' : ''}{team?.label || ''}</Text>
              <TouchableOpacity style={[s.stepBtn, teamIsToday && s.stepBtnOff]} onPress={() => (!teamIsToday ? stepTeamDay(1) : null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-forward" size={18} color={teamIsToday ? COLORS.faint : COLORS.navy} />
              </TouchableOpacity>
            </View>

            <TeamCard label={team?.label} counts={team?.counts} isToday={teamIsToday} />

            {teamLoading && !team ? (
              <View style={[s.center, { paddingVertical: 30 }]}><ActivityIndicator color={BLUE} /></View>
            ) : teamError ? (
              <View style={s.card}><Text style={s.errorText}>{teamError}</Text></View>
            ) : (
              <>
                <View style={[s.card, { padding: 0 }]}>
                  {(team?.rows || []).length === 0 ? (
                    <Text style={[s.empty, { padding: 16 }]}>Nobody on the roster is linked to HR yet.</Text>
                  ) : (team.rows.map((r, i) => (
                    <DayRow
                      key={r.user_id}
                      row={r}
                      open={!!teamOpen[r.user_id]}
                      onPress={() => toggleTeam(r.user_id)}
                      last={i === team.rows.length - 1}
                      left={(
                        <View style={s.nameCol}>
                          <Text style={s.nameTxt} numberOfLines={1}>{r.name}</Text>
                          {r.is_admin ? <Text style={s.nameSub}>Admin</Text> : null}
                        </View>
                      )}
                    />
                  )))}
                </View>

                {(team?.not_in_hr || []).length > 0 ? (
                  <View style={s.card}>
                    <TouchableOpacity style={s.cardHeadRow} onPress={() => { animate(); setMissingOpen((v) => !v); }} activeOpacity={0.8}>
                      <Text style={s.eyebrow}>NOT IN HR ({team.not_in_hr.length})</Text>
                      <Ionicons name={missingOpen ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.faint} />
                    </TouchableOpacity>
                    {missingOpen ? (
                      <View style={{ marginTop: 6 }}>
                        <Text style={s.hint}>These logins have no HR employee record, so their days are not graded. Link them in Odoo → Employees.</Text>
                        {team.not_in_hr.map((u) => <Text key={u.user_id} style={s.missingName}>· {u.name}</Text>)}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <TodayCard row={mine?.today} />
            <WeekStrip week={mine?.week} onPick={pickWeekDay} onCalendar={() => setCalOpen(true)} />
            <MonthTiles month={mine?.month} />

            <View style={s.histHead}>
              <Text style={s.eyebrow}>HISTORY</Text>
              <View style={s.chips}>
                {[7, 30, 90].map((d) => (
                  <TouchableOpacity key={d} style={[s.chip, rangeDays === d && s.chipOn]} onPress={() => setRangeDays(d)} activeOpacity={0.85}>
                    <Text style={[s.chipTxt, rangeDays === d && s.chipTxtOn]}>{d}d</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={[s.card, { padding: 0 }]}>
              {days.length === 0 ? (
                <Text style={[s.empty, { padding: 16 }]}>No attendance in the last {rangeDays} days.</Text>
              ) : days.map((r, i) => (
                <DayRow
                  key={r.date}
                  row={r}
                  open={!!expanded[r.date]}
                  flash={flashDate === r.date}
                  onPress={() => toggle(r.date)}
                  last={i === days.length - 1}
                  left={(
                    <View style={s.dateCol}>
                      <Text style={s.dateNum}>{r.day_number}</Text>
                      <Text style={s.dateDow}>{r.weekday}</Text>
                    </View>
                  )}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>

      <MonthSheet visible={calOpen} onClose={() => setCalOpen(false)} days={days} today={todayKey} />
    </View>
  );
}

// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 10 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...(SHADOW || {}) },
  title: { flex: 1, textAlign: 'center', marginHorizontal: 8, fontSize: 18, fontWeight: '800', color: COLORS.navy },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  errorText: { marginTop: 10, color: COLORS.red, textAlign: 'center' },
  retry: { marginTop: 14, backgroundColor: BLUE, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '700' },
  empty: { marginTop: 8, color: COLORS.muted, textAlign: 'center', lineHeight: 19 },
  emptyTitle: { marginTop: 12, fontSize: 16, fontWeight: '800', color: COLORS.navy },
  hint: { fontSize: 12, color: COLORS.muted, lineHeight: 17 },

  segment: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 12, backgroundColor: COLORS.line, borderRadius: 12, padding: 4, gap: 4 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  segBtnOn: { backgroundColor: '#fff', ...(SHADOW || {}) },
  segTxt: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  segTxtOn: { color: COLORS.navy, fontWeight: '800' },

  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 },
  stepBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...(SHADOW || {}) },
  stepBtnOff: { opacity: 0.5 },
  stepLbl: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy, minWidth: 130, textAlign: 'center' },

  // The blue card
  blue: { backgroundColor: BLUE, borderRadius: 18, padding: 16, gap: 14, shadowColor: BLUE, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  blueTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  blueDate: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.75)' },
  blueTag: { backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  blueTagTxt: { color: '#fff', fontSize: 11.5, fontWeight: '800' },
  blueHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  blueStatus: { fontSize: 32, fontWeight: '800', color: '#fff', letterSpacing: -0.5, lineHeight: 36, flexShrink: 1 },
  blueLate: { fontSize: 14, fontWeight: '700', color: '#FCD34D' },
  working: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 },
  workingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ADE80' },
  workingTxt: { fontSize: 12, fontWeight: '700', color: '#86EFAC' },
  blueCells: { flexDirection: 'row', gap: 8 },
  blueCell: { flex: 1, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 3 },
  blueCellLbl: { fontSize: 10.5, fontWeight: '700', color: 'rgba(255,255,255,0.7)' },
  blueCellVal: { fontSize: 16, fontWeight: '800', color: '#fff' },
  blueCellDim: { color: 'rgba(255,255,255,0.55)' },
  blueFoot: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: -4 },
  blueFootTxt: { fontSize: 11.5, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  teamGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  teamCell: { width: '31%', flexGrow: 1, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, paddingVertical: 10, alignItems: 'center', gap: 2 },
  teamNum: { fontSize: 20, fontWeight: '800' },
  teamLbl: { fontSize: 10.5, fontWeight: '700', color: 'rgba(255,255,255,0.75)' },

  // White cards
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 12, ...(SHADOW || {}) },
  cardHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  eyebrow: { fontSize: 11.5, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted },
  eyebrowPad: { paddingLeft: 2, marginBottom: 8 },
  link: { fontSize: 11.5, fontWeight: '700', color: COLORS.link },

  weekRow: { flexDirection: 'row', gap: 4, marginTop: 8 },
  weekTile: { flex: 1, height: 54, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 3 },
  weekTileToday: { backgroundColor: '#fff', borderWidth: 2, borderColor: BLUE },
  weekTileFuture: { backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  weekDow: { fontSize: 10, fontWeight: '800' },
  weekNum: { fontSize: 14, fontWeight: '800' },
  weekDot: { width: 6, height: 6, borderRadius: 3 },

  tileRow: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 4, alignItems: 'center', gap: 2, ...(SHADOW || {}) },
  tileNum: { fontSize: 20, fontWeight: '800' },
  tileLbl: { fontSize: 10.5, fontWeight: '700', color: COLORS.muted },
  deduct: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, backgroundColor: COLORS.redBg, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  deductTxt: { fontSize: 12, fontWeight: '700', color: '#B91C1C', flex: 1 },

  histHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 2 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { backgroundColor: '#fff', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, ...(SHADOW || {}) },
  chipOn: { backgroundColor: BLUE },
  chipTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted },
  chipTxtOn: { color: '#fff' },

  row: { paddingVertical: 12, paddingHorizontal: 14 },
  rowLine: { borderBottomWidth: 1, borderBottomColor: COLORS.line },
  rowFlash: { backgroundColor: '#EAF1FE' },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dateCol: { width: 44, alignItems: 'center' },
  dateNum: { fontSize: 16, fontWeight: '800', color: COLORS.navy },
  dateDow: { fontSize: 10.5, fontWeight: '700', color: COLORS.faint },
  nameCol: { width: 96 },
  nameTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy },
  nameSub: { fontSize: 10.5, fontWeight: '700', color: COLORS.faint },
  rowTimes: { fontSize: 14, fontWeight: '700', color: COLORS.ink },
  rowSub: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
  pill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  pillTxt: { fontSize: 12, fontWeight: '800' },
  wfhMini: { fontSize: 10, fontWeight: '800', color: '#1D4ED8' },
  rowMore: { marginTop: 10, backgroundColor: COLORS.bg, borderRadius: 10, padding: 10, gap: 4 },
  rowMoreTxt: { fontSize: 12.5, color: '#4B5563', lineHeight: 18 },
  rowMoreKey: { fontWeight: '800', color: COLORS.ink },
  missingName: { fontSize: 13, color: COLORS.ink, marginTop: 6, fontWeight: '600' },

  // Month sheet
  sheetBack: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 28 },
  sheetGrip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.line, marginBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: COLORS.navy, textAlign: 'center', marginBottom: 10 },
  calHead: { flexDirection: 'row' },
  calHeadTxt: { flex: 1, textAlign: 'center', fontSize: 10.5, fontWeight: '800', color: COLORS.faint, marginBottom: 4 },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: `${100 / 7}%`, height: 46, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 10 },
  calToday: { borderWidth: 2, borderColor: BLUE },
  calNum: { fontSize: 13.5, fontWeight: '700', color: COLORS.ink },
  calDot: { width: 6, height: 6, borderRadius: 3 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendTxt: { fontSize: 11.5, fontWeight: '700', color: COLORS.muted },
  sheetClose: { marginTop: 16, backgroundColor: BLUE, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  sheetCloseTxt: { color: '#fff', fontWeight: '800' },
});
