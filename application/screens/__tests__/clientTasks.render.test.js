// ClientTasks (the client's Requests screen) against a stubbed portal. Pins
// down the 🏁 Partly completed tab (finish_partial / partial_summary), the
// review line on an "Awaiting your sign-off" card, and the sign-off sheet:
// a Full Name choice + a signature, sending only the params the JSON route reads.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ getConnection: jest.fn(async () => ({ serverUrl: '' })) }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => false) }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('../../components/GradientBackground', () => () => null);

const task = (over) => ({
  id: 1, name: 'Task', kind: 'requirement', external_ref: 'REQ-1', client_name: 'Acme',
  project_name: '', task_state: 'in_progress', finish_partial: false, partial_summary: '', ...over,
});

jest.mock('../../services/clientPortal', () => ({
  getClientDashboard: jest.fn(),
  getClientSignature: jest.fn(async () => ({ hasSignature: false, imageB64: '', userName: 'Asha Client' })),
  removeClientSignature: jest.fn(),
  saveClientSignature: jest.fn(async () => ({ status: true, hasSignature: true })),
  fetchCertificatePdf: jest.fn(),
  getClientLinks: jest.fn(async () => null),
  getDbFormLink: jest.fn(),
  getChatLink: jest.fn(),
  getReviewDays: jest.fn(async () => 3),
}));
jest.mock('../../services/preApproval', () => ({
  fetchPreApprovals: jest.fn(async () => ({ kpis: [] })),
  decidePreApproval: jest.fn(),
  holdPreApproval: jest.fn(),
  submitClientSignoff: jest.fn(async () => ({ status: true })),
  submitClientRejection: jest.fn(),
}));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const portal = require('../../services/clientPortal');
const pre = require('../../services/preApproval');
const ClientTasks = require('../ClientTasks').default;

describe('ClientTasks', () => {
  beforeEach(() => {
    const signoff = task({ id: 7, name: 'Login page', task_state: 'awaiting_client', finish_partial: true, partial_summary: 'Screens done, API next' });
    portal.getClientDashboard.mockResolvedValue({
      authorized: true,
      kpis: [signoff, task({ id: 8, name: 'Invoices', task_state: 'completed' })],
      totals: {},
      pending_approvals: [signoff],
    });
    pre.submitClientSignoff.mockClear();
  });

  it('has a Partly completed tab with its count and the team summary', async () => {
    const { getByText, getAllByText } = render(<ClientTasks onBack={() => {}} />);
    await waitFor(() => getByText('🏁 Partly completed'), { timeout: 8000 });
    fireEvent.press(getByText('🏁 Partly completed'));
    expect(getByText('🏁 Partly completed (1)')).toBeTruthy();
    expect(getAllByText('Screens done, API next').length).toBeGreaterThan(0);
  });

  it('says when an awaiting sign-off task approves on its own', async () => {
    const { getByText } = render(<ClientTasks onBack={() => {}} />);
    await waitFor(() => getByText(/Awaiting your sign-off/));
    fireEvent.press(getByText(/Awaiting your sign-off/));
    expect(getByText('⏳ No reply within 3 days of delivery approves it automatically')).toBeTruthy();
  });

  it('signs off with the picked Full Name and an Auto signature', async () => {
    // The test renderer has no native SVG, so keeping the signature fails (and is
    // logged) — sign-off must still go through with the name.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { getByText } = render(<ClientTasks onBack={() => {}} />);
    await waitFor(() => getByText(/Awaiting your sign-off/));
    fireEvent.press(getByText(/Awaiting your sign-off/));
    fireEvent.press(getByText('Sign off'));
    // The only person known is the signed-in one, so they are picked already.
    expect(getByText('👤 Asha Client')).toBeTruthy();
    expect(getByText('Auto')).toBeTruthy();
    expect(getByText('Draw')).toBeTruthy();
    fireEvent.press(getByText('The work was delivered to me'));
    fireEvent.press(getByText('I have checked it and it works'));
    fireEvent.press(getByText("I'm authorized to approve this"));
    fireEvent.press(getByText('Sign & Approve'));
    await waitFor(() => expect(pre.submitClientSignoff).toHaveBeenCalled());
    // No PNG here (no native SVG in jest) and the signed-in person has no server key.
    expect(pre.submitClientSignoff).toHaveBeenCalledWith(7, {
      signatureText: 'Asha Client', notes: '', signer: '', signaturePng: '',
    });
    warn.mockRestore();
  });

  it('Draw stays locked until something is drawn', async () => {
    const { getByText } = render(<ClientTasks onBack={() => {}} />);
    await waitFor(() => getByText(/Awaiting your sign-off/));
    fireEvent.press(getByText(/Awaiting your sign-off/));
    fireEvent.press(getByText('Sign off'));
    fireEvent.press(getByText('The work was delivered to me'));
    fireEvent.press(getByText('I have checked it and it works'));
    fireEvent.press(getByText("I'm authorized to approve this"));
    fireEvent.press(getByText('Draw'));
    expect(getByText('Sign here with your finger')).toBeTruthy();
    fireEvent.press(getByText('Sign & Approve'));
    expect(pre.submitClientSignoff).not.toHaveBeenCalled();
  });
});
