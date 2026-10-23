// Render a WhatsApp group message template the way the server will render it.
//
// Kept out of the screen so it can be tested without mounting anything, the same
// way workdayNote.js and workdayState.js are.
//
// This MUST agree with KpiWaGroupEvent.render() in
// odoo_modules/kra_kpi_module/models/kpi_wa_group_event.py. The preview exists to
// answer one question — "what will the group actually see?" — so a preview that
// diverges from the server is worse than no preview at all.

/**
 * Substitute {tokens} and drop lines that ended up saying nothing.
 *
 * Plain string replacement, never a format() equivalent: these templates are
 * hand-written and contain emoji, quotes and the occasional stray brace.
 * Unknown {tokens} are left as literal text — visible, harmless, self-explaining.
 *
 * A line whose tokens ALL resolved to empty is dropped, decoration included, so
 * an empty note does not render as a bare 📝 "" and a day with no tasks does not
 * report "0 task(s) touched". The test is on the TOKENS, not on how the finished
 * line looks: an emoji is enough to defeat a text-based emptiness check. Lines
 * with no tokens at all are always kept, so headers survive.
 *
 * @param {string} template
 * @param {Object<string,string>} values
 * @returns {string}
 */
export function renderWaTemplate(template, values) {
  const vals = values || {};
  const out = [];
  for (const line of String(template == null ? '' : template).split('\n')) {
    let filled = line;
    const resolved = [];
    for (const key of Object.keys(vals)) {
      const token = `{${key}}`;
      if (filled.includes(token)) {
        const val = vals[key] == null ? '' : String(vals[key]);
        resolved.push(val.trim());
        filled = filled.split(token).join(val);
      }
    }
    if (resolved.length && !resolved.some(Boolean)) continue;
    out.push(filled);
  }
  // Collapse the runs of blank lines that dropping can leave behind.
  const text = [];
  let prevBlank = false;
  for (const line of out) {
    const blank = !line.trim();
    if (blank && prevBlank) continue;
    text.push(line);
    prevBlank = blank;
  }
  return text.join('\n').trim();
}

/**
 * Split rendered text into runs so WhatsApp's *bold* markers can be shown as
 * bold rather than as literal asterisks.
 *
 * Returns [{ text, bold }]. The screen maps these to <Text> nodes; React Native
 * has no markup()/dangerouslySetInnerHTML equivalent, so segmentation happens
 * here and stays testable.
 *
 * Only *paired* markers on the same line count. An unmatched '*' is ordinary
 * text — people type "5 * 3" and multiplication should not turn the rest of the
 * message bold.
 */
export function splitBold(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), bold: false });
  return out.filter((p) => p.text !== '');
}
