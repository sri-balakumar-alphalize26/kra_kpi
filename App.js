// KRA/KPI app shell: spinning KPI-wheel Splash → Login/Sign Up/Forgot → Home.
import React, { useState } from 'react';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import SignUpScreen from './screens/SignUpScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import HomeScreen from './screens/HomeScreen';

export default function App() {
  const [ready, setReady] = useState(false);      // splash finished
  const [screen, setScreen] = useState('login');  // login | signup | forgot
  const [user, setUser] = useState(null);

  if (!ready) return <SplashScreen onDone={() => setReady(true)} />;
  if (user) return <HomeScreen user={user} onLogout={() => { setUser(null); setScreen('login'); }} />;

  if (screen === 'signup')
    return <SignUpScreen onDone={setUser} goLogin={() => setScreen('login')} />;
  if (screen === 'forgot')
    return <ForgotPasswordScreen goLogin={() => setScreen('login')} />;

  return (
    <LoginScreen
      onLogin={setUser}
      goSignup={() => setScreen('signup')}
      goForgot={() => setScreen('forgot')}
    />
  );
}
