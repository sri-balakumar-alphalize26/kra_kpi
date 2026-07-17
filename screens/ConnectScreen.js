// LOGIN PAGE — Odoo connection flow: enter Server URL → databases auto-fetch →
// pick a database → enter username & password → authenticate against Odoo.
// URL + DB are remembered so later logins only need username/password.
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Image,
  KeyboardAvoidingView, Platform, ActivityIndicator, Keyboard, Animated, Easing, Dimensions,
  StatusBar as RNStatusBar, Modal, Pressable,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient as SvgGrad, Stop as SvgStop, Rect as SvgRect } from 'react-native-svg';
import { COLORS } from '../theme';
import * as odooApi from '../api/odooApi';
import * as session from '../api/session';
import { createLogger } from '../api/logger';

const log = createLogger('Login');

const TOP = (RNStatusBar.currentHeight || 0) + 10;
const BOTTOM_PAD = Platform.OS === 'android' ? 40 : 30;
const { height: SH } = Dimensions.get('window');

export default function ConnectScreen({ onLogin, goBack, visible = true }) {
  const [mounted, setMounted] = useState(visible); // keep rendered during close anim
  const [serverUrl, setServerUrl] = useState('');
  const [databases, setDatabases] = useState([]);
  const [selectedDb, setSelectedDb] = useState('');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);

  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [errors, setErrors] = useState({});

  // The normalized URL we last fetched databases for. Lets us skip a redundant
  // re-fetch (which would wipe the selected DB) when the URL hasn't changed.
  const lastFetchedUrl = useRef('');
  const pwRef = useRef(null); // focus password from username's "next"
  const scrollRef = useRef(null); // scroll a focused field above the keyboard

  // Scroll the credentials fields up so the keyboard doesn't cover them.
  const scrollToCreds = () => {
    // Small delay so the keyboard has begun to show before we scroll.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
  };

  // The sheet slides up from the bottom when `visible` becomes true, and slides
  // back down on close (then unmounts). Backdrop (blurred welcome) fades with it.
  const sheet = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(sheet, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      Animated.timing(sheet, { toValue: 0, duration: 260, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(() => setMounted(false));
    }
  }, [visible, sheet]);
  const sheetStyle = {
    transform: [{ translateY: sheet.interpolate({ inputRange: [0, 1], outputRange: [SH, 0] }) }],
  };
  const backdropStyle = { opacity: sheet };

  const setError = (field, msg) => setErrors((p) => ({ ...p, [field]: msg }));
  const clearError = (field) => setErrors((p) => ({ ...p, [field]: null }));

  // Pre-fill remembered URL/DB and auto-fetch that server's databases on mount.
  useEffect(() => {
    (async () => {
      log.info('mounted — restoring saved connection');
      const { serverUrl: savedUrl, db: savedDb } = await session.getConnection();
      if (savedUrl) {
        const norm = odooApi.normalizeUrl(savedUrl);
        log.info('restored connection', { serverUrl: norm, db: savedDb || '(none)' });
        setServerUrl(norm);
        const dbs = await safeFetch(norm);
        if (dbs && savedDb && dbs.includes(savedDb)) {
          log.info('re-selected remembered database', savedDb);
          setSelectedDb(savedDb);
        }
      } else {
        log.info('no saved connection');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the database list for `url`. `keepSelection` skips clearing the
  // current DB (used by the mount restore so it isn't wiped before we re-pick).
  async function safeFetch(url) {
    setLoadingDbs(true);
    setDatabases([]);
    setSelectedDb('');
    setDbOpen(false);
    try {
      const dbs = await odooApi.fetchDatabases(url);
      if (!dbs || dbs.length === 0) {
        setError('serverUrl', 'Could not fetch databases — check the URL and try again');
        lastFetchedUrl.current = '';
        return null;
      }
      setDatabases(dbs);
      // Don't auto-open — the user opens the dropdown by tapping the selector.
      setDbOpen(false);
      lastFetchedUrl.current = url;
      return dbs;
    } catch (err) {
      setError('serverUrl', odooApi.friendlyError(err, 'Cannot fetch databases'));
      lastFetchedUrl.current = '';
      return null;
    } finally {
      setLoadingDbs(false);
    }
  }

  function handleFetchDatabases() {
    Keyboard.dismiss();
    if (!serverUrl.trim()) return;
    const norm = odooApi.normalizeUrl(serverUrl);
    // Skip if we already have this server's databases loaded — avoids wiping
    // the selected DB on a no-op blur of the URL field.
    if (norm === lastFetchedUrl.current && databases.length > 0) return;
    clearError('serverUrl');
    safeFetch(norm);
  }

  async function handleLogin() {
    Keyboard.dismiss();
    let ok = true;
    if (!serverUrl.trim()) { setError('serverUrl', 'Server URL is required'); ok = false; }
    if (!selectedDb) { setError('db', 'Select a database'); ok = false; }
    if (!username.trim()) { setError('username', 'Username is required'); ok = false; }
    if (!pw) { setError('pw', 'Password is required'); ok = false; }
    if (!ok) {
      log.warn('login blocked — missing fields', {
        serverUrl: !!serverUrl.trim(), db: !!selectedDb, username: !!username.trim(), pw: !!pw,
      });
      return;
    }

    const base = odooApi.normalizeUrl(serverUrl);
    log.info('login attempt', { serverUrl: base, db: selectedDb, username: username.trim() });
    setLoadingAuth(true);
    try {
      const result = await odooApi.authenticate(base, selectedDb, username.trim(), pw);
      // Older Odoo signals bad credentials with a falsy uid instead of an error.
      if (!result.uid) {
        log.warn('login failed — falsy uid (bad credentials)');
        setError('username', 'Invalid username or password');
        setError('pw', ' ');
        return;
      }
      await session.saveConnection({
        serverUrl: base, db: selectedDb,
        // Lock this device to the Odoo account that just authenticated — only
        // this account's mobile number may app-login here (until re-setup).
        setupUid: result.uid,
        setupLogin: result.username || username.trim(),
        setupName: result.name || '',
      });
      // Device-setup ONLY: the Odoo login just points the app at the server and
      // provisions it. We do NOT log this Odoo user in — after setup the app
      // shows the mobile-number (non-Odoo) login page, not Home.
      log.info('device provisioned — returning to app login', { serverUrl: base, db: selectedDb });
      onLogin();
    } catch (err) {
      // Modern Odoo throws AccessDenied for wrong credentials — show that under
      // the username field, not the Server URL field.
      if (err?.isAuthError) {
        log.warn('login failed — invalid credentials');
        setError('username', 'Invalid username or password');
        setError('pw', ' ');
      } else {
        log.error('login failed — connection/server error', err?.message);
        setError('serverUrl', odooApi.friendlyError(err, 'Login failed'));
      }
    } finally {
      setLoadingAuth(false);
    }
  }

  const busy = loadingDbs || loadingAuth;

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <StatusBar style="light" />
      {/* Blurred backdrop = the welcome screen behind, frosted like a mirror.
          Fades in/out with the sheet; tap it to dismiss. */}
      <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
        <BlurView intensity={40} tint="dark" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={goBack} />
        </BlurView>
      </Animated.View>

      {/* The login form slides up from the bottom as a sheet. KeyboardAvoidingView
          lifts it above the keyboard; on Android "height" behavior + the scroll
          padding below let the focused field scroll into view. */}
      <KeyboardAvoidingView
        style={s.sheetRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
        pointerEvents="box-none"
      >
      <Animated.View style={[s.sheet, sheetStyle]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingBottom: BOTTOM_PAD + 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* Grabber + hero */}
        <View style={s.grabber} />
        <View style={s.hero}>
          <TouchableOpacity onPress={goBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.heroBack}>
            <Ionicons name="chevron-down" size={26} color={COLORS.navy} />
          </TouchableOpacity>
          <View style={s.heroBadge}>
            <Ionicons name="shield-checkmark" size={28} color="#fff" />
          </View>
          <Text style={s.heroTitle}>Welcome back</Text>
          <Text style={s.heroSub}>Sign in to your Alphalize KRA &amp; KPI workspace</Text>
        </View>

        {/* Form card */}
        <View style={s.glassWrap}>
          <View style={s.glass}>
          <View style={s.body}>
          {/* Step 1 — Server URL */}
          <View style={s.stepRow}>
            <View style={[s.badge, !!serverUrl.trim() && databases.length > 0 && s.badgeDone]}>
              {serverUrl.trim() && databases.length > 0
                ? <Ionicons name="checkmark" size={14} color="#fff" />
                : <Text style={s.badgeTxt}>1</Text>}
            </View>
            <Text style={s.stepTitle}>Server URL</Text>
            {databases.length > 0 ? <Text style={s.stepOk}>{databases.length} database{databases.length === 1 ? '' : 's'} found</Text> : null}
          </View>
          <View style={[s.field, errors.serverUrl && s.fieldErr]}>
            <Ionicons name="globe-outline" size={20} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              style={s.input}
              placeholder="https://your-server.com"
              placeholderTextColor={COLORS.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              value={serverUrl}
              onChangeText={(t) => {
                setServerUrl(t);
                clearError('serverUrl');
                setDatabases([]);
                setSelectedDb('');
                setDbOpen(false);
              }}
              onBlur={() => { if (serverUrl.trim()) handleFetchDatabases(); }}
              onSubmitEditing={handleFetchDatabases}
            />
            {loadingDbs && <ActivityIndicator size="small" color={COLORS.primary} />}
          </View>
          {errors.serverUrl ? <Text style={s.errTxt}>{errors.serverUrl}</Text> : null}

          {/* Step 2 — Database */}
          <View style={s.stepRow}>
            <View style={[s.badge, !!selectedDb && s.badgeDone]}>
              {selectedDb ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Text style={s.badgeTxt}>2</Text>}
            </View>
            <Text style={s.stepTitle}>Database</Text>
          </View>
          {/* The selector button; tapping it opens the database list in a Modal. */}
          <View style={s.dbWrap}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => { if (databases.length > 0) setDbOpen((o) => !o); }}
              style={[s.field, s.dbSelector, errors.db && s.fieldErr, { marginBottom: 0 }]}
            >
              <Ionicons name="server-outline" size={20} color={COLORS.muted} style={s.fIcon} />
              <Text style={[s.input, { color: selectedDb ? COLORS.ink : COLORS.faint }]}>
                {selectedDb || (databases.length === 0 ? 'Enter URL above to load databases' : 'Select a database')}
              </Text>
              {databases.length > 0 && (
                <Ionicons name={dbOpen ? 'chevron-up' : 'chevron-down'} size={20} color={COLORS.muted} />
              )}
            </TouchableOpacity>
          </View>

          {/* Database list — presented in a Modal so its ScrollView lives in its
              own native layer (outside the page ScrollView) and always scrolls,
              even with many databases. */}
          <Modal
            visible={dbOpen && databases.length > 0}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setDbOpen(false)}
          >
            <Pressable style={s.dbBackdrop} onPress={() => setDbOpen(false)}>
              <Pressable style={s.dbSheet} onPress={() => {}}>
                <View style={s.dbSheetHead}>
                  <Text style={s.dbSheetTitle}>Select a database</Text>
                  <TouchableOpacity onPress={() => setDbOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={22} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={s.dbSheetList}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                >
                  {databases.map((item) => (
                    <TouchableOpacity
                      key={item}
                      style={[s.dropItem, item === selectedDb && s.dropItemActive]}
                      onPress={() => { setSelectedDb(item); clearError('db'); setDbOpen(false); }}
                    >
                      <Text style={[s.dropTxt, item === selectedDb && s.dropTxtActive]}>{item}</Text>
                      {item === selectedDb && <Ionicons name="checkmark" size={18} color={COLORS.primary} />}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>
          {errors.db ? <Text style={s.errTxt}>{errors.db}</Text> : null}

          {/* Step 3 — Credentials */}
          <View style={s.stepRow}>
            <View style={s.badge}><Text style={s.badgeTxt}>3</Text></View>
            <Text style={s.stepTitle}>Credentials</Text>
          </View>
          <View style={[s.field, errors.username && s.fieldErr]}>
            <Ionicons name="person-outline" size={20} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              style={s.input}
              placeholder="Username or Email"
              placeholderTextColor={COLORS.faint}
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={(t) => { setUsername(t); clearError('username'); }}
              onFocus={scrollToCreds}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => pwRef.current && pwRef.current.focus()}
            />
          </View>
          {errors.username ? <Text style={s.errTxt}>{errors.username}</Text> : null}

          <View style={[s.field, errors.pw && s.fieldErr]}>
            <Ionicons name="lock-closed-outline" size={20} color={COLORS.muted} style={s.fIcon} />
            <TextInput
              ref={pwRef}
              style={s.input}
              placeholder="Password"
              placeholderTextColor={COLORS.faint}
              secureTextEntry={!showPw}
              value={pw}
              onChangeText={(t) => { setPw(t); clearError('pw'); }}
              onFocus={scrollToCreds}
              onSubmitEditing={handleLogin}
              returnKeyType="go"
            />
            <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name={showPw ? 'eye-outline' : 'eye-off-outline'} size={20} color={COLORS.muted} />
            </TouchableOpacity>
          </View>
          {errors.pw && errors.pw.trim() ? <Text style={s.errTxt}>{errors.pw}</Text> : null}

          <TouchableOpacity
            style={[s.loginBtn, busy && { opacity: 0.7 }]}
            onPress={handleLogin}
            activeOpacity={0.9}
            disabled={busy}
          >
            {loadingAuth ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={s.loginTxt}>Login</Text>
                <Ionicons name="arrow-forward" size={20} color="#fff" style={{ marginLeft: 10 }} />
              </>
            )}
          </TouchableOpacity>
          </View>
          </View>
        </View>
      </ScrollView>
      </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  // Bottom-sheet: the form panel is pinned to the bottom and takes most of the
  // height; the blurred welcome shows above it.
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: SH * 0.92, backgroundColor: '#fff',
    borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden',
    shadowColor: '#0B2A6B', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: -6 }, elevation: 24,
  },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: '#D5DCE8', marginTop: 10, marginBottom: 2 },

  // Form card wrapper (plain — the sheet itself is the white surface)
  glassWrap: { marginHorizontal: 0, borderRadius: 0 },
  glass: { backgroundColor: 'transparent' },

  // Brand hero (on the white sheet → dark text, solid brand badge)
  hero: {
    paddingTop: 8, paddingBottom: 14, paddingHorizontal: 24, alignItems: 'center',
  },
  heroBack: {
    position: 'absolute', right: 12, top: 4, width: 38, height: 38, borderRadius: 19,
    backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center',
  },
  heroBadge: {
    width: 60, height: 60, borderRadius: 20, backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
    shadowColor: COLORS.primary, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5,
  },
  heroTitle: { fontSize: 24, fontWeight: '900', color: COLORS.navy, letterSpacing: 0.3 },
  heroSub: { fontSize: 13.5, color: COLORS.muted, marginTop: 5, textAlign: 'center', lineHeight: 19 },

  body: { paddingHorizontal: 24, paddingTop: 4 },

  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, marginBottom: 10 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  badgeDone: { backgroundColor: COLORS.green },
  badgeTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  stepTitle: { fontSize: 15, fontWeight: '800', color: COLORS.navy },
  stepOk: { fontSize: 12, fontWeight: '700', color: COLORS.green, marginLeft: 'auto' },

  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F8FD',
    borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 14, paddingHorizontal: 15, height: 56,
    marginBottom: 12,   // gap between stacked fields (username / password)
  },
  fieldErr: { borderColor: COLORS.red, backgroundColor: COLORS.redBg },
  fIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15.5, color: COLORS.ink, height: '100%', textAlignVertical: 'center' },
  dbSelector: {},

  errTxt: { color: COLORS.red, fontSize: 12.5, marginTop: 5, marginLeft: 2 },

  // DB selector wrapper keeps the field's gap; high zIndex so the floating
  // dropdown renders above the Credentials fields below it.
  dbWrap: { position: 'relative', marginBottom: 12, zIndex: 20 },
  // Database picker — a Modal overlay. Its ScrollView is in its own native layer
  // (not nested in the page ScrollView), so it always scrolls with many databases.
  dbBackdrop: {
    flex: 1, backgroundColor: 'rgba(11,42,107,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  dbSheet: {
    width: '100%', maxWidth: 440, maxHeight: '75%',
    backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden',
    shadowColor: '#0B2A6B', shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 20,
  },
  dbSheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEF1F6',
  },
  dbSheetTitle: { fontSize: 16, fontWeight: '800', color: COLORS.ink },
  dbSheetList: { flexGrow: 0, flexShrink: 1 },
  dropItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F3F8',
  },
  dropItemActive: { backgroundColor: '#EEF3FF' },
  dropTxt: { fontSize: 15, color: COLORS.ink },
  dropTxtActive: { color: COLORS.primary, fontWeight: '800' },

  loginBtn: {
    flexDirection: 'row', backgroundColor: COLORS.primary, borderRadius: 13, height: 54,
    alignItems: 'center', justifyContent: 'center', marginTop: 18, marginBottom: 6,
    shadowColor: COLORS.primary, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  loginTxt: { color: '#fff', fontSize: 16.5, fontWeight: '800', letterSpacing: 0.3 },
});
