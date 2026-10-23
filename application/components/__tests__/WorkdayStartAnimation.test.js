// The Start Workday picture is decoration: it must close itself, and a tap
// must skip it, so it can never stand between someone and their work.

const React = require('react');
const { render, fireEvent, act } = require('@testing-library/react-native');

describe('WorkdayStartAnimation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders nothing while hidden', () => {
    const W = require('../WorkdayStartAnimation').default;
    expect(render(React.createElement(W, { visible: false, onDone: jest.fn() })).toJSON()).toBeNull();
  });

  it('plays when visible and closes itself once the page has played', () => {
    const W = require('../WorkdayStartAnimation').default;
    const { WORKDAY_START_DURATION_MS } = require('../../assets/art/workdayStartArt');
    const onDone = jest.fn();
    const { getByTestId } = render(React.createElement(W, { visible: true, onDone }));
    expect(getByTestId('workday-start-animation')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(WORKDAY_START_DURATION_MS - 1); });
    expect(onDone).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a tap skips it', () => {
    const W = require('../WorkdayStartAnimation').default;
    const onDone = jest.fn();
    const { getByTestId } = render(React.createElement(W, { visible: true, onDone }));
    fireEvent.press(getByTestId('workday-start-animation'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // The build WITHOUT the WebView is WorkdayStartAnimation.noWebView.test.js:
  // Jest hands every test in a file the same mock instance.
});
