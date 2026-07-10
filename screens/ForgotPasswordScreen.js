// FORGOT PASSWORD — 369 ai.Biz / alphalize design. Matches the mockup:
// back arrow, logo, "Forgot Password?", email field, Send Reset Link,
// envelope illustration, "Can't access your email?" + Contact Support.
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Image,
  KeyboardAvoidingView, Platform, ActivityIndicator, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { COLORS } from '../theme';

const TOP = (RNStatusBar.currentHeight || 0) + 14;

// Simple line-art envelope with a lock badge (matches the mockup illustration).
function MailLock() {
  return (
    <Svg width={150} height={112} viewBox="0 0 150 112">
      <Circle cx="20" cy="24" r="4" fill="#BFD2F2" />
      <Circle cx="132" cy="40" r="5" fill="#BFD2F2" />
      <Circle cx="120" cy="14" r="3" fill="#BFD2F2" />
      <Path d="M22 8 l4 4 -4 4 -4 -4 z" fill="#CBDAF5" />
      <Path d="M128 86 l4 4 -4 4 -4 -4 z" fill="#CBDAF5" />
      {/* envelope body */}
      <Rect x="30" y="34" width="90" height="60" rx="8" fill="#EAF1FE" stroke="#9DB9EC" strokeWidth="2.5" />
      {/* flap */}
      <Path d="M33 40 L75 70 L117 40" fill="none" stroke="#9DB9EC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* lock badge */}
      <Circle cx="112" cy="86" r="18" fill={COLORS.primary} />
      <Rect x="105" y="84" width="14" height="11" rx="2.5" fill="#fff" />
      <Path d="M108 84 v-3 a4 4 0 0 1 8 0 v3" fill="none" stroke="#fff" strokeWidth="2.2" />
    </Svg>
  );
}

export default function ForgotPasswordScreen({ goLogin }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  function send() {
    if (!email.trim()) return;
    setLoading(true);
    setTimeout(() => { setLoading(false); setSent(true); }, 600);
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
        <Text style={s.title}>Forgot Password?</Text>
        <Text style={s.sub}>
          {sent
            ? 'Reset link sent! Check your inbox and\nfollow the link to set a new password.'
            : "No worries! Enter your email address and\nwe'll send you a link to reset your password."}
        </Text>

        {/* Form */}
        <View style={s.form}>
          <View style={s.field}>
            <Text style={s.fIcon}>✉️</Text>
            <TextInput
              style={s.input} placeholder="Email Address" placeholderTextColor={COLORS.faint}
              autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}
            />
          </View>

          <TouchableOpacity style={[s.primaryBtn, loading && { opacity: 0.7 }]} onPress={send} activeOpacity={0.9} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryTxt}>{sent ? 'Resend Link' : 'Send Reset Link'}</Text>}
          </TouchableOpacity>

          {/* Illustration */}
          <View style={s.illustration}><MailLock /></View>

          {/* Support */}
          <Text style={s.supportTitle}>Can't access your email?</Text>
          <Text style={s.supportSub}>Contact our support team and we'll{'\n'}help you recover your account.</Text>

          <TouchableOpacity style={s.supportBtn} activeOpacity={0.9}>
            <Text style={s.supportIcon}>🎧</Text>
            <Text style={s.supportBtnTxt}>Contact Support</Text>
          </TouchableOpacity>

          <View style={s.bottomRow}>
            <Text style={s.bottomTxt}>Remember your password? </Text>
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
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  topRow: { paddingHorizontal: 18 },
  back: { fontSize: 40, color: COLORS.navy, lineHeight: 40, marginTop: -6 },

  logoWrap: { alignItems: 'center', marginTop: 2 },
  logo369img: { width: 210, height: 130 },

  title: { fontSize: 26, fontWeight: '900', color: COLORS.navy, textAlign: 'center', marginTop: 8 },
  sub: { fontSize: 14, color: COLORS.muted, textAlign: 'center', marginTop: 10, lineHeight: 20 },

  form: { paddingHorizontal: 24, marginTop: 24 },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.line,
    borderRadius: 14, paddingHorizontal: 15, marginBottom: 16, height: 56,
  },
  fIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%' },

  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 14, height: 56, alignItems: 'center', justifyContent: 'center' },
  primaryTxt: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },

  illustration: { alignItems: 'center', marginTop: 30, marginBottom: 20 },

  supportTitle: { fontSize: 16, fontWeight: '800', color: COLORS.navy, textAlign: 'center' },
  supportSub: { fontSize: 13.5, color: COLORS.muted, textAlign: 'center', marginTop: 8, lineHeight: 19 },

  supportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'center',
    borderWidth: 1.5, borderColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 22, height: 48, marginTop: 18,
  },
  supportIcon: { fontSize: 16 },
  supportBtnTxt: { fontSize: 15, fontWeight: '800', color: COLORS.link },

  bottomRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 22 },
  bottomTxt: { color: COLORS.muted, fontSize: 14 },
  bottomLink: { color: COLORS.link, fontSize: 14, fontWeight: '800' },

  footer: { height: 110, justifyContent: 'flex-end', marginTop: 20 },
  alphaRow: { alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  alphaImg: { width: 170, height: 46 },
});
