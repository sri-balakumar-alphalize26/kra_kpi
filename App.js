// KRA/KPI app shell: spinning KPI-wheel Splash → Welcome → Login (Odoo connect)
// → Home. A remembered Odoo session boots straight to Home after the splash.
import React, { useState, useEffect, useRef } from 'react';
import { BackHandler, View, ActivityIndicator, AppState, Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import ConnectScreen from './screens/ConnectScreen';
import HomeScreen from './screens/HomeScreen';
import KraKpiDashboard from './screens/KraKpiDashboard';
import KpiActionBoard from './screens/KpiActionBoard';
import UploadAmendments from './screens/UploadAmendments';
import OwnerDashboard from './screens/OwnerDashboard';
import LiveTracking from './screens/LiveTracking';
import NotificationsScreen from './screens/NotificationsScreen';
import ConfigurationScreen from './screens/ConfigurationScreen';
import LoginManagementScreen from './screens/LoginManagementScreen';
import UsersScreen from './screens/UsersScreen';
import WorkdaySnapshots from './screens/WorkdaySnapshots';
import DailyReports from './screens/DailyReports';
import CompanyBranding from './screens/CompanyBranding';
import WorkReport from './screens/WorkReport';
import ClientInvoices from './screens/ClientInvoices';
import MyWorkday from './screens/MyWorkday';
import ClientTasks from './screens/ClientTasks';
import GenerateClientFiles from './screens/GenerateClientFiles';
import ReassignmentHistory from './screens/ReassignmentHistory';
import ClientTaskQueue from './screens/ClientTaskQueue';
import UserManual from './screens/UserManual';
import StartWorkingScreen from './screens/StartWorkingScreen';
import AppLoginScreen from './screens/AppLoginScreen';
import AlarmScreen from './screens/AlarmScreen';
import ScreenTransition from './components/ScreenTransition';
import { scheduleTaskAlarm, stopAlarm } from './services/alarm';

// notifee is a native module, present only after the one-time rebuild. Load it
// DEFENSIVELY — a static import would throw at launch in a build without the native
// side and crash the app. Until it's available the alarm event wiring below no-ops;
// the app runs normally and the notification reminder still works.
let notifee = null, EventType = {};
try {
  const nf = require('@notifee/react-native');
  notifee = nf.default;
  EventType = nf.EventType;
} catch (_) { /* notifee native module absent (pre-rebuild) — alarm inert */ }
import * as session from './api/session';
import { getConnection, getRoleState, saveRoleState } from './api/session';
import { jsonRpc } from './api/odooApi';
import { createLogger } from './api/logger';
import { registerForPushAsync, unregisterPush } from './services/push';
import { pairingStatus } from './services/pairing';

const log = createLogger('App');

// Definitive runtime check: 'storeClient' = Expo Go (local notifications DON'T
// display there); 'standalone'/'bare' = a real dev/standalone build (they do).
log.info('runtime env', {
  executionEnvironment: Constants.executionEnvironment,
  appOwnership: Constants.appOwnership,
  isExpoGo: Constants.executionEnvironment === 'storeClient',
});

// Show a banner + add to the tray even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // Diagnostic: proves a (local or push) notification actually FIRED while the
    // app is foregrounded — the reminder alarm should log here when its timer hits.
    log.info('notification received (foreground)', {
      title: notification?.request?.content?.title,
      data: notification?.request?.content?.data,
    });
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

// SafeAreaProvider supplies the real system-bar insets (used by TabBar to sit
// above the phone's nav/gesture bar).
export default function App() {
  return (
    <SafeAreaProvider>
      {/* One app-wide status bar: dark icons on the transparent (edge-to-edge)
          bar, so every screen's light background shows through — no black strip. */}
      <StatusBar style="dark" />
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [ready, setReady] = useState(false);       // splash finished
  const [restoring, setRestoring] = useState(true); // reading saved session
  const [screen, setScreen] = useState('login');    // login (welcome) | connect
  const [user, setUser] = useState(null);
  const [appScreen, setAppScreen] = useState('home'); // post-login: home | dashboard | actionboard | startworking
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
  const [devLocked, setDevLocked] = useState(false);  // this user is a developer who must pair
  const [devPaired, setDevPaired] = useState(false);  // developer's device is currently paired
  // Pairing 'mode' ('resume' = workday still open but unpaired; 'start' = none) and
  // 'dayDone' (developer ENDED today → one start + one end per day). Both come from
  // pairingStatus(); they drive the Home read-only bar's Continue/Start/Ended label.
  const [pairMode, setPairMode] = useState('start');
  const [dayDone, setDayDone] = useState(false);
  const [gateReady, setGateReady] = useState(false);  // role gate resolved → avoids a Home flash before the PIN gate
  const [provisioned, setProvisioned] = useState(false); // device set up (server URL saved)
  const [forceSetup, setForceSetup] = useState(false);   // show Odoo device-setup over the app login

  const [isClient, setIsClient] = useState(false);     // client-only user → no Action Board

  const pushTokenRef = useRef(null);       // this device's Expo token (for logout unregister)
  const pendingTapRef = useRef(null);      // kpi_id from a tap that arrived before login/restore
  const pendingReportRef = useRef(null);   // report_id from a "daily report ready" tap before login
  const pendingInvoiceRef = useRef(null);  // invoice_id from an invoice notification tap before login
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
  const routeToTask = (kpiId) => {
    if (!kpiId) return;
    if (userRef.current) {
      setFocusTaskId(kpiId);
      setAppScreen(isClientRef.current ? 'mytasks' : 'actionboard');
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
      setAppScreen('dailyreports');
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
      setAppScreen(isClientRef.current ? 'myinvoices' : 'clientinvoices');
    } else {
      pendingInvoiceRef.current = invoiceId;
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
    log.info('alarm → full-screen', { notifId: notif?.id, kpiId: data.kpi_id });
    // `reason` = the optional note typed when setting the reminder (shown on the
    // alarm screen; blank → plain screen).
    setAlarmData({ task: { id: data.kpi_id, name: data.task_name || '' }, reason: data.reason || '', notifId: notif?.id });
  };

  // STOP: cancel the notification (stops the loop), clear the stored reminder so
  // the card bell resets, and open the task (if logged in). Then drop the takeover.
  const stopAlarmAndClose = async () => {
    const a = alarmData;
    log.info('alarm: stop pressed', { notifId: a?.notifId, taskId: a?.task?.id });
    setAlarmData(null);
    if (a?.notifId) await stopAlarm(a.notifId);
    if (a?.task?.id) {
      try { await session.removeReminder(a.task.id); } catch (_) {}
      if (userRef.current) routeToTask(a.task.id);
    }
  };

  // SNOOZE: stop the current ring and re-schedule the same alarm 5 minutes out,
  // updating the stored reminder so the card bell shows the new time.
  const snoozeAlarm = async () => {
    const a = alarmData;
    log.info('alarm: snooze pressed', { notifId: a?.notifId, taskId: a?.task?.id });
    setAlarmData(null);
    if (a?.notifId) await stopAlarm(a.notifId);
    if (a?.task) {
      // Snooze length comes from the user's alarm settings (set in the picker).
      const { snoozeMins } = await session.getAlarmSettings();
      const mins = Math.max(1, snoozeMins || 5);
      const whenMs = Date.now() + mins * 60 * 1000;
      const reason = a.reason || '';
      const notifId = await scheduleTaskAlarm(a.task, whenMs, reason);
      log.info('alarm: snoozed', { taskId: a.task.id, notifId, whenMs, snoozeMins: mins });
      try {
        await session.setReminder(a.task.id, {
          whenIso: new Date(whenMs).toISOString(), notifId, mode: 'alarm', reason,
          snoozed: true,   // so the task shows a "Snoozed" state, not a plain reminder
        });
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
      setRestoring(false);
    })();
  }, []);

  // Android hardware back: go one screen back instead of exiting the app.
  // Returning true from the handler tells Android we handled the event.
  useEffect(() => {
    const onBack = () => {
      // (The old rule swallowed back for an unpaired developer to trap them on
      // the PIN screen. The PIN now gates only task ACTIONS, so back behaves
      // normally — the PIN screen is a place they chose to visit, not a cage.)
      // Everyone else: a non-home screen goes back to Home.
      if (user && appScreen !== 'home') { setAppScreen('home'); return true; }
      // Odoo sheet open → close it, revealing the welcome ("Tap to Enter") screen.
      if (!user && screen === 'connect') { setScreen('login'); return true; }
      // On the welcome screen during admin setup → back to the mobile login page.
      if (!user && forceSetup) { setForceSetup(false); return true; }
      return false; // at home / login — let the OS handle it (exit)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [user, appScreen, screen, devLocked, devPaired, forceSetup]);

  // Register this device for push once logged in (needs the session cookie so
  // the token binds to the right user server-side).
  useEffect(() => {
    if (!user) return;
    (async () => {
      const token = await registerForPushAsync();
      if (token) pushTokenRef.current = token;
    })();
  }, [user?.uid]);

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
    let alive = true;
    setGateReady(false);   // role unknown until /kpi_user/info resolves → show a loader, never Home
    (async () => {
      // Seed from the last known server answer so there's no unlocked flash while
      // the request is in flight (same trick as WORKDAY_CACHE on the board).
      const cached = await getRoleState(user?.uid);
      if (alive && cached) {
        setIsClient(cached.kpiRole === 'client');
        setDevLocked(cached.kpiRole === 'developer');
        setDevPaired(!!cached.paired);
      }
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) { if (alive) { setDevLocked(false); } return; } // offline demo → Home
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        const isAdmin = !!(info && (info.is_system || info.is_owner || info.is_admin));
        const isDev = !!(info && info.is_developer);
        if (!alive) return;
        // The KRA/KPI role ONLY (kpi_role: admin|client|developer) — the value
        // Login Management's dropdown sets and Profile shows
        // (res.users._compute_kpi_role). NOT the Odoo groups: those disagree, e.g.
        // a client who is also in the developer group would be wrongly PIN-locked.
        // Falls back to the flags if the server predates kpi_role on this route.
        const kpiRole = (info && info.kpi_role) || '';
        const lock = kpiRole ? kpiRole === 'developer' : (isDev && !isAdmin);
        setIsClient(kpiRole ? kpiRole === 'client' : !!(info && info.is_client_only));
        setDevLocked(lock);
        let paired = true;   // non-developers are never gated
        let pmode = 'start';
        let ddone = false;
        if (lock) {
          try {
            const st = await pairingStatus();
            paired = !!st?.paired;
            pmode = st?.mode || 'start';
            ddone = !!st?.dayDone;
          } catch (_) { paired = false; }
        }
        if (!alive) return;
        setDevPaired(paired);
        setPairMode(pmode);
        setDayDone(ddone);
        // Started-then-closed: the workday is still OPEN but the web tab was closed,
        // so the device un-paired with mode='resume'. Land straight on the PIN screen
        // to re-pair and continue. mode='start' (never started / already ended) stays
        // read-only — no forced PIN. Ended-for-today (day_done) also stays read-only:
        // no restart until tomorrow, so never force the PIN there.
        if (lock && !paired && pmode === 'resume' && !ddone) {
          setAppScreen((s) => (s === 'startworking' ? s : 'startworking'));
        }
        log.info('role gate', { kpi_role: kpiRole, lock, paired, mode: pmode, day_done: ddone, isAdmin, isDev });
        saveRoleState(user?.uid, { kpiRole, paired });   // for the offline path below
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

  // Poll pairing for a developer: pairing on the web lifts read-only here, and
  // being un-paired (End Workday / auto-away / midnight close) drops back into it.
  useEffect(() => {
    if (!user || !devLocked) return;
    const id = setInterval(async () => {
      try {
        const st = await pairingStatus();
        setPairMode(st?.mode || 'start');
        setDayDone(!!st?.dayDone);
        setDevPaired((prev) => {
          const now = !!st?.paired;
          if (now !== prev) {
            // Keep the offline cache honest — this is the other place the paired
            // state changes, and a stale cache would show the wrong mode offline.
            saveRoleState(user?.uid, { kpiRole: 'developer', paired: now });
            // Only navigate if they're SITTING on the PIN screen waiting: send
            // them to the board they wanted. Never yank someone off Home or a
            // screen they're reading just because pairing landed.
            if (now) setAppScreen((s) => (s === 'startworking' ? 'actionboard' : s));
          }
          return now;
        });
      } catch (_) { /* keep polling */ }
    }, 5000);
    return () => clearInterval(id);
  }, [user?.uid, devLocked]);

  // On app FOREGROUND (open / resume): just REFRESH the pairing state — do NOT
  // force-navigate to the PIN screen. A developer who un-paired while the workday
  // is still open (web tab closed / away) drops to a READ-ONLY board that now
  // shows a "Continue Workday" button (utils/workdayState.js); they tap it when
  // ready. This used to hard-redirect to the PIN screen on every resume, which
  // yanked people there just for switching apps and back — the source of the
  // intermittent "it keeps sending me to the PIN screen". The startup role gate
  // still lands an already-open-but-unpaired developer on the PIN screen; only
  // this mid-session resume no longer does.
  useEffect(() => {
    if (!user || !devLocked) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const st = await pairingStatus();
        setDevPaired(!!st?.paired);
        setPairMode(st?.mode || 'start');
        setDayDone(!!st?.dayDone);
        saveRoleState(user?.uid, { kpiRole: 'developer', paired: !!st?.paired });
      } catch (_) { /* offline → keep current mode */ }
    });
    return () => sub.remove();
  }, [user?.uid, devLocked]);

  // Notification tap → open the task on the board. Registered once; reads the
  // latest user via userRef. Also handles a cold-start tap (app launched from
  // a killed state by tapping the banner).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp?.notification?.request?.content?.data || {};
      log.info('notification tapped', { kpiId: data.kpi_id, reportId: data.report_id, invoiceId: data.invoice_id });
      // Invoice / daily-report pushes carry an anchor kpi_id too — the specific
      // tap-target (invoice_id / report_id) wins so it opens the right screen,
      // not the unrelated anchor task.
      if (data.invoice_id) routeToInvoice(data.invoice_id);
      else if (data.report_id) routeToReport(data.report_id);
      else routeToTask(data.kpi_id);
    });
    (async () => {
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        const data = last?.notification?.request?.content?.data || {};
        if (data.invoice_id) { log.info('cold-start tap → invoice', { invoiceId: data.invoice_id }); routeToInvoice(data.invoice_id); }
        else if (data.report_id) { log.info('cold-start tap → report', { reportId: data.report_id }); routeToReport(data.report_id); }
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
    if (!notifee) return;   // native module absent (pre-rebuild) — no alarm events
    const unsub = notifee.onForegroundEvent(({ type, detail }) => {
      const notif = detail?.notification;
      if (!notif || String(notif?.data?.alarm) !== '1') return;
      if (type === EventType.DELIVERED || type === EventType.PRESS) {
        log.info('alarm foreground event', { type, notifId: notif.id });
        routeToAlarm(notif);
      }
    });
    (async () => {
      try {
        const initial = await notifee.getInitialNotification();
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
    if (!notifee) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const displayed = await notifee.getDisplayedNotifications();
        const hit = (displayed || []).find((d) => String(d?.notification?.data?.alarm) === '1');
        if (hit) { log.info('alarm resume-check → full-screen', { notifId: hit.notification?.id }); routeToAlarm(hit.notification); }
      } catch (_) {}
    });
    return () => sub.remove();
  }, []);

  const logout = async () => {
    // Best-effort: stop this device receiving the previous user's banners.
    if (pushTokenRef.current) { unregisterPush(pushTokenRef.current); pushTokenRef.current = null; }
    await session.clearSession();
    setUser(null);
    setScreen('login');
    setAppScreen('home');
    setFocusTaskId(null);
    setFocusReportId(null);
    setFocusInvoiceId(null);
    setDevLocked(false);
    setDevPaired(false);
    setPairMode('start');
    setDayDone(false);
    setGateReady(false);
  };

  // Confirm before logging out. A mis-tap on the log-out icon shouldn't end the
  // session — and, per the one-start-one-end-per-day rule, logging out then back
  // in must not become a backdoor to a second workday, so we warn about that too.
  // Non-developers (never locked) get a plain confirm without the workday line.
  const confirmLogout = () => {
    const warn = devLocked
      ? "You'll be signed out. If you've ended your workday, logging back in won't let you start another one today."
      : "You'll be signed out of the app.";
    Alert.alert('Log out?', warn, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => { logout(); } },
    ]);
  };

  // Splash keeps showing until both the animation and the session read finish.
  if (!ready || restoring) return <SplashScreen onDone={() => setReady(true)} />;

  // A ringing task alarm takes over EVERYTHING (even before login) so Stop is
  // always reachable to silence it. Wins over Home, the PIN gate, and login.
  if (alarmData) {
    return <AlarmScreen alarm={alarmData} onStop={stopAlarmAndClose} onSnooze={snoozeAlarm} />;
  }

  if (user) {
    log.info('render post-login screen', { appScreen, devLocked, devPaired, gateReady });
    // Returning home clears any pending task-focus so it can't re-pulse later.
    const home = () => { setAppScreen('home'); setFocusTaskId(null); };
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
      setAppScreen(dest);
    };

    // A developer ("User") who hasn't paired → the workday hasn't started, so
    // task ACTIONS are off everywhere (read-only). Everything else works.
    const workdayLocked = devLocked && !devPaired;

    // End Workday un-pairs the device server-side (action_end_day → _unpair), so
    // flip to read-only immediately rather than leaving live action buttons on
    // screen until the 5s pairing poll catches up. Cache it too, so the mode is
    // still right if they go offline before the next successful request.
    const onWorkdayEnded = () => {
      if (!devLocked) return;              // admins/clients are never locked
      log.info('workday ended → read-only');
      setDevPaired(false);
      saveRoleState(user?.uid, { kpiRole: 'developer', paired: false });
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

    // The PIN gates WORK, not the app. An unpaired developer still gets Home,
    // the bell, Profile and a READ-ONLY board — pairing proves they're at their
    // computer to work, and reading isn't work. (It used to gate everything,
    // which meant the midnight auto-close un-paired them and then hid the very
    // notification telling them why.) `workdayLocked` below drives the read-only
    // UI; this route is just the PIN screen itself.
    // Every post-login screen is rendered through renderScreen() so ScreenTransition
    // can play the same open animation for all of them — every option, every role.
    const renderScreen = () => {
    if (appScreen === 'startworking') {
      return (
        <StartWorkingScreen
          // Backing out returns to the board they were heading for (read-only),
          // not Home — a mis-tap shouldn't cost them their place.
          onBack={() => setAppScreen('actionboard')}
          onLogout={confirmLogout}
          // Nothing starts until the PIN is verified: /kpi_pair/verify is what
          // opens the workday, so walking away from here starts nothing.
          onPaired={() => { setDevPaired(true); setDayDone(false); setAppScreen('actionboard'); }}
        />
      );
    }

    if (appScreen === 'dashboard')
      return <KraKpiDashboard onBack={home} />;
    if (appScreen === 'actionboard')
      // Back always returns to Home (the developer is paired once they can reach
      // the board; the PIN screen is only the pre-pair gate).
      return (
        <KpiActionBoard
          onBack={home} focusTaskId={focusTaskId} onFocusHandled={() => setFocusTaskId(null)}
          workdayLocked={workdayLocked} onNeedPair={() => setAppScreen('startworking')}
          onWorkdayEnded={onWorkdayEnded}
        />
      );
    if (appScreen === 'owner')
      return <OwnerDashboard onBack={home} />;
    if (appScreen === 'livetracking')
      // Admin: live "who's doing what now" + attendance. Route is admin-gated server-side.
      return <LiveTracking onBack={home} />;
    if (appScreen === 'notifications')
      // isClient → a tapped notification opens My Requests, not the Action Board.
      // workdayLocked → READ MODE ONLY: rows still mark themselves read, but a null
      // onOpen means tapping never navigates to the task (onRowPress guards on it).
      return (
        <NotificationsScreen
          onBack={home} isClient={isClient}
          onOpen={workdayLocked ? null : open}
        />
      );
    if (appScreen === 'config')
      return <ConfigurationScreen onBack={home} />;
    if (appScreen === 'loginmgmt')
      return <LoginManagementScreen onBack={home} />;
    if (appScreen === 'users')
      // Admin: create/edit users with a KRA/KPI role only. Route is admin-gated server-side.
      return <UsersScreen onBack={home} />;
    if (appScreen === 'snapshots')
      // focusSnapshotId: set when an admin taps the "ended their workday"
      // notification → that day + developer auto-expand and the image flashes.
      return <WorkdaySnapshots onBack={home} focusSnapshotId={focusSnapshotId} />;
    if (appScreen === 'mysnapshots')
      // Self-scoped: every user sees ONLY their own workday snapshot images
      // (server route is hard-scoped to request.env.user).
      return <WorkdaySnapshots onBack={home} mine />;
    if (appScreen === 'dailyreports')
      // focusReportId: set when an admin taps a "Daily report ready" notification
      // → the Daily Reports screen opens that report's PDF.
      return <DailyReports onBack={home} focusReportId={focusReportId} />;
    if (appScreen === 'companybranding')
      return <CompanyBranding onBack={home} />;
    if (appScreen === 'workreport')
      return <WorkReport onBack={home} />;
    if (appScreen === 'clientinvoices')
      return <ClientInvoices onBack={home} focusInvoiceId={focusInvoiceId} onFocusHandled={() => setFocusInvoiceId(null)} />;
    if (appScreen === 'myinvoices')
      // Client-facing read-only invoices (server record rule scopes to their own finalized/sent).
      return <ClientInvoices onBack={home} portal focusInvoiceId={focusInvoiceId} onFocusHandled={() => setFocusInvoiceId(null)} />;
    if (appScreen === 'myworkday')
      // Every user's OWN daily workday report (self-scoped server-side).
      return <MyWorkday onBack={home} />;
    if (appScreen === 'mytasks')
      // focusTaskId: set when a client taps a notification → the row scrolls into
      // view and flashes, mirroring the board's behaviour for developers.
      return <ClientTasks onBack={home} focusTaskId={focusTaskId} />;
    if (appScreen === 'clientfiles')
      return <GenerateClientFiles onBack={home} />;
    if (appScreen === 'reassignhistory')
      return <ReassignmentHistory onBack={home} />;
    if (appScreen === 'taskqueue')
      return <ClientTaskQueue onBack={home} />;
    if (appScreen === 'usermanual')
      // Every role: role-tagged PDF manuals (server-filtered). The screen
      // self-gates admin add/edit/delete via app_bundle.can_edit.
      return <UserManual onBack={home} />;
    // (A second `appScreen === 'startworking'` branch used to sit here. It was
    // unreachable — the live one above returns first — and still carried the
    // retired "locked developer: no back button" rule, contradicting it.)
    // Upload screens share one component, differing only by docType.
    if (appScreen.startsWith('upload:'))
      return <UploadAmendments onBack={home} docType={appScreen.split(':')[1]} />;
    // Status shortcut (from Home stat cards) → the Action Board focused on one
    // status: list view auto-expands that heading; board view scrolls to its lane.
    if (appScreen.startsWith('status:'))
      return (
        <KpiActionBoard
          onBack={home} focusStatus={appScreen.split(':')[1]}
          workdayLocked={workdayLocked} onNeedPair={() => setAppScreen('startworking')}
          onWorkdayEnded={onWorkdayEnded}
        />
      );
    return (
      <HomeScreen
        user={user}
        // Home & Profile have their OWN logout confirmation modals (which now
        // carry the one-per-day warning), so pass the raw logout — wrapping it in
        // confirmLogout's Alert too would double-confirm. StartWorkingScreen has
        // no modal, so it gets confirmLogout.
        onLogout={logout}
        onOpen={open}
        // Drives the red "read-only" line under the name + its Start/Continue/
        // Ended button. False for admins/clients — they're never locked.
        workdayLocked={workdayLocked}
        // workdayOpen: the session is still open (unpaired via tab-close/away) →
        // the bar says "Continue Workday". dayDone: ended today → "ended" state.
        workdayOpen={pairMode === 'resume'}
        dayDone={dayDone}
        onNeedPair={() => setAppScreen('startworking')}
      />
    );
    };  // end renderScreen

    // key by appScreen so each navigation replays the enter animation.
    return (
      <ScreenTransition screenKey={appScreen}>
        {renderScreen()}
      </ScreenTransition>
    );
  }

  // Not logged in. Once the device is set up (server URL saved), the PRIMARY
  // login is mobile# + password. The Odoo device-setup login stays reachable
  // via "Admin / device setup" (and on a fresh install) so no one is locked out.
  if (provisioned && !forceSetup) {
    return (
      <AppLoginScreen
        onLogin={(u) => { setForceSetup(false); setUser(u); }}
        onNeedSetup={() => { setForceSetup(true); setScreen('connect'); }}
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
