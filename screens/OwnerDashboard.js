// OWNER DASHBOARD — "Certified tasks ready to invoice". Mobile port of the Odoo
// kpi_owner_dashboard: one card per client with Certified / Awaiting / In Progress
// stats, actual & quoted hours, last-invoice info, an expandable Projects list,
// and View Certified Tasks + Invoice actions.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  ActivityIndicator, Alert, Modal, StatusBar as RNStatusBar,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, SHADOW } from '../theme';
import GradientBackground from '../components/GradientBackground';
import { createLogger } from '../api/logger';
import * as svc from '../services/ownerDashboard';

const log = createLogger('OwnerDashboard');
const TOP = (RNStatusBar.currentHeight || 0) + 12;

const hrs = (v) => `${Number(v || 0)}h`;
const invColor = (state) => state === 'sent' ? COLORS.green : state === 'finalized' ? COLORS.amber : COLORS.muted;

export default function OwnerDashboard({ onBack }) {
  const [clients, setClients] = useState([]);
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterClient, setFilterClient] = useState(''); // client_id as string ('' = all)
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState({}); // client_id → bool
  const [busyInvoice, setBusyInvoice] = useState(null); // client_id being invoiced
  const [drill, setDrill] = useState(null); // { clientId, clientName, tasks, loading, query }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { clients: rows, isMock: mock } = await svc.getCertifiedByClient();
      setClients(rows);
      setIsMock(mock);
      // Clear a stale filter if its client is no longer in the fresh set —
      // otherwise the view can lock to an empty list with the filter bar hidden.
      setFilterClient((prev) => (prev && !rows.some((c) => String(c.client_id) === prev) ? '' : prev));
    } catch (e) {
      log.error('load failed', e?.message);
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = filterClient
    ? clients.filter((c) => String(c.client_id) === filterClient)
    : clients;

  const toggleProjects = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  // ---- View Certified Tasks ----------------------------------------------
  async function openDrill(client) {
    const cid = client.client_id;
    setDrill({ clientId: cid, clientName: client.client_name, tasks: [], loading: true, query: '' });
    try {
      const { tasks } = await svc.getClientCertifiedTasks(cid);
      // Ignore a stale response if the user has since opened a different client.
      setDrill((d) => (d && d.clientId === cid ? { ...d, tasks, loading: false } : d));
    } catch (e) {
      setDrill((d) => (d && d.clientId === cid ? { ...d, loading: false } : d));
      Alert.alert('Error', e?.message || 'Could not load certified tasks');
    }
  }

  // ---- Invoice ------------------------------------------------------------
  function confirmInvoice(client, project) {
    const label = project ? `project "${project.project_name}"` : `client "${client.client_name}"`;
    Alert.alert(
      'Create invoice?',
      `This will create a draft invoice for ${label} covering all certified time logs.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create', onPress: async () => {
            setBusyInvoice(client.client_id);
            try {
              const res = await svc.createInvoice({
                clientKraId: client.client_id,
                subKraIds: project ? [project.project_id] : [],
              });
              Alert.alert('Invoice created', `Draft invoice #${res.invoice_id} created${res.isMock ? ' (offline mock)' : ''}.`);
              load();
            } catch (e) {
              Alert.alert('Error', e?.message || 'Could not create invoice');
            } finally {
              setBusyInvoice(null);
            }
          },
        },
      ]
    );
  }

  return (
    <View style={s.root}>
      <GradientBackground />
      <StatusBar style="dark" />

      {/* Header — back button matches the KPI Action Board (white, shadow) */}
      <View style={[s.header, { paddingTop: TOP }]}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="chevron-back" size={24} color={COLORS.navy} />
          </TouchableOpacity>
        ) : <View style={{ width: 40 }} />}
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={s.title}>Owner Dashboard</Text>
          <Text style={s.subtitle}>Certified tasks ready to invoice</Text>
        </View>
        <TouchableOpacity onPress={load} style={s.iconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="refresh" size={20} color={COLORS.navy} />
        </TouchableOpacity>
      </View>

      {/* Filter bar */}
      {!loading && !error && clients.length > 1 ? (
        <View style={s.filterBar}>
          <Ionicons name="filter" size={16} color={COLORS.muted} />
          <TouchableOpacity style={s.filterSel} onPress={() => setFilterOpen(true)} activeOpacity={0.8}>
            <Text style={s.filterTxt} numberOfLines={1}>
              {filterClient ? clients.find((c) => String(c.client_id) === filterClient)?.client_name : 'All clients'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={COLORS.muted} />
          </TouchableOpacity>
          <Text style={s.showing}>Showing {shown.length}/{clients.length}</Text>
        </View>
      ) : null}

      {isMock && !loading ? (
        <View style={s.mockHint}>
          <Ionicons name="information-circle-outline" size={16} color={COLORS.amber} />
          <Text style={s.mockTxt}>Showing sample data — connect to Odoo to see live clients.</Text>
        </View>
      ) : null}

      {/* Body */}
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /><Text style={s.centerTxt}>Loading dashboard…</Text></View>
      ) : error ? (
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={COLORS.faint} />
          <Text style={s.centerTxt}>{error}</Text>
          <TouchableOpacity style={s.retry} onPress={load}><Ionicons name="refresh" size={18} color="#fff" /><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : shown.length === 0 ? (
        <View style={s.center}><Ionicons name="briefcase-outline" size={44} color={COLORS.faint} /><Text style={s.centerTxt}>No clients to show.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {shown.map((c) => (
            <ClientCard
              key={c.client_id} c={c}
              expanded={!!expanded[c.client_id]} onToggle={() => toggleProjects(c.client_id)}
              onViewTasks={() => openDrill(c)}
              onInvoice={() => confirmInvoice(c, null)}
              onInvoiceProject={(p) => confirmInvoice(c, p)}
              invoicing={busyInvoice === c.client_id}
            />
          ))}
        </ScrollView>
      )}

      {/* Filter picker */}
      <Modal visible={filterOpen} transparent animationType="fade" onRequestClose={() => setFilterOpen(false)}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => setFilterOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={s.sheet}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Filter by Client</Text>
            <ScrollView style={{ maxHeight: 340 }}>
              {[{ client_id: '', client_name: 'All clients' }, ...clients].map((c) => (
                <TouchableOpacity key={String(c.client_id)} style={s.pickItem}
                  onPress={() => { setFilterClient(String(c.client_id) === '' ? '' : String(c.client_id)); setFilterOpen(false); }}>
                  <Text style={s.pickTxt}>{c.client_name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Certified-tasks drill-down */}
      <DrillModal drill={drill} setDrill={setDrill} onInvoice={() => {
        const c = clients.find((x) => x.client_id === drill?.clientId);
        if (c) { setDrill(null); confirmInvoice(c, null); }
      }} />
    </View>
  );
}

// ---- Client card ----------------------------------------------------------

function ClientCard({ c, expanded, onToggle, onViewTasks, onInvoice, onInvoiceProject, invoicing }) {
  const canInvoice = !!c.completed_count;
  return (
    <View style={s.card}>
      <Text style={s.cardName}>{c.client_name}</Text>
      {c.parent_name ? <Text style={s.cardParent}>under {c.parent_name}</Text> : null}

      {/* Stat row */}
      <View style={s.statRow}>
        <Stat label="Certified" value={c.completed_count} color={COLORS.green} />
        <Stat label="Awaiting" value={c.awaiting_client_count} color={COLORS.amber} />
        <Stat label="In Progress" value={c.in_progress_count} color={COLORS.primary} />
      </View>

      <View style={s.divider} />

      <Row label="Actual hours:" value={hrs(c.total_actual_hours)} />
      <Row label="Quoted hours:" value={hrs(c.total_quoted_hours)} />

      {/* Invoice info */}
      <View style={s.invInfo}>
        <Ionicons name="information-circle-outline" size={15} color={COLORS.muted} />
        {c.last_invoice_name ? (
          <Text style={s.invTxt}>
            Last invoice: {c.last_invoice_name}
            {c.last_invoice_state ? <Text style={{ color: invColor(c.last_invoice_state), fontWeight: '800' }}>  ·  {c.last_invoice_state}</Text> : null}
            {c.last_invoice_date ? `  on ${c.last_invoice_date}` : ''}
          </Text>
        ) : <Text style={s.invTxt}>No invoices yet</Text>}
      </View>

      {/* Projects (expandable) */}
      {(c.projects || []).length > 0 ? (
        <>
          <TouchableOpacity style={s.projToggle} onPress={onToggle} activeOpacity={0.7}>
            <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={COLORS.link} />
            <Text style={s.projToggleTxt}>Projects ({c.projects.length})</Text>
          </TouchableOpacity>
          {expanded ? c.projects.map((p) => (
            <View key={p.project_id} style={s.projCard}>
              <View style={{ flex: 1 }}>
                <Text style={s.projName}>{p.project_name}</Text>
                <Text style={s.projMeta}>{p.completed_count} certified · {p.awaiting_client_count} awaiting · {p.in_progress_count} active</Text>
                <Text style={s.projMeta}>Actual {hrs(p.total_actual_hours)} · Quoted {hrs(p.total_quoted_hours)}</Text>
              </View>
              <TouchableOpacity
                style={[s.projInvBtn, !p.completed_count && s.btnDisabled]}
                disabled={!p.completed_count} onPress={() => onInvoiceProject(p)} activeOpacity={0.85}
              >
                <Ionicons name="document-text-outline" size={14} color={p.completed_count ? COLORS.green : COLORS.faint} />
                <Text style={[s.projInvTxt, !p.completed_count && { color: COLORS.faint }]}>Invoice</Text>
              </TouchableOpacity>
            </View>
          )) : null}
        </>
      ) : null}

      {/* Card actions */}
      <View style={s.cardBtns}>
        <TouchableOpacity style={s.viewBtn} onPress={onViewTasks} activeOpacity={0.85}>
          <Ionicons name="list" size={16} color={COLORS.navy} />
          <Text style={s.viewTxt}>View Certified Tasks</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.invBtn, !canInvoice && s.btnDisabled]}
          disabled={!canInvoice || invoicing} onPress={onInvoice} activeOpacity={0.85}
        >
          {invoicing ? <ActivityIndicator size="small" color="#fff" /> : (
            <>
              <Ionicons name="document-text-outline" size={16} color={canInvoice ? '#fff' : COLORS.faint} />
              <Text style={[s.invBtnTxt, !canInvoice && { color: COLORS.faint }]}>Invoice</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Stat({ label, value, color }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLbl}>{label}</Text>
      <Text style={[s.statVal, { color }]}>{value || 0}</Text>
    </View>
  );
}
function Row({ label, value }) {
  return (
    <View style={s.kvRow}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={s.kvValue}>{value}</Text>
    </View>
  );
}

// ---- Drill-down modal -----------------------------------------------------

function DrillModal({ drill, setDrill, onInvoice }) {
  if (!drill) return null;
  const q = (drill.query || '').toLowerCase();
  const tasks = q
    ? drill.tasks.filter((t) =>
      [t.name, t.external_ref, t.primary_assignee, t.client_signed_by].some((v) => (v || '').toLowerCase().includes(q)))
    : drill.tasks;
  const totalActual = tasks.reduce((a, t) => a + Number(t.actual_hours || 0), 0);
  const totalQuoted = tasks.reduce((a, t) => a + Number(t.quoted_hours || 0), 0);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => setDrill(null)}>
      <View style={s.drillWrap}>
        <View style={s.drillCard}>
          <View style={s.drillHead}>
            <Text style={s.drillTitle} numberOfLines={1}>Certified — {drill.clientName}</Text>
            <TouchableOpacity onPress={() => setDrill(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={COLORS.navy} />
            </TouchableOpacity>
          </View>

          <View style={s.searchBox}>
            <Ionicons name="search" size={16} color={COLORS.muted} />
            <TextInput
              style={s.searchInput} placeholder="Search tasks…" placeholderTextColor={COLORS.faint}
              value={drill.query} onChangeText={(t) => setDrill((d) => ({ ...d, query: t }))}
            />
          </View>

          {drill.loading ? (
            <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
          ) : tasks.length === 0 ? (
            <View style={[s.center, { paddingVertical: 30 }]}>
              <MaterialCommunityIcons name="clipboard-check-outline" size={40} color={COLORS.faint} />
              <Text style={s.centerTxt}>No certified tasks.</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 380 }} keyboardShouldPersistTaps="handled">
              {tasks.map((t) => (
                <View key={t.id} style={s.taskRow}>
                  <View style={{ flex: 1 }}>
                    <View style={s.taskTop}>
                      <Text style={s.taskRef}>{t.external_ref || '—'}</Text>
                      <Text style={s.taskName} numberOfLines={1}>{t.name}</Text>
                    </View>
                    <Text style={s.taskMeta} numberOfLines={1}>
                      {t.primary_assignee || '—'} · signed by {t.client_signed_by || '—'}
                      {(t.signed_date || t.completion_date) ? ` · ${t.signed_date || t.completion_date}` : ''}
                    </Text>
                  </View>
                  <View style={s.taskHrs}>
                    <Text style={s.taskHrsA}>{hrs(t.actual_hours)}</Text>
                    <Text style={s.taskHrsQ}>Q {hrs(t.quoted_hours)}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={s.drillFoot}>
            <Text style={s.drillTotal}>{tasks.length} task{tasks.length === 1 ? '' : 's'} · Actual {totalActual.toFixed(1)}h · Quoted {totalQuoted.toFixed(1)}h</Text>
            <TouchableOpacity style={s.genInvBtn} onPress={onInvoice} activeOpacity={0.9}>
              <Ionicons name="document-text-outline" size={16} color="#fff" />
              <Text style={s.genInvTxt}>Generate Invoice</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EAF2FF' }, // gradient on top via GradientBackground

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', ...SHADOW },
  title: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  subtitle: { fontSize: 12, color: COLORS.muted, marginTop: 1, fontWeight: '600' },

  filterBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginTop: 6, backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 12, height: 44, ...SHADOW },
  filterSel: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filterTxt: { flex: 1, fontSize: 13.5, fontWeight: '700', color: COLORS.ink, marginRight: 6 },
  showing: { fontSize: 12, fontWeight: '700', color: COLORS.muted },

  mockHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: COLORS.amberBg, borderRadius: 10 },
  mockTxt: { flex: 1, fontSize: 12, color: COLORS.amber, fontWeight: '600' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30 },
  centerTxt: { fontSize: 14.5, color: COLORS.muted, textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, backgroundColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 22, height: 44 },
  retryTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Card
  card: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 2, borderColor: COLORS.primary, padding: 16, marginBottom: 14, ...SHADOW },
  cardName: { fontSize: 18, fontWeight: '900', color: COLORS.navy },
  cardParent: { fontSize: 13, color: COLORS.muted, marginTop: 2 },

  statRow: { flexDirection: 'row', marginTop: 16 },
  stat: { flex: 1, alignItems: 'center' },
  statLbl: { fontSize: 12, color: COLORS.muted, fontWeight: '700' },
  statVal: { fontSize: 24, fontWeight: '900', marginTop: 4 },

  divider: { height: 1, backgroundColor: COLORS.line, marginVertical: 14 },

  kvRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  kvLabel: { fontSize: 14, color: COLORS.ink, fontWeight: '600' },
  kvValue: { fontSize: 14, color: COLORS.navy, fontWeight: '900' },

  invInfo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  invTxt: { flex: 1, fontSize: 13, color: COLORS.muted },

  projToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: COLORS.line },
  projToggleTxt: { fontSize: 14, fontWeight: '800', color: COLORS.link },
  projCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F7FAFF', borderWidth: 1.5, borderColor: '#E3EBF7', borderRadius: 12, padding: 12, marginTop: 10 },
  projName: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
  projMeta: { fontSize: 12, color: COLORS.muted, marginTop: 3 },
  projInvBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: COLORS.green, borderRadius: 10, paddingHorizontal: 12, height: 38 },
  projInvTxt: { fontSize: 13, fontWeight: '800', color: COLORS.green },

  cardBtns: { flexDirection: 'row', gap: 10, marginTop: 16 },
  viewBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 46, borderRadius: 12, borderWidth: 1.5, borderColor: '#E7ECF3', backgroundColor: '#fff' },
  viewTxt: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy },
  invBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 46, borderRadius: 12, paddingHorizontal: 22, backgroundColor: COLORS.green },
  invBtnTxt: { fontSize: 13.5, fontWeight: '800', color: '#fff' },
  btnDisabled: { backgroundColor: '#F1F5FB', borderColor: '#E7ECF3' },

  // Backdrop / sheets
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, paddingBottom: 26 },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#D5DCE8', marginBottom: 14 },
  sheetTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy, marginBottom: 8 },
  pickItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  pickTxt: { fontSize: 15.5, color: COLORS.ink },

  // Drill modal
  drillWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  drillCard: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 16, paddingBottom: 24 },
  drillHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  drillTitle: { flex: 1, fontSize: 17, fontWeight: '900', color: COLORS.navy, marginRight: 10 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F5F8FD', borderWidth: 1.5, borderColor: '#E7ECF3', borderRadius: 12, paddingHorizontal: 12, height: 44, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 14.5, color: COLORS.ink },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  taskTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  taskRef: { fontSize: 11, fontWeight: '800', color: COLORS.primary, backgroundColor: '#EEF3FF', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  taskName: { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.ink },
  taskMeta: { fontSize: 12, color: COLORS.muted, marginTop: 3 },
  taskHrs: { alignItems: 'flex-end' },
  taskHrsA: { fontSize: 14, fontWeight: '900', color: COLORS.navy },
  taskHrsQ: { fontSize: 11.5, color: COLORS.muted, marginTop: 2 },
  drillFoot: { marginTop: 14, gap: 10 },
  drillTotal: { fontSize: 12.5, color: COLORS.muted, fontWeight: '700', textAlign: 'center' },
  genInvBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, backgroundColor: COLORS.green },
  genInvTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
});
