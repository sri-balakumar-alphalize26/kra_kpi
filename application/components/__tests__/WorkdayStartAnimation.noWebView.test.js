// The build WITHOUT react-native-webview: an older APK, or Expo Go. Start
// Workday must behave exactly as before — nothing drawn, closed at once.
jest.mock('react-native-webview', () => ({}));

const React = require('react');
const { render } = require('@testing-library/react-native');

describe('WorkdayStartAnimation without the WebView', () => {
  it('renders nothing and closes at once', () => {
    const W = require('../WorkdayStartAnimation').default;
    const onDone = jest.fn();
    expect(render(React.createElement(W, { visible: true, onDone })).toJSON()).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
