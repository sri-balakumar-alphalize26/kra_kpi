// APP LOGIN — the primary per-user login after the device is set up once.
// Mobile-number-first: enter mobile → password (or set a new one on first login).
// "Water flowing" look: a blue top with organic blobs + a white wavy sheet that
// holds the form; the wave gently drifts for a flowing-water feel.
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Animated, Easing, Dimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path, Circle, Ellipse } from 'react-native-svg';
import LoginArt from '../components/LoginArt';
import { COLORS } from '../theme';
import { saveSession } from '../api/session';
import { loginCheck, appLogin, setAppPassword, requestOtp, verifyOtp, getMobileConfig } from '../services/appAuth';
import { createLogger } from '../api/logger';

const log = createLogger('AppLogin');
const { width: SW } = Dimensions.get('window');

// Alphalize blue — buttons / links.
const WATER = '#1F6FE5';

// Blue "water" wave at the top of the form sheet — clearly visible, flows down.
const WAVE_H = 92;
const WAVE_LIGHT = '#6FA0F2';   // lighter drifting layer
const WAVE_D =
  `M0,${WAVE_H} L0,48 ` +
  `C ${SW * 0.18},14 ${SW * 0.36},66 ${SW * 0.54},46 ` +
  `C ${SW * 0.70},28 ${SW * 0.86},60 ${SW},40 ` +
  `L ${SW},${WAVE_H} Z`;
const WAVE_ACCENT =
  `M0,${WAVE_H} L0,58 ` +
  `C ${SW * 0.22},26 ${SW * 0.42},74 ${SW * 0.60},54 ` +
  `C ${SW * 0.76},38 ${SW * 0.88},66 ${SW},50 ` +
  `L ${SW},${WAVE_H} Z`;

