// SIGN UP — 369 ai.Biz / alphalize design. Matches the "Create your account"
// mockup: logo + tagline, name/email/phone/password/confirm fields, Terms
// checkbox, Sign Up, Google + Microsoft, "Already have an account? Log In".
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Image, Alert,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal, FlatList,
  StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path } from 'react-native-svg';
import { COLORS } from '../theme';
import GoogleIcon from '../components/GoogleIcon';
import { COUNTRIES, DEFAULT_COUNTRY, toLocalDigits } from '../utils/countryMobile';

const TOP = (RNStatusBar.currentHeight || 0) + 14;

export default function SignUpScreen({ onDone, goLogin }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');           // local digits only
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [pickCountry, setPickCountry] = useState(false); // country picker modal
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);

  // Phone is valid when it has exactly the country's local length.
  const phoneComplete = phone.length === country.length;
  const phoneInvalid = phone.length > 0 && !phoneComplete;

  function onPhoneChange(t) {
    setPhone(toLocalDigits(t, country));
  }
  function chooseCountry(c) {
    setCountry(c);
    setPickCountry(false);
    // Re-cap the existing number to the new country's length.
    setPhone((p) => toLocalDigits(p, c));
  }

  function finish(displayName, mail) {
    onDone && onDone({ name: displayName, email: mail });
  }
  function signUp() {
    if (!name.trim() || !email.trim() || !pw || pw !== pw2 || !agree) return;
    setLoading(true);
    // Account created → return to the Login page so they sign in, then Home.
    setTimeout(() => { setLoading(false); goLogin && goLogin(); }, 600);
  }
  function googleSoon() {
    Alert.alert('Coming Soon', 'Google sign-up will be available in an update soon.');
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 0 }} keyboardShouldPersistTaps="handled">
        {/* Back arrow */}
        <View style={[s.topRow, { paddingTop: TOP }]}>
          <TouchableOpacity onPress={goLogin} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={s.back}>‹</Text>
          </TouchableOpacity>
        </View>

        {/* Company logo */}
        <View style={s.logoWrap}>
          <Image source={require('../assets/logo369.png')} style={s.logo369img} resizeMode="contain" />
        </View>

        {/* Heading */}
        <Text style={s.title}>Create your account</Text>
        <Text style={s.sub}>Join 369 ai.Biz and start managing your{'\n'}KPIs smarter, better, faster.</Text>

        {/* Form */}
        <View style={s.form}>
          <View style={s.field}>
            <Text style={s.fIcon}>👤</Text>
            <TextInput style={s.input} placeholder="Full Name" placeholderTextColor={COLORS.faint} value={name} onChangeText={setName} />
          </View>

          <View style={s.field}>
            <Text style={s.fIcon}>✉️</Text>
            <TextInput
              style={s.input} placeholder="Email Address" placeholderTextColor={COLORS.faint}
              autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}
            />
          </View>

          {/* Phone with country selector + dial code + digit cap */}
          <View style={[s.field, phoneInvalid && s.fieldError, { paddingHorizontal: 8 }]}>
            <TouchableOpacity style={s.ccBtn} onPress={() => setPickCountry(true)} activeOpacity={0.8}>
              <Text style={s.ccCode}>+{country.dial}</Text>
              <Text style={s.ccCaret}>▾</Text>
            </TouchableOpacity>
            <View style={s.ccDivider} />
            <TextInput
              style={[s.input, { paddingLeft: 8 }]}
              placeholder={`${country.length}-digit number`}
              placeholderTextColor={COLORS.faint}
              keyboardType="phone-pad"
              maxLength={country.length}
              value={phone}
              onChangeText={onPhoneChange}
            />
            {phoneComplete && <Text style={s.okTick}>✓</Text>}
          </View>
          {phoneInvalid && (
            <Text style={s.errHint}>Enter {country.length} digits for {country.name}</Text>
          )}

          <View style={s.field}>
            <Text style={s.fIcon}>🔒</Text>
            <TextInput
              style={s.input} placeholder="Password" placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw} value={pw} onChangeText={setPw}
            />
            <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.eye}>{showPw ? '🙈' : '👁'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.field}>
            <Text style={s.fIcon}>🔒</Text>
            <TextInput
              style={s.input} placeholder="Confirm Password" placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw2} value={pw2} onChangeText={setPw2}
            />
            <TouchableOpacity onPress={() => setShowPw2((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.eye}>{showPw2 ? '🙈' : '👁'}</Text>
            </TouchableOpacity>
          </View>

          {/* Terms checkbox */}
          <TouchableOpacity style={s.termsRow} onPress={() => setAgree((v) => !v)} activeOpacity={0.8}>
            <View style={[s.box, agree && s.boxOn]}>{agree && <Text style={s.tick}>✓</Text>}</View>
            <Text style={s.termsTxt}>
              I agree to the <Text style={s.link}>Terms of Service</Text> and <Text style={s.link}>Privacy Policy</Text>
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.primaryBtn, loading && { opacity: 0.7 }]} onPress={signUp} activeOpacity={0.9} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>Sign Up</Text>}
          </TouchableOpacity>

          {/* OR */}
          <View style={s.orRow}>
            <View style={s.orLine} /><Text style={s.or}>or</Text><View style={s.orLine} />
          </View>

          {/* Google */}
          <TouchableOpacity style={s.socialBtn} onPress={googleSoon} activeOpacity={0.9}>
            <GoogleIcon size={22} />
            <Text style={s.socialTxt}>Sign up with Google</Text>
          </TouchableOpacity>

          <View style={s.bottomRow}>
            <Text style={s.bottomTxt}>Already have an account? </Text>
            <TouchableOpacity onPress={goLogin}><Text style={s.bottomLink}>Log In</Text></TouchableOpacity>
          </View>
        </View>

        {/* Footer wave + alphalize */}
        <View style={s.footer}>
          <Svg width="100%" height="70" viewBox="0 0 400 70" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
            <Path d="M0,34 C90,70 150,8 220,34 C300,62 340,22 400,36 L400,70 L0,70 Z" fill={COLORS.wave} />
          </Svg>
          <View style={s.alphaRow}>
            <Image source={require('../assets/alphalize.png')} style={s.alphaImg} resizeMode="contain" />
          </View>
        </View>
      </ScrollView>

      {/* Country picker */}
      <Modal visible={pickCountry} transparent animationType="fade" onRequestClose={() => setPickCountry(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setPickCountry(false)}>
          <TouchableOpacity style={s.modalSheet} activeOpacity={1}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>Select country</Text>
              <TouchableOpacity onPress={() => setPickCountry(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={COUNTRIES}
              keyExtractor={(c) => c.code}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = item.code === country.code;
                return (
                  <TouchableOpacity style={[s.ccRow, on && s.ccRowOn]} onPress={() => chooseCountry(item)} activeOpacity={0.8}>
                    <Text style={s.ccRowName}>{item.name}</Text>
                    <Text style={s.ccRowMeta}>+{item.dial} · {item.length} digits</Text>
                    {on && <Text style={s.ccRowTick}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  topRow: { paddingHorizontal: 18 },
  back: { fontSize: 40, color: COLORS.navy, lineHeight: 40, marginTop: -6 },

  logoWrap: { alignItems: 'center', marginTop: 2 },
  logo369img: { width: 210, height: 130 },

  title: { fontSize: 25, fontWeight: '900', color: COLORS.navy, textAlign: 'center', marginTop: 6 },
  sub: { fontSize: 14, color: COLORS.muted, textAlign: 'center', marginTop: 8, lineHeight: 20 },

  form: { paddingHorizontal: 24, marginTop: 20 },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line,
    borderRadius: 14, paddingHorizontal: 15, marginBottom: 14, height: 56,
  },
  fIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },
  eye: { fontSize: 18 },
  fieldError: { borderColor: COLORS.red },

  // Country selector inside the phone field
  ccBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: '100%' },
  ccCode: { fontSize: 15.5, fontWeight: '800', color: COLORS.navy },
  ccCaret: { fontSize: 11, color: COLORS.muted, marginLeft: 4 },
  ccDivider: { width: 1, height: 26, backgroundColor: COLORS.line },
  okTick: { color: COLORS.green, fontSize: 16, fontWeight: '900', marginLeft: 6 },
  errHint: { color: COLORS.red, fontSize: 12.5, marginTop: -8, marginBottom: 12, marginLeft: 6 },

  // Country picker modal
  // Centered dialog (not a bottom sheet) — matches the app's other popups.
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 26,
  },
  modalSheet: {
    width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20,
    maxHeight: '70%', paddingBottom: 12, overflow: 'hidden',
  },
  modalHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: COLORS.navy },
  modalClose: { fontSize: 18, color: COLORS.muted, fontWeight: '700' },
  ccRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#F1F4F9',
  },
  ccRowOn: { backgroundColor: '#F0F5FF' },
  ccRowName: { flex: 1, fontSize: 15, color: COLORS.ink, fontWeight: '600' },
  ccRowMeta: { fontSize: 12.5, color: COLORS.muted, marginRight: 8 },
  ccRowTick: { color: COLORS.primary, fontSize: 15, fontWeight: '900' },

  termsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, marginBottom: 18 },
  box: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center', marginRight: 10, backgroundColor: '#fff',
  },
  boxOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tick: { color: '#fff', fontSize: 14, fontWeight: '900' },
  termsTxt: { flex: 1, fontSize: 13.5, color: COLORS.muted, lineHeight: 19 },
  link: { color: COLORS.link, fontWeight: '700' },

  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 14, height: 56, alignItems: 'center', justifyContent: 'center' },
  primaryTxt: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },

  orRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 18 },
  orLine: { flex: 1, height: 1, backgroundColor: COLORS.line },
  or: { marginHorizontal: 14, color: COLORS.muted, fontSize: 13, fontWeight: '600' },

  socialBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 14, height: 56,
  },
  socialTxt: { fontSize: 15.5, fontWeight: '700', color: COLORS.link },

  bottomRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  bottomTxt: { color: COLORS.muted, fontSize: 14 },
  bottomLink: { color: COLORS.link, fontSize: 14, fontWeight: '800' },

  footer: { height: 110, justifyContent: 'flex-end', marginTop: 20 },
  alphaRow: { alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  alphaImg: { width: 170, height: 46 },
});
