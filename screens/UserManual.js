// USER MANUAL — per-role in-app manuals (369 App User Manual module).
// Every user sees the manuals tagged for THEIR role + "Everyone" (the server
// role-filters, so a client can never fetch an admin doc). Tapping a manual
// opens its PDF via the OS viewer, exactly like the app opens reports/invoices.
// Admins additionally get + Add / Edit / Delete with a Role picker; the module
// enforces this too (create/write/unlink ACL is admin-only).

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Modal, Alert, StatusBar as RNStatusBar, Platform,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import { fetchManualBundle, fetchManualData, saveManual, deleteManual } from '../services/userManual';

const log = createLogger('UserManual');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// Role tag → who can see the manual. Order matches the backend Selection.
const ROLE_OPTIONS = [
  { value: 'all', label: 'Everyone' },
  { value: 'developer', label: 'Developer' },
  { value: 'admin', label: 'Admin' },
  { value: 'client', label: 'Client' },
];
const ROLE_STYLE = {
  all:       { bg: '#EEF2FF', fg: '#4F46E5', label: 'Everyone' },
  developer: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'Developer' },
  admin:     { bg: '#EDE9FE', fg: '#7C3AED', label: 'Admin' },
  client:    { bg: '#CFFAFE', fg: '#0E7490', label: 'Client' },
};

