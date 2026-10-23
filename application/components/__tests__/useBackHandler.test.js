// Android asks back listeners newest-first and stops at the first that returns
// true (react-native BackHandler.android.js). Jest runs the iOS build, where
// addEventListener does nothing, so the listener list is kept here and pressBack
// walks it the way Android does.

const React = require('react');
const { render } = require('@testing-library/react-native');
const { BackHandler } = require('react-native');

let listeners = [];
function pressBack() {
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    if (listeners[i]()) return true;
  }
  return false;
}

beforeEach(() => {
  listeners = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_evt, fn) => {
    listeners.push(fn);
    return { remove: () => { listeners = listeners.filter((l) => l !== fn); } };
  });
});
afterEach(() => jest.restoreAllMocks());

const useBackHandler = require('../useBackHandler').default;

function Probe({ onBack }) {
  useBackHandler(onBack);
  return null;
}

describe('useBackHandler', () => {
  it('asks a screen mounted later before the app shell', () => {
    const app = jest.fn(() => true);
    BackHandler.addEventListener('hardwareBackPress', app);   // App.js, registered at mount
    const screen = jest.fn(() => true);
    render(React.createElement(Probe, { onBack: screen }));
    expect(pressBack()).toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
  });

  it('falls through to the shell when the screen returns false', () => {
    const app = jest.fn(() => true);
    BackHandler.addEventListener('hardwareBackPress', app);
    render(React.createElement(Probe, { onBack: () => false }));
    expect(pressBack()).toBe(true);
    expect(app).toHaveBeenCalledTimes(1);
  });

  it('registers once and always runs the latest handler', () => {
    const first = jest.fn(() => true);
    const second = jest.fn(() => true);
    const { rerender } = render(React.createElement(Probe, { onBack: first }));
    rerender(React.createElement(Probe, { onBack: second }));
    expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
    pressBack();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', () => {
    const { unmount } = render(React.createElement(Probe, { onBack: () => true }));
    expect(listeners).toHaveLength(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });
});
