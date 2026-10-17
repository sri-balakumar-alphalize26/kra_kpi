// The Workday Map, worked out once: the to-scale day bar, the cards in time
// order, and what changed between one card and the next.
//
// Input is the `timeline` array from _daily_summary_payload (the End Workday
// summary and /kpi_owner/employee_day). Pure: no React, no clock of its own.
//
// Copy of the Odoo module's kpi_workday_timeline/workday_timeline.js (minus its
// HTML renderer; components/work/WorkdayTimeline.jsx draws it here) and of
// utils/workdayTimeline.js in the mobile app, which is unit-tested. Change all
// three together, or the clients will tell different stories.

// Gaps shorter than this are rounding between two clicks, not idle time.
export const IDLE_MIN_MINUTES = 5;

// One colour per KIND of time. Outcome (completed / paused / moved…) is a
// labelled pill on the card, never a colour, so no colour means two things.
export const CATEGORY = {
  work:     { label: 'Working',  color: '#2563EB' },
  break:    { label: 'Break',    color: '#F59E0B' },
  lunch:    { label: 'Lunch',    color: '#EC4899' },
  meeting:  { label: 'Meeting',  color: '#8B5CF6' },
  no_tasks: { label: 'No tasks', color: '#0891B2' },
  urgent:   { label: 'Urgent',   color: '#EF4444' },
  away:     { label: 'Away',     color: '#64748B' },
  idle:     { label: 'Idle',     color: '#CBD5E1' },
};

const BREAK_CATEGORY = {
  break: 'break', lunch: 'lunch', meeting: 'meeting', no_tasks: 'no_tasks',
  urgent: 'urgent', away: 'away', leave: 'away', other: 'away',
};

const BREAK_TITLE = {
  break: 'Break', lunch: 'Lunch', meeting: 'Meeting', no_tasks: 'No tasks',
  urgent: 'Urgent', away: 'Away', leave: 'Leave', other: 'Other',
};

export const OUTCOME = {
  active:    { label: 'Working now', tone: 'live' },
  completed: { label: 'Completed',   tone: 'good' },
  submitted: { label: 'Submitted',   tone: 'info' },
  paused:    { label: 'Paused',      tone: 'warn' },
  moved:     { label: 'Reassigned',  tone: 'alert' },
  worked:    { label: 'Switched',    tone: 'muted' },
};

