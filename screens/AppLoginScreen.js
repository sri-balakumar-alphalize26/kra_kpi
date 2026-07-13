// APP LOGIN — the primary per-user login after the device is set up once.
// Mobile-number-first: enter mobile → password (or set a new one on first login).
// Falls back to the Odoo device-setup login via "Admin / device setup".
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ActivityIndicator,
  KeyboardAvoidingView, Platform, StatusBar as RNStatusBar, ScrollView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { saveSession } from '../api/session';
import { loginCheck, appLogin, setAppPassword, requestOtp, verifyOtp, getMobileConfig } from '../services/appAuth';
import { createLogger } from '../api/logger';

const log = createLogger('AppLogin');
const TOP = (RNStatusBar.currentHeight || 0) + 16;

export default function AppLoginScreen({ onLogin, onNeedSetup }) {
  const [step, setStep] = useState('mobile');   // mobile | password | setpw | otp
  const [mobile, setMobile] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingUser, setPendingUser] = useState(null);
  // Country / mobile format from the Odoo Configuration screen.
  const [dial, setDial] = useState('91');
  const [mobileLen, setMobileLen] = useState(10);

  useEffect(() => {
    let alive = true;
    getMobileConfig().then((c) => {
      if (!alive) return;
      setDial(c.dial || '91');
      setMobileLen(c.length || 10);
    });
    return () => { alive = false; };
  }, []);

  const fail = (msg) => { setError(msg); setBusy(false); };

  async function continueMobile() {
    const m = mobile.replace(/[^\d]/g, '');
    if (m.length < mobileLen) return fail(`Enter your ${mobileLen}-digit mobile number.`);
    setBusy(true); setError('');
    try {
      const { state } = await loginCheck(m);
      if (state === 'unknown') return fail('This number is not registered. Please contact your admin to register this number.');
      if (state === 'disabled') return fail('Your login is disabled. Contact your admin.');
      // ready or needs_setup → ask for the password.
      setStep('password'); setBusy(false);
    } catch (e) { fail('Could not reach the server. Try again.'); }
  }

  async function doLogin() {
    if (!pw) return fail('Enter your password.');
    setBusy(true); setError('');
    try {
      const res = await appLogin(mobile.replace(/[^\d]/g, ''), pw);
      if (!res.ok) return fail(res.error || 'Invalid mobile number or password.');
      if (res.mustChange) {
        // First login → force a new password before entering the app.
        setPendingUser(res.user); setStep('setpw'); setBusy(false); return;
      }
      await saveSession(res.user);
      onLogin(res.user);
    } catch (e) { fail('Login failed. Try again.'); }
  }

  async function saveNewPassword() {
    if (newPw.length < 4) return fail('Password must be at least 4 characters.');
    if (newPw !== newPw2) return fail('Passwords do not match.');
    setBusy(true); setError('');
    try {
      const res = await setAppPassword(newPw);
      if (!res.ok) return fail(res.error || 'Could not set the password.');
      await saveSession(pendingUser);
      onLogin(pendingUser);
    } catch (e) { fail('Could not set the password. Try again.'); }
  }

  // Forgot password / onboarding → send a WhatsApp code, go to the OTP step.
  async function startOtp() {
    const m = mobile.replace(/[^\d]/g, '');
    if (m.length < 6) return fail('Enter your mobile number first.');
    setBusy(true); setError('');
    try {
      await requestOtp(m);              // generic — always proceeds
      setCode(''); setNewPw(''); setNewPw2('');
      setStep('otp'); setBusy(false);
    } catch (e) { fail('Could not send the code. Try again.'); }
  }

  async function submitOtp() {
    if (code.replace(/[^\d]/g, '').length < 4) return fail('Enter the 4-digit code.');
    if (newPw.length < 4) return fail('Password must be at least 4 characters.');
    if (newPw !== newPw2) return fail('Passwords do not match.');
    setBusy(true); setError('');
    try {
      const res = await verifyOtp(mobile.replace(/[^\d]/g, ''), code.replace(/[^\d]/g, ''), newPw);
      if (!res.ok) return fail(res.error || 'Incorrect or expired code.');
      await saveSession(res.user);
      onLogin(res.user);
    } catch (e) { fail('Could not verify. Try again.'); }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <GradientBackground />
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <View style={[s.body, { paddingTop: TOP }]}>
          <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />

          {step === 'mobile' && (
            <View style={s.card}>
              <Text style={s.title}>Sign in</Text>
              <Text style={s.sub}>Enter your registered mobile number.</Text>
              <View style={s.field}>
                <Ionicons name="call-outline" size={18} color={COLORS.muted} />
                <Text style={s.dialPrefix}>+{dial}</Text>
                <TextInput
                  style={s.input} placeholder="Mobile number" placeholderTextColor={COLORS.faint}
                  keyboardType="phone-pad" value={mobile}
                  onChangeText={(t) => setMobile(t.replace(/[^\d]/g, '').slice(0, mobileLen))}
                  maxLength={mobileLen} autoFocus
                />
              </View>
              {!!error && <Text style={s.err}>{error}</Text>}
              <TouchableOpacity style={s.primaryBtn} onPress={continueMobile} disabled={busy} activeOpacity={0.9}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>Continue</Text>}
              </TouchableOpacity>
            </View>
          )}

          {step === 'password' && (
            <View style={s.card}>
              <Text style={s.title}>Enter password</Text>
              <Text style={s.sub}>{mobile}</Text>
              <View style={s.field}>
                <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="Password" placeholderTextColor={COLORS.faint}
                  secureTextEntry={!showPw} value={pw} onChangeText={setPw} autoFocus
                />
                <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
              </View>
              {!!error && <Text style={s.err}>{error}</Text>}
              <TouchableOpacity style={s.primaryBtn} onPress={doLogin} disabled={busy} activeOpacity={0.9}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>Log In</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={startOtp} style={{ marginTop: 14 }} disabled={busy}>
                <Text style={s.link}>Forgot password?</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setStep('mobile'); setPw(''); setError(''); }} style={{ marginTop: 10 }}>
                <Text style={s.linkMuted}>← Use a different number</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'otp' && (
            <View style={s.card}>
              <Text style={s.title}>Enter the code</Text>
              <Text style={s.sub}>We sent a code to your WhatsApp. Enter it below and choose a new password.</Text>
              <View style={s.field}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="4-digit code" placeholderTextColor={COLORS.faint}
                  keyboardType="number-pad" maxLength={4} value={code} onChangeText={setCode} autoFocus
                />
              </View>
              <View style={s.field}>
                <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="New password" placeholderTextColor={COLORS.faint}
                  secureTextEntry={!showPw} value={newPw} onChangeText={setNewPw}
                />
                <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
              </View>
              <View style={s.field}>
                <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="Re-enter password" placeholderTextColor={COLORS.faint}
                  secureTextEntry={!showPw} value={newPw2} onChangeText={setNewPw2}
                />
              </View>
              {!!error && <Text style={s.err}>{error}</Text>}
              <TouchableOpacity style={s.primaryBtn} onPress={submitOtp} disabled={busy} activeOpacity={0.9}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>Verify & Set Password</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={startOtp} style={{ marginTop: 12 }} disabled={busy}>
                <Text style={s.link}>Resend code</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setStep('password'); setError(''); }} style={{ marginTop: 10 }}>
                <Text style={s.linkMuted}>← Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'setpw' && (
            <View style={s.card}>
              <Text style={s.title}>Set a new password</Text>
              <Text style={s.sub}>Choose your own password to continue.</Text>
              <View style={s.field}>
                <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="New password" placeholderTextColor={COLORS.faint}
                  secureTextEntry={!showPw} value={newPw} onChangeText={setNewPw} autoFocus
                />
                <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={18} color={COLORS.muted} />
                </TouchableOpacity>
              </View>
              <View style={s.field}>
                <Ionicons name="lock-closed-outline" size={18} color={COLORS.muted} />
                <TextInput
                  style={s.input} placeholder="Re-enter password" placeholderTextColor={COLORS.faint}
                  secureTextEntry={!showPw} value={newPw2} onChangeText={setNewPw2}
                />
              </View>
              {!!error && <Text style={s.err}>{error}</Text>}
              <TouchableOpacity style={s.primaryBtn} onPress={saveNewPassword} disabled={busy} activeOpacity={0.9}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>Save & Continue</Text>}
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity onPress={onNeedSetup} style={s.setupLink} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="settings-outline" size={14} color={COLORS.muted} />
            <Text style={s.setupTxt}>Admin / device setup</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: 24, paddingBottom: 30 },
  logo: { width: 190, height: 110, marginTop: 6, marginBottom: 6 },
  card: { width: '100%', backgroundColor: '#fff', borderRadius: 18, padding: 22, ...({ shadowColor: '#1e293b', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3 }) },
  title: { fontSize: 22, fontWeight: '900', color: COLORS.navy },
  sub: { fontSize: 13.5, color: COLORS.muted, marginTop: 4, marginBottom: 16 },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff',
    borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 12, paddingHorizontal: 14, height: 54, marginBottom: 12,
  },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },
  dialPrefix: { fontSize: 15.5, fontWeight: '700', color: COLORS.ink, marginRight: -4 },
  err: { color: COLORS.red, fontSize: 13, marginBottom: 8 },
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 12, height: 54, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryTxt: { color: '#fff', fontSize: 16.5, fontWeight: '800' },
  link: { color: COLORS.link, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  linkMuted: { color: COLORS.muted, fontSize: 13.5, fontWeight: '600', textAlign: 'center' },
  setupLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 26 },
  setupTxt: { color: COLORS.muted, fontSize: 13, fontWeight: '600' },
});
