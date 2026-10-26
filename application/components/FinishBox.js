// After the client's check: 👍 the client said it's finished → 🏁 Full Complete
// (what is still missing is listed) → the bill; 🧾 Bill now when no price
// matched (admins). The web's FinishBox, shared by the board card and KPI
// Details. Renders nothing for a task that is not that far (utils/taskFinish).
//
// Presentational: the caller makes the server call (onFullComplete / onBillNow)
// and says how it went, the way every other card button reports. `busy` is the
// key in flight ('fc' | 'bn'). `showButtons` false keeps the status but hides the
// buttons — the board's read-only mode (workday not started) withholds every
// button that changes a task.
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../theme';
import { finishState } from '../utils/taskFinish';

export default function FinishBox({ task, isAdmin = false, canFinish = false, busy = '', onFullComplete, onBillNow, showButtons = true, compact = false }) {
  const f = finishState(task, { isAdmin });
  if (!f) return null;

  if (f.kind === 'pending') {
    return (
      <View style={[st.box, st.boxGreen, compact && st.boxCompact]}>
        <Text style={[st.head, { color: '#166534' }]}>👍 The client said it's finished: needs 🏁 Full Complete</Text>
        {f.missing.map((m) => <Text key={m} style={st.item}>• {m}</Text>)}
        {canFinish && showButtons && (
          <TouchableOpacity style={[st.btn, { backgroundColor: COLORS.green }, !!busy && st.off]}
            onPress={onFullComplete} disabled={!!busy} activeOpacity={0.85}>
            {busy === 'fc' ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.btnTxt}>🏁 Full Complete</Text>}
          </TouchableOpacity>
        )}
      </View>
    );
  }

  if (f.kind === 'billed') {
    const tone = f.status === 'Paid' ? st.tagPaid : st.tagDue;
    return (
      <View style={[st.box, compact && st.boxCompact]}>
        <View style={st.billRow}>
          <Text style={[st.head, { flex: 1 }]} numberOfLines={2}>🧾 {f.bill.name} · {f.bill.money}</Text>
          <View style={[st.tag, tone]}><Text style={[st.tagTxt, tone]}>{f.status}</Text></View>
        </View>
      </View>
    );
  }

  // Fully complete with no bill — admins only (finishState).
  return (
    <View style={[st.box, st.boxAmber, compact && st.boxCompact]}>
      <Text style={[st.head, { color: '#92400E' }]}>🏁 Fully complete: no bill yet</Text>
      <Text style={st.hint}>
        {f.billOff
          ? 'Invoices are off for this client (Settings → Billing). Make one by hand:'
          : 'Usually no price matches this client and work type. Add it in Settings → Configuration → Billing, then:'}
      </Text>
      {showButtons && (
        <TouchableOpacity style={[st.btn, { backgroundColor: COLORS.primary }, !!busy && st.off]}
          onPress={onBillNow} disabled={!!busy} activeOpacity={0.85}>
          {busy === 'bn' ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.btnTxt}>🧾 Bill now</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  box: { borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, marginTop: 8 },
  boxCompact: { padding: 8 },
  boxGreen: { borderColor: '#86EFAC', backgroundColor: '#F0FDF4' },
  boxAmber: { borderColor: '#FCD34D', backgroundColor: '#FFFBEB' },
  head: { fontSize: 12.5, fontWeight: '900', color: COLORS.navy, lineHeight: 17 },
  item: { fontSize: 12, color: COLORS.ink, lineHeight: 17, marginTop: 3 },
  hint: { fontSize: 11.5, color: COLORS.muted, lineHeight: 16, marginTop: 3 },
  btn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 34, minWidth: 120, paddingHorizontal: 14, borderRadius: 9, marginTop: 8 },
  btnTxt: { color: '#fff', fontWeight: '900', fontSize: 13 },
  off: { opacity: 0.55 },
  billRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tag: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  tagTxt: { fontSize: 10.5, fontWeight: '900' },
  tagPaid: { backgroundColor: COLORS.greenBg, color: COLORS.green },
  tagDue: { backgroundColor: COLORS.amberBg, color: COLORS.amber },
});
