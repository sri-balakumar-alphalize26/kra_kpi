// Live Tracking's employee popup. What this pins down: the status line uses the
// paused task's reason and time, a long break turns the line red, the four tabs
// are there, Reset PIN goes through the same route as Login Management, and
// ⏪ Reduce yesterday loads yesterday's time for the task.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('../../components/WorkdaySummaryBody', () => () => null);
jest.mock('../../services/liveTracking', () => ({ fetchEmployeeDay: jest.fn(async () => ({ status: true, started: false })) }));
jest.mock('../../services/loginManagement', () => ({ resetPassword: jest.fn(async () => ({ status: true })) }));
jest.mock('../../services/adminExtras', () => ({
  fetchEmployeeProfile: jest.fn(), nudgeUser: jest.fn(),
  fetchPrevDayTime: jest.fn(), reducePrevDay: jest.fn(),
}));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const { fetchEmployeeProfile, fetchPrevDayTime } = require('../../services/adminExtras');
const { resetPassword } = require('../../services/loginManagement');
const EmployeePopup = require('../EmployeePopup').default;
const { timerLevel, cardText } = require('../EmployeePopup');

const ROW = {
  user_id: 18, name: 'Asha', role: 'Developer', attendance: 'late', arrival: '14:29', started: true,
  active: false, activity_kind: 'break', activity_note: 'Break', elapsed_seconds: 35 * 60,
  active_tasks: [], paused_task: { id: 344, ref: 'REQ-169', name: 'Login', reason: 'Break', at: '14:33' },
  break_start: '14:33', top_tasks: [{ id: 344, ref: 'REQ-169', name: 'Login', state: 'paused', reason: 'Break', at: '14:33' }],
};
const PROFILE = {
  status: true, user_id: 18,
  contact: { name: 'Asha', login: 'asha', role: 'Developer', mobile: '9000000001', dial: '91', country: 'India',
    whatsapp: '919000000001', app_login_enabled: true, last_app_login: '26 Oct 2026, 14:28', last_device: 'Tab',
    allow_multitask: false, pin_is_default: true },
  workload: { tasks: [{ id: 344, ref: 'REQ-169', name: 'Login', client: 'Acme', state: 'paused', state_label: 'Paused',
    deadline: '', overdue: false, due_week: false, estimate_h: 2, spent_h: 1 }],
  counts: { running: 0, paused: 1, todo: 0, hold: 0, approval: 0 }, open: 1, overdue: 0, due_week: 0,
  est_total: 2, spent_total: 1, done_today: 0, done_week: 0, done_month: 0 },
  questions: [], meetings_today: [],
  attendance: { days: [{ date: '2026-10-25', status: 'late', first_login: '10:50' }],
    totals: { on_time: 0, late: 1, absent: 0, working_days: 1 }, joined: '', cutoff: '10:40' },
};

it('describes a break with the paused task and turns red past 30 minutes', () => {
  expect(timerLevel(ROW)).toBe('late');
  expect(timerLevel({ ...ROW, elapsed_seconds: 20 * 60 })).toBe('warn');
  expect(timerLevel({ ...ROW, elapsed_seconds: 5 * 60 })).toBe('');
  const [head, sub] = cardText(ROW);
  expect(head).toBe('On break · 35 min');
  expect(sub).toBe('Paused REQ-169 at 2:33 PM — Break');
});

it('renders the tabs, resets the PIN and opens Reduce yesterday', async () => {
  fetchEmployeeProfile.mockResolvedValue(PROFILE);
  fetchPrevDayTime.mockResolvedValue({
    status: true, date: '2026-10-25', date_display: 'Sun 25 Oct 2026', seconds: 3600, display: '1h 00m',
    people: [], intervals: [], day_totals: [], task_total_display: '1h 00m',
    reasons: [{ key: 'forgot_pause', label: 'Forgot to pause the task' }, { key: 'other', label: 'Other' }],
  });
  const now = Date.now();
  const { getByText, getAllByText } = render(
    <EmployeePopup visible person={ROW} nowMs={now} fetchedAt={now} onClose={() => {}} />,
  );
  await waitFor(() => getByText('Contact & login'), { timeout: 8000 });
  expect(getByText('Default PIN – not changed')).toBeTruthy();
  expect(getByText('Well over the usual break time')).toBeTruthy();
  ['Overview', 'Today', 'History'].forEach((t) => expect(getByText(t)).toBeTruthy());

  fireEvent.press(getByText('Reset PIN'));
  fireEvent.press(getAllByText('Reset PIN').pop());
  await waitFor(() => expect(resetPassword).toHaveBeenCalledWith(18));

  fireEvent.press(getByText('Workload 1'));
  fireEvent.press(getByText('Reduce yesterday'));
  await waitFor(() => getByText('Forgot to pause the task'));
  expect(fetchPrevDayTime).toHaveBeenCalledWith(344);
}, 30000);
