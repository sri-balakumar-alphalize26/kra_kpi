// Client Task Queue. What this pins down:
//  - an admin whose role lookup FAILS is not shown "Admins only": the last
//    role the server gave (cached) lets them in, and with nothing cached the
//    screen says it could not check, with a Retry;
//  - 🚫 Refused lists declined requests and ↩️ Restore calls the route.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../services/roleInfo', () => ({ fetchRoleInfo: jest.fn() }));
jest.mock('../../services/pendingQueue', () => ({
  fetchQueue: jest.fn(async () => ({ queue: [] })),
  saveQueueTask: jest.fn(), publishQueueTask: jest.fn(), discardQueueTask: jest.fn(),
}));
jest.mock('../../services/uploadAmendments', () => ({
  getUsers: jest.fn(async () => ({ users: [] })),
  PRIORITIES: [{ value: 'regular', label: 'Regular' }],
}));
jest.mock('../../services/adminExtras', () => ({
  fetchRefused: jest.fn(), restoreRefused: jest.fn(),
}));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const { fetchRoleInfo } = require('../../services/roleInfo');
const { fetchRefused, restoreRefused } = require('../../services/adminExtras');
const ClientTaskQueue = require('../ClientTaskQueue').default;

const REFUSED = {
  status: true,
  refused: [{
    id: 41, name: 'Add a GST column', external_ref: 'REQ-501', client_name: 'Acme', project_name: '',
    received_at: '2026-10-20 10:00', declined_at: '2026-10-21 11:30', declined_by: 'Owner',
    reason: 'Out of scope', note: '', decline_count: 1, client_answer: 'pending',
    client_answer_label: 'No answer yet', description: 'Please add it', submitted_by: 'Client', attachments: [],
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  fetchRefused.mockResolvedValue(REFUSED);
});

it('lets a cached admin in when the role lookup fails', async () => {
  fetchRoleInfo.mockResolvedValue({ info: null, kpiRole: 'admin', fromServer: false });
  const { getByText, queryByText } = render(<ClientTaskQueue onBack={() => {}} />);
  await waitFor(() => getByText('No client tasks waiting.'), { timeout: 15000 });
  expect(queryByText('Admins only')).toBeNull();
}, 30000);

it('says it could not check, rather than "Admins only", with nothing cached', async () => {
  fetchRoleInfo.mockResolvedValue({ info: null, kpiRole: '', fromServer: false });
  const { getByText, queryByText } = render(<ClientTaskQueue onBack={() => {}} />);
  await waitFor(() => getByText("Couldn't check your access"), { timeout: 15000 });
  expect(queryByText('Admins only')).toBeNull();
}, 30000);

it('still locks a real non-admin answer', async () => {
  fetchRoleInfo.mockResolvedValue({ info: { is_client: true }, kpiRole: 'client', fromServer: true });
  const { getByText } = render(<ClientTaskQueue onBack={() => {}} />);
  await waitFor(() => getByText('Admins only'));
  expect(getByText(/signed in as: Client/)).toBeTruthy();
});

it('lists refused requests and restores one', async () => {
  fetchRoleInfo.mockResolvedValue({ info: { is_admin: true }, kpiRole: 'admin', fromServer: true });
  restoreRefused.mockResolvedValue({ status: true, message: 'REQ-501 is back in the client queue.' });
  const { getByText, getAllByText } = render(<ClientTaskQueue onBack={() => {}} />);
  await waitFor(() => getByText('🚫 Refused (1)'));
  fireEvent.press(getByText('🚫 Refused (1)'));
  expect(getByText('Add a GST column')).toBeTruthy();
  expect(getByText('Out of scope')).toBeTruthy();
  fireEvent.press(getByText('Restore'));
  expect(getByText('Restore REQ-501?')).toBeTruthy();
  fireEvent.press(getAllByText('↩️ Restore').pop());
  await waitFor(() => expect(restoreRefused).toHaveBeenCalledWith(41));
});