// 'YYYY-MM-DD HH:MM:SS' in UTC → epoch ms. The server's own format; Safari and
// Hermes will not parse it with Date(), so it is taken apart by hand.
export function parseTs(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(ts || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return '<1m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const ordinal = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};

// The server formats `time` in the DEVELOPER's timezone and sends instants in
// UTC. One pair of the two gives their offset, so every time this module prints
// — bar ticks, idle gaps — is in the developer's clock too, matching the cards.
function tzOffsetMinutes(nodes) {
  for (const n of nodes) {
    const ts = parseTs(n.ts || n.start_ts);
    const hm = /^(\d{1,2}):(\d{2})/.exec(n.time || '');
    if (ts == null || !hm) continue;
    const d = new Date(ts);
    const local = +hm[1] * 60 + +hm[2];
    const utc = d.getUTCHours() * 60 + d.getUTCMinutes();
    let off = local - utc;
    if (off > 840) off -= 1440;
    if (off < -720) off += 1440;
    return off;
  }
  return -new Date().getTimezoneOffset();
}

function hm(ms, offMin) {
  if (ms == null) return '';
  const d = new Date(ms + offMin * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function cardFromNode(n, i, nowMs) {
  const startMs = parseTs(n.start_ts);
  const running = !!n.running;
  const endMs = running ? nowMs : parseTs(n.end_ts);
  const seconds = n.seconds != null ? n.seconds
    : (startMs != null && endMs != null ? (endMs - startMs) / 1000 : 0);
  if (n.kind === 'task') {
    const outcome = OUTCOME[n.outcome] || OUTCOME.worked;
    return {
      key: `t${i}`, kind: 'task', cat: 'work', running,
      title: n.name || n.label || 'Task', ref: n.ref || '', taskId: n.task_id || null,
      visit: n.visit || 1, visitLabel: n.visit > 1 ? `${ordinal(n.visit)} time today` : '',
      outcome: n.outcome || 'worked', outcomeLabel: outcome.label, outcomeTone: outcome.tone,
      note: (n.reason || '').trim(), startMs, endMs, seconds,
    };
  }
  const type = n.break_type || 'other';
  return {
    key: `b${i}`, kind: 'break', cat: BREAK_CATEGORY[type] || 'away', running,
    title: BREAK_TITLE[type] || 'Other', ref: '', taskId: null, visit: 1, visitLabel: '',
    outcome: '', outcomeLabel: running ? 'Now' : '', outcomeTone: running ? 'live' : '',
    note: (n.reason || '').trim(), with: (n.with || '').trim(), from: (n.from || '').trim(),
    startMs, endMs, seconds,
  };
}

// What happened between two cards, short (on the line) and long (hover / tap).
function transition(a, b, after, idleSec, offMin) {
  const at = hm(b.startMs, offMin);
  let verb;
  if (a.kind === 'task' && b.kind === 'task') {
    if (a.taskId && a.taskId === b.taskId) verb = `Picked ${b.title} up again`;
    else if (a.outcome === 'completed' || a.outcome === 'submitted') verb = `Finished ${a.title}, started ${b.title}`;
    else if (a.outcome === 'moved') verb = `${a.title} was reassigned; started ${b.title}`;
    else verb = `Moved from ${a.title} to ${b.title}`;
  } else if (a.kind === 'task') {
    verb = a.outcome === 'paused' ? `Paused ${a.title} for ${b.title.toLowerCase()}`
      : `${a.outcome === 'completed' ? `Finished ${a.title}, then` : 'Went on'} ${b.title.toLowerCase()}`;
  } else if (b.kind === 'task') {
    verb = b.taskId && b.taskId === a.resumeTaskId
      ? `Back from ${a.title.toLowerCase()} to ${b.title}`
      : `After ${a.title.toLowerCase()}, started ${b.title}`;
  } else {
    verb = `${a.title} → ${b.title}`;
  }
  const idle = idleSec >= IDLE_MIN_MINUTES * 60 ? fmtDuration(idleSec) : '';
  const short = idle ? `Idle ${idle} · ${verb}` : verb;
  const parts = [`${at} · ${verb}`];
  if (idle) parts.push(`nothing running for ${idle} before that`);
  if (b.note) parts.push(`“${b.note}”`);
  if (after) parts.push(`next: ${after.title}${after.running ? ' (now)' : ` at ${hm(after.startMs, offMin)}`}`);
  else if (b.running) parts.push('still going');
  return { short, long: parts.join(' · '), idleSec: idle ? idleSec : 0, at };
}

/**
 * timeline — the server's nodes. now — epoch ms ("still going" ends here).
 * Returns { empty, startLabel, endLabel, live, items, strip, ticks, legend }.
 *   items  — [{type:'card', ...card} | {type:'link', short, long, idleSec}] in order
 *   strip  — [{cat, color, leftPct, widthPct, label}] to draw the day to scale
 *   ticks  — [{pct, label}] hour marks along the bar
 *   legend — the categories that actually appear, in CATEGORY order
 */
export function buildWorkdayTimeline(timeline, now = Date.now()) {
  const nodes = Array.isArray(timeline) ? timeline : [];
  const offMin = tzOffsetMinutes(nodes);
  const startNode = nodes.find((n) => n.kind === 'start');
  const endNode = nodes.find((n) => n.kind === 'end');
  const cards = nodes
    .map((n, i) => (n.kind === 'task' || n.kind === 'break' ? cardFromNode(n, i, now) : null))
    .filter((c) => c && c.startMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  const ended = !!(endNode && parseTs(endNode.ts));
  const live = !ended && cards.some((c) => c.running);
  const dayStart = parseTs(startNode && startNode.ts) ?? (cards[0] ? cards[0].startMs : null);
  const lastEnd = cards.reduce((m, c) => Math.max(m, c.endMs ?? c.startMs), dayStart ?? 0);
  const dayEnd = ended ? parseTs(endNode.ts) : Math.max(lastEnd, live ? now : lastEnd);

  const base = {
    startLabel: dayStart != null ? hm(dayStart, offMin) : '',
    endLabel: ended ? hm(dayEnd, offMin) : '',
    live,
  };
  if (!cards.length || dayStart == null || !(dayEnd > dayStart)) {
    return { ...base, empty: true, items: [], strip: [], ticks: [], legend: [] };
  }

  // A break started from a task remembers which one, so "back to it" can be said.
  for (let i = 1; i < cards.length; i += 1) {
    const prev = cards[i - 1];
    if (cards[i].kind === 'break' && prev.kind === 'task') cards[i].resumeTaskId = prev.taskId;
  }

  const span = dayEnd - dayStart;
  const pct = (ms) => Math.min(100, Math.max(0, ((ms - dayStart) / span) * 100));
  const strip = [];
  const items = [];
  let coveredTo = dayStart;
  cards.forEach((c, i) => {
    const end = c.endMs ?? c.startMs;
    const gapSec = (c.startMs - coveredTo) / 1000;
    if (gapSec >= IDLE_MIN_MINUTES * 60) {
      strip.push({ cat: 'idle', color: CATEGORY.idle.color, leftPct: pct(coveredTo),
        widthPct: pct(c.startMs) - pct(coveredTo),
        label: `Idle ${fmtDuration(gapSec)} (${hm(coveredTo, offMin)}–${hm(c.startMs, offMin)})` });
    }
    strip.push({ cat: c.cat, color: CATEGORY[c.cat].color, leftPct: pct(c.startMs),
      widthPct: Math.max(0.6, pct(end) - pct(c.startMs)),
      label: `${c.title} · ${hm(c.startMs, offMin)}–${c.running ? 'now' : hm(end, offMin)} · ${fmtDuration(c.seconds)}` });
    if (i > 0) {
      items.push({ type: 'link', key: `l${i}`,
        ...transition(cards[i - 1], c, cards[i + 1], Math.max(0, gapSec), offMin) });
    }
    items.push({ type: 'card', ...c,
      startLabel: hm(c.startMs, offMin), endLabel: c.running ? '' : hm(end, offMin),
      durationLabel: fmtDuration(c.seconds) });
    coveredTo = Math.max(coveredTo, end);
  });

  // Hour marks along the bar; every 2h on a long day so they don't crowd.
  const ticks = [];
  const hourMs = 3600000;
  const step = span > 10 * hourMs ? 2 : 1;
  const localStart = dayStart + offMin * 60000;
  let t = Math.ceil(localStart / hourMs) * hourMs;
  for (; t - offMin * 60000 <= dayEnd; t += hourMs) {
    const hour = new Date(t).getUTCHours();
    if (hour % step === 0) ticks.push({ pct: pct(t - offMin * 60000), label: String(hour).padStart(2, '0') });
  }

  const present = new Set(strip.map((s) => s.cat));
  const legend = Object.keys(CATEGORY).filter((k) => present.has(k))
    .map((k) => ({ cat: k, ...CATEGORY[k] }));

  return { ...base, empty: false, items, strip, ticks, legend };
}
