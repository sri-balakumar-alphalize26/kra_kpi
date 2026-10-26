// Configuration renders against the services' offline data (no server). What
// this pins down: a developer's WhatsApp number is READ-ONLY now (the old
// /kpi_multitask/set_wa editor is retired server-side and refused every save),
// and the new sections are there — CEO numbers, Finish & client review, the
// Billing link and the Approval chain with its steps.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-blur', () => ({ BlurView: ({ children }) => children }));
jest.mock('../../api/session', () => ({ getConnection: jest.fn(async () => ({ serverUrl: '' })) }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), callKw: jest.fn() }));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const { jsonRpc } = require('../../api/odooApi');
const ConfigurationScreen = require('../ConfigurationScreen').default;

describe('ConfigurationScreen', () => {
  it('shows the WhatsApp number read-only and never calls the retired route', async () => {
    const onOpen = jest.fn();
    const { getByText, queryByPlaceholderText } = render(<ConfigurationScreen onBack={() => {}} onOpen={onOpen} />);
    await waitFor(() => getByText('Dev One'), { timeout: 8000 });
    // The mock developer has no number: the read-only box says so.
    expect(getByText('no login mobile')).toBeTruthy();
    expect(getByText('The WhatsApp number follows the login mobile. Change it in Login Management.')).toBeTruthy();
    // No editable WhatsApp box any more.
    expect(queryByPlaceholderText(/WhatsApp —/)).toBeNull();
    fireEvent.press(getByText('no login mobile'));
    expect(onOpen).toHaveBeenCalledWith('loginmgmt');
    expect(jsonRpc.mock.calls.some((c) => c[1] === '/kpi_multitask/set_wa')).toBe(false);
  }, 30000);

  it('has the CEO numbers, Finish, Billing and Approval chain sections', async () => {
    const onOpen = jest.fn();
    const { getByText, getByPlaceholderText, getByDisplayValue } = render(<ConfigurationScreen onBack={() => {}} onOpen={onOpen} />);
    await waitFor(() => getByText('Approval chain'));
    expect(getByPlaceholderText('9876543210, 971501234567')).toBeTruthy();
    expect(getByText('Finish & client review')).toBeTruthy();
    expect(getByText('Admin check first')).toBeTruthy();
    // The mock chain's two steps, editable in place.
    await waitFor(() => getByDisplayValue('Coordinator'));
    expect(getByDisplayValue('Owner')).toBeTruthy();
    expect(getByText('Administrator')).toBeTruthy();
    fireEvent.press(getByText('Open billing'));
    expect(onOpen).toHaveBeenCalledWith('billing');
  });
});
