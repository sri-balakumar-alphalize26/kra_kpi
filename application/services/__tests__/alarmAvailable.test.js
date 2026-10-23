// Whether this build can ring, and the one way that answer used to get stuck.
//
// loadNotifee() memoised with a one-way flag set BEFORE the require. A single
// early call that threw — and moving native loading off the startup path made an
// early call far more likely — latched notifee to null for the rest of the app
// session. alarmAvailable() then answered false forever on a build carrying a
// perfectly healthy notifee, so every alarm the user asked for quietly became a
// notification, with nothing anywhere saying why.
//
// Each case re-requires the module inside jest.isolateModules, because the thing
// under test IS module-level state; sharing one instance between tests would hide
// exactly the bug this file exists for.

// services/alarm.js drags in storage and an Android intent launcher on the way to
// the thing under test. Hoisted so they apply inside the isolateModules blocks
// too; only the notifee mock varies per case, and that is the point of each test.
jest.mock('../../api/session', () => ({
  getAlarmSound: jest.fn(async () => null),
  getAlarmSettings: jest.fn(async () => ({ ringMins: 5, snoozeMins: 5 })),
}));
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn() }));
jest.mock('../lazyNotifications', () => ({
  __esModule: true,
  default: {
    AndroidImportance: { MAX: 5 },
    AndroidNotificationVisibility: { PUBLIC: 1 },
    AndroidAudioUsage: { ALARM: 4 },
  },
}));

describe('alarmAvailable', () => {
  const nf = () => ({
    default: { displayNotification: jest.fn(), createTriggerNotification: jest.fn() },
    AndroidImportance: { HIGH: 4 },
    AndroidCategory: { ALARM: 'alarm' },
    TriggerType: { TIMESTAMP: 0 },
    AuthorizationStatus: { AUTHORIZED: 1 },
  });

  it('retries after a failed load instead of latching false forever', () => {
    jest.isolateModules(() => {
      let broken = true;
      jest.doMock('@notifee/react-native', () => {
        // The real failure: the native module is not ready yet.
        if (broken) throw new Error('Notifee native module not found.');
        return nf();
      });

      const { alarmAvailable } = require('../alarm');

      // First call, too early — honestly false.
      expect(alarmAvailable()).toBe(false);

      // The native side is ready now. THIS is the regression: the old code never
      // asked again, so a reminder set minutes later still became a banner.
      broken = false;
      expect(alarmAvailable()).toBe(true);
    });
  });

  it('keeps answering true once loaded, without requiring again', () => {
    jest.isolateModules(() => {
      const factory = jest.fn(nf);
      jest.doMock('@notifee/react-native', factory);

      const { alarmAvailable } = require('../alarm');
      expect(alarmAvailable()).toBe(true);
      expect(alarmAvailable()).toBe(true);
      expect(alarmAvailable()).toBe(true);

      // Success IS memoised — only failure is retried. Re-requiring on every
      // check would put native module work on a hot path.
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  it('stays false on a build that genuinely has no notifee', () => {
    jest.isolateModules(() => {
      jest.doMock('@notifee/react-native', () => {
        throw new Error('Notifee native module not found.');
      });
      const { alarmAvailable } = require('../alarm');
      expect(alarmAvailable()).toBe(false);
      expect(alarmAvailable()).toBe(false);
    });
  });

  it('does not accept a module that resolved to nothing', () => {
    jest.isolateModules(() => {
      // A require that succeeds but yields no default would otherwise be latched
      // in place of null, taking the "unavailable" branch away while still being
      // unusable.
      jest.doMock('@notifee/react-native', () => ({}));
      const { alarmAvailable } = require('../alarm');
      expect(alarmAvailable()).toBe(false);
    });
  });
});
