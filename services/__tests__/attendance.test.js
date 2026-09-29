// The attendance service has one job the rest of the app leans on: telling Home
// whether to draw the bubble. Two cases matter more than the happy path —
// a server WITHOUT the bridge (the routes 404, jsonRpc throws) must read as
// "not installed, hide it", never as an error the user sees; and the mock
// path must produce the shape the screen renders, so the screen can be looked
// at with no server at all.

const mockConn = { serverUrl: '' };
const mockRpc = jest.fn();

jest.mock('../../api/session', () => ({
  getConnection: jest.fn(async () => mockConn),
}));
jest.mock('../../api/odooApi', () => ({
  jsonRpc: (...args) => mockRpc(...args),
}));

const {
  fetchAttendanceStatus, fetchMyAttendance, fetchTeamAttendance, statusStyle, ATT_STATUS,
} = require('../attendance');

describe('attendance service', () => {
  beforeEach(() => { mockRpc.mockReset(); mockConn.serverUrl = ''; });

  it('reads a missing route as notInstalled, not as an error', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockRejectedValueOnce(new Error('404: Not Found'));
    const res = await fetchAttendanceStatus();
    expect(res.status).toBe(false);
    expect(res.notInstalled).toBe(true);
    expect(res.enabled).toBe(false);
  });

  it('passes the server answer through when the bridge is there', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockResolvedValueOnce({ status: true, enabled: true, can_view_team: false, today: { status: 'late', open: true } });
    const res = await fetchAttendanceStatus();
    expect(mockRpc).toHaveBeenCalledWith('https://odoo.example.com', '/kpi_attendance/status', {});
    expect(res.enabled).toBe(true);
    expect(res.today.status).toBe('late');
  });

  it('sends the history range as `days`', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockResolvedValueOnce({ status: true, days: [] });
    await fetchMyAttendance(90);
    expect(mockRpc).toHaveBeenCalledWith('https://odoo.example.com', '/kpi_attendance/mine', { days: 90 });
  });

  it('omits the date for "today" on the team call', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockResolvedValue({ status: true, rows: [] });
    await fetchTeamAttendance();
    expect(mockRpc).toHaveBeenLastCalledWith('https://odoo.example.com', '/kpi_attendance/team', {});
    await fetchTeamAttendance('2026-09-25');
    expect(mockRpc).toHaveBeenLastCalledWith('https://odoo.example.com', '/kpi_attendance/team', { date: '2026-09-25' });
  });

  it('mock data has the shape the screen renders', async () => {
    const res = await fetchMyAttendance(30);
    expect(res.isMock).toBe(true);
    expect(res.today.open).toBe(true);
    expect(res.week).toHaveLength(7);
    expect(res.days).toHaveLength(30);
    expect(res.days[0].is_today).toBe(true);
    expect(res.month.present).toBeGreaterThan(0);
    const team = await fetchTeamAttendance();
    expect(team.rows.length).toBeGreaterThan(0);
    expect(team.counts.present).toBeDefined();
  });

  it('never returns an undefined style for an unknown status', () => {
    expect(statusStyle('something_new')).toBe(ATT_STATUS.none);
    expect(statusStyle(undefined)).toBe(ATT_STATUS.none);
    expect(statusStyle('late').label).toBe('Late');
  });
});
