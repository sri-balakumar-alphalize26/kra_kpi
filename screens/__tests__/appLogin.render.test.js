// Renders the app-login screen for real: the one test that proves its imports
// resolve (three SVG string modules, the WebView component) and the first step
// draws with its picture. Native pieces are mocked in jest.setup.js.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ saveSession: jest.fn() }));
jest.mock('../../services/appAuth', () => ({
  getMobileConfig: jest.fn(async () => ({ dial: '91', length: 10 })),
  loginCheck: jest.fn(), appLogin: jest.fn(), setAppPassword: jest.fn(),
  requestOtp: jest.fn(), verifyOtp: jest.fn(),
}));

const React = require('react');
const { render, waitFor } = require('@testing-library/react-native');

describe('AppLoginScreen', () => {
  it('renders the number step with the animated picture', async () => {
    const AppLoginScreen = require('../AppLoginScreen').default;
    const { getByText, getByTestId, getByPlaceholderText } = render(
      React.createElement(AppLoginScreen, { onLogin: () => {}, onNeedSetup: () => {} }),
    );
    expect(getByText(/Welcome back/)).toBeTruthy();
    expect(getByPlaceholderText('Mobile number')).toBeTruthy();
    expect(getByTestId('animated-art')).toBeTruthy();
    const { getMobileConfig } = require('../../services/appAuth');
    await waitFor(() => expect(getMobileConfig).toHaveBeenCalled());
  });
});
