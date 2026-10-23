// The animated pictures are decoration: the one thing that must hold is that
// they can never take the login screen down, with or without the WebView.

const React = require('react');
const { render } = require('@testing-library/react-native');

describe('AnimatedArt', () => {
  it('renders nothing without markup', () => {
    const AnimatedArt = require('../AnimatedArt').default;
    expect(render(React.createElement(AnimatedArt, { svg: '' })).toJSON()).toBeNull();
  });

  it('renders the frame with markup', () => {
    const AnimatedArt = require('../AnimatedArt').default;
    const { getByTestId } = render(React.createElement(AnimatedArt, { svg: '<svg></svg>', size: 120 }));
    expect(getByTestId('animated-art')).toBeTruthy();
  });

  it('says the pictures are available in a build that has the WebView', () => {
    expect(require('../AnimatedArt').animatedArtAvailable()).toBe(true);
  });

  // The build WITHOUT the WebView is AnimatedArt.noWebView.test.js: Jest hands
  // every test in a file the same mock instance, so it needs a file of its own.
});