export default function AppLoginScreen({ onLogin, onNeedSetup }) {
  const insets = useSafeAreaInsets();            // clear the phone's nav/gesture bar
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
  const [needsSetup, setNeedsSetup] = useState(false);  // password still the default 1111 (not changed yet)
  const [resendIn, setResendIn] = useState(0);   // seconds left before "Resend" is allowed
  // Country / mobile format from the Odoo Configuration screen.
  const [dial, setDial] = useState('91');
  const [mobileLen, setMobileLen] = useState(10);

  // Tick the resend cooldown down to 0 while the OTP step is showing.
  useEffect(() => {
    if (step !== 'otp' || resendIn <= 0) return;
    const id = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [step, resendIn]);

  useEffect(() => {
    let alive = true;
    getMobileConfig().then((c) => {
      if (!alive) return;
      setDial(c.dial || '91');
      setMobileLen(c.length || 10);
      log.info('mobile config', { dial: c.dial, length: c.length });
    });
    return () => { alive = false; };
  }, []);

  // Entrance — the form "flows" in (fade + slide up with a springy lift) when the
  // screen appears, e.g. right after the Odoo device-setup login hands off here.
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    enter.setValue(0);
    Animated.spring(enter, { toValue: 1, friction: 6, tension: 70, useNativeDriver: true }).start();
  }, []);

  // Per-step transition (mobile → password → otp → setpw) — replays on step change.
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [step]);

  // Water flow — the accent wave drifts gently left/right forever.
  const waveX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(waveX, { toValue: 1, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(waveX, { toValue: 0, duration: 3800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ])).start();
  }, []);

  const fail = (msg) => { log.warn('login step failed', msg); setError(msg); setBusy(false); };

  // Hidden admin gesture: tap the 369 logo 7 times (within ~1.5s between taps)
  // to open the Odoo device-setup page. Lives only on this sign-in screen.
  const tapCount = useRef(0);
  const tapTimer = useRef(null);
  const onLogoTap = () => {
    tapCount.current += 1;
    log.info('logo tap', tapCount.current);
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 1500);
    if (tapCount.current >= 7) {
      tapCount.current = 0;
      if (tapTimer.current) clearTimeout(tapTimer.current);
      log.info('logo 7-tap → open device setup');
      onNeedSetup();
    }
  };

  async function continueMobile() {
    const m = mobile.replace(/[^\d]/g, '');
    if (m.length < mobileLen) return fail(`Enter your ${mobileLen}-digit mobile number.`);
    log.info('continue mobile', m);
    setBusy(true); setError('');
    try {
      const { state, name } = await loginCheck(m);
      log.info('login state', state);
      if (state === 'unknown') return fail('This number is not registered. Please contact your admin to register this number.');
      if (state === 'disabled') return fail('Your login is disabled. Contact your admin.');
      if (state === 'wrong_device') return fail(`This device is set up for ${name || 'another account'}. Contact your admin to use it.`);
      // ready or needs_setup → ask for the password. needs_setup means the app
      // password is still the default 1111 (must-change) → show the red reminder on
      // the password page until they change it (then loginCheck returns 'ready').
      setNeedsSetup(state === 'needs_setup');
      setStep('password'); setBusy(false);
    } catch (e) { fail('Could not reach the server. Try again.'); }
  }

  async function doLogin() {
    if (!pw) return fail('Enter your password.');
    log.info('login attempt', mobile.replace(/[^\d]/g, ''));
    setBusy(true); setError('');
    try {
      const res = await appLogin(mobile.replace(/[^\d]/g, ''), pw);
      if (!res.ok) return fail(res.error || 'Invalid mobile number or password.');
      // NOTE: we no longer FORCE a password change on a first (1111) login — the
      // user goes straight into the app and is nagged to set their own via the red
      // "Forgot Password" button on Profile (must_change drives it). Logging in with
      // the default 1111 first, then changing it, is the intended flow.
      log.info('login success', res.user?.username, { mustChange: !!res.mustChange });
      await saveSession(res.user);
      onLogin(res.user);
    } catch (e) { fail('Login failed. Try again.'); }
  }

  async function saveNewPassword() {
    if (newPw.length < 4) return fail('Password must be at least 4 characters.');
    if (newPw !== newPw2) return fail('Passwords do not match.');
    log.info('setting new password (first login)');
    setBusy(true); setError('');
    try {
      const res = await setAppPassword(newPw);
      if (!res.ok) return fail(res.error || 'Could not set the password.');
      log.info('password set → entering app');
      await saveSession(pendingUser);
      onLogin(pendingUser);
    } catch (e) { fail('Could not set the password. Try again.'); }
  }

  // Forgot password / onboarding → send a WhatsApp code, go to the OTP step.
  async function startOtp() {
    const m = mobile.replace(/[^\d]/g, '');
    if (m.length < mobileLen) return fail('Enter your mobile number first.');
    log.info('request OTP', m);
    setBusy(true); setError('');
    try {
      await requestOtp(m);              // generic — always proceeds
      setCode(''); setNewPw(''); setNewPw2('');
      setResendIn(10);                  // 10s before a resend is allowed
      setStep('otp'); setBusy(false);
    } catch (e) { fail('Could not send the code. Try again.'); }
  }

  async function submitOtp() {
    if (code.replace(/[^\d]/g, '').length < 4) return fail('Enter the 4-digit code.');
    if (newPw.length < 4) return fail('Password must be at least 4 characters.');
    if (newPw !== newPw2) return fail('Passwords do not match.');
    log.info('verify OTP + set new password');
    setBusy(true); setError('');
    try {
      const res = await verifyOtp(mobile.replace(/[^\d]/g, ''), code.replace(/[^\d]/g, ''), newPw);
      if (!res.ok) return fail(res.error || 'Incorrect or expired code.');
      log.info('OTP verified → entering app');
      await saveSession(res.user);
      onLogin(res.user);
    } catch (e) { fail('Could not verify. Try again.'); }
  }

  const enterStyle = {
    opacity: enter.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }),
    transform: [
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  };
  const stepStyle = {
    opacity: anim,
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  // One header per step — avoids showing "Welcome back" AND a step title together.
  const HEADS = {
    mobile: { t: 'Welcome back 👋', s: 'Sign in to continue' },
    password: { t: 'Enter password', s: mobile },
    otp: { t: 'Enter the code', s: 'Enter the WhatsApp code and choose a new password.' },
    setpw: { t: 'Set a new password', s: 'Choose your own password to continue.' },
  };
  const head = HEADS[step] || HEADS.mobile;

  return (
    <View style={s.root}>
      <StatusBar style="dark" />

      {/* Illustration up top */}
      <View style={[s.heroWrap, { paddingTop: insets.top + 10 }]}>
        <LoginArt width={SW * 0.62} height={SW * 0.62 * (220 / 300)} />
      </View>

      {/* White wave sheet holding the form — the water flow ends here, at the form */}
      <View style={s.sheet}>
        {/* drifting accent wave (flow) */}
        <Animated.View
          pointerEvents="none"
          style={[s.waveLayer, { transform: [{ translateX: waveX.interpolate({ inputRange: [0, 1], outputRange: [-16, 16] }) }] }]}
        >
          <Svg width={SW} height={WAVE_H} viewBox={`0 0 ${SW} ${WAVE_H}`}>
            <Path d={WAVE_ACCENT} fill={WAVE_LIGHT} opacity={0.8} />
          </Svg>
        </Animated.View>
        {/* main blue water wave */}
        <Svg width={SW} height={WAVE_H} style={s.waveLayer} pointerEvents="none" viewBox={`0 0 ${SW} ${WAVE_H}`}>
          <Path d={WAVE_D} fill={WATER} />
        </Svg>

        <View style={s.sheetBody}>
          {/* faint water blobs so the lower half isn't plain white */}
          <Svg style={s.bottomDeco} width={SW} height={180} pointerEvents="none" viewBox={`0 0 ${SW} 180`}>
            <Ellipse cx={SW * 0.20} cy={160} rx={130} ry={84} fill={WATER} opacity={0.05} />
            <Ellipse cx={SW * 0.92} cy={126} rx={104} ry={72} fill={WATER} opacity={0.06} />
            <Circle cx={SW * 0.55} cy={174} r={62} fill={WATER} opacity={0.04} />
          </Svg>

          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={s.formScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Animated.View style={enterStyle}>
                {/* 369 logo under the wave — tap it 7× → Odoo device setup (hidden) */}
                <TouchableOpacity activeOpacity={1} onPress={onLogoTap} style={s.logoWrap}>
                  <Image source={require('../assets/logo369.png')} style={s.logo} resizeMode="contain" />
                </TouchableOpacity>
                <View style={s.decorRow}>
                  <View style={s.decorLine} />
                  <Text style={s.decorTxt}>
                    <Text style={{ color: COLORS.navy }}>Track. </Text>
                    <Text style={{ color: '#1E6FD9' }}>Measure. </Text>
                    <Text style={{ color: '#2BB673' }}>Achieve.</Text>
                  </Text>
                  <View style={s.decorLine} />
                </View>

                <Animated.View style={stepStyle}>
                  {/* One header, changes per step (no duplicate titles) */}
                  <Text style={s.welcome}>{head.t}</Text>
                  <Text style={s.welcomeSub}>{head.s}</Text>

                  {step === 'mobile' && (
                    <View style={s.form}>
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
                    <View style={s.form}>
                      {needsSetup && (
                        <View style={s.pwWarn}>
                          <Ionicons name="alert-circle" size={16} color={COLORS.red} />
                          <Text style={s.pwWarnTxt}>
                            Your password is still the default <Text style={{ fontWeight: '800' }}>1111</Text>. Please change it — tap “Forgot password?” below to set your own.
                          </Text>
                        </View>
                      )}
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
                      <TouchableOpacity onPress={() => { setStep('mobile'); setPw(''); setError(''); setNeedsSetup(false); }} style={{ marginTop: 10 }}>
                        <Text style={s.linkMuted}>← Use a different number</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {step === 'otp' && (
                    <View style={s.form}>
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
                      <TouchableOpacity onPress={startOtp} style={{ marginTop: 12 }} disabled={busy || resendIn > 0}>
                        <Text style={[s.link, (busy || resendIn > 0) && s.linkDisabled]}>
                          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => { setStep('password'); setError(''); }} style={{ marginTop: 10 }}>
                        <Text style={s.linkMuted}>← Back</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {step === 'setpw' && (
                    <View style={s.form}>
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

                </Animated.View>
              </Animated.View>
            </ScrollView>
          </KeyboardAvoidingView>

          {/* Footer — pinned above the phone's nav/gesture bar. */}
          <View style={[s.footer, { paddingBottom: 14 + insets.bottom }]}>
            <Ionicons name="shield-checkmark" size={13} color={COLORS.muted} />
            <Text style={s.footerTxt}>Secure login · Alphalize · v1.0</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F5F9FD' },
  heroWrap: { width: SW, backgroundColor: '#F5F9FD', alignItems: 'center', justifyContent: 'center', paddingBottom: 24 },

  sheet: { flex: 1, marginTop: -24, backgroundColor: 'transparent' },
  waveLayer: { position: 'absolute', top: 0, left: 0 },
  sheetBody: { flex: 1, backgroundColor: '#fff', marginTop: WAVE_H - 1 },
  bottomDeco: { position: 'absolute', left: 0, right: 0, bottom: 0 },

  // Sit the form near the top (just under the water flow), moved up.
  formScroll: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 20 },
  form: { width: '100%' },
  logoWrap: { alignSelf: 'center', marginBottom: 2 },
  logo: { width: 168, height: 90 },
  decorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 16 },
  decorLine: { width: 22, height: 1.5, backgroundColor: '#CBD6E6', borderRadius: 1 },
  decorTxt: { fontSize: 13, fontWeight: '800' },
  welcome: { fontSize: 23, fontWeight: '900', color: COLORS.navy },
  welcomeSub: { fontSize: 13.5, color: COLORS.muted, marginTop: 4, marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '900', color: COLORS.navy },
  sub: { fontSize: 13.5, color: COLORS.muted, marginTop: 4, marginBottom: 16 },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F4F7FB',
    borderWidth: 1.5, borderColor: '#E6ECF5', borderRadius: 12, paddingHorizontal: 14, height: 54, marginBottom: 12,
  },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },
  dialPrefix: { fontSize: 15.5, fontWeight: '700', color: COLORS.ink, marginRight: -4 },
  err: { color: COLORS.red, fontSize: 13, marginBottom: 8 },
  pwWarn: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FEECEC', borderWidth: 1, borderColor: COLORS.red, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 14 },
  pwWarnTxt: { flex: 1, color: COLORS.red, fontSize: 12.5, lineHeight: 18, fontWeight: '600' },
  primaryBtn: { backgroundColor: WATER, borderRadius: 12, height: 54, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryTxt: { color: '#fff', fontSize: 16.5, fontWeight: '800' },
  link: { color: WATER, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  linkDisabled: { color: COLORS.faint },
  linkMuted: { color: COLORS.muted, fontSize: 13.5, fontWeight: '600', textAlign: 'center' },

  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 10 },
  footerTxt: { fontSize: 12, color: COLORS.muted, fontWeight: '600' },
});
