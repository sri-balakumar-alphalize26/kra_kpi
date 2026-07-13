// KRA/KPI app shell: spinning KPI-wheel Splash → Welcome → Login (Odoo connect)
// → Home. A remembered Odoo session boots straight to Home after the splash.
import React, { useState, useEffect } from 'react';
import { BackHandler } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import ConnectScreen from './screens/ConnectScreen';
import HomeScreen from './screens/HomeScreen';
import KraKpiDashboard from './screens/KraKpiDashboard';
import KpiActionBoard from './screens/KpiActionBoard';
import UploadAmendments from './screens/UploadAmendments';
import OwnerDashboard from './screens/OwnerDashboard';
import NotificationsScreen from './screens/NotificationsScreen';
import * as session from './api/session';
import { createLogger } from './api/logger';

const log = createLogger('App');

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
  const [appScreen, setAppScreen] = useState('home'); // post-login: home | dashboard | actionboard
  const [focusTaskId, setFocusTaskId] = useState(null); // task to scroll-to + pulse on the board

  // Restore a remembered session so the app can skip login on relaunch.
  useEffect(() => {
    (async () => {
      const saved = await session.getSession();
      if (saved) setUser(saved);
      setRestoring(false);
    })();
  }, []);

  // Android hardware back: go one screen back instead of exiting the app.
  // Returning true from the handler tells Android we handled the event.
  useEffect(() => {
    const onBack = () => {
      if (user && appScreen !== 'home') { setAppScreen('home'); return true; }
      if (!user && screen === 'connect') { setScreen('login'); return true; }
      return false; // at home / login — let the OS handle it (exit)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [user, appScreen, screen]);

  const logout = async () => {
    await session.clearSession();
    setUser(null);
    setScreen('login');
    setAppScreen('home');
    setFocusTaskId(null);
  };

  // Splash keeps showing until both the animation and the session read finish.
  if (!ready || restoring) return <SplashScreen onDone={() => setReady(true)} />;

  if (user) {
    log.info('render post-login screen', { appScreen });
    // Returning home clears any pending task-focus so it can't re-pulse later.
    const home = () => { setAppScreen('home'); setFocusTaskId(null); };
    // open(dest, param): param is an optional payload (e.g. a task id to focus).
    const open = (dest, param) => { log.info('open', dest, param); setFocusTaskId(param ?? null); setAppScreen(dest); };
    if (appScreen === 'dashboard')
      return <KraKpiDashboard onBack={home} />;
    if (appScreen === 'actionboard')
      return <KpiActionBoard onBack={home} focusTaskId={focusTaskId} onFocusHandled={() => setFocusTaskId(null)} />;
    if (appScreen === 'owner')
      return <OwnerDashboard onBack={home} />;
    if (appScreen === 'notifications')
      return <NotificationsScreen onBack={home} onOpen={open} />;
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

  // Welcome screen is the base; the Connect (URL/DB/login) form slides up over it
  // as a bottom sheet with the welcome blurred behind it.
  return (
    <>
      <LoginScreen goConnect={() => setScreen('connect')} />
      <ConnectScreen
        visible={screen === 'connect'}
        onLogin={setUser}
        goBack={() => setScreen('login')}
      />
    </>
  );
}
