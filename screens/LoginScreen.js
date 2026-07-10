// LOGIN — 369 ai.Biz layout, compact to fit one screen (no scrolling needed).
// 369 logo → small gap → hero photo (KRA/KPI + man, animated flow) → white card
// with brand pill, alphalize-icon welcome, decorative Track·Measure·Achieve line,
// email/password, Login, Google, Sign Up.
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Image, Alert,
  KeyboardAvoidingView, Platform, ActivityIndicator, Animated, Easing, Dimensions,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { COLORS } from '../theme';
import GoogleIcon from '../components/GoogleIcon';
import FlowOverlay from '../components/FlowOverlay';

const { width: SW } = Dimensions.get('window');
const HERO_H = SW * (1304 / 1283);     // full composite hero (369 logo baked in)
const CARD_OVERLAP = SW * 0.16;        // card pulls up over the hero bottom
const TOP = (RNStatusBar.currentHeight || 0) + 6;
// clear the device's bottom bar (Android 3-button nav ~48dp / iOS home indicator)
const BOTTOM_PAD = Platform.OS === 'android' ? 62 : 34;

// Curved (wave) top edge of the white card. The white fill + main green→blue
// line stay low on the left (so "Welcome" sits tight). The blue companion line
// is drawn ON TOP of the card, so it can sweep down on the right (a real
// flowing second line) without pushing the content down.
const CURVE_H = 56;
const CURVE_D =
  `M0,${CURVE_H} L0,46 ` +
  `C ${SW * 0.14},46 ${SW * 0.30},10 ${SW * 0.50},20 ` +
  `C ${SW * 0.68},28 ${SW * 0.84},46 ${SW},40 ` +
  `L ${SW},${CURVE_H} Z`;
const CURVE_EDGE =
  `M0,46 C ${SW * 0.14},46 ${SW * 0.30},10 ${SW * 0.50},20 ` +
  `C ${SW * 0.68},28 ${SW * 0.84},46 ${SW},40`;
// Second (blue) companion line — its START joins the main line (at the mid anchor
// SW*0.50,20) and its END joins the main line's end (SW,40); bows down between.
const CURVE_EDGE2 =
  `M ${SW * 0.50},20 C ${SW * 0.66},34 ${SW * 0.84},50 ${SW},40`;

