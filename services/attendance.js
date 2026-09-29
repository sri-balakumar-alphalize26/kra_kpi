// Attendance — the HR attendance behind the floating button on Home.
//
// Served by kra_kpi_attendance_bridge (an Odoo addon that installs itself
// only when BOTH kra_kpi_module and hr_attendance_369 are present), never by
// kra_kpi_module itself. So every call here has to cope with a server that
// simply does not have these routes: fetchAttendanceStatus() turns that into
// `{ status:false, notInstalled:true }` — the same signal reminderList.js
// uses for a missing model — and Home hides the bubble.
//
// Read-only. Checking in and out stays with Start / End Workday; the bridge
// mirrors those into hr.attendance on the server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Attendance');

// The statuses a row can carry. Six come from hr.attendance.day.status; the
// last three are the bridge's own for days that have no row yet.
export const ATT_STATUS = {
  present:        { label: 'Present',        fg: '#15803D', bg: '#DCFCE7', dot: '#16A34A' },
  late:           { label: 'Late',           fg: '#B45309', bg: '#FEF3C7', dot: '#D97706' },
  half_day:       { label: 'Half day',       fg: '#B45309', bg: '#FEF3C7', dot: '#D97706' },
  absent:         { label: 'Absent',         fg: '#B91C1C', bg: '#FEE2E2', dot: '#DC2626' },
  leave:          { label: 'Leave',          fg: '#1D4ED8', bg: '#DBEAFE', dot: '#2563EB' },
  day_off:        { label: 'Day off',        fg: '#4B5563', bg: '#F1F5F9', dot: '#9CA3AF' },
  not_checked_in: { label: 'Not checked in', fg: '#4B5563', bg: '#F1F5F9', dot: '#9CA3AF' },
  upcoming:       { label: 'Upcoming',       fg: '#9CA3AF', bg: '#FFFFFF', dot: 'transparent' },
  none:           { label: 'No record',      fg: '#6B7280', bg: '#F1F5F9', dot: '#CBD5E1' },
};

export function statusStyle(status) {
  return ATT_STATUS[status] || ATT_STATUS.none;
}

