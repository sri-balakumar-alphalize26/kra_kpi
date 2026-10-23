// The widget links are the one place a URL from outside the JS decides where the
// app goes. These pin what gets through and, more importantly, what does not.

const { parseWidgetLink } = require('../widgetLink');

describe('destinations', () => {
  it('reads the three the widgets offer', () => {
    expect(parseWidgetLink('krakpi://widget/actionboard')).toEqual({ dest: 'actionboard', action: null, kpiId: null, userId: null });
    expect(parseWidgetLink('krakpi://widget/livetracking')).toMatchObject({ dest: 'livetracking' });
    expect(parseWidgetLink('krakpi://widget/home')).toMatchObject({ dest: 'home' });
  });

  it('is case-insensitive and tolerates a trailing slash', () => {
    expect(parseWidgetLink('KRAKPI://Widget/ActionBoard/')).toMatchObject({ dest: 'actionboard' });
  });

  it('refuses anything else', () => {
    expect(parseWidgetLink('krakpi://widget/settings')).toBeNull();
    expect(parseWidgetLink('krakpi://widget/')).toBeNull();
    expect(parseWidgetLink('krakpi://task/42')).toBeNull();
    expect(parseWidgetLink('https://example.com/widget/home')).toBeNull();
    expect(parseWidgetLink('')).toBeNull();
    expect(parseWidgetLink(null)).toBeNull();
    expect(parseWidgetLink(undefined)).toBeNull();
    expect(parseWidgetLink(42)).toBeNull();
  });
});

describe('the task widget button', () => {
  it('carries pause or resume with the task id', () => {
    expect(parseWidgetLink('krakpi://widget/home?action=pause&kpi=42'))
      .toEqual({ dest: 'home', action: 'pause', kpiId: 42, userId: null });
    expect(parseWidgetLink('krakpi://widget/home?kpi=7&action=resume'))
      .toEqual({ dest: 'home', action: 'resume', kpiId: 7, userId: null });
  });

  it('drops an action it does not know, keeping the destination', () => {
    expect(parseWidgetLink('krakpi://widget/home?action=delete&kpi=42'))
      .toEqual({ dest: 'home', action: null, kpiId: 42, userId: null });
  });

  it('refuses ids that are not positive integers', () => {
    for (const bad of ['0', '-1', '1e3', '42abc', '', '9'.repeat(13), '%20']) {
      expect(parseWidgetLink(`krakpi://widget/home?action=pause&kpi=${bad}`).kpiId).toBeNull();
    }
  });

  it('takes the first of a repeated id', () => {
    expect(parseWidgetLink('krakpi://widget/home?kpi=1&kpi=2').kpiId).toBe(1);
  });

  it('survives a malformed escape and a fragment', () => {
    expect(parseWidgetLink('krakpi://widget/home?action=%E0%A4%A&kpi=5#x'))
      .toEqual({ dest: 'home', action: null, kpiId: 5, userId: null });
  });
});

describe('the live tracking rows', () => {
  it('carries the person', () => {
    expect(parseWidgetLink('krakpi://widget/livetracking?user=7'))
      .toEqual({ dest: 'livetracking', action: null, kpiId: null, userId: 7 });
  });
});