export default function LoginScreen({ onLogin, goSignup, goForgot }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  // Man photo appears first, then the welcome card follows a split-second later.
  // Triggered off the hero image finishing load so the man is always first
  // (never "welcome first, then image"). Fallback timer in case onLoad is missed.
  const heroIn = useRef(new Animated.Value(0)).current;
  const cardIn = useRef(new Animated.Value(0)).current;
  const started = useRef(false);
  const runEnter = () => {
    if (started.current) return;
    started.current = true;
    Animated.stagger(130, [
      Animated.timing(heroIn, { toValue: 1, duration: 260, useNativeDriver: true }),
      Animated.timing(cardIn, { toValue: 1, duration: 320, useNativeDriver: true }),
    ]).start();
  };
  useEffect(() => {
    const t = setTimeout(runEnter, 450);
    return () => clearTimeout(t);
  }, []);

  function done() {
    const raw = (email.split('@')[0] || 'User').replace(/[._]/g, ' ');
    onLogin({ name: raw.charAt(0).toUpperCase() + raw.slice(1), email: email.trim() });
  }
  function login() {
    if (!email.trim() || !pw) return;
    setLoading(true);
    setTimeout(() => { setLoading(false); done(); }, 500);
  }
  function googleSoon() {
    Alert.alert('Coming Soon', 'Google sign-in will be available in an update soon.');
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}
      >
        {/* status-bar pad (matches hero bg) + single hero image (369 baked in) */}
        <View style={s.statusPad} />
        <Animated.View style={[s.heroWrap, { opacity: heroIn }]}>
          <Image source={require('../assets/loginhero.png')} style={s.hero} resizeMode="cover" onLoad={runEnter} />
          <FlowOverlay />
        </Animated.View>

        {/* White card with a curved (wave) top edge */}
        <Animated.View style={[s.card, { opacity: cardIn }]}>
          <Svg width={SW} height={CURVE_H} viewBox={`0 0 ${SW} ${CURVE_H}`}>
            <Defs>
              <LinearGradient id="cg" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#2BB673" />
                <Stop offset="0.55" stopColor="#17A2C4" />
                <Stop offset="1" stopColor="#1E6FD9" />
              </LinearGradient>
            </Defs>
            <Path d={CURVE_D} fill="#fff" />
            <Path d={CURVE_EDGE} stroke="url(#cg)" strokeWidth={4.5} fill="none" strokeLinecap="round" />
          </Svg>
          <View style={s.cardBody}>
          {/* welcome */}
          <Text style={s.welcomeTo}>Welcome to</Text>
          <Text style={s.welcomeBig}>Alphalize KRA & KPI</Text>

          {/* decorative Track · Measure · Achieve */}
          <View style={s.decorRow}>
            <View style={s.decorLine} />
            <Text style={s.decorTxt}>
              <Text style={{ color: COLORS.navy }}>Track. </Text>
              <Text style={{ color: '#1E6FD9' }}>Measure. </Text>
              <Text style={{ color: '#2BB673' }}>Achieve.</Text>
            </Text>
            <View style={s.decorLine} />
          </View>

          <View style={s.field}>
            <Ionicons name="mail-outline" size={20} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              style={s.input} placeholder="Email Address" placeholderTextColor={COLORS.faint}
              autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}
            />
          </View>

          <View style={s.field}>
            <Ionicons name="lock-closed-outline" size={20} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              style={s.input} placeholder="Password" placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw} value={pw} onChangeText={setPw}
            />
            <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name={showPw ? 'eye-outline' : 'eye-off-outline'} size={20} color={COLORS.muted} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={s.forgot} onPress={goForgot}>
            <Text style={s.forgotTxt}>Forgot Password?</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.loginBtn, loading && { opacity: 0.7 }]} onPress={login} activeOpacity={0.9} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={s.loginTxt}>Login</Text>
                <Ionicons name="arrow-forward" size={20} color="#fff" style={{ marginLeft: 10 }} />
              </>
            )}
          </TouchableOpacity>

          <View style={s.orRow}>
            <View style={s.orLine} /><Text style={s.or}>OR</Text><View style={s.orLine} />
          </View>

          <TouchableOpacity style={s.googleBtn} onPress={googleSoon} activeOpacity={0.9}>
            <GoogleIcon size={22} />
            <Text style={s.googleTxt}>Login with Google</Text>
          </TouchableOpacity>

          <View style={s.signupRow}>
            <Text style={s.signupTxt}>Don't have an account? </Text>
            <TouchableOpacity onPress={goSignup}><Text style={s.signupLink}>Sign Up</Text></TouchableOpacity>
          </View>
          </View>

          {/* blue companion line, drawn on top so it can flow down the right */}
          <Svg style={s.curveLine2} width={SW} height={68} viewBox={`0 0 ${SW} 68`} pointerEvents="none">
            <Path d={CURVE_EDGE2} stroke="#1E6FD9" strokeWidth={2.5} fill="none" strokeLinecap="round" opacity={0.85} />
          </Svg>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EEF2FB' },

  statusPad: { height: TOP, backgroundColor: '#EEF2FB' },
  heroWrap: { width: SW, height: HERO_H },
  hero: { width: SW, height: HERO_H },

  card: { flex: 1, marginTop: -CARD_OVERLAP, backgroundColor: 'transparent' },
  cardBody: {
    flex: 1, backgroundColor: '#fff', marginTop: -8,
    paddingHorizontal: 24, paddingTop: 2, paddingBottom: BOTTOM_PAD,
  },
  curveLine2: { position: 'absolute', top: 0, left: 0 },

  pill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8,
    backgroundColor: '#E9F7F0', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 5, marginBottom: 10,
  },
  pillTxt: { color: '#1E6FD9', fontSize: 12.5, fontWeight: '800' },
  pillDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#2BB673' },
  pillKpi: { color: '#2BB673', fontSize: 12.5, fontWeight: '800' },

  welcomeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wIcon: { width: 46, height: 40 },
  welcomeTo: { fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  welcomeBig: { fontSize: 23, fontWeight: '900', color: COLORS.navy, marginTop: 1 },

  decorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8, marginBottom: 14 },
  decorLine: { width: 26, height: 1.5, backgroundColor: '#CBD6E6', borderRadius: 1 },
  decorTxt: { fontSize: 14, fontWeight: '800' },

  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F8FD',
    borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 13, paddingHorizontal: 15, marginBottom: 12, height: 54,
  },
  fIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },

  forgot: { alignSelf: 'flex-end', marginTop: -2, marginBottom: 14 },
  forgotTxt: { color: COLORS.link, fontWeight: '700', fontSize: 13.5 },

  loginBtn: {
    flexDirection: 'row', backgroundColor: COLORS.primary, borderRadius: 13, height: 54,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.primary, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  loginTxt: { color: '#fff', fontSize: 16.5, fontWeight: '800', letterSpacing: 0.3 },

  orRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: COLORS.line },
  or: { marginHorizontal: 14, color: COLORS.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1 },

  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 13, height: 54,
    shadowColor: '#334155', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  googleTxt: { fontSize: 15, fontWeight: '700', color: COLORS.ink },

  signupRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 15 },
  signupTxt: { color: COLORS.muted, fontSize: 13.5 },
  signupLink: { color: COLORS.link, fontSize: 13.5, fontWeight: '800' },
});
