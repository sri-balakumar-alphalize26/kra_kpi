// AttendanceScreen renders against the service's mock data (no server), which
// is the same shape the bridge sends. What this pins down: the three states the
// screen can open in (loading → the Me view; the "not linked to HR" empty
// state; a server refusal), and that the Team tab only exists when the server
// says can_view_team.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ getConnection: jest.fn(async () => ({ serverUrl: '' })) }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const attendance = require('../../services/attendance');
const AttendanceScreen = require('../AttendanceScreen').default;

describe('AttendanceScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('opens on the Me view with today, the week, the month and the history', async () => {
    const { getByText, getAllByText, queryByText } = render(<AttendanceScreen onBack={() => {}} />);
    // First render in the file pays the module warm-up; the default 1s is not enough.
    await waitFor(() => getByText('THIS WEEK'), { timeout: 8000 });
    // Today card: the mock day is late by 12 min and still open.
    expect(getByText('by 12 min')).toBeTruthy();
    expect(getByText('Working')).toBeTruthy();
    expect(getByText('10:12 AM')).toBeTruthy();
    // Month tiles and the history chips. "Half day" is a tile AND a pill in the
    // history, so it is counted rather than fetched.
    expect(getAllByText('Half day').length).toBeGreaterThanOrEqual(2);
    expect(getByText('30d')).toBeTruthy();
    expect(getByText('HISTORY')).toBeTruthy();
    // The mock says can_view_team, so the segment control is there.
    expect(getByText('Team')).toBeTruthy();
    expect(getAllByText('Me').length).toBeGreaterThan(0);
    expect(queryByText('Not linked to HR yet')).toBeNull();
  });

  it('switches to the Team tab and lists the roster plus the unlinked logins', async () => {
    const { getByText } = render(<AttendanceScreen onBack={() => {}} />);
    await waitFor(() => getByText('Team'));
    fireEvent.press(getByText('Team'));
    await waitFor(() => getByText('Arun K.'));
    expect(getByText('Karthik S.')).toBeTruthy();
    expect(getByText('NOT IN HR (1)')).toBeTruthy();
    fireEvent.press(getByText('NOT IN HR (1)'));
    expect(getByText('· New Joiner')).toBeTruthy();
  });

  it('shows the "not linked to HR" state instead of an empty page', async () => {
    jest.spyOn(attendance, 'fetchMyAttendance').mockResolvedValue({
      status: true, has_employee: false, message: 'Your login is not linked to an HR employee yet.',
    });
    const { getByText, queryByText } = render(<AttendanceScreen onBack={() => {}} />);
    await waitFor(() => getByText('Not linked to HR yet'));
    expect(queryByText('THIS WEEK')).toBeNull();
    expect(queryByText('Team')).toBeNull();
  });

  it('surfaces a server refusal with a Retry', async () => {
    jest.spyOn(attendance, 'fetchMyAttendance').mockResolvedValue({ status: false, message: 'Attendance is not enabled in the app.' });
    const { getByText } = render(<AttendanceScreen onBack={() => {}} />);
    await waitFor(() => getByText('Attendance is not enabled in the app.'));
    expect(getByText('Retry')).toBeTruthy();
  });

  it('hides the Team tab when the server says the caller cannot see it', async () => {
    const real = await attendance.fetchMyAttendance(7);
    jest.spyOn(attendance, 'fetchMyAttendance').mockResolvedValue({ ...real, can_view_team: false });
    const { getByText, queryByText } = render(<AttendanceScreen onBack={() => {}} />);
    await waitFor(() => getByText('THIS WEEK'));
    expect(queryByText('Team')).toBeNull();
  });
});