export default function UserManual({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);
  const [manuals, setManuals] = useState([]);
  const [unavailable, setUnavailable] = useState(false);   // module not installed
  const [openingId, setOpeningId] = useState(null);        // PDF being fetched
  const [banner, setBanner] = useState(null);              // { kind, msg }
  const [editor, setEditor] = useState(null);              // add/edit modal state
  const [saving, setSaving] = useState(false);

  const flash = (kind, msg) => { setBanner({ kind, msg }); setTimeout(() => setBanner(null), 3200); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchManualBundle();
      if (res?.status) {
        setCanEdit(!!res.canEdit);
        setManuals(res.manuals || []);
        setUnavailable(false);
      } else {
        // Module not installed / no connection → show a friendly empty state.
        setManuals([]);
        setUnavailable(!!res?.notInstalled);
      }
    } catch (e) {
      log.warn('load failed', e?.message);
      setManuals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Open a manual's PDF: fetch the bytes, write to a cache file, hand it to the
  // OS share/open sheet (same path as the invoice/report PDFs).
  const openManual = async (item) => {
    setOpeningId(item.id);
    try {
      const res = await fetchManualData(item.id);
      if (!res?.status || !res.data) { flash('err', res?.message || 'Could not open this manual.'); return; }
      const name = (res.filename || `${res.name || 'Manual'}.pdf`).split(/[\\/]/).pop();
      const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      const uri = `${dir}${Date.now()}_${name}`;
      await FileSystem.writeAsStringAsync(uri, res.data, { encoding: FileSystem.EncodingType.Base64 });

      // Android: OPEN the PDF in a viewer via ACTION_VIEW (the system "Open with"
      // chooser) — not the share/link sheet. Needs a content:// URI + read grant.
      if (Platform.OS === 'android') {
        try {
          const IntentLauncher = require('expo-intent-launcher');
          const contentUri = await FileSystem.getContentUriAsync(uri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            flags: 1,   // FLAG_GRANT_READ_URI_PERMISSION
            type: 'application/pdf',
          });
          return;
        } catch (e) {
          log.warn('intent view failed, falling back to share', e?.message);
        }
      }

      // iOS / fallback: opening a PDF lives behind the share sheet here.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: name, UTI: 'com.adobe.pdf' });
      } else {
        flash('err', 'No app available to open PDFs on this device.');
      }
    } catch (e) {
      log.warn('open failed', e?.message);
      flash('err', 'Could not open this manual.');
    } finally {
      setOpeningId(null);
    }
  };

  // ── Admin: add / edit ──
  const startAdd = () => setEditor({ id: null, name: '', role: 'all', filename: '', base64: null });
  const startEdit = (item) => setEditor({ id: item.id, name: item.name || '', role: item.role || 'all', filename: item.filename || '', base64: null });

  const pickPdf = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: 'application/pdf' });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file) { flash('err', 'No file was chosen.'); return; }
      const data = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
      setEditor((p) => ({ ...p, base64: data, filename: file.name || 'manual.pdf' }));
    } catch (e) {
      log.warn('pick failed', e?.message);
      flash('err', e?.message || 'Could not read the file.');
    }
  };

  const submitEditor = async () => {
    if (!editor) return;
    const name = (editor.name || '').trim();
    if (!name) { flash('err', 'Give the manual a title.'); return; }
    if (!editor.id && !editor.base64) { flash('err', 'Pick a PDF file first.'); return; }
    setSaving(true);
    try {
      const res = await saveManual({
        id: editor.id || undefined,
        name,
        role: editor.role,
        filename: editor.filename,
        base64: editor.base64 || undefined,   // omit on edit = keep existing PDF
      });
      if (res?.status) {
        setEditor(null);
        flash('ok', editor.id ? 'Manual updated.' : 'Manual added.');
        load();
      } else {
        flash('err', res?.message || 'Could not save the manual.');
      }
    } catch (e) {
      flash('err', 'Could not save the manual.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (item) => {
    Alert.alert('Delete manual', `Delete "${item.name}"? This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          const res = await deleteManual(item.id);
          if (res?.status) { flash('ok', 'Manual deleted.'); load(); }
          else flash('err', res?.message || 'Could not delete.');
        },
      },
    ]);
  };

  // ═══════════════════════ RENDER ═══════════════════════
  const RoleBadge = ({ role }) => {
    const st = ROLE_STYLE[role] || ROLE_STYLE.all;
    return (
      <View style={[s.badge, { backgroundColor: st.bg }]}>
        <Text style={[s.badgeTxt, { color: st.fg }]}>{st.label}</Text>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <GradientBackground />

      {/* Header */}
      <View style={[s.header, { paddingTop: TOP }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>User Manual</Text>
        {canEdit ? (
          <TouchableOpacity onPress={startAdd} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
            <Ionicons name="add" size={26} color={COLORS.primary} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
      </View>

      {/* Banner */}
      {banner ? (
        <View style={[s.banner, banner.kind === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.kind === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={15}
            color={banner.kind === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.kind === 'ok' ? '#065F46' : COLORS.red }]}>{banner.msg}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : (
        <FlatList
          data={manuals}
          keyExtractor={(it) => String(it.id)}
          contentContainerStyle={manuals.length ? { padding: 14, paddingBottom: 40 } : s.emptyWrap}
          renderItem={({ item }) => (
            <View style={s.card}>
              <TouchableOpacity style={s.cardMain} onPress={() => openManual(item)} activeOpacity={0.85}>
                <View style={s.pdfIcon}>
                  <MaterialCommunityIcons name="file-pdf-box" size={26} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.manName} numberOfLines={2}>{item.name}</Text>
                  <View style={s.metaRow}>
                    <RoleBadge role={item.role} />
                    <Text style={s.manFile} numberOfLines={1}>{item.filename}</Text>
                  </View>
                </View>
                {openingId === item.id
                  ? <ActivityIndicator size="small" color={COLORS.primary} />
                  : <Ionicons name="open-outline" size={20} color={COLORS.primary} />}
              </TouchableOpacity>

              {canEdit ? (
                <View style={s.rowActions}>
                  <TouchableOpacity style={s.rowBtn} onPress={() => startEdit(item)} activeOpacity={0.85}>
                    <Ionicons name="create-outline" size={15} color={COLORS.primary} /><Text style={s.rowBtnTxt}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.rowBtn} onPress={() => confirmDelete(item)} activeOpacity={0.85}>
                    <Ionicons name="trash-outline" size={15} color={COLORS.red} /><Text style={[s.rowBtnTxt, { color: COLORS.red }]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <View style={s.emptyBox}>
              <MaterialCommunityIcons name="book-open-page-variant-outline" size={46} color={COLORS.faint} />
              <Text style={s.emptyTitle}>{unavailable ? 'Manuals not set up yet' : 'No manuals yet'}</Text>
              <Text style={s.emptySub}>
                {unavailable
                  ? 'Ask your admin to install the User Manual module and upload guides.'
                  : canEdit ? 'Tap + to add your first manual.' : 'Your manuals will appear here once added.'}
              </Text>
            </View>
          }
        />
      )}

      {/* Add / Edit modal */}
      <Modal visible={!!editor} transparent animationType="fade" onRequestClose={() => setEditor(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <Text style={s.modalTitle}>{editor?.id ? 'Edit Manual' : 'Add Manual'}</Text>
              <TouchableOpacity onPress={() => setEditor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.muted} />
              </TouchableOpacity>
            </View>

            <Text style={s.fLbl}>Title</Text>
            <TextInput
              style={s.input} value={editor?.name} placeholder="e.g. Getting Started Guide" placeholderTextColor={COLORS.faint}
              onChangeText={(t) => setEditor((p) => ({ ...p, name: t }))}
            />

            <Text style={[s.fLbl, { marginTop: 14 }]}>Visible to</Text>
            <View style={s.roleWrap}>
              {ROLE_OPTIONS.map((r) => {
                const on = editor?.role === r.value;
                return (
                  <TouchableOpacity key={r.value} style={[s.roleChip, on && s.roleChipOn]} activeOpacity={0.85}
                    onPress={() => setEditor((p) => ({ ...p, role: r.value }))}>
                    <Text style={[s.roleChipTxt, on && s.roleChipTxtOn]}>{r.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[s.fLbl, { marginTop: 14 }]}>PDF file</Text>
            <TouchableOpacity style={s.pickBtn} onPress={pickPdf} activeOpacity={0.85}>
              <MaterialCommunityIcons name="file-upload-outline" size={18} color={COLORS.primary} />
              <Text style={s.pickTxt} numberOfLines={1}>
                {editor?.filename ? editor.filename : (editor?.id ? 'Replace PDF (optional)' : 'Choose a PDF')}
              </Text>
            </TouchableOpacity>
            {editor?.id && !editor?.base64 ? <Text style={s.hint}>Leave empty to keep the current PDF.</Text> : null}

            <View style={s.modalActions}>
              <TouchableOpacity onPress={() => setEditor(null)}><Text style={s.cancelTxt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={submitEditor} disabled={saving} activeOpacity={0.9}>
                {saving ? <ActivityIndicator size="small" color="#fff" />
                  : <><Ionicons name="checkmark" size={17} color="#fff" /><Text style={s.saveTxt}>Save</Text></>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },   // solid fallback under the gradient
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingBottom: 12,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.navy, marginHorizontal: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 10, padding: 10, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { flex: 1, fontSize: 12.5, fontWeight: '600' },

  card: { backgroundColor: COLORS.card, borderRadius: 14, marginBottom: 12, padding: 12, ...SHADOW },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pdfIcon: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' },
  manName: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  manFile: { flex: 1, fontSize: 11.5, color: COLORS.faint },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  badgeTxt: { fontSize: 10.5, fontWeight: '800' },

  rowActions: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.line },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: COLORS.bg },
  rowBtnTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.primary },

  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyBox: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: COLORS.muted, marginTop: 6 },
  emptySub: { fontSize: 13, color: COLORS.faint, textAlign: 'center', paddingHorizontal: 20 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  modalCard: { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 20, padding: 20, ...SHADOW },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: COLORS.navy },
  fLbl: { fontSize: 12.5, fontWeight: '700', color: COLORS.muted, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: COLORS.ink, backgroundColor: '#fff' },
  roleWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roleChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  roleChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  roleChipTxt: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  roleChipTxtOn: { color: '#fff' },
  pickBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: COLORS.primary, borderStyle: 'dashed', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12 },
  pickTxt: { flex: 1, fontSize: 13.5, fontWeight: '600', color: COLORS.primary },
  hint: { fontSize: 11.5, color: COLORS.faint, marginTop: 6 },
  modalActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 18, marginTop: 22 },
  cancelTxt: { fontSize: 14.5, fontWeight: '700', color: COLORS.muted },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primary, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 10 },
  saveTxt: { fontSize: 14.5, fontWeight: '800', color: '#fff' },
});
