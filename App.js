// KRA/KPI app shell: spinning KPI-wheel Splash → Welcome → Login (Odoo connect)
// → Home. A remembered Odoo session boots straight to Home after the splash.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BackHandler, View, ActivityIndicator, AppState, Linking, ToastAndroid, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
// Lazy. Importing expo-notifications at module scope starts a promise chain in
// its own module body that hung the standalone build -- see services/lazyNotifications.js.
import Notifications from './services/lazyNotifications';
import SplashScreen from './screens/SplashScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { boot, bootTick } from './utils/bootTrace';
import { pushHistory, popHistory, isSecondBackPress } from './utils/navHistory';
import LoginScreen from './screens/LoginScreen';
import ConnectScreen from './screens/ConnectScreen';
import HomeScreen from './screens/HomeScreen';
import KraKpiDashboard from './screens/KraKpiDashboard';
import KpiActionBoard, { resetWorkdayCache } from './screens/KpiActionBoard';
import UploadAmendments from './screens/UploadAmendments';
import OwnerDashboard from './screens/OwnerDashboard';
import LiveTracking from './screens/LiveTracking';
import NotificationsScreen from './screens/NotificationsScreen';
import ConfigurationScreen from './screens/ConfigurationScreen';
import LoginManagementScreen from './screens/LoginManagementScreen';
import UsersScreen from './screens/UsersScreen';
import WorkdaySnapshots from './screens/WorkdaySnapshots';
import PaidWork from './screens/PaidWork';
import DailyReports from './screens/DailyReports';
import CompanyBranding from './screens/CompanyBranding';
import WorkReport from './screens/WorkReport';
import KraReport from './screens/KraReport';
import ClientInvoices from './screens/ClientInvoices';
import MyWorkday from './screens/MyWorkday';
import EmployeeTracker from './screens/EmployeeTracker';
import TaskDocuments from './screens/TaskDocuments';
import ClientTasks from './screens/ClientTasks';
import GenerateClientFiles from './screens/GenerateClientFiles';
import ReassignmentHistory from './screens/ReassignmentHistory';
import ClientTaskQueue from './screens/ClientTaskQueue';
import UserManual from './screens/UserManual';
import Reminders from './screens/Reminders';
import AttendanceScreen from './screens/AttendanceScreen';

import AppLoginScreen from './screens/AppLoginScreen';
import AlarmScreen from './screens/AlarmScreen';
import ScreenTransition from './components/ScreenTransition';
import WorkdayStartAnimation from './components/WorkdayStartAnimation';
import { scheduleTaskAlarm, stopAlarm } from './services/alarm';
import { completeReminder } from './services/reminderList';

// notifee is a native module, present only in a build that bundles its native
// side. Resolved on FIRST USE, not at import — same rule as expo-notifications
// above. Two reasons, and the second is the one that bit:
//   * a static import throws at launch where the native side is absent;
//   * a module-scope require runs native work during module evaluation, which is
//     what kept the standalone build on its splash forever.
// Every use below is inside an effect, so deferring costs nothing. Until it is
// available the alarm wiring no-ops and the notification reminder still works.
let _nf = null, _nfTried = false;
function getNotifee() {
  if (!_nfTried) {
    _nfTried = true;
    try {
      // eslint-disable-next-line global-require
      _nf = require('@notifee/react-native');
    } catch (_) { _nf = null; /* absent (Expo Go, pre-rebuild) — alarm inert */ }
  }
  return _nf?.default || null;
}
function getEventType() {
  getNotifee();
  return _nf?.EventType || {};
}
import * as session from './api/session';
import { getConnection, getRoleState, saveRoleState } from './api/session';
import { loadHaptics } from './utils/haptics';
import { jsonRpc, setSessionExpiredHandler } from './api/odooApi';
import { parseWidgetLink } from './utils/widgetLink';
import { clearWidgetState } from './utils/taskWidget';
import { clearLiveTrackingState } from './utils/liveTrackingWidget';
import { setLockScreenVisible } from './modules/expo-task-widget-bridge';
import { createLogger } from './api/logger';
import { registerForPushAsync, unregisterPush } from './services/push';
import { fetchReminders } from './services/reminderList';
import { syncReminderAlarms, clearReminderAlarms, clearTaskReminders } from './services/reminderAlarm';
import { getWorkdayStatus } from './services/kpiActions';
import { fetchAttendanceStatus } from './services/attendance';

const log = createLogger('App');

// Definitive runtime check: 'storeClient' = Expo Go (local notifications DON'T
// display there); 'standalone'/'bare' = a real dev/standalone build (they do).
log.info('runtime env', {
  executionEnvironment: Constants.executionEnvironment,
  appOwnership: Constants.appOwnership,
  isExpoGo: Constants.executionEnvironment === 'storeClient',
});

// The foreground notification handler used to be set here, at module scope.
// It now runs from services/nativeWiring.js on the root mount effect, so that
// expo-notifications is not loaded before the app has drawn a frame.

