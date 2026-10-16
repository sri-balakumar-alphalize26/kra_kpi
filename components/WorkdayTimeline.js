// The Workday Map: the day as a to-scale bar, then the same day as cards top
// to bottom, with a line between each pair that says what changed.
//
// Replaced the old wrapping row of same-size chips joined by "→". That had no
// legend, used one colour for different things, drew a 2-minute break as big
// as a 3-hour task and zigzagged on a phone — so it was hard to read.
//
// All the working-out lives in utils/workdayTimeline.js (tested). This file only
// draws it. On a phone there is no hover, so each link shows its short text and
// a tap opens the long one; a tap on the bar names the piece under the finger.
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../theme';
import { buildWorkdayTimeline, CATEGORY } from '../utils/workdayTimeline';

const TONE = {
  live:  { bg: '#DBEAFE', fg: '#1D4ED8' },
  good:  { bg: '#DCFCE7', fg: '#15803D' },
  info:  { bg: '#CCFBF1', fg: '#0F766E' },
  warn:  { bg: '#FEF3C7', fg: '#B45309' },
  alert: { bg: '#FFEDD5', fg: '#C2410C' },
  muted: { bg: '#F1F5F9', fg: '#475569' },
};

function Pill({ label, tone }) {
  if (!label) return null;
  const t = TONE[tone] || TONE.muted;
  return (
    <View style={[st.pill, { backgroundColor: t.bg }]}>
      <Text style={[st.pillTxt, { color: t.fg }]}>{tone === 'live' ? '● ' : ''}{label}</Text>
    </View>
  );
}

function Card({ c }) {
  const [open, setOpen] = useState(false);
  const color = CATEGORY[c.cat].color;
  const extra = [c.ref, c.visitLabel].filter(Boolean).join(' · ');
  return (
    <View style={st.row}>
      <View style={st.rail}>
        <Text style={st.railTime}>{c.startLabel}</Text>
        <View style={[st.dot, { backgroundColor: color }, c.running && st.dotLive]} />
        <View style={st.railLine} />
      </View>
      <TouchableOpacity
        style={[st.card, { borderLeftColor: color }]}
        activeOpacity={c.note ? 0.8 : 1}
        onPress={() => c.note && setOpen((o) => !o)}
      >
        <View style={st.cardTop}>
          <Text style={st.cardTitle} numberOfLines={2}>{c.title}</Text>
          <Pill label={c.outcomeLabel} tone={c.outcomeTone} />
        </View>
        <Text style={st.cardTime}>
          {c.startLabel} → {c.running ? 'now' : c.endLabel}
          <Text style={st.cardDur}>  ·  {c.durationLabel}</Text>
        </Text>
        {extra ? <Text style={st.cardMeta} numberOfLines={1}>{extra}</Text> : null}
        {c.with ? <Text style={st.cardMeta} numberOfLines={1}>with {c.with}</Text> : null}
        {c.note ? (
          <Text style={st.cardNote} numberOfLines={open ? undefined : 2}>“{c.note}”</Text>
        ) : null}
      </TouchableOpacity>
    </View>
  );
}

