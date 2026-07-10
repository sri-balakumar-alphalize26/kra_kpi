// Recursive KRA node — mirrors the Odoo kra_node.js. A KRA row is an accordion
// that, when expanded, shows its child KRAs (deeper indent) and its KPI leaf rows.
// KRA rows get edit (pencil) + delete (trash); KPI rows get edit + delete.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';

const STEP = 16;   // indent per depth level

// Count all KPIs at/under a node — shown as a badge on collapsed folders.
function countKpis(node) {
  let n = (node.kpi_ids || []).length;
  for (const c of node.child_ids || []) n += countKpis(c);
  return n;
}

function KpiRow({ kpi, depth, onEditKpi, onDeleteKpi }) {
  return (
    <View style={[s.kpiRow, { paddingLeft: PADX + depth * STEP + 26 }]}>
      <MaterialCommunityIcons name="circle-medium" size={20} color={COLORS.link} />
      <Text style={s.kpiName} numberOfLines={1}>{kpi.name}</Text>
      {kpi.has_user_manual ? (
        <View style={s.manualBadge}>
          <Ionicons name="book-outline" size={12} color={COLORS.link} />
          <Text style={s.manualTxt}>{kpi.manual_count}</Text>
        </View>
      ) : null}
      {onEditKpi ? (
        <TouchableOpacity onPress={() => onEditKpi(kpi)} hitSlop={HIT} style={s.actBtn}>
          <Ionicons name="pencil" size={15} color={COLORS.muted} />
        </TouchableOpacity>
      ) : null}
      {onDeleteKpi ? (
        <TouchableOpacity onPress={() => onDeleteKpi(kpi)} hitSlop={HIT} style={s.actBtn}>
          <Ionicons name="trash-outline" size={15} color={COLORS.red} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function KraNode({ node, depth = 0, expanded, onToggle, onEditKra, onDeleteKra, onEditKpi, onDeleteKpi }) {
  const isOpen = expanded.has(node.id);
  const children = node.child_ids || [];
  const kpis = node.kpi_ids || [];
  const kpiTotal = countKpis(node);
  const hasContent = children.length > 0 || kpis.length > 0;

  return (
    <View>
      <TouchableOpacity
        style={[s.row, { paddingLeft: PADX + depth * STEP }]}
        onPress={() => onToggle(node.id)}
        activeOpacity={0.7}
      >
        <Ionicons
          name={isOpen ? 'chevron-down' : 'chevron-forward'}
          size={18}
          color={hasContent ? COLORS.navy : 'transparent'}
        />
        <Ionicons
          name={isOpen ? 'folder-open' : 'folder'}
          size={18}
          color={depth === 0 ? '#E8A33D' : '#C89B4A'}
          style={{ marginLeft: 4 }}
        />
        <Text style={[s.name, depth === 0 && s.nameRoot]} numberOfLines={1}>{node.name}</Text>
        {kpiTotal > 0 ? (
          <View style={s.countBadge}><Text style={s.countTxt}>{kpiTotal}</Text></View>
        ) : null}
        {onEditKra ? (
          <TouchableOpacity onPress={() => onEditKra(node)} hitSlop={HIT} style={s.actBtn}>
            <Ionicons name="pencil" size={16} color={COLORS.muted} />
          </TouchableOpacity>
        ) : null}
        {onDeleteKra ? (
          <TouchableOpacity onPress={() => onDeleteKra(node)} hitSlop={HIT} style={s.actBtn}>
            <Ionicons name="trash-outline" size={16} color={COLORS.red} />
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>

      {isOpen && (
        <View>
          {children.map((c) => (
            <KraNode
              key={c.id} node={c} depth={depth + 1} expanded={expanded} onToggle={onToggle}
              onEditKra={onEditKra} onDeleteKra={onDeleteKra} onEditKpi={onEditKpi} onDeleteKpi={onDeleteKpi}
            />
          ))}
          {kpis.map((k) => (
            <KpiRow key={k.id} kpi={k} depth={depth} onEditKpi={onEditKpi} onDeleteKpi={onDeleteKpi} />
          ))}
        </View>
      )}
    </View>
  );
}

const PADX = 14;
const HIT = { top: 8, bottom: 8, left: 8, right: 8 };

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', paddingRight: 12,
    minHeight: 46, borderBottomWidth: 1, borderBottomColor: COLORS.line,
  },
  name: { flex: 1, marginLeft: 8, fontSize: 14.5, fontWeight: '700', color: COLORS.ink },
  nameRoot: { fontSize: 15.5, fontWeight: '900', color: COLORS.navy },
  actBtn: { paddingHorizontal: 5, paddingVertical: 4 },

  countBadge: {
    minWidth: 22, height: 20, borderRadius: 10, paddingHorizontal: 6, marginRight: 2,
    backgroundColor: '#EAF1FE', alignItems: 'center', justifyContent: 'center',
  },
  countTxt: { fontSize: 11.5, fontWeight: '800', color: COLORS.primary },

  kpiRow: {
    flexDirection: 'row', alignItems: 'center', paddingRight: 12, gap: 6,
    minHeight: 42, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: '#FBFCFE',
  },
  kpiName: { flex: 1, fontSize: 13.5, color: COLORS.ink },

  manualBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#EEF3FF', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2,
  },
  manualTxt: { fontSize: 11, fontWeight: '800', color: COLORS.link },
});