// SafeAreaProvider supplies the real system-bar insets (used by TabBar to sit
// above the phone's nav/gesture bar).
export default function App() {
  bootTick('App render');
  // Native wiring (notifee's background handler) runs from HERE, after the first
  // commit -- never during module evaluation, and not from a setTimeout(0) in
  // index.js either, which can fire before React has drawn anything on a slow
  // device. The standalone build hung on the splash while native work ran ahead
  // of the first frame; a mount effect is the only hook guaranteed to follow it.
  // The require sits inside the effect for the same reason.
  useEffect(() => {
    // eslint-disable-next-line global-require
    require('./services/nativeWiring').wireNativeIntegrations();
    // Behind the lock screen like any other app. The manifest's showWhenLocked
    // exists for the alarm's cold start; AlarmScreen switches it on while it
    // rings and off after (screens/AlarmScreen.js). Without this first "off",
    // every screen stayed visible and usable on a locked phone.
    setLockScreenVisible(false);
  }, []);
  return (
    <SafeAreaProvider>
      {/* One app-wide status bar: dark icons on the transparent (edge-to-edge)
          bar, so every screen's light background shows through — no black strip. */}
      <StatusBar style="dark" />
      {/* Last line of defence. Anything AppInner throws that its own boundaries
          did not catch lands here as a readable screen with a Try again, rather
          than as an app that never draws and never says why. */}
      <ErrorBoundary name="root">
        <AppInner />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

function AppInner() {
  bootTick('AppInner render');
  const [ready, setReady] = useState(false);       // splash finished
  const [restoring, setRestoring] = useState(true); // reading saved session
  // Stable identity, deliberately. An inline arrow here is a new prop on every
  // render of this component, and SplashScreen's intro effect keyed off it —
  // so each re-render restarted the animation and leaked the previous one's
  // endless loop. The splash only ever needs to say "done" once.
  const finishSplash = useCallback(() => setReady(true), []);
  const [screen, setScreen] = useState('login');    // login (welcome) | connect
  const [user, setUser] = useState(null);
  const [appScreen, setAppScreen] = useState('home'); // post-login: home | dashboard | actionboard
  // The screens behind the current one (utils/navHistory.js), so back returns to
  // where you came from instead of always to Home. Refs, not state: the back
  // listener is registered once and reads them when pressed.
  const historyRef = useRef([]);
  const appScreenRef = useRef('home');
  appScreenRef.current = appScreen;
  const lastBackRef = useRef(0);    // when back was last pressed on Home / login
  const [focusTaskId, setFocusTaskId] = useState(null); // task to scroll-to + pulse on the board
  // Snapshot to auto-expand + flash on the Workday Snapshots screen, set when an
  // admin taps an "ended their workday" notification. Null on every other route.
  const [focusSnapshotId, setFocusSnapshotId] = useState(null);
  // Report to auto-open on the Daily Reports screen, set when an admin taps a
  // "Daily report ready" notification. Null on every other route.
  const [focusReportId, setFocusReportId] = useState(null);
  // Invoice to auto-open on the (My) Invoices screen, set when a notification about
  // an invoice is tapped. Null on every other route.
  const [focusInvoiceId, setFocusInvoiceId] = useState(null);
  // Set when a task ALARM fires (services/alarm.js full-screen intent). Holds
  // { task, notifId }; while non-null the ringing AlarmScreen takes over the whole
  // app (even before login) so Stop is always reachable to silence it.
  const [alarmData, setAlarmData] = useState(null);
  const [devLocked, setDevLocked] = useState(false);  // this user is a developer → gated by their workday
  // The workday, not a PIN, now decides read-only: a developer may act on tasks
  // while today's session is OPEN, and is read-only before Start Workday and
  // again after End Workday. Both values come from getWorkdayStatus() — the same
  // call, so they can never disagree with each other.
  const [workdayOpen, setWorkdayOpen] = useState(false);
  const [dayDone, setDayDone] = useState(false);   // ENDED today → one start + one end per day
  // The drop-in picture after Start Workday — only while attendance is on in the app.
  const [workdayAnim, setWorkdayAnim] = useState(false);
  // A session for today was closed by the CRON, not by the developer. Restart is
  // still allowed; it only changes what the button is called, so a day the system
  // cut at midnight does not read as a day that never started.
  const [todayClosed, setTodayClosed] = useState(false);
  // ...or an ADMIN reopened an ended day. Also leaves todayClosed true, which is
  // exactly the problem: without telling the two apart, a developer whose day was
  // just reopened is offered "Start New Workday Session", as though nothing had
  // happened yet. Carried so the Home bar says the same thing as the board button.
  const [workdayReopened, setWorkdayReopened] = useState(false);
  const [gateReady, setGateReady] = useState(false);  // role gate resolved → avoids a Home flash
  const [provisioned, setProvisioned] = useState(false); // device set up (server URL saved)
  const [forceSetup, setForceSetup] = useState(false);   // show Odoo device-setup over the app login

  const [isClient, setIsClient] = useState(false);     // client-only user → no Action Board

  // A Pause / Resume tap on the task widget, for Home to act on once. The nonce
  // makes two taps on the same button two actions (screens/HomeScreen.js).
  const [widgetAction, setWidgetAction] = useState(null);   // { kind, taskId, nonce }
  // A tap on one person's row of the Live Tracking widget: the screen scrolls to
  // and flashes them, then clears this.
  const [focusUserId, setFocusUserId] = useState(null);

  const pushTokenRef = useRef(null);       // this device's Expo token (for logout unregister)
  const pendingTapRef = useRef(null);      // kpi_id from a tap that arrived before login/restore
  const pendingReportRef = useRef(null);   // report_id from a "daily report ready" tap before login
  const pendingScreenRef = useRef(null);   // destination from a widget tap before login
  const pendingInvoiceRef = useRef(null);  // invoice_id from an invoice notification tap before login
  const pendingSnapshotRef = useRef(null); // snapshot_id from a "workday ended" tap before login
  const devLockedRef = useRef(false);      // latest devLocked for listeners/back-handler
  useEffect(() => { devLockedRef.current = devLocked; }, [devLocked]);
  // routeToTask is called from notification listeners registered once at mount,
  // so it must read the LATEST role through a ref — a captured state value would
  // be stale and send clients back to the Action Board.
  const isClientRef = useRef(false);
  useEffect(() => { isClientRef.current = isClient; }, [isClient]);

  // Route a notification tap to the task (opens + pulses it).
  //
  // Role decides WHERE. The KPI Action Board is the developer/admin work screen —
  // /kra_kpi/tasks/get returns nothing for a client, so sending them there landed
  // them on an empty board that then couldn't even fetch the task. A client's
  // tasks live in My Requests, so every client notification opens that instead.
  // If we aren't logged in yet (cold-start tap), queue it until the session
  // restore / login completes.
  // A reminder tap has no kpi_id -- see services/reminderAlarm.js, which leaves
  // it out deliberately. Without a branch of its own the tap fell through to
  // routeToTask, which returns immediately on a falsy id, so tapping a reminder
  // did precisely nothing.
  // Every screen change goes through navigate (so it is remembered) and every
  // back through goBack. goBack clears the focus slots exactly as Home does, so
  // a task that pulsed on the way in does not pulse again on the way back.
  const navigate = (dest) => {
    historyRef.current = pushHistory(historyRef.current, appScreenRef.current, dest);
    appScreenRef.current = dest;
    setAppScreen(dest);
  };
  const goBack = () => {
    const { dest, stack } = popHistory(historyRef.current);
    historyRef.current = stack;
    setFocusTaskId(null);
    setFocusSnapshotId(null);
    setFocusReportId(null);
    setFocusInvoiceId(null);
    setFocusUserId(null);
    appScreenRef.current = dest;
    setAppScreen(dest);
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  const routeToReminders = () => {
    if (userRef.current) navigate('reminders');
    // Not queued in pendingTapRef like a task: that ref holds a task id and is
    // consumed by routeToTask on login. A reminder tap before login is rare
    // enough that opening Home is a fine answer.
  };

  // A home-screen widget was tapped. The widget shows a thing, so it opens that
  // thing — landing on Home and making the user navigate is the version people
  // stop tapping.
  //
  // `link` is utils/widgetLink.parseWidgetLink's output, so only the destinations
  // the widgets actually offer get here. The URL comes from outside the JS, and
  // treating it as a free-form screen name would let any app holding the scheme
  // open arbitrary screens.
  const WIDGET_SCREENS = { actionboard: 'actionboard', livetracking: 'livetracking', home: 'home' };
  const routeToWidgetScreen = (link) => {
    const screenName = link && WIDGET_SCREENS[link.dest];
    if (!screenName) return;
    if (userRef.current) {
      // Clear the focus slots, like the other routers: a stale id would make an
      // unrelated row flash on arrival.
      setFocusTaskId(null);
      setFocusReportId(null);
      // The widget's Pause / Resume button lands on Home, which owns the pause
      // dialog and the resume call and acts on this once (screens/HomeScreen.js).
      if (link.dest === 'home' && link.action && link.kpiId) {
        setWidgetAction({ kind: link.action, taskId: link.kpiId, nonce: Date.now() });
      }
      // A person's row on the Live Tracking widget opens the screen ON them.
      setFocusUserId(link.dest === 'livetracking' && link.userId ? link.userId : null);
      navigate(screenName);
    } else {
      // Queued like a task tap — a widget tap from a cold start arrives long
      // before login resolves, and dropping it means the tap did nothing.
      pendingScreenRef.current = link;
    }
  };

  const routeToTask = (kpiId) => {
    if (!kpiId) return;
    if (userRef.current) {
      setFocusTaskId(kpiId);
      navigate(isClientRef.current ? 'mytasks' : 'actionboard');
    } else {
      pendingTapRef.current = kpiId;
    }
  };

  // Route a "daily report ready" notification tap to the Daily Reports screen,
  // auto-opening that report. Admin-only (the Home tile + server both gate it).
  // Same cold-start queueing as routeToTask — clear the other focus slots so a
  // stale id can't make an unrelated row flash on the next visit.
  const routeToReport = (reportId) => {
    if (!reportId) return;
    if (userRef.current) {
      setFocusReportId(reportId);
      setFocusTaskId(null);
      setFocusSnapshotId(null);
      navigate('dailyreports');
    } else {
      pendingReportRef.current = reportId;
    }
  };

  // Route an invoice notification tap to the invoice. A client lands on their
  // read-only "My Invoices"; an admin on the full Client Invoices screen. Same
  // cold-start queueing; clear the other focus slots so no stale row flashes.
  const routeToInvoice = (invoiceId) => {
    if (!invoiceId) return;
    if (userRef.current) {
      setFocusInvoiceId(invoiceId);
      setFocusTaskId(null);
      setFocusSnapshotId(null);
      setFocusReportId(null);
      navigate(isClientRef.current ? 'myinvoices' : 'clientinvoices');
    } else {
      pendingInvoiceRef.current = invoiceId;
    }
  };

  // Route a "workday ended" / snapshot push to that day's snapshot. The push
  // carries snapshot_id (kpi_notify._send_push) and, on an older server, an
  // anchor kpi_id that is NOT the tap target — without this branch the tap
  // opened whichever task that happened to be.
  const routeToSnapshot = (snapshotId) => {
    if (!snapshotId) return;
    if (userRef.current) {
      setFocusSnapshotId(snapshotId);
      setFocusTaskId(null);
      setFocusReportId(null);
      navigate('snapshots');
    } else {
      pendingSnapshotRef.current = snapshotId;
    }
  };

  // Keep a ref to `user` so listeners (registered once) see the latest value.
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // A task alarm (notifee) carries data.alarm==='1' + kpi_id + task_name and the
  // notification id. Show the full-screen ringing screen so the user can Stop it.
  const routeToAlarm = (notif) => {
    const data = notif?.data || {};
    if (String(data.alarm) !== '1') return;
    // A reminder alarm carries reminder_id and no kpi_id -- see the payload in
    // services/alarm.js. subject_kind is explicit rather than inferred, so an
    // older notification still in the tray (kpi_id, no subject_kind) keeps
    // behaving as a task.
    const isReminder = data.subject_kind === 'reminder' || (!data.kpi_id && !!data.reminder_id);
    const id = isReminder ? data.reminder_id : data.kpi_id;
    log.info('alarm → full-screen', { notifId: notif?.id, kind: isReminder ? 'reminder' : 'task', id });
    // `reason` = the optional note typed when setting the reminder (shown on the
    // alarm screen; blank → plain screen).
    setAlarmData({
      task: { kind: isReminder ? 'reminder' : 'task', id, name: data.task_name || '' },
      reason: data.reason || '',
      notifId: notif?.id,
    });
  };

  // STOP: cancel the notification (stops the loop), clear the stored reminder so
  // the card bell resets, and open the task (if logged in). Then drop the takeover.
  const stopAlarmAndClose = async () => {
    const a = alarmData;
    log.info('alarm: stop pressed', { notifId: a?.notifId, taskId: a?.task?.id });
    setAlarmData(null);
    if (a?.notifId) await stopAlarm(a.notifId);
    if (!a?.task?.id) return;
    // A REMINDER's id is not a task id. This branch used to be missing, so
    // Stop on a reminder cleared the bell of whichever task shared that number
    // and opened that unrelated task. A reminder's local state is its snooze
    // (the schedule itself is the server's), and Stop opens Reminders — where
    // tapping its notification already goes.
    if (a.task.kind === 'reminder') {
      try { await session.setReminderSnooze(a.task.id, null, user?.uid); } catch (_) {}
      routeToReminders();
      return;
    }
    try { await session.removeReminder(a.task.id); } catch (_) {}
    if (userRef.current) routeToTask(a.task.id);
  };

  // DONE (reminders only): silence it AND mark the reminder complete, which is
  // what advances a daily / weekly one to its next date on the server. Stop
  // alone left the reminder due, so it showed as overdue in the list until
  // somebody opened it and pressed Done there.
  const doneAlarmReminder = async () => {
    const a = alarmData;
    if (a?.task?.kind !== 'reminder') return stopAlarmAndClose();
    log.info('alarm: done pressed', { notifId: a?.notifId, reminderId: a?.task?.id });
    setAlarmData(null);
    if (a?.notifId) await stopAlarm(a.notifId);
    if (a?.task?.id) {
      try { await session.setReminderSnooze(a.task.id, null, user?.uid); } catch (_) {}
      try {
        const res = await completeReminder(a.task.id);
        if (res && res.status === false) log.warn('alarm: complete refused', res.message);
      } catch (e) { log.warn('alarm: complete failed', e?.message); }
    }
    routeToReminders();
  };

  // SNOOZE: stop the current ring and re-schedule the same alarm 5 minutes out,
  // updating the stored reminder so the card bell shows the new time.
  const snoozeAlarm = async () => {
    const a = alarmData;
    log.info('alarm: snooze pressed', { notifId: a?.notifId, kind: a?.task?.kind || 'task', id: a?.task?.id });
    setAlarmData(null);
    if (a?.notifId) await stopAlarm(a.notifId);
    if (a?.task?.id) {
      // Snooze length comes from the user's alarm settings (set in the picker).
      const { snoozeMins } = await session.getAlarmSettings();
      const mins = Math.max(1, snoozeMins || 5);
      const whenMs = Date.now() + mins * 60 * 1000;
      const reason = a.reason || '';
      const notifId = await scheduleTaskAlarm(a.task, whenMs, reason);
      const isReminder = a.task.kind === 'reminder';
      log.info('alarm: snoozed', { kind: a.task.kind || 'task', id: a.task.id, notifId, whenMs, snoozeMins: mins });
      try {
        if (isReminder) {
          // Snooze is LOCAL and temporary, and must stay that way. A reminder's
          // fire time is the server's next_trigger; writing 5-minutes-from-now
          // back would turn "remind me shortly" into "this reminder is now at
          // 15:05, every day" -- a silent edit to the schedule nobody asked for.
          //
          // Recording it also stops the 15s sync from killing it: syncReminderAlarms
          // cancels anything whose armed time no longer matches next_trigger, which
          // is exactly what a snooze looks like.
          // uid, so the snooze is keyed the same way the armed-alarm map is --
          // otherwise the sync reads one namespace and snooze writes another.
          await session.setReminderSnooze(a.task.id, {
            whenIso: new Date(whenMs).toISOString(), notifId, reason,
          }, user?.uid);
        } else {
          await session.setReminder(a.task.id, {
            whenIso: new Date(whenMs).toISOString(), notifId, mode: 'alarm', reason,
            snoozed: true,   // so the task shows a "Snoozed" state, not a plain reminder
          });
        }
      } catch (_) {}
    }
  };

  // Restore a remembered session + device-setup state on relaunch.
  useEffect(() => {
    (async () => {
      const conn = await session.getConnection();
      setProvisioned(!!(conn && conn.serverUrl));   // device already set up?
      const saved = await session.getSession();
      if (saved) setUser(saved);
      // Read the haptics preference once into the in-memory cache, so the first
      // button press doesn't have to await AsyncStorage to know whether to buzz.
      // Defaults to on, so a failure here is silent and harmless.
      loadHaptics();
      setRestoring(false);
    })();
  }, []);

  // Android hardware back: go one screen back instead of exiting the app.
  // Returning true from the handler tells Android we handled the event.
  //
  // Registered ONCE. It used to re-register on every screen change, which made it
  // the newest listener every time — and React Native asks the newest first, so
  // no screen could ever handle back itself (close a task detail, switch the
  // Profile tab back). Screens now do that through components/useBackHandler,
  // and this is only asked when none of them wanted the press.
  const backStateRef = useRef({});
  backStateRef.current = { user, appScreen, screen, forceSetup, alarmData };
  useEffect(() => {
    const toast = (msg) => {
      if (Platform.OS === 'android') ToastAndroid.show(msg, ToastAndroid.SHORT);
    };
    const onBack = () => {
      const st = backStateRef.current;
      // A ringing alarm covers everything. Back must neither close the app nor
      // quietly change the screen hidden underneath it.
      if (st.alarmData) { toast('Tap Stop or Snooze to close the alarm'); return true; }
      // (The old rule swallowed back for an unpaired developer to trap them on
      // the PIN screen. The PIN now gates only task ACTIONS, so back behaves
      // normally — the PIN screen is a place they chose to visit, not a cage.)
      // Any other screen goes back to the one it was opened from.
      if (st.user && st.appScreen !== 'home') { goBackRef.current(); return true; }
      // Odoo sheet open → close it, revealing the welcome ("Tap to Enter") screen.
      if (!st.user && st.screen === 'connect') { setScreen('login'); return true; }
      // On the welcome screen during admin setup → back to the mobile login page.
      if (!st.user && st.forceSetup) { setForceSetup(false); return true; }
      // Home / login: one press used to close the app, so a stray tap threw
      // people out. Warn first; a second press within the window exits.
      const now = Date.now();
      if (isSecondBackPress(lastBackRef.current, now)) { lastBackRef.current = 0; return false; }
      lastBackRef.current = now;
      toast('Press back again to exit');
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, []);

  // Register this device for push once logged in (needs the session cookie so
  // the token binds to the right user server-side).
  useEffect(() => {
    if (!user) return;
    (async () => {
      const token = await registerForPushAsync();
      if (token) pushTokenRef.current = token;
    })();
  }, [user?.uid]);

  // A widget tap arrives as a krakpi:// URL (the scheme is declared in app.json,
  // and the PendingIntent is built in plugins/withTaskWidget.js and
  // plugins/withLiveTrackingWidget.js).
  //
  // Both halves are needed: getInitialURL covers a COLD start, where the tap is
  // what launched the process, and the listener covers a WARM one, where the app
  // was already in memory and no initial URL is ever produced. Handling only the
  // first makes the widget work exactly once per boot.
  useEffect(() => {
    const handle = (url) => {
      // krakpi://widget/<dest>?action=…&kpi=…&user=… — parsed and bounded by
      // utils/widgetLink.js; anything it does not recognise is dropped here.
      const link = parseWidgetLink(url);
      if (!link) return;
      log.info('widget tap', { url, ...link });
      routeToWidgetScreen(link);
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e?.url));
    return () => { try { sub.remove(); } catch (_) {} };
  }, []);

  // Flush a queued cold-start tap only ONCE THE ROLE IS KNOWN (`gateReady`):
  // routeToTask picks the destination by role, and the gate resolves async —
  // flushing on login alone would still read isClient=false and send a client
  // to the empty Action Board, which is the bug this routing exists to fix.
  useEffect(() => {
    if (!user || !gateReady) return;
    if (pendingReportRef.current) {
      const reportId = pendingReportRef.current;
      pendingReportRef.current = null;
      log.info('cold-start tap flushed → report', { reportId });
      routeToReport(reportId);
      return;
    }
    if (pendingInvoiceRef.current) {
      const invoiceId = pendingInvoiceRef.current;
      pendingInvoiceRef.current = null;
      log.info('cold-start tap flushed → invoice', { invoiceId });
      routeToInvoice(invoiceId);
      return;
    }
    if (pendingSnapshotRef.current) {
      const snapshotId = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      log.info('cold-start tap flushed → snapshot', { snapshotId });
      routeToSnapshot(snapshotId);
      return;
    }
    if (pendingScreenRef.current) {
      const link = pendingScreenRef.current;
      pendingScreenRef.current = null;
      log.info('cold-start tap flushed → widget screen', { dest: link.dest, action: link.action });
      routeToWidgetScreen(link);
      return;
    }
    if (!pendingTapRef.current) return;
    const kpiId = pendingTapRef.current;
    pendingTapRef.current = null;
    log.info('cold-start tap flushed', { kpiId, isClient });
    routeToTask(kpiId);
  }, [user?.uid, gateReady, isClient]);

  // Role gate: a DEVELOPER ("User" in KRA/KPI terms) must pair via the PIN screen
  // before they can WORK. They still get the whole app read-only — Home, the bell,
  // Profile, and the board to look at — because pairing proves they're at their
  // computer to work, and reading isn't work. Admins/clients are never gated.
  useEffect(() => {
    if (!user) return;
    // Task reminders (the board's bell) are stored per user from here on. Set
    // before anything renders, so the board reads THIS user's map on mount.
    session.setReminderOwner(user.uid);
    let alive = true;
    setGateReady(false);   // role unknown until /kpi_user/info resolves → show a loader, never Home
    (async () => {
      // Seed from the last known server answer so there's no unlocked flash while
      // the request is in flight (same trick as WORKDAY_CACHE on the board).
      const cached = await getRoleState(user?.uid);
      if (alive && cached) {
        setIsClient(cached.kpiRole === 'client');
        setDevLocked(cached.kpiRole === 'developer');
      }
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) { if (alive) { setDevLocked(false); } return; } // offline demo → Home
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        // The route answers {status:false} when it hits an exception. That is a
        // failure, not a role: read as one, kpiRole came back '' → "not a
        // developer" → the board unlocked, and the empty role was cached for
        // every offline launch after. Throw into the catch below instead.
        if (info && info.status === false) throw new Error(info.message || '/kpi_user/info failed');
        const isAdmin = !!(info && (info.is_system || info.is_owner || info.is_admin));
        const isDev = !!(info && info.is_developer);
        if (!alive) return;
        // The KRA/KPI role ONLY (kpi_role: admin|client|developer) — the value
        // Login Management's dropdown sets and Profile shows
        // (res.users._compute_kpi_role). NOT the Odoo groups: those disagree, e.g.
        // a client who is also in the developer group would be wrongly gated.
        // Falls back to the flags if the server predates kpi_role on this route.
        const kpiRole = (info && info.kpi_role) || '';
        const lock = kpiRole ? kpiRole === 'developer' : (isDev && !isAdmin);
        setIsClient(kpiRole ? kpiRole === 'client' : !!(info && info.is_client_only));
        setDevLocked(lock);
        let wopen = true;    // non-developers are never gated
        let ddone = false;
        if (lock) {
          try {
            const st = await getWorkdayStatus();
            wopen = !!st?.is_open;
            ddone = !!st?.day_done;
            setTodayClosed(!!st?.today_closed);
            setWorkdayReopened(!!st?.reopened_reason);
          } catch (_) {
            // Unreachable → stay read-only rather than guessing "open". A wrongly
            // unlocked board offers buttons that will all fail server-side.
            wopen = false;
          }
        }
        if (!alive) return;
        setWorkdayOpen(wopen);
        setDayDone(ddone);
        // No forced navigation any more. There is no PIN screen to send anyone to,
        // and a developer who hasn't started yet simply sees a read-only board with
        // a Start Workday button on it.
        log.info('role gate', { kpi_role: kpiRole, lock, workday_open: wopen, day_done: ddone, isAdmin, isDev });
        saveRoleState(user?.uid, { kpiRole });   // for the offline path below
      } catch (e) {
        // Offline / server unreachable. Reuse the last known answer rather than
        // guessing "unlocked" — otherwise a developer who ended their workday
        // gets a fully-unlocked board with no signal, and every button fails.
        // Only fall open when we've genuinely never resolved a role.
        log.warn('role gate check failed, using cached role', e?.message);
        if (alive && !cached) setDevLocked(false);
      } finally {
        if (alive) setGateReady(true);   // role known → safe to render
      }
    })();
    return () => { alive = false; };
  }, [user?.uid]);

  // Poll the WORKDAY for a developer: pressing Start Workday (here or on the web)
  // lifts read-only, and End Workday drops back into it. This used to poll the
  // pairing state, which meant a five-minute idle un-pair could take the board
  // away mid-shift — the workday is the honest signal for "am I working?".
  useEffect(() => {
    if (!user || !devLocked) return;
    const id = setInterval(async () => {
      try {
        const st = await getWorkdayStatus();
        setWorkdayOpen(!!st?.is_open);
        setDayDone(!!st?.day_done);
        setTodayClosed(!!st?.today_closed);
        setWorkdayReopened(!!st?.reopened_reason);
      } catch (_) { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [user?.uid, devLocked]);

  // Keep this device's reminder alarms in step with the server.
  //
  // A reminder is armed locally from next_trigger; nothing pushes when a row is
  // created, so one added on the web — or on another phone — is invisible here
  // until we ask. Syncing on login and on every foreground is what makes "set it
  // on the web, it rings on the phone" actually true, instead of requiring the
  // user to open the Reminders screen first.
  //
  // Deliberately NOT gated on devLocked like the workday effects around it:
  // reminders belong to every role, not just developers.
  useEffect(() => {
    if (!user) return undefined;
    const sync = async () => {
      try {
        const res = await fetchReminders();
        if (res?.status) await syncReminderAlarms(res.reminders || [], user?.uid);
      } catch (_) { /* offline → whatever is already armed stays armed */ }
    };
    sync();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') sync(); });
    return () => sub.remove();
  }, [user?.uid]);

  // On app FOREGROUND (open / resume): refresh the workday state. Never
  // force-navigates — switching apps and back must not move anyone off the screen
  // they were reading, which is what the old PIN redirect did.
  useEffect(() => {
    if (!user || !devLocked) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const st = await getWorkdayStatus();
        setWorkdayOpen(!!st?.is_open);
        setDayDone(!!st?.day_done);
        setTodayClosed(!!st?.today_closed);
        setWorkdayReopened(!!st?.reopened_reason);
      } catch (_) { /* offline → keep current state */ }
    });
    return () => sub.remove();
  }, [user?.uid, devLocked]);

  // Notification tap → open the task on the board. Registered once; reads the
  // latest user via userRef. Also handles a cold-start tap (app launched from
  // a killed state by tapping the banner).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp?.notification?.request?.content?.data || {};
      log.info('notification tapped', { kpiId: data.kpi_id, reportId: data.report_id, invoiceId: data.invoice_id, reminderId: data.reminder_id });
      // Invoice / daily-report pushes carry an anchor kpi_id too — the specific
      // tap-target (invoice_id / report_id) wins so it opens the right screen,
      // not the unrelated anchor task.
      if (data.invoice_id) routeToInvoice(data.invoice_id);
      else if (data.report_id) routeToReport(data.report_id);
      else if (data.snapshot_id) routeToSnapshot(data.snapshot_id);
      else if (data.reminder_id) routeToReminders();
      else routeToTask(data.kpi_id);
    });
    (async () => {
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        const data = last?.notification?.request?.content?.data || {};
        if (data.invoice_id) { log.info('cold-start tap → invoice', { invoiceId: data.invoice_id }); routeToInvoice(data.invoice_id); }
        else if (data.report_id) { log.info('cold-start tap → report', { reportId: data.report_id }); routeToReport(data.report_id); }
        else if (data.snapshot_id) { log.info('cold-start tap → snapshot', { snapshotId: data.snapshot_id }); routeToSnapshot(data.snapshot_id); }
        else if (data.reminder_id) { log.info('cold-start tap \u2192 reminders', { reminderId: data.reminder_id }); routeToReminders(); }
        else if (data.kpi_id) { log.info('cold-start notification tap', { kpiId: data.kpi_id }); routeToTask(data.kpi_id); }
      } catch (_) {}
    })();
    return () => sub.remove();
  }, []);

  // Notifee (task alarm) events. onForegroundEvent covers the app-open cases: the
  // alarm fired while the app is up (DELIVERED) or the user tapped it (PRESS).
  // getInitialNotification covers the cold-start / lock-screen case where the
  // full-screen intent LAUNCHED the app. Both funnel through routeToAlarm, which
  // shows the full-screen Stop UI. Registered once.
  useEffect(() => {
    const nf = getNotifee();
    if (!nf) return;   // native module absent (pre-rebuild) — no alarm events
    const EventType = getEventType();
    const unsub = nf.onForegroundEvent(({ type, detail }) => {
      const notif = detail?.notification;
      if (!notif || String(notif?.data?.alarm) !== '1') return;
      if (type === EventType.DELIVERED || type === EventType.PRESS) {
        log.info('alarm foreground event', { type, notifId: notif.id });
        routeToAlarm(notif);
      }
    });
    (async () => {
      try {
        const initial = await nf.getInitialNotification();
        if (String(initial?.notification?.data?.alarm) === '1') {
          log.info('cold-start alarm', { notifId: initial.notification.id });
          routeToAlarm(initial.notification);
        }
      } catch (_) {}
    })();
    return () => unsub();
  }, []);

  // Warm lock-screen wake: when the full-screen intent brings a BACKGROUNDED (not
  // killed) app forward, getInitialNotification won't fire — so on every resume,
  // check the displayed notifications for a live alarm and show the Stop screen.
  useEffect(() => {
    const nf2 = getNotifee();
    if (!nf2) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const displayed = await nf2.getDisplayedNotifications();
        const hit = (displayed || []).find((d) => String(d?.notification?.data?.alarm) === '1');
        if (hit) { log.info('alarm resume-check → full-screen', { notifId: hit.notification?.id }); routeToAlarm(hit.notification); }
      } catch (_) {}
    });
    return () => sub.remove();
  }, []);

  const logout = async ({ skipServer = false } = {}) => {
    // Best-effort: stop this device receiving the previous user's banners.
    if (pushTokenRef.current) { unregisterPush(pushTokenRef.current); pushTokenRef.current = null; }
    // End the session on the SERVER too. Only the stored copy was ever
    // removed, so the cookie in the native jar stayed valid until Odoo expired
    // it, and calls still in flight finished as the old user. Skipped when the
    // server itself said the session is gone — there is nothing to destroy.
    if (!skipServer) {
      try {
        const { serverUrl } = await getConnection();
        if (serverUrl) await jsonRpc(serverUrl, '/web/session/destroy', {}, 8000);
      } catch (e) { log.info('session destroy skipped', e?.message); }
    }
    // Reminder alarms are scheduled with the OS, not with the server, so signing
    // out does not stop them. Without this the next person on this phone gets
    // the previous user's reminders — by name.
    clearReminderAlarms(user?.uid);
    // Per-task reminders too ("remind me in 60 min" on a card): OS alarms and
    // banners scheduled with this user's task names, which nothing cancelled, so
    // the next person on the phone got a full-screen alarm for somebody else's
    // task. Awaited, so the map is read before the owner below is cleared.
    await clearTaskReminders();
    session.setReminderOwner(null);
    // The home-screen widgets keep showing whatever was last written — the
    // previous user's running task and, for an admin, the whole team's day — on
    // a device nobody is signed in to. Both writers swallow their own errors.
    // The Live Tracking receiver is deliberately NOT disabled here: disabling a
    // provider makes Android delete every placed copy of it, so an admin would
    // lose the widget on each sign-out. Home's role gate decides that at login.
    clearWidgetState();
    clearLiveTrackingState();
    await session.clearSession();
    setUser(null);
    setScreen('login');
    historyRef.current = [];
    appScreenRef.current = 'home';
    setAppScreen('home');
    setFocusTaskId(null);
    setFocusReportId(null);
    setFocusInvoiceId(null);
    setWidgetAction(null);
    setFocusUserId(null);
    setDevLocked(false);
    // setDevPaired / setPairMode used to be called here. Neither existed any
    // more, so logout threw a ReferenceError at this point — after setUser(null)
    // had already sent the UI to the login screen, so nobody saw it, and before
    // every reset below, so none of them ran: the next account inherited the
    // previous one's workday cache, dayDone and role gate.
    setIsClient(false);
    setWorkdayOpen(false);
    setDayDone(false);
    setTodayClosed(false);
    setWorkdayReopened(false);
    setWorkdayAnim(false);
    setGateReady(false);
    // The board's workday cache is module scope, so it survives this sign-out —
    // the JS context doesn't reload. Clearing these state hooks without clearing
    // it left the next account inheriting the previous one's workday.
    resetWorkdayCache();
  };
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  // The server said the session is gone (api/odooApi.js). Until this existed a
  // restarted server left the app on Home with every screen failing and no way
  // back to login. Local state is cleared like a sign-out — nothing to destroy
  // server-side — and the login screen says why.
  const [sessionNotice, setSessionNotice] = useState('');
  useEffect(() => {
    setSessionExpiredHandler(() => {
      if (!userRef.current) return;
      log.warn('session expired → login');
      setSessionNotice('Your session has expired. Please sign in again.');
      logoutRef.current({ skipServer: true });
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  // Splash keeps showing until both the animation and the session read finish.
  //
  // Wrapped, because an intro animation is the least important thing in the app
  // and in a release build it was the most dangerous: when SplashScreen threw,
  // React unmounted everything, the root view never drew a frame, and
  // expo-splash-screen held the NATIVE splash forever — an app that looked hung
  // with no way in. Now a failure here costs the animation and nothing else:
  // onError marks the splash done and the app carries on to login.
  if (!ready || restoring) {
    bootTick('AppInner -> splash');
    return (
      <ErrorBoundary name="splash" fallback={null} onError={finishSplash}>
        <SplashScreen onDone={finishSplash} />
      </ErrorBoundary>
    );
  }

  // A ringing task alarm takes over EVERYTHING (even before login) so Stop is
  // always reachable to silence it. Wins over Home, the PIN gate, and login.
  if (alarmData) {
    return <AlarmScreen alarm={alarmData} onStop={stopAlarmAndClose} onSnooze={snoozeAlarm} onDone={doneAlarmReminder} />;
  }

  if (user) {
    log.info('render post-login screen', { appScreen, devLocked, workdayOpen, gateReady });
    // open(dest, param): param is an optional payload (e.g. a task id to focus).
    // `param` means different things per destination: a task id for the board /
    // My Requests, a snapshot id for Workday Snapshots. Route it into the right
    // slot — putting a snapshot id in focusTaskId would have the board hunting for
    // a task that doesn't exist. Always clear the other, so a stale id can't make
    // an unrelated row flash on the next visit.
    const open = (dest, param) => {
      log.info('open', dest, param);
      const isSnap = dest === 'snapshots';
      const isReport = dest === 'dailyreports';
      const isInvoice = dest === 'myinvoices' || dest === 'clientinvoices';
      setFocusSnapshotId(isSnap ? (param ?? null) : null);
      setFocusReportId(isReport ? (param ?? null) : null);
      setFocusInvoiceId(isInvoice ? (param ?? null) : null);
      setFocusTaskId(isSnap || isReport || isInvoice ? null : (param ?? null));
      navigate(dest);
    };

    // A developer whose workday is not open → task ACTIONS are off everywhere
    // (read-only). Everything else — Home, the bell, Profile, reading the board —
    // works as normal. Reading isn't work.
    const workdayLocked = devLocked && !workdayOpen;

    // Flip to read-only the instant End Workday returns, rather than leaving live
    // action buttons on screen until the 5s poll catches up.
    const onWorkdayEnded = () => {
      if (!devLocked) return;              // admins/clients are never locked
      log.info('workday ended → read-only');
      setWorkdayOpen(false);
      setDayDone(true);
    };

    // Start Workday from the read-only bar or the board: unlock immediately for
    // the same reason.
    const onWorkdayStarted = () => {
      // Attendance on (the admin's "Show attendance in the app" switch) → Start
      // Workday was also the HR check-in, so mark it with the drop-in picture.
      // Asked fresh each time so flipping the switch needs no relaunch; never
      // awaited, so the unlock below is not held up by it. Before the devLocked
      // return because admins start their day from the board too.
      fetchAttendanceStatus()
        .then((st) => { if (st && st.enabled) setWorkdayAnim(true); })
        .catch(() => {});
      if (!devLocked) return;
      log.info('workday started → unlocked');
      setWorkdayOpen(true);
      setDayDone(false);
    };

    // Until the role gate resolves, render a neutral loader — NEVER Home. This
    // stops a developer from seeing a flash of Home before the PIN gate loads.
    if (!gateReady) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2FB' }}>
          <ActivityIndicator size="large" color="#1E6FD9" />
        </View>
      );
    }

    // The WORKDAY gates work, not the app. A developer who hasn't started still
    // gets Home, the bell, Profile and a READ-ONLY board — starting the workday
    // is what says "I'm working", and reading isn't work. (The gate used to hide
    // everything, which meant the midnight auto-close locked them out and then
    // hid the very notification telling them why.) `workdayLocked` drives it.
    // Every post-login screen is rendered through renderScreen() so ScreenTransition
    // can play the same open animation for all of them — every option, every role.
    const renderScreen = () => {
    if (appScreen === 'dashboard')
      return <KraKpiDashboard onBack={goBack} />;
    if (appScreen === 'actionboard')
      // Back returns to wherever it was opened from. The board is reachable
      // whether or not the workday is open — read-only until it is.
      return (
        <KpiActionBoard
          onBack={goBack} focusTaskId={focusTaskId} onFocusHandled={() => setFocusTaskId(null)}
          workdayLocked={workdayLocked} dayDone={dayDone} todayClosed={todayClosed}
          onWorkdayStarted={onWorkdayStarted}
          onWorkdayEnded={onWorkdayEnded}
        />
      );
    if (appScreen === 'owner')
      return <OwnerDashboard onBack={goBack} />;
    if (appScreen === 'livetracking')
      // Admin: live "who's doing what now" + attendance. Route is admin-gated server-side.
      return (
        <LiveTracking
          onBack={goBack}
          // From a tap on one person's row of the home-screen widget.
          focusUserId={focusUserId} onFocusHandled={() => setFocusUserId(null)}
        />
      );
    if (appScreen === 'notifications')
      // isClient → a tapped notification opens My Requests, not the Action Board.
      // workdayLocked → READ MODE ONLY: rows still mark themselves read, but a null
      // onOpen means tapping never navigates to the task (onRowPress guards on it).
      return (
        <NotificationsScreen
          onBack={goBack} isClient={isClient}
          onOpen={workdayLocked ? null : open}
        />
      );
    if (appScreen === 'config')
      return <ConfigurationScreen onBack={goBack} />;
    if (appScreen === 'loginmgmt')
      return <LoginManagementScreen onBack={goBack} />;
    if (appScreen === 'users')
      // Admin: create/edit users with a KRA/KPI role only. Route is admin-gated server-side.
      return <UsersScreen onBack={goBack} />;
    if (appScreen === 'snapshots')
      // focusSnapshotId: set when an admin taps the "ended their workday"
      // notification → that day + developer auto-expand and the image flashes.
      return <WorkdaySnapshots onBack={goBack} focusSnapshotId={focusSnapshotId} />;
    if (appScreen === 'mysnapshots')
      // Self-scoped: every user sees ONLY their own workday snapshot images
      // (server route is hard-scoped to request.env.user).
      return <WorkdaySnapshots onBack={goBack} mine />;
    if (appScreen === 'paidwork')
      // Admin: what has been billed and settled. Paying an invoice archives its
      // tasks, so this is the only place they still exist. Route is role-gated
      // server-side; the tile is admin-only as well.
      return <PaidWork onBack={goBack} />;
    if (appScreen === 'dailyreports')
      // focusReportId: set when an admin taps a "Daily report ready" notification
      // → the Daily Reports screen opens that report's PDF.
      return <DailyReports onBack={goBack} focusReportId={focusReportId} />;
    if (appScreen === 'companybranding')
      return <CompanyBranding onBack={goBack} />;
    if (appScreen === 'workreport')
      return <WorkReport onBack={goBack} />;
    if (appScreen === 'krareport')
      return <KraReport onBack={goBack} />;
    if (appScreen === 'clientinvoices')
      return <ClientInvoices onBack={goBack} focusInvoiceId={focusInvoiceId} onFocusHandled={() => setFocusInvoiceId(null)} />;
    if (appScreen === 'myinvoices')
      // Client-facing read-only invoices (server record rule scopes to their own finalized/sent).
      return <ClientInvoices onBack={goBack} portal focusInvoiceId={focusInvoiceId} onFocusHandled={() => setFocusInvoiceId(null)} />;
    if (appScreen === 'myworkday')
      // Every user's OWN daily workday report (self-scoped server-side).
      return <MyWorkday onBack={goBack} />;
    if (appScreen === 'employeetracker')
      // The team-wide counterpart. /kpi_reports/developer_summary refuses anyone
      // below Coordinator itself, so the tile's adminOnly is convenience rather
      // than the boundary.
      return <EmployeeTracker onBack={goBack} />;
    if (appScreen === 'taskdocuments')
      // Documents across every task you are on. /task_documents/list scopes to
      // your own tasks server-side, so this needs no role gate here.
      return <TaskDocuments onBack={goBack} />;
    if (appScreen === 'mytasks')
      // focusTaskId: set when a client taps a notification → the row scrolls into
      // view and flashes, mirroring the board's behaviour for developers.
      return <ClientTasks onBack={goBack} focusTaskId={focusTaskId} />;
    if (appScreen === 'clientfiles')
      return <GenerateClientFiles onBack={goBack} />;
    if (appScreen === 'reassignhistory')
      return <ReassignmentHistory onBack={goBack} />;
    if (appScreen === 'taskqueue')
      return <ClientTaskQueue onBack={goBack} />;
    if (appScreen === 'usermanual')
      // Every role: role-tagged PDF manuals (server-filtered). The screen
      // self-gates admin add/edit/delete via app_bundle.can_edit.
      return <UserManual onBack={goBack} />;
    if (appScreen === 'reminders')
      // Standalone reminders — the same kpi.reminder rows the web shows under
      // My Work. No role gate here: the model's record rule scopes every row to
      // its owner, so this screen can only ever show the caller's own.
      return <Reminders onBack={goBack} uid={user?.uid} />;
    if (appScreen === 'attendance')
      // Behind the floating bubble on Home. Exists only while the admin's
      // "Show attendance in the app" switch is on; the screen asks the server
      // itself whether this person may see the team (admin / HR), so no role
      // prop is needed here. /kpi_attendance/mine is self-scoped server-side.
      return <AttendanceScreen onBack={goBack} />;
    // Upload screens share one component, differing only by docType.
    if (appScreen.startsWith('upload:'))
      return <UploadAmendments onBack={goBack} docType={appScreen.split(':')[1]} />;
    // Status shortcut (from Home stat cards) → the Action Board focused on one
    // status: list view auto-expands that heading; board view scrolls to its lane.
    if (appScreen.startsWith('status:'))
      return (
        <KpiActionBoard
          onBack={goBack} focusStatus={appScreen.split(':')[1]}
          workdayLocked={workdayLocked} dayDone={dayDone} todayClosed={todayClosed}
          onWorkdayStarted={onWorkdayStarted}
          onWorkdayEnded={onWorkdayEnded}
        />
      );
    return (
      <HomeScreen
        user={user}
        // Home & Profile have their OWN logout confirmation modals (which now
        // carry the one-per-day warning), so pass the raw logout — wrapping it in
        // another confirmation here too would double-confirm.
        onLogout={logout}
        onOpen={open}
        // Drives the red "read-only" line under the name + its Start/Ended
        // button. False for admins/clients — they're never locked.
        workdayLocked={workdayLocked}
        workdayOpen={workdayOpen}
        dayDone={dayDone} todayClosed={todayClosed} workdayReopened={workdayReopened}
        // Start Workday straight from the read-only bar — there is no PIN screen
        // to route to any more.
        onWorkdayStarted={onWorkdayStarted}
        // The task widget's Pause / Resume button, acted on once by Home.
        widgetAction={widgetAction} onWidgetActionHandled={() => setWidgetAction(null)}
      />
    );
    };  // end renderScreen

    // key by appScreen so each navigation replays the enter animation.
    return (
      <>
        <ScreenTransition screenKey={appScreen}>
          {renderScreen()}
        </ScreenTransition>
        <WorkdayStartAnimation visible={workdayAnim} onDone={() => setWorkdayAnim(false)} />
      </>
    );
  }

  // Not logged in. Once the device is set up (server URL saved), the PRIMARY
  // login is mobile# + password. The Odoo device-setup login stays reachable
  // via "Admin / device setup" (and on a fresh install) so no one is locked out.
  if (provisioned && !forceSetup) {
    return (
      <AppLoginScreen
        onLogin={(u) => { setSessionNotice(''); setForceSetup(false); setUser(u); }}
        onNeedSetup={() => { setForceSetup(true); setScreen('connect'); }}
        notice={sessionNotice}
      />
    );
  }

  // Fresh install / forced setup: welcome + the Connect (URL/DB/Odoo login) sheet.
  // A successful connect only PROVISIONS the device (saves the server/DB); it does
  // NOT log a user in. The app then shows the mobile-number (non-Odoo) login page.
  return (
    <>
      <LoginScreen goConnect={() => setScreen('connect')} />
      <ConnectScreen
        visible={screen === 'connect'}
        onLogin={() => { setProvisioned(true); setForceSetup(false); setScreen('login'); }}
        goBack={() => setScreen('login')}
      />
    </>
  );
}