function Link({ l }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={st.row}>
      <View style={st.rail}>
        <View style={[st.railLine, l.idleSec ? st.railLineIdle : null]} />
      </View>
      <TouchableOpacity style={st.link} activeOpacity={0.7} onPress={() => setOpen((o) => !o)}>
        <Text style={[st.linkTxt, l.idleSec ? st.linkIdle : null]} numberOfLines={open ? undefined : 1}>
          ↓ {open ? l.long : l.short}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * timeline — the server's nodes (summary.timeline).
 * now      — epoch ms; a running piece ends here. Pass a ticking value to keep it live.
 */
export default function WorkdayTimeline({ timeline, now = Date.now() }) {
  const t = useMemo(() => buildWorkdayTimeline(timeline, now), [timeline, now]);
  const [tip, setTip] = useState('');

  if (t.empty) {
    return <Text style={st.empty}>No activity recorded yet today.</Text>;
  }
  return (
    <View>
      {/* The whole day to scale. Width is time, so a long task looks long. */}
      <View style={st.bar}>
        {t.strip.map((seg, i) => (
          <TouchableOpacity
            key={i}
            activeOpacity={0.6}
            onPress={() => setTip(seg.label)}
            style={[st.seg, {
              left: `${seg.leftPct}%`, width: `${seg.widthPct}%`, backgroundColor: seg.color,
            }, seg.cat === 'idle' && st.segIdle]}
          />
        ))}
      </View>
      <View style={st.ticks}>
        {t.ticks.map((k) => (
          <Text key={k.label + k.pct} style={[st.tick, { left: `${k.pct}%` }]}>{k.label}</Text>
        ))}
      </View>
      <Text style={tip ? st.tip : st.tipHint} numberOfLines={2}>
        {tip || 'Tap the bar to see what each part was.'}
      </Text>

      <View style={st.legend}>
        {t.legend.map((g) => (
          <View key={g.cat} style={st.legendItem}>
            <View style={[st.legendSwatch, { backgroundColor: g.color }, g.cat === 'idle' && st.segIdle]} />
            <Text style={st.legendTxt}>{g.label}</Text>
          </View>
        ))}
      </View>

      <Text style={st.edge}>🌅  Started {t.startLabel}</Text>
      {t.items.map((it) => (it.type === 'link'
        ? <Link key={it.key} l={it} />
        : <Card key={it.key} c={it} />))}
      <Text style={[st.edge, t.live && st.edgeLive]}>
        {t.live ? '●  Still working' : (t.endLabel ? `🌙  Ended ${t.endLabel}` : '⏳  Not ended yet')}
      </Text>
    </View>
  );
}

const RAIL = 46;

const st = StyleSheet.create({
  empty: { fontSize: 13, color: COLORS.muted, paddingVertical: 8 },
  bar: {
    height: 18, borderRadius: 9, backgroundColor: '#EEF2F7', overflow: 'hidden', position: 'relative',
  },
  seg: { position: 'absolute', top: 0, bottom: 0 },
  // Idle has no colour of its own to speak of — it is the absence of anything.
  segIdle: { borderWidth: 1, borderColor: '#94A3B8', borderStyle: 'dashed' },
  ticks: { height: 14, position: 'relative', marginTop: 2 },
  tick: { position: 'absolute', fontSize: 10, color: COLORS.muted, marginLeft: -6 },
  tip: { fontSize: 12, color: COLORS.ink, fontWeight: '700', marginTop: 4 },
  tipHint: { fontSize: 11, color: COLORS.faint, marginTop: 4 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8, marginBottom: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 10, height: 10, borderRadius: 3 },
  legendTxt: { fontSize: 11, color: COLORS.muted, fontWeight: '700' },

  edge: { fontSize: 12, fontWeight: '800', color: COLORS.navy, marginVertical: 6, marginLeft: 4 },
  edgeLive: { color: '#1D4ED8' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  rail: { width: RAIL, alignItems: 'center' },
  railTime: { fontSize: 10.5, fontWeight: '800', color: COLORS.muted, marginTop: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 3 },
  dotLive: { borderWidth: 2, borderColor: '#BFDBFE' },
  railLine: { flex: 1, width: 2, backgroundColor: '#E2E8F0', minHeight: 6 },
  railLineIdle: { backgroundColor: '#CBD5E1' },
  card: {
    flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: COLORS.line,
    borderLeftWidth: 4, paddingHorizontal: 10, paddingVertical: 8, marginVertical: 3,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { flex: 1, fontSize: 13.5, fontWeight: '800', color: COLORS.ink },
  cardTime: { fontSize: 12, fontWeight: '700', color: COLORS.ink, marginTop: 3 },
  cardDur: { color: COLORS.muted, fontWeight: '800' },
  cardMeta: { fontSize: 11, color: COLORS.muted, marginTop: 2 },
  cardNote: { fontSize: 11.5, color: '#374151', fontStyle: 'italic', marginTop: 3 },
  pill: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  pillTxt: { fontSize: 10.5, fontWeight: '800' },
  link: { flex: 1, paddingVertical: 4, paddingRight: 4 },
  linkTxt: { fontSize: 11.5, color: '#475569', fontWeight: '600' },
  linkIdle: { color: '#64748B', fontStyle: 'italic' },
});