// ---------------------------------------------------------------------------
// Mock data — the numbers on the approved design, so the screen can be looked
// at with no server. Dates are relative so "today" is always today.
// ---------------------------------------------------------------------------
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mockRow(offset, status, extra = {}) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const base = {
    date: ymd(d), day_number: d.getDate(),
    weekday: d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(),
    label: d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }),
    status, status_label: statusStyle(status).label, status_display: statusStyle(status).label,
    check_in: '', check_out: '', check_in_office_time: '', check_out_office_time: '',
    worked_hours: 0, worked_display: '', is_late: false, late_minutes: 0, late_minutes_display: '',
    late_reason: '', is_wfh: false, work_location: '', deduction_amount: 0, from_kra: true,
    open: false, is_today: offset === 0,
  };
  return { ...base, ...extra };
}
function mockMine(daysBack) {
  const today = mockRow(0, 'late', {
    check_in_office_time: '10:12 AM', worked_hours: 4.08, worked_display: '4h 05m',
    is_late: true, late_minutes: 12, late_minutes_display: '12 min', is_wfh: true, open: true,
    status_display: 'Late (10:12 AM) · WFH',
  });
  const pattern = [
    ['present', { check_in_office_time: '9:58 AM', check_out_office_time: '6:31 PM', worked_display: '8h 33m', worked_hours: 8.55 }],
    ['late', { check_in_office_time: '10:22 AM', check_out_office_time: '6:40 PM', worked_display: '8h 18m', worked_hours: 8.3, is_late: true, late_minutes: 22, late_minutes_display: '22 min', late_reason: 'Traffic on OMR, informed HR at 9:50' }],
    ['leave', { status_display: 'Leave - Casual (Paid)' }],
    ['present', { check_in_office_time: '9:45 AM', check_out_office_time: '6:10 PM', worked_display: '8h 25m', worked_hours: 8.42 }],
    ['half_day', { check_in_office_time: '1:05 PM', check_out_office_time: '6:20 PM', worked_display: '5h 15m', worked_hours: 5.25, deduction_amount: 850 }],
    ['day_off', {}],
    ['day_off', {}],
  ];
  const days = [today];
  for (let i = 1; i < daysBack; i += 1) {
    const [st, extra] = pattern[(i - 1) % pattern.length];
    days.push(mockRow(i, st, extra));
  }
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  const week = [];
  for (let i = 0; i < 7; i += 1) {
    const off = dow - i;
    week.push(off < 0 ? mockRow(off, 'upcoming') : (off === 0 ? today : days[off] || mockRow(off, 'present')));
  }
  return {
    status: true, isMock: true, enabled: true, has_employee: true, can_view_team: true,
    employee_name: 'You', office_tz: 'Asia/Kolkata',
    today, week,
    month: { label: new Date().toLocaleDateString('en-GB', { month: 'long' }), present: 18, late: 3, half_day: 1, absent: 0, leave: 2, day_off: 4, wfh: 3, deduction_total: 850 },
    days, days_back: daysBack,
  };
}
function mockTeam(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const mk = (name, status, extra) => ({ ...mockRow(0, status, extra), user_id: name.length, name, has_employee: true, is_admin: false });
  const rows = [
    mk('Arun K.', 'present', { check_in_office_time: '9:41 AM', check_out_office_time: '6:02 PM', worked_display: '8h 21m' }),
    mk('Divya R.', 'late', { check_in_office_time: '10:18 AM', worked_display: '3h 52m', open: true, is_late: true, late_minutes: 18, late_minutes_display: '18 min', is_wfh: true }),
    mk('Karthik S.', 'absent', {}),
    mk('Meena P.', 'leave', { status_display: 'Leave - Sick (Paid)' }),
  ];
  return {
    status: true, isMock: true, date: ymd(d),
    label: d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }),
    is_today: !dateStr,
    counts: { present: 1, late: 1, half_day: 0, absent: 1, leave: 1, day_off: 0, wfh: 1, deduction_total: 0 },
    rows,
    not_in_hr: [{ user_id: 99, name: 'New Joiner' }],
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

// Whether to draw the bubble at all, and the colour of its dot.
// Returns { status, enabled, can_view_team, has_employee, today } — or
// { status:false, notInstalled:true } when the server has no bridge.
export async function fetchAttendanceStatus() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('status — no server, mock');
    return { status: true, isMock: true, enabled: true, can_view_team: true, has_employee: true, today: mockMine(1).today };
  }
  try {
    const res = await jsonRpc(serverUrl, '/kpi_attendance/status', {});
    return res || { status: false, enabled: false };
  } catch (e) {
    // A 404 from Odoo arrives as a thrown JSON-RPC error. Older server, or
    // the bridge is not installed: either way there is nothing to show.
    log.info('status failed (bridge missing?)', e?.message);
    return { status: false, notInstalled: true, enabled: false, message: e?.message || 'Unavailable' };
  }
}

// The caller's own attendance for the last `daysBack` days. HARD-SCOPED
// server-side to the logged-in user.
export async function fetchMyAttendance(daysBack = 30) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('mine — no server, mock');
    return mockMine(daysBack);
  }
  const res = await jsonRpc(serverUrl, '/kpi_attendance/mine', { days: daysBack });
  log.info('mine ←', { status: res?.status, days: res?.days?.length ?? 0 });
  return res || { status: false, message: 'No response' };
}

// The team for one day (YYYY-MM-DD; omit for today). Admin / HR only —
// the route answers { status:false } for anyone else.
export async function fetchTeamAttendance(dateStr) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('team — no server, mock');
    return mockTeam(dateStr);
  }
  const params = dateStr ? { date: dateStr } : {};
  const res = await jsonRpc(serverUrl, '/kpi_attendance/team', params);
  log.info('team ←', { status: res?.status, rows: res?.rows?.length ?? 0 });
  return res || { status: false, message: 'No response' };
}
