// GENERATE CLIENT FILES (admin-only) — mobile port of the web OWL screen
// kpi_client_workspace. Pick a Client (required) + Project (optional) + Version +
// "Include existing tasks as data", then Generate & Download a ZIP of 3 XLSX
// (Requirements / Updates / Bug Reports), each pre-titled with the client name.
//
// The ZIP route (/kpi_client_workspace/generate_zip) is a type='http' GET that
// streams a binary attachment — so we open its URL with WebBrowser (the same
// pattern the Upload screens use for the "Download Blank Template" button).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Modal, Switch, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import * as svc from '../services/uploadAmendments';

const log = createLogger('GenClientFiles');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

// The three files the ZIP always contains (labels mirror the web).
const FILE_LIST = [
  { icon: 'file-document-outline', label: 'Requirements', color: '#2563EB' },
  { icon: 'cloud-upload-outline',  label: 'Updates',      color: '#EA580C' },
  { icon: 'bug-outline',           label: 'Bug Reports',  color: '#DC2626' },
];

export default function GenerateClientFiles({ onBack }) {
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);
  const [canGenerate, setCanGenerate] = useState(true); // admin-only
  const [roleName, setRoleName] = useState('');

  const [clients, setClients] = useState([]);
  const [subKras, setSubKras] = useState([]);
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [version, setVersion] = useState('v1.0');
  const [includeData, setIncludeData] = useState(false);

  const [loadingSubKras, setLoadingSubKras] = useState(false);
  const [picker, setPicker] = useState(null); // 'client' | 'project' | null
  const [banner, setBanner] = useState(null);  // { type, text }
  const [genPopup, setGenPopup] = useState(null); // { url, clientName, projectName, version, includeData }

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 4000); };

  // ---- Load on mount: role gate + client list --------------------------------
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const info = await svc.getUserInfo().catch((e) => { log.warn('getUserInfo failed', e?.message); return { isMock: false }; });
        const allowed = !!(info.isMock || info.is_system || info.is_owner || info.is_admin);
        setCanGenerate(allowed);
        setRoleName(
          info.is_system ? 'Administrator'
            : info.is_owner ? 'Owner'
            : info.is_admin ? 'Admin'
            : info.is_developer ? 'Developer'
            : info.is_client ? 'Client' : 'User'
        );
        if (!allowed) { log.warn('not allowed to generate', { name: info.name }); setLoading(false); return; }
        const c = await svc.getClients();
        setClients(c.clients || []);
        setIsMock(!!c.isMock);
        log.info('mount loaded', { clients: (c.clients || []).length, isMock: !!c.isMock });
      } catch (err) {
        log.error('load failed', err?.message);
        flash('err', err?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---- Client → Project (guard against a stale response overwriting a newer) --
  const subReq = useRef(0);
  const onSelectClient = useCallback(async (id) => {
    const token = ++subReq.current;
    setClientId(String(id));
    setProjectId('');
    setSubKras([]);
    setPicker(null);
    setLoadingSubKras(true);
    try {
      const res = await svc.getSubKras(id);
      if (token !== subReq.current) return;
      setSubKras(res.kras || []);
      log.info('projects loaded', { clientId: id, count: (res.kras || []).length });
    } catch (err) {
      if (token !== subReq.current) return;
      flash('err', err?.message || 'Could not load projects');
    } finally {
      if (token === subReq.current) setLoadingSubKras(false);
    }
  }, []);

  const clientName = clients.find((c) => String(c.id) === clientId)?.name || '';
  const projectName = subKras.find((k) => String(k.id) === projectId)?.display
    || subKras.find((k) => String(k.id) === projectId)?.name || '';

  // ---- Generate: build the URL and show the confirm/download popup ------------
  async function onGenerate() {
    if (!clientId) { flash('err', 'Please select a client first'); return; }
    const url = await svc.clientFilesZipUrl({
      clientKraId: clientId,
      projectKraId: projectId || null,
      version: version.trim() || 'v1.0',
      includeData,
    });
    if (!url) { flash('err', 'Connect to a server to generate files'); return; }
    log.info('generate → popup', { clientId, projectId: projectId || null, version, includeData });
    setGenPopup({ url, clientName, projectName, version: version.trim() || 'v1.0', includeData });
  }

  async function onDownload() {
    const url = genPopup?.url;
    if (!url) return;
    try {
      log.info('opening zip url', url);
      await WebBrowser.openBrowserAsync(url);
    } catch (err) {
      log.error('zip open failed', err?.message);
      flash('err', err?.message || 'Could not open the download');
    } finally {
      setGenPopup(null);
    }
  }

  // ---- Loading / not-admin states --------------------------------------------
  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <GradientBackground />
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={s.loadingTxt}>Loading…</Text>
      </View>
    );
  }

  if (!canGenerate) {
    return (
      <View style={s.root}>
        <GradientBackground />
        <StatusBar style="dark" />
        <Header onBack={onBack} title="Generate Client Files" />
        <View style={[s.center, { flex: 1, padding: 32 }]}>
          <View style={s.lockWrap}><Ionicons name="lock-closed" size={40} color={COLORS.amber} /></View>
          <Text style={s.lockTitle}>Admins only</Text>
          <Text style={s.lockMsg}>
            Generating client document files is restricted to Admin, Owner and
            Manager accounts.{roleName ? `\n\nYou're signed in as: ${roleName}.` : ''}
          </Text>
          <TouchableOpacity style={s.lockBtn} onPress={onBack} activeOpacity={0.9}>
            <Ionicons name="arrow-back" size={18} color="#fff" />
            <Text style={s.lockBtnTxt}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />
      <Header onBack={onBack} title="Generate Client Files" />

      {isMock && (
        <View style={s.mockBar}>
          <Ionicons name="cloud-offline-outline" size={14} color={COLORS.amber} />
          <Text style={s.mockTxt}>Offline demo data — connect to a server to generate real files</Text>
        </View>
      )}
      {banner && (
        <View style={[s.banner, banner.type === 'ok' ? s.bannerOk : s.bannerErr]}>
          <Ionicons name={banner.type === 'ok' ? 'checkmark-circle' : 'alert-circle'} size={16} color={banner.type === 'ok' ? COLORS.green : COLORS.red} />
          <Text style={[s.bannerTxt, { color: banner.type === 'ok' ? COLORS.green : COLORS.red }]}>{banner.text}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Intro */}
        <View style={s.intro}>
          <MaterialCommunityIcons name="folder-zip-outline" size={22} color={COLORS.primary} />
          <Text style={s.introTxt}>
            Build a ZIP of ready-to-share Excel files for a client — Requirements,
            Updates and Bug Reports, each pre-titled with the client name.
          </Text>
        </View>

        {/* 1. Client & Project */}
        <Section n="1" title="Client & Project" icon="account-outline">
          <Label required>Client</Label>
          <Selector
            placeholder="-- Select Client --"
            value={clientName}
            onPress={() => setPicker('client')}
          />
          <Label>Project (optional)</Label>
          <Selector
            placeholder={loadingSubKras ? 'Loading…' : (clientId ? '— whole client —' : 'Select a client first')}
            value={projectName}
            disabled={!clientId || loadingSubKras}
            loading={loadingSubKras}
            onPress={() => setPicker('project')}
            onClear={projectId ? () => setProjectId('') : null}
          />
          <Text style={s.hintTxt}>Leave the project blank to include the whole client.</Text>
        </Section>

        {/* 2. Version */}
        <Section n="2" title="Version" icon="pricetag-outline">
          <View style={s.field}>
            <Ionicons name="pricetag-outline" size={18} color={COLORS.muted} style={{ marginRight: 9 }} />
            <TextInput
              style={s.input} placeholder="v1.0" placeholderTextColor={COLORS.faint}
              value={version} onChangeText={setVersion} autoCapitalize="none"
            />
          </View>
          <Text style={s.hintTxt}>Shown in the file names (e.g. Requirements_v1.0.xlsx).</Text>
        </Section>

        {/* 3. Options */}
        <Section n="3" title="Options" icon="cog-outline">
          <View style={s.switchRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={s.switchTitle}>Include existing tasks as data</Text>
              <Text style={s.switchSub}>
                On → each sheet is pre-filled with the client's current tasks.
                Off → blank templates with headers only.
              </Text>
            </View>
            <Switch
              value={includeData}
              onValueChange={setIncludeData}
              trackColor={{ true: COLORS.primary, false: '#CBD5E1' }}
              thumbColor="#fff"
            />
          </View>
        </Section>

        {/* What you'll receive */}
        <View style={s.receiveCard}>
          <Text style={s.receiveTitle}>What you'll receive</Text>
          <Text style={s.receiveSub}>
            {clientName ? `${clientName} — ` : ''}a single ZIP containing:
          </Text>
          {FILE_LIST.map((f) => (
            <View key={f.label} style={s.receiveRow}>
              <MaterialCommunityIcons name={f.icon} size={18} color={f.color} />
              <Text style={s.receiveRowTxt}>{f.label}.xlsx</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={[s.genBtn, !clientId && s.genBtnDisabled]}
          onPress={onGenerate}
          disabled={!clientId}
          activeOpacity={0.9}
        >
          <MaterialCommunityIcons name="folder-zip" size={20} color="#fff" />
          <Text style={s.genBtnTxt}>Generate &amp; Download ZIP</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Client / Project picker sheet */}
      <PickerModal
        picker={picker}
        onClose={() => setPicker(null)}
        clients={clients}
        subKras={subKras}
        onSelectClient={onSelectClient}
        onSelectProject={(id) => { setProjectId(id ? String(id) : ''); setPicker(null); }}
      />

      {/* Styled generate / download popup */}
      <Modal visible={!!genPopup} transparent animationType="fade" onRequestClose={() => setGenPopup(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <View style={s.modalHead}>
              <MaterialCommunityIcons name="folder-zip" size={22} color="#0F5132" />
              <Text style={s.modalTitle}>Ready to download</Text>
              <TouchableOpacity onPress={() => setGenPopup(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#0F5132" />
              </TouchableOpacity>
            </View>
            <View style={s.modalPad}>
              <SummaryRow label="Client" value={genPopup?.clientName || '—'} />
              <SummaryRow label="Project" value={genPopup?.projectName || 'Whole client'} />
              <SummaryRow label="Version" value={genPopup?.version || 'v1.0'} />
              <SummaryRow label="Data" value={genPopup?.includeData ? 'With existing tasks' : 'Blank templates'} />
              <View style={s.modalFiles}>
                {FILE_LIST.map((f) => (
                  <View key={f.label} style={s.modalFileChip}>
                    <MaterialCommunityIcons name={f.icon} size={14} color={f.color} />
                    <Text style={s.modalFileTxt}>{f.label}</Text>
                  </View>
                ))}
              </View>
              <View style={s.modalNote}>
                <Ionicons name="information-circle-outline" size={15} color={COLORS.muted} style={{ marginTop: 1 }} />
                <Text style={s.modalNoteTxt}>The ZIP opens in your browser to download.</Text>
              </View>
            </View>
            <View style={s.modalFoot}>
              <TouchableOpacity style={s.footCancel} onPress={() => setGenPopup(null)}>
                <Text style={s.footCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.footConfirm} onPress={onDownload} activeOpacity={0.9}>
                <Ionicons name="download-outline" size={18} color="#fff" />
                <Text style={s.footConfirmTxt}>Download ZIP</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---- Small presentational helpers ------------------------------------------
function Header({ onBack, title }) {
  return (
    <View style={[s.header, { paddingTop: TOP }]}>
      <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={s.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
      </TouchableOpacity>
      <Text style={s.hTitle} numberOfLines={1}>{title}</Text>
      <View style={{ width: 40 }} />
    </View>
  );
}

function Section({ n, title, icon, children }) {
  return (
    <View style={s.card}>
      <View style={s.secTitleRow}>
        <View style={s.badge}><Text style={s.badgeTxt}>{n}</Text></View>
        <Ionicons name={icon} size={17} color={COLORS.navy} style={{ marginRight: 6 }} />
        <Text style={s.secTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const Label = ({ children, required }) => (
  <Text style={s.label}>{children}{required ? <Text style={s.reqStar}> *</Text> : null}</Text>
);

function Selector({ value, placeholder, onPress, disabled, loading, onClear }) {
  return (
    <TouchableOpacity
      style={[s.field, disabled && s.fieldDisabled]}
      onPress={disabled ? undefined : onPress}
      activeOpacity={0.8}
    >
      <Text style={[s.input, { color: value ? COLORS.ink : COLORS.faint }]} numberOfLines={1}>
        {value || placeholder}
      </Text>
      {loading
        ? <ActivityIndicator size="small" color={COLORS.primary} />
        : onClear
          ? <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={18} color={COLORS.muted} /></TouchableOpacity>
          : <Ionicons name="chevron-down" size={18} color={COLORS.muted} />}
    </TouchableOpacity>
  );
}

const SummaryRow = ({ label, value }) => (
  <View style={s.sumRow}>
    <Text style={s.sumLabel}>{label}</Text>
    <Text style={s.sumValue} numberOfLines={2}>{value}</Text>
  </View>
);

function PickerModal({ picker, onClose, clients, subKras, onSelectClient, onSelectProject }) {
  if (!picker) return null;
  let title = 'Select';
  let items = [];
  if (picker === 'client') {
    title = 'Select Client';
    items = clients.map((c) => ({ key: String(c.id), label: c.name, onPress: () => onSelectClient(c.id) }));
  } else if (picker === 'project') {
    title = 'Select Project';
    items = [
      { key: 'none', label: '— whole client —', onPress: () => onSelectProject('') },
      ...subKras.map((k) => ({ key: String(k.id), label: k.display || k.name, onPress: () => onSelectProject(k.id) })),
    ];
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={s.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={s.sheet}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>{title}</Text>
          {items.length === 0 ? (
            <Text style={s.sheetEmpty}>Nothing to choose.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {items.map((it) => (
                <TouchableOpacity key={it.key} style={s.sheetItem} onPress={it.onPress}>
                  <Text style={s.sheetItemTxt}>{it.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <TouchableOpacity style={s.sheetCancel} onPress={onClose}>
            <Text style={s.sheetCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' },
  center: { alignItems: 'center', justifyContent: 'center' },
  loadingTxt: { marginTop: 14, color: COLORS.muted, fontSize: 14 },

  lockWrap: { width: 88, height: 88, borderRadius: 26, backgroundColor: COLORS.amberBg, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  lockTitle: { fontSize: 22, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  lockMsg: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center', lineHeight: 21 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 26, backgroundColor: COLORS.primary, borderRadius: 13, paddingHorizontal: 24, height: 50 },
  lockBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 10, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  hTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '900', color: COLORS.navy },

  mockBar: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.amberBg, paddingHorizontal: 16, paddingVertical: 7 },
  mockTxt: { color: COLORS.amber, fontSize: 12, flex: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  bannerOk: { backgroundColor: COLORS.greenBg }, bannerErr: { backgroundColor: COLORS.redBg },
  bannerTxt: { fontSize: 13, fontWeight: '600', flex: 1 },

  intro: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: '#EEF3FF', borderRadius: 14, padding: 14, marginBottom: 14 },
  introTxt: { flex: 1, fontSize: 13, color: COLORS.ink, lineHeight: 19 },

  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14, ...SHADOW },
  secTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  badgeTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  secTitle: { fontSize: 16, fontWeight: '900', color: COLORS.navy },

  label: { fontSize: 13, fontWeight: '700', color: COLORS.muted, marginBottom: 6, marginTop: 10 },
  reqStar: { color: COLORS.red, fontWeight: '900' },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F8FD',
    borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 13, height: 50,
  },
  fieldDisabled: { opacity: 0.55 },
  input: { flex: 1, fontSize: 15, color: COLORS.ink },
  hintTxt: { fontSize: 12.5, color: COLORS.muted, marginTop: 6, lineHeight: 17 },

  switchRow: { flexDirection: 'row', alignItems: 'center' },
  switchTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  switchSub: { fontSize: 12.5, color: COLORS.muted, marginTop: 4, lineHeight: 17 },

  receiveCard: { backgroundColor: '#F8FAFF', borderRadius: 14, borderWidth: 1, borderColor: '#E4ECF7', padding: 15, marginBottom: 16 },
  receiveTitle: { fontSize: 14, fontWeight: '900', color: COLORS.navy },
  receiveSub: { fontSize: 12.5, color: COLORS.muted, marginTop: 3, marginBottom: 8 },
  receiveRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 5 },
  receiveRowTxt: { fontSize: 14, color: COLORS.ink, fontWeight: '600' },

  genBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    backgroundColor: COLORS.green, borderRadius: 14, height: 54,
    shadowColor: COLORS.green, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  genBtnDisabled: { backgroundColor: '#9DBBA6', shadowOpacity: 0 },
  genBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },

  // Picker sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 28 },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#D5DCE8', marginBottom: 14 },
  sheetTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy, marginBottom: 10 },
  sheetEmpty: { color: COLORS.muted, fontSize: 14, paddingVertical: 14 },
  sheetItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  sheetItemTxt: { fontSize: 15.5, color: COLORS.ink },
  sheetCancel: { marginTop: 14, height: 50, borderRadius: 13, backgroundColor: '#F1F5FB', alignItems: 'center', justifyContent: 'center' },
  sheetCancelTxt: { fontSize: 15.5, fontWeight: '800', color: COLORS.muted },

  // Generate popup
  modalWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 400, backgroundColor: '#fff', borderRadius: 18, overflow: 'hidden' },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#DCFCE7', paddingHorizontal: 16, paddingVertical: 13 },
  modalTitle: { flex: 1, fontSize: 16.5, fontWeight: '900', color: '#0F5132' },
  modalPad: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4 },
  sumRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  sumLabel: { width: 78, fontSize: 13, color: COLORS.muted, fontWeight: '700' },
  sumValue: { flex: 1, fontSize: 14, color: COLORS.ink, fontWeight: '700' },
  modalFiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  modalFileChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F1F5FB', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  modalFileTxt: { fontSize: 12.5, fontWeight: '700', color: COLORS.ink },
  modalNote: { flexDirection: 'row', gap: 7, alignItems: 'flex-start', marginTop: 12 },
  modalNoteTxt: { flex: 1, fontSize: 12.5, color: COLORS.muted, lineHeight: 17 },
  modalFoot: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 8 },
  footCancel: { paddingHorizontal: 18, height: 46, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F8' },
  footCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 14.5 },
  footConfirm: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 20, height: 46, borderRadius: 11, justifyContent: 'center', backgroundColor: COLORS.green },
  footConfirmTxt: { color: '#fff', fontWeight: '900', fontSize: 14.5 },
});
