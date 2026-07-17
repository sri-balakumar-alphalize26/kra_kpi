// COMPANY BRANDING (admin) — mobile port of the Odoo web "Company Branding"
// screen. Sets res.company.name + res.company.logo, which brand every generated
// PDF (daily task report, work report, client invoices). A new logo takes effect
// on the NEXT PDF generated (the logo is read at generation time).

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Image, StatusBar as RNStatusBar, Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { fetchCompanyBranding, saveCompanyBranding } from '../services/companyBranding';

const log = createLogger('CompanyBranding');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Build a data URI from raw base64, sniffing the format from its magic prefix so a
// JPEG the web uploaded still renders (RN's Image needs the right mime). SVG can't
// render in an RN <Image> — but a logo picked here is always re-encoded to PNG.
function dataUri(b64) {
  if (!b64) return null;
  let mime = 'image/png';
  if (b64.startsWith('/9j/')) mime = 'image/jpeg';
  else if (b64.startsWith('R0lGOD')) mime = 'image/gif';
  return `data:${mime};base64,${b64}`;
}

export default function CompanyBranding({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');
  const [logoB64, setLogoB64] = useState('');   // '' = no logo
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetchCompanyBranding();
      if (res?.status) {
        setName(res.name || '');
        setLogoB64(res.logo_b64 || '');
      }
    } catch (e) { log.warn('load failed', e?.message); }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const pickLogo = async () => {
    setPicking(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset) return;
      // Shrink to a logo-sized PNG before base64 so it stays under the 1 MB cap.
      const m = await ImageManipulator.manipulateAsync(
        asset.uri, [{ resize: { width: 512 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.PNG },
      );
      const data = await FileSystem.readAsStringAsync(m.uri, { encoding: FileSystem.EncodingType.Base64 });
      setLogoB64(data);
      setDirty(true);
      log.info('logo picked', { bytesB64: data.length });
    } catch (e) {
      log.warn('pick failed', e?.message);
      Alert.alert('Logo', 'Could not read that image.');
    } finally { setPicking(false); }
  };

  const removeLogo = () => { setLogoB64(''); setDirty(true); };

  const onSave = async () => {
    const nm = name.trim();
    if (!nm) { Alert.alert('Company Branding', 'Company name is required.'); return; }
    setSaving(true);
    try {
      const res = await saveCompanyBranding({ name: nm, logo_b64: logoB64 });
      if (res?.status) {
        setDirty(false);
        setSavedMsg('Branding saved');
        setTimeout(() => setSavedMsg(''), 1800);
      } else {
        Alert.alert('Company Branding', res?.message || 'Could not save.');
      }
    } catch (e) {
      log.warn('save failed', e?.message);
      Alert.alert('Company Branding', 'Could not save the branding.');
    } finally { setSaving(false); }
  };

  const uri = dataUri(logoB64);

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.hTitle} numberOfLines={1}>Company Branding</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Text style={s.sub}>Shown at the top of every generated PDF — daily task report, work report and client invoices.</Text>

          <View style={s.card}>
            <Text style={s.label}>Company Name</Text>
            <TextInput
              style={s.input} value={name}
              onChangeText={(t) => { setName(t); setDirty(true); }}
              placeholder="Company name" placeholderTextColor={COLORS.faint}
            />

            <Text style={[s.label, { marginTop: 18 }]}>Company Logo</Text>
            <View style={s.logoBox}>
              {uri ? (
                <Image source={{ uri }} style={s.logoImg} resizeMode="contain" />
              ) : (
                <View style={s.logoEmpty}>
                  <MaterialCommunityIcons name="image-outline" size={34} color={COLORS.faint} />
                  <Text style={s.logoEmptyTxt}>No logo</Text>
                </View>
              )}
            </View>
            <View style={s.logoBtns}>
              <TouchableOpacity style={s.logoBtn} onPress={pickLogo} disabled={picking} activeOpacity={0.85}>
                {picking
                  ? <ActivityIndicator size="small" color={COLORS.primary} />
                  : <Ionicons name="image-outline" size={16} color={COLORS.primary} />}
                <Text style={s.logoBtnTxt}>Choose Image</Text>
              </TouchableOpacity>
              {uri ? (
                <TouchableOpacity style={[s.logoBtn, s.logoBtnDanger]} onPress={removeLogo} activeOpacity={0.85}>
                  <Ionicons name="trash-outline" size={16} color={COLORS.red} />
                  <Text style={[s.logoBtnTxt, { color: COLORS.red }]}>Remove</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={s.hint}>PNG / JPEG · resized automatically. A new logo re-brands the next PDF you generate.</Text>
          </View>

          <TouchableOpacity
            style={[s.saveBtn, (!dirty || saving) && s.saveBtnOff]}
            onPress={onSave} disabled={!dirty || saving} activeOpacity={0.9}
          >
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={s.saveTxt}>Save Branding</Text></>}
          </TouchableOpacity>
          {savedMsg ? <Text style={s.savedMsg}>✓ {savedMsg}</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // solid fallback under the gradient (no black)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sub: { fontSize: 12.5, color: COLORS.muted, marginBottom: 14, lineHeight: 18 },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, ...SHADOW },
  label: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginBottom: 6 },
  input: { borderWidth: 1.5, borderColor: COLORS.line, borderRadius: 10, height: 46, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink, backgroundColor: '#fff' },
  hint: { fontSize: 12, color: COLORS.muted, marginTop: 10, lineHeight: 17 },

  logoBox: {
    height: 150, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.line,
    backgroundColor: '#F7F9FC', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  logoImg: { width: '90%', height: '90%' },
  logoEmpty: { alignItems: 'center', gap: 6 },
  logoEmptyTxt: { fontSize: 12, color: COLORS.faint, fontWeight: '600' },

  logoBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  logoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 9, backgroundColor: '#fff',
  },
  logoBtnDanger: { borderColor: '#FECACA' },
  logoBtnTxt: { fontSize: 13, fontWeight: '800', color: COLORS.primary },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, marginTop: 18, ...SHADOW,
  },
  saveBtnOff: { opacity: 0.5 },
  saveTxt: { color: '#fff', fontWeight: '800', fontSize: 15 },
  savedMsg: { textAlign: 'center', color: COLORS.green, fontWeight: '800', marginTop: 12 },
});
