// Which WAY a reminder fires, and the one case that can go wrong silently.
//
// syncReminderAlarms used to decide by capability alone — `canRing =
// alarmAvailable()` — so the moment a build shipped with notifee, EVERY reminder
// became a full-screen looping alarm whether or not its owner wanted that. The
// mode is now the owner's, held per reminder in api/session.
//
// The trap these tests exist for is the reconcile. It leaves an unchanged
// reminder alone by comparing the armed TIME, and switching Notify↔Alarm does not
// change the time. Without the kind in that comparison the old scheduling
// survives: the reminder keeps firing the way it used to, or fires twice — once
// from notifee and once from expo-notifications. That is invisible in the UI,
// which happily shows the new choice.
//
// utils/reminderSchedule is deliberately NOT mocked: it is pure, and letting the
// real armableReminders run means these tests exercise the actual naive-UTC parse
// and the past-due rule rather than a convenient fiction.

jest.mock('../lazyNotifications', () => ({
  __esModule: true,
  default: {
    getAllScheduledNotificationsAsync: jest.fn(async () => []),
    scheduleNotificationAsync: jest.fn(async () => 'banner-id'),
    cancelScheduledNotificationAsync: jest.fn(async () => {}),
    SchedulableTriggerInputTypes: { DATE: 'date' },
  },
}));
jest.mock('../reminders', () => ({ ensureReminderChannel: jest.fn(async () => 'reminders') }));
jest.mock('../alarm', () => ({
  alarmAvailable: jest.fn(() => true),
  scheduleTaskAlarm: jest.fn(async () => 'alarm-id'),
  stopAlarm: jest.fn(async () => {}),
}));
jest.mock('../../api/session', () => ({
  getReminderAlarms: jest.fn(async () => ({})),
  saveReminderAlarms: jest.fn(async () => {}),
  pruneReminderSnoozes: jest.fn(async () => ({})),
  getReminderModes: jest.fn(async () => ({})),
}));

const Notifications = require('../lazyNotifications').default;
const { alarmAvailable, scheduleTaskAlarm, stopAlarm } = require('../alarm');
const session = require('../../api/session');
const { syncReminderAlarms } = require('../reminderAlarm');

// The server hands back naive UTC: 'YYYY-MM-DD HH:MM:SS', no T and no Z.
const serverUtc = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').slice(0, 19);

// One row in the shape /kpi_reminder search_read returns.
const row = (over = {}) => ({
  id: 5, name: 'AlarmTest', enabled: true, next_trigger: serverUtc(60 * 60 * 1000), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  alarmAvailable.mockReturnValue(true);
  session.getReminderAlarms.mockResolvedValue({});
  session.pruneReminderSnoozes.mockResolvedValue({});
  session.getReminderModes.mockResolvedValue({});
  Notifications.getAllScheduledNotificationsAsync.mockResolvedValue([]);
  Notifications.scheduleNotificationAsync.mockResolvedValue('banner-id');
  scheduleTaskAlarm.mockResolvedValue('alarm-id');
});

describe('choosing how a reminder fires', () => {
  it('rings by default, because every existing reminder already did', async () => {
    // No stored mode at all — the upgrade case. Defaulting to notify here would
    // silence every reminder anybody had already created.
    await syncReminderAlarms([row()], 7);

    expect(scheduleTaskAlarm).toHaveBeenCalledTimes(1);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('sends a plain notification when the owner asked for Notify', async () => {
    session.getReminderModes.mockResolvedValue({ 5: 'notify' });

    await syncReminderAlarms([row()], 7);

    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('still falls back to a banner when Alarm is asked for but the build cannot ring', async () => {
    // A build without notifee. Silence would be the wrong answer — the reminder
    // should arrive, just not full-screen.
    alarmAvailable.mockReturnValue(false);
    session.getReminderModes.mockResolvedValue({ 5: 'alarm' });

    await syncReminderAlarms([row()], 7);

    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps one reminder on Notify without dragging the others off Alarm', async () => {
    session.getReminderModes.mockResolvedValue({ 5: 'notify' });

    await syncReminderAlarms([row(), row({ id: 6, name: 'Second' })], 7);

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(scheduleTaskAlarm).toHaveBeenCalledTimes(1);
    // ...and it is the OTHER one that got the alarm.
    expect(scheduleTaskAlarm.mock.calls[0][0]).toMatchObject({ id: '6' });
  });
});

describe('the reconcile, when only the mode changed', () => {
  // Same reminder, same instant, already armed as an alarm. Only the choice moved.
  const armedAsAlarm = (r) => ({
    [String(r.id)]: {
      notifId: 'alarm-id',
      whenIso: new Date(Date.parse(r.next_trigger.replace(' ', 'T') + 'Z')).toISOString(),
      kind: 'alarm',
    },
  });

  it('tears down the alarm and re-arms as a notification', async () => {
    const r = row();
    session.getReminderAlarms.mockResolvedValue(armedAsAlarm(r));
    session.getReminderModes.mockResolvedValue({ 5: 'notify' });

    await syncReminderAlarms([r], 7);

    // The old alarm must actually be cancelled. Left armed, it would ring at the
    // same instant the new notification posts.
    expect(stopAlarm).toHaveBeenCalledWith('alarm-id');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves it completely alone when nothing changed', async () => {
    const r = row();
    session.getReminderAlarms.mockResolvedValue(armedAsAlarm(r));
    session.getReminderModes.mockResolvedValue({ 5: 'alarm' });

    await syncReminderAlarms([r], 7);

    // No churn: the whole point of the reconcile is that repeated 15s syncs do
    // not cancel and re-create the OS's timer list every time.
    expect(stopAlarm).not.toHaveBeenCalled();
    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('records the kind it armed, so the next sync can tell', async () => {
    session.getReminderModes.mockResolvedValue({ 5: 'notify' });

    await syncReminderAlarms([row()], 7);

    const saved = session.saveReminderAlarms.mock.calls[0][1];
    expect(saved['5']).toMatchObject({ kind: 'banner' });
  });
});

describe('what the mode must not disturb', () => {
  it('does not touch a snoozed reminder, whatever its mode says', async () => {
    const r = row();
    session.pruneReminderSnoozes.mockResolvedValue({
      5: { whenIso: new Date(Date.now() + 5 * 60 * 1000).toISOString(), notifId: 'snoozed-id' },
    });
    session.getReminderModes.mockResolvedValue({ 5: 'notify' });

    await syncReminderAlarms([r], 7);

    // A snooze is armed for a time the server knows nothing about. Re-arming it
    // to match next_trigger is exactly the bug pruneReminderSnoozes prevents.
    expect(stopAlarm).not.toHaveBeenCalled();
    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('ignores a disabled reminder regardless of mode', async () => {
    session.getReminderModes.mockResolvedValue({ 5: 'alarm' });

    await syncReminderAlarms([row({ enabled: false })], 7);

    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('ignores a past-due reminder regardless of mode', async () => {
    session.getReminderModes.mockResolvedValue({ 5: 'alarm' });

    await syncReminderAlarms([row({ next_trigger: serverUtc(-60 * 1000) })], 7);

    expect(scheduleTaskAlarm).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
