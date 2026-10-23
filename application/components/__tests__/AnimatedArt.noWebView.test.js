// The build WITHOUT react-native-webview: an older APK, or Expo Go. The mock is
// file-level because Jest hands every test in a file the same mock instance,
// so "with" and "without" the WebView cannot share one file.
jest.mock('react-native-webview', () => ({}));

const React = require('react');
const { render } = require('@testing-library/react-native');

describe('AnimatedArt without the WebView', () => {
  it('says the pictures are unavailable and renders nothing', () => {
    const mod = require('../AnimatedArt');
    expect(mod.animatedArtAvailable()).toBe(false);
    expect(render(React.createElement(mod.default, { svg: '<svg></svg>' })).toJSON()).toBeNull();
  });
});
