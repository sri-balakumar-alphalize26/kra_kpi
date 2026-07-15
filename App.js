// KRA/KPI app shell: spinning KPI-wheel Splash → Welcome → Login (Odoo connect)
// → Home. A remembered Odoo session boots straight to Home after the splash.
import React, { useState, useEffect, useRef } from 'react';
import { BackHandler, View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import ConnectScreen from './screens/ConnectScreen';
import HomeScreen from './screens/HomeScreen';
import KraKpiDashboard from './screens/KraKpiDashboard';
import KpiActionBoard from './screens/KpiActionBoard';
import UploadAmendments from './screens/UploadAmendments';
import OwnerDashboard from './screens/OwnerDashboard';
import NotificationsScreen from './screens/NotificationsScreen';
import ConfigurationScreen from './screens/ConfigurationScreen';
import LoginManagementScreen from './screens/LoginManagementScreen';
import ClientTasks from './screens/ClientTasks';
import GenerateClientFiles from './screens/GenerateClientFiles';
import ReassignmentHistory from './screens/ReassignmentHistory';
import ClientTaskQueue from './screens/ClientTaskQueue';
import StartWorkingScreen from './screens/StartWorkingScreen';
import AppLoginScreen from './screens/AppLoginScreen';
import * as session from './api/session';
import { getConnection, getRoleState, saveRoleState } from './api/session';
import { jsonRpc } from './api/odooApi';
import { createLogger } from './api/logger';
import { registerForPushAsync, unregisterPush } from './services/push';
import { pairingStatus } from './services/pairing';

const log = createLogger('App');

// Show a banner + add to the tray even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// SafeAreaProvider supplies the real system-bar insets (used by TabBar to sit
// above the phone's nav/gesture bar).
export default function App() {
  return (
    <SafeAreaProvider>
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
  const [devLocked, setDevLocked] = useState(false);  // this user is a developer who must pair
  const [devPaired, setDevPaired] = useState(false);  // developer's device is currently paired
  const [gateReady, setGateReady] = useState(false);  // role gate resolved → avoids a Home flash before the PIN gate
  const [provisioned, setProvisioned] = useState(false); // device set up (server URL saved)
  const [forceSetup, setForceSetup] = useState(false);   // show Odoo device-setup over the app login

  const [isClient, setIsClient] = useState(false);     // client-only user → no Action Board

  const pushTokenRef = useRef(null);       // this device's Expo token (for logout unregister)
  const pendingTapRef = useRef(null);      // kpi_id from a tap that arrived before login/restore
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

  // Keep a ref to `user` so listeners (registered once) see the latest value.
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

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
    if (!user || !gateReady || !pendingTapRef.current) return;
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
        if (lock) {
          try {
            const st = await pairingStatus();
            paired = !!st?.paired;
          } catch (_) { paired = false; }
        }
        if (!alive) return;
        setDevPaired(paired);
        log.info('role gate', { kpi_role: kpiRole, lock, paired, isAdmin, isDev });
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

  // Notification tap → open the task on the board. Registered once; reads the
  // latest user via userRef. Also handles a cold-start tap (app launched from
  // a killed state by tapping the banner).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const kpiId = resp?.notification?.request?.content?.data?.kpi_id;
      log.info('notification tapped', { kpiId });
      routeToTask(kpiId);
    });
    (async () => {
      try {
        const last = await Notifications.getLastNotificationResponseAsync();
        const kpiId = last?.notification?.request?.content?.data?.kpi_id;
        if (kpiId) { log.info('cold-start notification tap', { kpiId }); routeToTask(kpiId); }
      } catch (_) {}
    })();
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
    setDevLocked(false);
    setDevPaired(false);
    setGateReady(false);
  };

  // Splash keeps showing until both the animation and the session read finish.
  if (!ready || restoring) return <SplashScreen onDone={() => setReady(true)} />;

  if (user) {
    log.info('render post-login screen', { appScreen, devLocked, devPaired, gateReady });
    // Returning home clears any pending task-focus so it can't re-pulse later.
    const home = () => { setAppScreen('home'); setFocusTaskId(null); };
    // open(dest, param): param is an optional payload (e.g. a task id to focus).
    const open = (dest, param) => { log.info('open', dest, param); setFocusTaskId(param ?? null); setAppScreen(dest); };

    // A developer ("User") who hasn't paired → the workday hasn't started, so
    // task ACTIONS are off everywhere (read-only). Everything else works.
    const workdayLocked = devLocked && !devPaired;

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
    if (appScreen === 'startworking') {
      return (
        <StartWorkingScreen
          // Backing out returns to the board they were heading for (read-only),
          // not Home — a mis-tap shouldn't cost them their place.
          onBack={() => setAppScreen('actionboard')}
          onLogout={logout}
          // Nothing starts until the PIN is verified: /kpi_pair/verify is what
          // opens the workday, so walking away from here starts nothing.
          onPaired={() => { setDevPaired(true); setAppScreen('actionboard'); }}
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
        />
      );
    if (appScreen === 'owner')
      return <OwnerDashboard onBack={home} />;
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
    if (appScreen === 'startworking')
      // Locked developer: no back button (they must pair); give a logout escape.
      // Non-locked (shouldn't normally reach here): allow back to Home.
      return (
        <StartWorkingScreen
          onBack={devLocked ? null : home}
          onLogout={logout}
          onPaired={() => setAppScreen('home')}
        />
      );
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
        />
      );
    return (
      <HomeScreen
        user={user}
        onLogout={logout}
        onOpen={open}
        // Drives the red "read-only" line under the name + its Start Workday
        // button. False for admins/clients — they're never locked.
        workdayLocked={workdayLocked}
        onNeedPair={() => setAppScreen('startworking')}
      />
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
