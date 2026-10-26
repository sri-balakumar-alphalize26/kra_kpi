// ↩ Every time the client sent the work back, newest first: what is still wrong
// and the photos / videos / voice notes that show it (task.sendbacks, server
// models/kpi_client_sendback.py). The web's SendBackHistory, for the phone:
//
//   compact (board card)  one closed line — "↩ Client sent it back 2× · 📷 2 photos"
//                         — tap it for the rounds. Closed by default so a card
//                         does not grow by a wall of proof, and so the photos
//                         are only fetched once someone asks to see them.
//   full (KPI Details)    the rounds themselves; the screen gives the heading.
//
// Renders nothing for a task the client never sent back.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import ProofMedia from './ProofMedia';
import { sendBackRounds, sendBackLine } from '../utils/taskFinish';
import { parseServerTs } from '../services/kpiActions';

const RED = '#B91C1C';

// The server's UTC stamp as the phone's "22 Oct, 10:15".
function when(utc) {
  const ms = parseServerTs(utc);
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Round({ sb, small, onError }) {
  const head = [`Round ${sb.round}`, sb.by, when(sb.at)].filter(Boolean).join(' · ');
  return (
    <View style={st.round}>
      <Text style={st.roundHead}>{head}</Text>
      {!!(sb.reason || '').trim() && <Text style={st.reason}>{sb.reason}</Text>}
      {(sb.files || []).length > 0 && (
        <View style={st.files}>
          {sb.files.map((f) => <ProofMedia key={`sbf-${f.id}`} f={f} small={small} onError={onError} />)}
        </View>
      )}
    </View>
  );
}

export default function SendBackHistory({ task, compact = false, onError }) {
  const [open, setOpen] = useState(false);
  const rounds = sendBackRounds(task);
  const line = sendBackLine(task);
  if (!line) return null;
  if (!compact) {
    return (
      <View>
        {rounds.map((sb) => <Round key={`sb-${sb.id}`} sb={sb} onError={onError} />)}
      </View>
    );
  }
  return (
    <View style={st.compact}>
      <TouchableOpacity style={st.line} activeOpacity={0.7} disabled={!rounds.length}
        onPress={() => setOpen((v) => !v)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={st.lineTxt} numberOfLines={2}>{line}</Text>
        {rounds.length > 0 && <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={RED} />}
      </TouchableOpacity>
      {open && rounds.map((sb) => <Round key={`sb-${sb.id}`} sb={sb} small onError={onError} />)}
    </View>
  );
}

const st = StyleSheet.create({
  compact: { marginTop: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FEF2F2', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7 },
  lineTxt: { flex: 1, fontSize: 12.5, fontWeight: '800', color: RED },
  round: { borderLeftWidth: 3, borderLeftColor: '#FCA5A5', backgroundColor: '#FFF7F7', borderRadius: 8, padding: 9, marginTop: 7 },
  roundHead: { fontSize: 11, fontWeight: '800', color: COLORS.muted },
  reason: { fontSize: 13, color: COLORS.ink, lineHeight: 18, marginTop: 3 },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
