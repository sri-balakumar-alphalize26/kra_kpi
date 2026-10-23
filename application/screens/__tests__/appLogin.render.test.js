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

  // Back walks the steps like the on-screen links, and on the first step lets
  // the press through to App ("press back again to exit"). Android asks the
  // newest listener first; jest runs the iOS BackHandler, so the list is kept here.
  it('goes back from the password step to the number step', async () => {
    const { BackHandler } = require('react-native');
    let listeners = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, fn) => {
      listeners.push(fn);
      return { remove: () => { listeners = listeners.filter((l) => l !== fn); } };
    });
    const pressBack = () => {
      for (let i = listeners.length - 1; i >= 0; i -= 1) if (listeners[i]()) return true;
      return false;
    };
    const { loginCheck } = require('../../services/appAuth');
    loginCheck.mockResolvedValue({ state: 'ready' });
    const { fireEvent, act } = require('@testing-library/react-native');
    const AppLoginScreen = require('../AppLoginScreen').default;
    const { getByText, getByPlaceholderText, queryByPlaceholderText } = render(
      React.createElement(AppLoginScreen, { onLogin: () => {}, onNeedSetup: () => {} }),
    );
    fireEvent.changeText(getByPlaceholderText('Mobile number'), '9876543210');
    fireEvent.press(getByText('Continue'));
    await waitFor(() => expect(getByPlaceholderText('Password')).toBeTruthy());

    let handled;
    act(() => { handled = pressBack(); });
    expect(handled).toBe(true);
    await waitFor(() => expect(getByPlaceholderText('Mobile number')).toBeTruthy());
    expect(queryByPlaceholderText('Password')).toBeNull();
    // First step: not handled here, so App's exit warning gets it.
    expect(pressBack()).toBe(false);
    spy.mockRestore();
  });
});
