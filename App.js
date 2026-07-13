// KRA/KPI app shell: spinning KPI-wheel Splash → Welcome → Login (Odoo connect)
// → Home. A remembered Odoo session boots straight to Home after the splash.
import React, { useState, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
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
import StartWorkingScreen from './screens/StartWorkingScreen';
import AppLoginScreen from './screens/AppLoginScreen';
import * as session from './api/session';
import { getConnection } from './api/session';
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
  const [provisioned, setProvisioned] = useState(false); // device set up (server URL saved)
  const [forceSetup, setForceSetup] = useState(false);   // show Odoo device-setup over the app login

  const pushTokenRef = useRef(null);       // this device's Expo token (for logout unregister)
  const pendingTapRef = useRef(null);      // kpi_id from a tap that arrived before login/restore
  const devLockedRef = useRef(false);      // latest devLocked for listeners/back-handler
  useEffect(() => { devLockedRef.current = devLocked; }, [devLocked]);

  // Route a notification tap to the task on the board (opens + pulses the card).
  // If we aren't logged in yet (cold-start tap), queue it until the session
  // restore / login completes.
  const routeToTask = (kpiId) => {
    if (!kpiId) return;
    if (userRef.current) {
      setFocusTaskId(kpiId);
      setAppScreen('actionboard');
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
      // An unpaired developer is hard-gated to the PIN screen — swallow back so
      // they can't escape it (they must pair on the computer).
      if (user && devLocked && !devPaired) return true;
      // Everyone else: a non-home screen goes back to Home.
      if (user && appScreen !== 'home') { setAppScreen('home'); return true; }
      if (!user && screen === 'connect') { setScreen('login'); return true; }
      return false; // at home / login — let the OS handle it (exit)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [user, appScreen, screen, devLocked, devPaired]);

  // Register this device for push once logged in (needs the session cookie so
  // the token binds to the right user server-side). Flush any queued tap.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const token = await registerForPushAsync();
      if (token) pushTokenRef.current = token;
    })();
    if (pendingTapRef.current) {
      const kpiId = pendingTapRef.current;
      pendingTapRef.current = null;
      setFocusTaskId(kpiId);
      setAppScreen('actionboard');
    }
  }, [user?.uid]);

  // Role gate: a DEVELOPER (not admin/owner/system) must pair via the PIN
  // screen before using the app. Admins land on Home as usual. Runs on login.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      try {
        const { serverUrl } = await getConnection();
        if (!serverUrl) { if (alive) { setDevLocked(false); } return; } // offline demo → Home
        const info = await jsonRpc(serverUrl, '/kpi_user/info', {});
        const isAdmin = !!(info && (info.is_system || info.is_owner || info.is_admin));
        const isDev = !!(info && info.is_developer);
        const lock = isDev && !isAdmin;
        if (!alive) return;
        setDevLocked(lock);
        if (lock) {
          // Resolve pairing. Paired → Home; unpaired → the PIN gate is FORCED by
          // the render (see below), so we just record the paired flag.
          try {
            const st = await pairingStatus();
            setDevPaired(!!st?.paired);
            if (st?.paired) setAppScreen('home');
          } catch (_) { setDevPaired(false); }
        } else {
          setDevPaired(true); // non-developers are never gated
        }
      } catch (e) {
        log.warn('role gate check failed', e?.message);
        if (alive) setDevLocked(false);
      }
    })();
    return () => { alive = false; };
  }, [user?.uid]);

  // While a locked developer is on the PIN gate, poll so pairing (from the web)
  // moves them to Home. Once paired and on Home, they use the app freely; the
  // poll only pulls them BACK to the PIN gate if they get un-paired (auto-away).
  useEffect(() => {
    if (!user || !devLocked) return;
    const id = setInterval(async () => {
      try {
        const st = await pairingStatus();
        setDevPaired((prev) => {
          const now = !!st?.paired;
          // On the transition unpaired → paired, land on Home.
          if (now && !prev) setAppScreen('home');
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
  };

  // Splash keeps showing until both the animation and the session read finish.
  if (!ready || restoring) return <SplashScreen onDone={() => setReady(true)} />;

  if (user) {
    log.info('render post-login screen', { appScreen, devLocked, devPaired });
    // Returning home clears any pending task-focus so it can't re-pulse later.
    const home = () => { setAppScreen('home'); setFocusTaskId(null); };
    // open(dest, param): param is an optional payload (e.g. a task id to focus).
    const open = (dest, param) => { log.info('open', dest, param); setFocusTaskId(param ?? null); setAppScreen(dest); };

    // HARD GATE: a developer who isn't paired can ONLY see the PIN screen —
    // no other screen renders (prevents a board "flash" before the poll bounces
    // them). They stay here strictly until they pair on the computer.
    if (devLocked && !devPaired) {
      return (
        <StartWorkingScreen
          onBack={null}
          onLogout={logout}
          onPaired={() => { setDevPaired(true); setAppScreen('home'); }}
        />
      );
    }

    if (appScreen === 'dashboard')
      return <KraKpiDashboard onBack={home} />;
    if (appScreen === 'actionboard')
      // Back always returns to Home (the developer is paired once they can reach
      // the board; the PIN screen is only the pre-pair gate).
      return <KpiActionBoard onBack={home} focusTaskId={focusTaskId} onFocusHandled={() => setFocusTaskId(null)} />;
    if (appScreen === 'owner')
      return <OwnerDashboard onBack={home} />;
    if (appScreen === 'notifications')
      return <NotificationsScreen onBack={home} onOpen={open} />;
    if (appScreen === 'config')
      return <ConfigurationScreen onBack={home} />;
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
    return (
      <HomeScreen
        user={user}
        onLogout={logout}
        onOpen={open}
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
        goBack={() => { setScreen('login'); setForceSetup(false); }}
      />
    </>
  );
}
