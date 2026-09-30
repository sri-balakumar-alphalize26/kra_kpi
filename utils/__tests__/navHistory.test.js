const { pushHistory, popHistory, isSecondBackPress, HISTORY_MAX } = require('../navHistory');

describe('pushHistory', () => {
  it('remembers Home when a tile opens a screen', () => {
    expect(pushHistory([], 'home', 'actionboard')).toEqual(['home']);
  });

  it('keeps the trail Notifications → board, so back returns to Notifications', () => {
    let st = pushHistory([], 'home', 'notifications');
    st = pushHistory(st, 'notifications', 'actionboard');
    expect(st).toEqual(['home', 'notifications']);
    const first = popHistory(st);
    expect(first.dest).toBe('notifications');
    expect(popHistory(first.stack).dest).toBe('home');
  });

  it('clears the trail on arriving Home', () => {
    expect(pushHistory(['home', 'a'], 'b', 'home')).toEqual([]);
  });

  it('ignores re-opening the screen already showing', () => {
    const st = ['home'];
    expect(pushHistory(st, 'a', 'a')).toBe(st);
    expect(pushHistory(st, null, 'a')).toBe(st);
  });

  it('cuts a loop instead of bouncing between two screens', () => {
    expect(pushHistory(['home', 'a', 'b'], 'c', 'a')).toEqual(['home']);
  });

  it('is capped', () => {
    let st = [];
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) st = pushHistory(st, `s${i}`, `s${i + 1}`);
    expect(st).toHaveLength(HISTORY_MAX);
    expect(st[st.length - 1]).toBe(`s${HISTORY_MAX + 4}`);
  });
});

describe('popHistory', () => {
  it('goes Home from an empty trail', () => {
    expect(popHistory([])).toEqual({ dest: 'home', stack: [] });
  });
});

describe('isSecondBackPress', () => {
  it('needs an earlier press inside the window', () => {
    expect(isSecondBackPress(0, 5000)).toBe(false);
    expect(isSecondBackPress(undefined, 5000)).toBe(false);
    expect(isSecondBackPress(1000, 2999)).toBe(true);
    expect(isSecondBackPress(1000, 3000)).toBe(false);
  });
});
