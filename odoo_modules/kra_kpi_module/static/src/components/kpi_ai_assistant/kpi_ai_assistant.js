/** @odoo-module **/
import { Component, xml, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";

/**
 * 369 AI Assistant — the Odoo backend twin of the web Owner Dashboard drawer
 * (web/components/admin/AiAssistant.jsx). Same backend, same history:
 *   /kra_kpi/ai_assistant/ask        answer a question from live data (rules; AI only when a key is set)
 *   /kra_kpi/ai_assistant/export     the same answer with every table row, for PDF / Word
 *   /kra_kpi/ai_assistant/chats|chat|chat_delete   saved chats (kpi.ai.chat)
 *   /kra_kpi/ai_assistant/find_tasks live "Find a task"
 *   /kra_kpi/get_users               the People list
 * An "Ask AI" pill opens a drawer on the right (Ctrl/⌘+J toggles, Esc closes).
 * Questions mean "today" unless they name a period.
 * docked: on the Dashboard (kpi_dashboard.js) it sits in the page's left column,
 * always open, with no pill and no close; Ctrl/⌘+J puts the cursor in the box. Same
 * chats as the drawer. onAnswer(res, question) hears every answer (to highlight a card).
 * Keep the FAQ lists in step with web/components/admin/aiFaq.js.
 */

const FAQ = [
    { key: "today", label: "Today", items: ["Summary of today", "Who started their workday?", "Who hasn't started their workday?", "Who is running a task?", "Any alerts?", "Completed tasks today"] },
    { key: "tasks", label: "Tasks", items: ["Who has paused tasks?", "Urgent tasks not started", "Important tasks not started", "What's waiting for my approval?", "Overdue tasks", "Tasks over estimate", "How many tasks are not started?", "Unassigned tasks"] },
    { key: "people", label: "People", people: true },
    { key: "performance", label: "Performance", items: ["Top performers this week", "Top performers this month", "Who has the most paused tasks?", "Completed tasks this week", "Completed tasks last month", "Summary of this month"] },
    { key: "find", label: "Find a task", find: true },
];
const QUICK = [["Summary", "Summary of today"], ["Paused", "Who has paused tasks?"], ["Approvals", "What's waiting for my approval?"],
    ["Overdue", "Overdue tasks"], ["Workday", "Who started their workday?"], ["Alerts", "Any alerts?"], ["Top this week", "Top performers this week"]];
const personQuestions = (n) => [`How is ${n} doing?`, `${n}'s paused tasks`, `${n}'s tasks not started`, `${n}'s completed tasks this week`, `Is ${n} online?`];
const ALL_QUESTIONS = FAQ.flatMap((s) => s.items || []);
const SOURCE = { rules: "Data answer", "ai-gemini": "Gemini", "ai-groq": "Groq", "ai-claude": "Claude" };
const STATE_LABEL = { in_progress: "Running", paused: "Paused", partially_completed: "Pending approval", completed: "Completed",
    awaiting_client: "Awaiting client sign-off", queue_waiting: "Queued", pre_approval_pending: "Waiting for client approval",
    pre_approval_approved: "Client approved, not started", pre_approval_partial: "Partly approved by client", hold: "On hold", rework: "Rework needed" };
const KEY = "kpi.assistant.odoo.chat";

function suggest(text, people, max = 5) {
    const words = String(text || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const out = ALL_QUESTIONS.filter((q) => words.every((w) => q.toLowerCase().includes(w)));
    for (const p of people) {
        if (out.length >= max) break;
        const parts = (p.name || "").toLowerCase().split(/\s+/);
        if (words.some((w) => parts.some((part) => part.startsWith(w)))) {
            for (const q of personQuestions(p.name)) if (out.length < max && !out.includes(q)) out.push(q);
        }
    }
    return out.slice(0, max);
}
const fmtDay = (d) => { if (!d) return ""; const x = new Date(`${d}T00:00:00`); return isNaN(x) ? d : x.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };
const fmtRange = (r) => (!r ? "" : r.start === r.end ? fmtDay(r.start) : `${fmtDay(r.start)} - ${fmtDay(r.end)}`);
const fmtWhen = (s) => {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
    if (isNaN(d)) return s;
    const t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === t.toDateString()) return `Today, ${time}`;
    if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + `, ${time}`;
};
const exportable = (res) => res && res.intent !== "smalltalk" && (res.blocks || []).length > 0;

/* ------------------------------------------------ PDF / Word (window.jspdf, window.JSZip from the bundle's CDN scripts) */
const pdfText = (s) => String(s ?? "").replace(/[·•]/g, "-").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/₹/g, "Rs ").replace(/[✓✔]/g, "").replace(/[^\x00-\xFF]/g, "?");
const cellText = (v) => (v === "" || v == null ? "-" : String(v));
const isWide = (sections) => sections.some((s) => (s.res.blocks || []).some((b) => b.type === "table" && (b.columns || []).length >= 7));
export const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${p(d.getDate())}${p(d.getMonth() + 1)}${p(d.getFullYear() % 100)}_${p(d.getHours())}${p(d.getMinutes())}`; };
export const slug = (s) => String(s || "answer").replace(/[\\/:*?"<>|]+/g, " ").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "answer";
const nowText = () => new Date().toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
export function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function buildPdf(sections, meta) {
    if (!window.jspdf?.jsPDF) throw new Error("The PDF library did not load. Refresh the page and try again.");
    const doc = new window.jspdf.jsPDF({ orientation: isWide(sections) ? "landscape" : "portrait", unit: "pt", format: "a4" });
    if (typeof doc.autoTable !== "function") throw new Error("The PDF table library did not load. Refresh the page and try again.");
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
    let y = M;
    const ensure = (h) => { if (y + h > H - M - 14) { doc.addPage(); y = M; } };
    const lines = (txt, size, style = "normal", color = 20, indent = 0) => {
        doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(color);
        for (const l of doc.splitTextToSize(pdfText(txt), W - 2 * M - indent)) { ensure(size + 4); doc.text(l, M + indent, y + size * 0.8); y += size + 4; }
    };
    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(30, 64, 175); doc.text("369 AI Assistant", M, y + 12); y += 22;
    lines(`${meta.subtitle}  -  generated ${nowText()}${meta.user ? ` by ${meta.user}` : ""}`, 9, "normal", 110);
    doc.setDrawColor(30, 64, 175); doc.setLineWidth(1.2); doc.line(M, y + 2, W - M, y + 2); y += 16;
    sections.forEach((s, idx) => {
        const r = s.res;
        if (s.question) lines(`Question: ${s.question}`, 10, "bold", 90);
        if (r.title) { y += 2; lines(r.title, 13, "bold", 20); }
        if (r.date_range) lines(`Period: ${fmtRange(r.date_range)}`, 9, "normal", 120);
        y += 4;
        for (const b of r.blocks || []) {
            if (b.type === "stats") {
                ensure(50);
                doc.autoTable({ startY: y, margin: { left: M, right: M, bottom: M + 14 }, theme: "grid",
                    head: [(b.items || []).map((i) => pdfText(i.label))], body: [(b.items || []).map((i) => pdfText(cellText(i.value)))],
                    styles: { fontSize: 8.5, cellPadding: 4, halign: "center" }, headStyles: { fillColor: [238, 242, 255], textColor: [55, 65, 81], fontStyle: "bold" },
                    bodyStyles: { fontStyle: "bold", fontSize: 11, textColor: 20 } });
                y = doc.lastAutoTable.finalY + 10;
            } else if (b.type === "table") {
                ensure(60);
                const cols = b.columns || [];
                doc.autoTable({ startY: y, margin: { left: M, right: M, top: M, bottom: M + 14 }, theme: "striped",
                    head: [cols.map((c) => pdfText(c.label))], body: (b.rows || []).map((row) => cols.map((c) => pdfText(cellText(row[c.key])))),
                    styles: { fontSize: 8.5, cellPadding: 3.5, overflow: "linebreak", valign: "top" }, headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
                    columnStyles: Object.fromEntries(cols.map((c, i) => [i, c.kind === "num" ? { halign: "right" } : c.kind === "task" ? { minCellWidth: 130 } : {}])) });
                y = doc.lastAutoTable.finalY + 8;
                if (b.more > 0) lines(`+${b.more} more rows not included.`, 8.5, "italic", 120);
            } else if (b.type === "list") {
                if (b.title) lines(b.title.toUpperCase(), 9, "bold", 100);
                for (const it of b.items || []) lines(`-  ${it}`, 10, "normal", 30, 6);
                y += 4;
            } else if (b.text) { lines(b.text, 10.5, "normal", 30); y += 4; }
        }
        if (idx < sections.length - 1) { y += 6; ensure(20); doc.setDrawColor(215); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 16; }
    });
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(150); doc.text(`369 AI Assistant  -  page ${i} of ${n}`, W - M, H - 18, { align: "right" }); }
    return doc.output("blob");
}

const esc = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wrun = (t, { b, i, sz, color } = {}) => `<w:r><w:rPr>${b ? "<w:b/>" : ""}${i ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const wpara = (runs, { after = 100, indent } = {}) => `<w:p><w:pPr><w:spacing w:after="${after}"/>${indent ? `<w:ind w:left="${indent}"/>` : ""}</w:pPr>${runs}</w:p>`;
const wcell = (text, { head, fill, bold, right } = {}) => `<w:tc><w:tcPr>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/>${right ? '<w:jc w:val="right"/>' : ""}</w:pPr>${wrun(text, { b: head || bold, sz: 18, color: head ? "FFFFFF" : undefined })}</w:p></w:tc>`;
const WBORDERS = "<w:tblBorders>" + ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="C9D2E3"/>`).join("") + "</w:tblBorders>";
const wtable = (head, rows, { rightCols = [], light, boldBody } = {}) =>
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${WBORDERS}</w:tblPr><w:tblGrid>${head.map(() => "<w:gridCol/>").join("")}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h) => wcell(h, { head: !light, fill: light ? "EEF2FF" : "1E40AF", bold: true })).join("")}</w:tr>` +
    rows.map((r, ri) => `<w:tr>${r.map((v, ci) => wcell(v, { fill: ri % 2 ? "F5F7FB" : undefined, right: rightCols.includes(ci), bold: boldBody })).join("")}</w:tr>`).join("") +
    "</w:tbl>" + wpara("", { after: 120 });

export async function buildDocx(sections, meta) {
    const JSZip = window.JSZip;
    if (typeof JSZip !== "function") throw new Error("The Word library did not load. Refresh the page and try again.");
    const body = [wpara(wrun("369 AI Assistant", { b: true, sz: 34, color: "1E40AF" }), { after: 40 }),
        wpara(wrun(`${meta.subtitle}  ·  generated ${nowText()}${meta.user ? ` by ${meta.user}` : ""}`, { sz: 18, color: "6B7280" }), { after: 240 })];
    sections.forEach((s, idx) => {
        const r = s.res;
        if (s.question) body.push(wpara(wrun("Question: ", { b: true, sz: 20, color: "6B7280" }) + wrun(s.question, { sz: 20, color: "374151" }), { after: 60 }));
        if (r.title) body.push(wpara(wrun(r.title, { b: true, sz: 26 }), { after: 60 }));
        if (r.date_range) body.push(wpara(wrun(`Period: ${fmtRange(r.date_range)}`, { sz: 18, color: "6B7280" }), { after: 120 }));
        for (const b of r.blocks || []) {
            if (b.type === "stats") body.push(wtable((b.items || []).map((i) => i.label), [(b.items || []).map((i) => cellText(i.value))], { light: true, boldBody: true }));
            else if (b.type === "table") {
                const cols = b.columns || [];
                body.push(wtable(cols.map((c) => c.label), (b.rows || []).map((row) => cols.map((c) => cellText(row[c.key]))), { rightCols: cols.map((c, i) => (c.kind === "num" ? i : -1)).filter((i) => i >= 0) }));
                if (b.more > 0) body.push(wpara(wrun(`+${b.more} more rows not included.`, { i: true, sz: 18, color: "6B7280" })));
            } else if (b.type === "list") {
                if (b.title) body.push(wpara(wrun(b.title.toUpperCase(), { b: true, sz: 18, color: "6B7280" }), { after: 40 }));
                for (const it of b.items || []) body.push(wpara(wrun(`•  ${it}`, { sz: 21 }), { after: 40, indent: 240 }));
            } else if (b.text) body.push(wpara(wrun(b.text, { sz: 21 }), { after: 140 }));
        }
        if (idx < sections.length - 1) body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="240"/></w:pPr></w:p>');
    });
    const sect = `<w:sectPr>${isWide(sections) ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>'}<w:pgMar w:top="900" w:right="800" w:bottom="900" w:left="800" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`;
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join("")}${sect}</w:body></w:document>`);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/* ------------------------------------------------------------------ component */
export class KpiAiAssistant extends Component {
    static props = {
        docked: { type: Boolean, optional: true },
        onAnswer: { type: Function, optional: true },
    };
    static template = xml/* xml */`
    <div t-attf-class="o_kpi_ai {{ props.docked ? 'docked' : '' }}">
        <button t-if="!state.open and !props.docked" type="button" class="o_kpi_ai_launcher" t-on-click="() => this.setOpen(true)" title="Ask AI (Ctrl+J)">
            <span class="o_kpi_ai_orb sm"><i class="fa fa-bar-chart"/></span> <span>Ask AI</span>
        </button>
        <div t-if="!props.docked" t-attf-class="o_kpi_ai_scrim {{ state.open ? 'open' : '' }}" t-on-click="() => this.setOpen(false)"/>
        <aside t-attf-class="o_kpi_ai_drawer {{ props.docked ? 'o_kpi_ai_panel' : '' }} {{ state.open ? 'open' : '' }}" t-att-style="state.top and !props.docked ? 'top:' + state.top + 'px' : ''">
            <header class="o_kpi_ai_head">
                <span class="o_kpi_ai_orb sm"><i class="fa fa-bar-chart"/></span>
                <div class="o_kpi_ai_headtxt">
                    <strong>369 AI Assistant</strong>
                    <span><i class="o_kpi_ai_live"/> Reading your dashboard · live data</span>
                </div>
                <button type="button" t-attf-class="o_kpi_ai_iconbtn {{ state.view === 'faq' ? 'on' : '' }}" title="Questions you can ask" t-on-click="() => this.setView(state.view === 'faq' ? 'chat' : 'faq')"><i class="fa fa-question-circle-o"/></button>
                <span t-if="botIdx.length and state.view === 'chat'" class="o_kpi_ai_dlwrap head">
                    <button type="button" t-attf-class="o_kpi_ai_iconbtn {{ state.dlOpen === 'all' ? 'on' : '' }}" title="Download whole chat (PDF / Word)" t-on-click="() => this.toggleDl('all')"><i class="fa fa-download"/></button>
                    <span t-if="state.dlOpen === 'all'" class="o_kpi_ai_dlmenu">
                        <small>Download whole chat</small>
                        <button type="button" t-att-disabled="state.dlBusy" t-on-click="() => this.downloadAll('pdf')"><i class="fa fa-file-pdf-o"/> <t t-esc="state.dlBusy === 'pdf' ? 'Preparing…' : 'PDF'"/></button>
                        <button type="button" t-att-disabled="state.dlBusy" t-on-click="() => this.downloadAll('docx')"><i class="fa fa-file-word-o"/> <t t-esc="state.dlBusy === 'docx' ? 'Preparing…' : 'Word (.docx)'"/></button>
                        <small t-if="state.dlErr" class="o_kpi_ai_err" t-esc="state.dlErr"/>
                    </span>
                </span>
                <button type="button" t-attf-class="o_kpi_ai_iconbtn {{ state.view === 'history' ? 'on' : '' }}" title="Chat history" t-on-click="showHistory"><i class="fa fa-history"/></button>
                <button type="button" class="o_kpi_ai_iconbtn" title="New chat" t-on-click="newChat"><i class="fa fa-plus"/></button>
                <button t-if="!props.docked" type="button" class="o_kpi_ai_iconbtn" title="Close (Esc)" t-on-click="() => this.setOpen(false)"><i class="fa fa-times"/></button>
            </header>

            <t t-if="state.view === 'history'">
                <div class="o_kpi_ai_body">
                    <div class="o_kpi_ai_histhead">
                        <button type="button" class="o_kpi_ai_chip sm" t-on-click="() => this.setView('chat')"><i class="fa fa-angle-left"/> Back to chat</button>
                        <span class="o_kpi_ai_meta" t-if="state.chats"><t t-esc="state.chats.length"/> saved chat<t t-if="state.chats.length !== 1">s</t></span>
                    </div>
                    <p t-if="state.histErr" class="o_kpi_ai_err" t-esc="state.histErr"/>
                    <span t-if="!state.chats and !state.histErr" class="o_kpi_ai_dots"><i/><i/><i/></span>
                    <p t-if="state.chats and !state.chats.length" class="o_kpi_ai_meta">No saved chats yet. Every question you ask is saved here.</p>
                    <div t-foreach="state.chats || []" t-as="c" t-key="c.id" t-attf-class="o_kpi_ai_histrow {{ c.id === state.chatId ? 'on' : '' }}">
                        <button type="button" class="o_kpi_ai_histopen" t-on-click="() => this.openChat(c.id)">
                            <b t-esc="c.title"/>
                            <small><t t-esc="fmtWhen(c.updated)"/> · <t t-esc="Math.ceil((c.count || 0) / 2)"/> question(s)<t t-if="c.id === state.chatId"> · open now</t></small>
                        </button>
                        <button type="button" class="o_kpi_ai_iconbtn sm" title="Delete this chat" t-on-click="() => this.removeChat(c.id)"><i class="fa fa-trash-o"/></button>
                    </div>
                </div>
            </t>
            <t t-else="">
                <div class="o_kpi_ai_body" t-ref="body">
                    <t t-if="state.view === 'faq' or !state.msgs.length">
                        <div t-attf-class="{{ state.view === 'faq' ? '' : 'o_kpi_ai_welcome' }}">
                            <div t-if="state.view === 'faq'" class="o_kpi_ai_histhead">
                                <button type="button" class="o_kpi_ai_chip sm" t-on-click="() => this.setView('chat')"><i class="fa fa-angle-left"/> Back to chat</button>
                                <span class="o_kpi_ai_meta">Tap a question to ask it</span>
                            </div>
                            <t t-else="">
                                <span class="o_kpi_ai_orb"><i class="fa fa-bar-chart"/></span>
                                <h3>Hi <t t-esc="firstName"/>, how can I help?</h3>
                                <p>Tap a question, or type your own. Add "this week" or "this month" for other periods.</p>
                            </t>
                            <div class="o_kpi_ai_tabs">
                                <button t-foreach="FAQ" t-as="s" t-key="s.key" type="button" t-attf-class="{{ state.tab === s.key ? 'on' : '' }}" t-on-click="() => this.setTab(s.key)" t-esc="s.label"/>
                            </div>
                            <t t-if="currentTab.find">
                                <label class="o_kpi_ai_find"><i class="fa fa-search"/><input t-model="state.findText" t-on-input="onFindInput" placeholder="Type a task name or number, e.g. REQ-146"/></label>
                                <p class="o_kpi_ai_meta" t-esc="state.findText.trim() ? 'Tap a task to see its status' : 'Recently updated: tap one to see its status'"/>
                                <div class="o_kpi_ai_chips">
                                    <span t-if="state.findRows === null" class="o_kpi_ai_dots"><i/><i/><i/></span>
                                    <p t-if="state.findRows and !state.findRows.length" class="o_kpi_ai_meta">No task matches. Try another word or the task number.</p>
                                    <button t-foreach="state.findRows || []" t-as="t" t-key="t.id" type="button" class="o_kpi_ai_chip o_kpi_ai_taskhit" t-on-click="() => this.ask('Status of ' + (t.ref || ('&quot;' + t.name + '&quot;')))">
                                        <i class="fa fa-search"/>
                                        <span><b><t t-if="t.ref"><t t-esc="t.ref"/> · </t><t t-esc="t.name"/></b><small><t t-esc="t.person"/> · <t t-esc="stateLabel(t.status)"/></small></span>
                                    </button>
                                </div>
                            </t>
                            <t t-elif="currentTab.people">
                                <div t-if="state.person" class="o_kpi_ai_chips">
                                    <button type="button" class="o_kpi_ai_chip sm" t-on-click="() => this.state.person = null"><i class="fa fa-angle-left"/> All people</button>
                                    <button t-foreach="personQs" t-as="q" t-key="q" type="button" class="o_kpi_ai_chip" t-on-click="() => this.ask(q)"><i class="fa fa-magic"/> <t t-esc="q"/></button>
                                </div>
                                <t t-else="">
                                    <label class="o_kpi_ai_find"><i class="fa fa-search"/><input t-model="state.peopleFind" placeholder="Find a person"/></label>
                                    <div class="o_kpi_ai_people">
                                        <p t-if="!state.people.length" class="o_kpi_ai_meta">Loading the team…</p>
                                        <button t-foreach="shownPeople" t-as="p" t-key="p.id" type="button" class="o_kpi_ai_personchip" t-on-click="() => this.state.person = p.name"><i class="fa fa-user-o"/> <t t-esc="p.name"/></button>
                                    </div>
                                </t>
                            </t>
                            <div t-else="" class="o_kpi_ai_chips">
                                <button t-foreach="currentTab.items" t-as="q" t-key="q" type="button" class="o_kpi_ai_chip" t-on-click="() => this.ask(q)"><i class="fa fa-magic"/> <t t-esc="q"/></button>
                            </div>
                        </div>
                    </t>
                    <t t-else="">
                        <t t-foreach="state.msgs" t-as="m" t-key="m_index">
                            <div t-if="m.role === 'user'" class="o_kpi_ai_user"><div class="o_kpi_ai_bubble" t-esc="m.text"/><span class="o_kpi_ai_avatar" t-esc="initial"/></div>
                            <div t-else="" class="o_kpi_ai_ai">
                                <span class="o_kpi_ai_orb sm"><i class="fa fa-bar-chart"/></span>
                                <div class="o_kpi_ai_text">
                                    <t t-if="m.role === 'bot'">
                                        <p t-if="m.res.title"><strong t-esc="m.res.title"/></p>
                                        <t t-foreach="m.res.blocks || []" t-as="b" t-key="b_index">
                                            <div t-if="b.type === 'stats'" class="o_kpi_ai_stats">
                                                <div t-foreach="b.items" t-as="it" t-key="it_index" class="o_kpi_ai_stat"><b t-esc="it.value"/><small t-esc="it.label"/></div>
                                            </div>
                                            <t t-elif="b.type === 'list'">
                                                <p t-if="b.title" class="o_kpi_ai_sub" t-esc="b.title"/>
                                                <ul><li t-foreach="b.items" t-as="li" t-key="li_index" t-esc="li"/></ul>
                                            </t>
                                            <div t-elif="b.type === 'table'" class="o_kpi_ai_table">
                                                <div class="o_kpi_ai_tablescroll">
                                                    <table>
                                                        <thead><tr><th t-foreach="b.columns" t-as="c" t-key="c.key" t-att-class="c.kind === 'num' ? 'num' : ''" t-esc="c.label"/></tr></thead>
                                                        <tbody>
                                                            <tr t-foreach="b.rows" t-as="r" t-key="r_index">
                                                                <td t-foreach="b.columns" t-as="c" t-key="c.key" t-att-class="c.kind === 'num' ? 'num' : (c.kind === 'task' or c.key === 'paused' ? 'wrap' : '')">
                                                                    <a t-if="c.kind === 'task' and r.task_id" href="#" t-on-click.prevent="() => this.openTask(r.task_id)" t-esc="r[c.key]"/>
                                                                    <a t-elif="c.kind === 'person' and r[c.key] and r[c.key] !== 'Unassigned'" href="#" t-on-click.prevent="() => this.ask('How is ' + r[c.key] + ' doing?')" t-esc="r[c.key]"/>
                                                                    <t t-else="" t-esc="cellText(r[c.key])"/>
                                                                </td>
                                                            </tr>
                                                        </tbody>
                                                    </table>
                                                </div>
                                                <p t-if="b.more" class="o_kpi_ai_meta">+<t t-esc="b.more"/> more not shown. Narrow it down, e.g. by person or priority (downloads include every row).</p>
                                            </div>
                                            <p t-elif="b.text" t-esc="b.text"/>
                                        </t>
                                        <div t-if="m.res.intent !== 'smalltalk'" class="o_kpi_ai_metarow">
                                            <span class="o_kpi_ai_meta"><t t-esc="SOURCE[m.res.source] || m.res.source"/><t t-if="m.res.date_range"> · <t t-esc="fmtRange(m.res.date_range)"/></t></span>
                                            <span t-if="exportable(m.res)" class="o_kpi_ai_dlwrap">
                                                <button type="button" class="o_kpi_ai_dl" t-on-click="() => this.toggleDl(m_index)"><i class="fa fa-download"/> Download</button>
                                                <span t-if="state.dlOpen === m_index" class="o_kpi_ai_dlmenu">
                                                    <button type="button" t-att-disabled="state.dlBusy" t-on-click="() => this.downloadOne('pdf', m_index)"><i class="fa fa-file-pdf-o"/> <t t-esc="state.dlBusy === 'pdf' ? 'Preparing…' : 'PDF'"/></button>
                                                    <button type="button" t-att-disabled="state.dlBusy" t-on-click="() => this.downloadOne('docx', m_index)"><i class="fa fa-file-word-o"/> <t t-esc="state.dlBusy === 'docx' ? 'Preparing…' : 'Word (.docx)'"/></button>
                                                    <small t-if="state.dlErr" class="o_kpi_ai_err" t-esc="state.dlErr"/>
                                                </span>
                                            </span>
                                        </div>
                                        <div t-if="m_last and (m.res.suggestions || []).length" class="o_kpi_ai_chips o_kpi_ai_chiprow">
                                            <button t-foreach="m.res.suggestions" t-as="s" t-key="s" type="button" class="o_kpi_ai_chip sm" t-att-disabled="state.busy" t-on-click="() => this.ask(s)"><i class="fa fa-magic"/> <t t-esc="s"/></button>
                                        </div>
                                    </t>
                                    <t t-elif="m.role === 'err'">
                                        <p class="o_kpi_ai_err" t-esc="m.text"/>
                                        <button type="button" class="o_kpi_ai_chip sm" t-att-disabled="state.busy" t-on-click="() => this.ask(m.q)">Try again</button>
                                    </t>
                                    <p t-else="" class="o_kpi_ai_meta" t-esc="m.text"/>
                                </div>
                            </div>
                        </t>
                    </t>
                    <div t-if="state.busy and state.view === 'chat'" class="o_kpi_ai_ai"><span class="o_kpi_ai_orb sm"><i class="fa fa-bar-chart"/></span><div class="o_kpi_ai_text"><span class="o_kpi_ai_dots"><i/><i/><i/></span></div></div>
                </div>

                <div t-if="state.msgs.length and state.view === 'chat' and !typeAhead.length" class="o_kpi_ai_quick">
                    <button type="button" class="o_kpi_ai_qchip faq" t-on-click="() => this.setView('faq')"><i class="fa fa-question-circle-o"/> All questions</button>
                    <button t-foreach="QUICK" t-as="qk" t-key="qk[0]" type="button" class="o_kpi_ai_qchip" t-att-disabled="state.busy" t-att-title="qk[1]" t-on-click="() => this.ask(qk[1])" t-esc="qk[0]"/>
                </div>
                <div class="o_kpi_ai_composerwrap">
                    <ul t-if="typeAhead.length" class="o_kpi_ai_suggest">
                        <li t-foreach="typeAhead" t-as="s" t-key="s"><button type="button" t-att-class="s_index === state.hi ? 'on' : ''" t-on-mousedown.prevent="() => {}" t-on-click="() => this.ask(s)"><i class="fa fa-magic"/> <t t-esc="s"/></button></li>
                    </ul>
                    <form class="o_kpi_ai_composer" t-on-submit.prevent="() => this.ask()">
                        <textarea t-ref="input" rows="1" maxlength="1000" placeholder="Ask anything about your team's work…" t-model="state.q" t-on-keydown="onKeyDown"/>
                        <button t-if="state.busy" type="button" class="o_kpi_ai_send stop" title="Stop" t-on-click="stop"><span/></button>
                        <button t-else="" type="submit" class="o_kpi_ai_send" title="Send" t-att-disabled="!state.q.trim()"><i class="fa fa-arrow-up"/></button>
                    </form>
                </div>
            </t>
        </aside>
    </div>`;

    setup() {
        this.FAQ = FAQ; this.QUICK = QUICK; this.SOURCE = SOURCE;
        this.fmtRange = fmtRange; this.fmtWhen = fmtWhen; this.cellText = cellText; this.exportable = exportable;
        this.action = useService("action");
        this.bodyRef = useRef("body");
        this.inputRef = useRef("input");
        this.seq = 0;
        this.state = useState({
            open: !!this.props.docked, view: "chat", msgs: [], ctx: {}, q: "", busy: false, chatId: null,
            chats: null, histErr: "", people: [], tab: "today", person: null, peopleFind: "",
            findText: "", findRows: null, hi: -1, dlOpen: null, dlBusy: "", dlErr: "", top: null,
        });
        this.onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key || "").toLowerCase() === "j") {
                e.preventDefault();
                if (this.props.docked) { if (this.inputRef.el) this.inputRef.el.focus(); } else this.setOpen(!this.state.open);
            } else if (e.key === "Escape" && this.state.open && !this.props.docked) this.setOpen(false);
        };
        this.onResize = () => this.place();
        onMounted(() => {
            window.addEventListener("keydown", this.onKey);
            window.addEventListener("resize", this.onResize);
            if (this.props.docked) this.loadPeople();
            try { const id = Number(sessionStorage.getItem(KEY)); if (id) this.loadChat(id, true); } catch (_) { /* storage blocked */ }
        });
        onWillUnmount(() => { window.removeEventListener("keydown", this.onKey); window.removeEventListener("resize", this.onResize); });
    }

    /* ---------------- derived */
    get currentTab() { return FAQ.find((s) => s.key === this.state.tab) || FAQ[0]; }
    get personQs() { return personQuestions(this.state.person); }
    get shownPeople() {
        const f = this.state.peopleFind.trim().toLowerCase();
        return this.state.people.filter((p) => !f || (p.name || "").toLowerCase().includes(f));
    }
    get typeAhead() { return this.state.q.trim().length >= 2 && !this.state.busy ? suggest(this.state.q, this.state.people, 5) : []; }
    get botIdx() { return this.state.msgs.map((m, i) => (m.role === "bot" && exportable(m.res) ? i : -1)).filter((i) => i >= 0); }
    get firstName() { return ((user && user.name) || "").trim().split(" ")[0] || "there"; }
    get initial() { return ((user && user.name) || "?").trim().charAt(0).toUpperCase(); }
    stateLabel(st) { return STATE_LABEL[st] || "Not started"; }

    /* ---------------- open / layout */
    place() {
        const bar = document.querySelector(".o_main_navbar");
        this.state.top = Math.max(8, Math.round(bar ? bar.getBoundingClientRect().bottom : 46) + 10);
    }
    setOpen(v) {
        this.state.open = v;
        this.state.dlOpen = null;
        if (v) {
            this.place();
            this.loadPeople();
            setTimeout(() => this.inputRef.el && this.inputRef.el.focus(), 250);
            this.scrollDown();
        }
    }
    loadPeople() {
        if (!this.state.people.length) rpc("/kra_kpi/get_users", {}).then((r) => { this.state.people = Array.isArray(r) ? r : (r && r.users) || []; }).catch(() => {});
    }
    setView(v) { this.state.view = v; this.state.dlOpen = null; if (v === "chat") this.scrollDown(); }
    setTab(k) { this.state.tab = k; this.state.person = null; if (k === "find" && this.state.findRows === null) this.searchTasks(); }
    scrollDown() { setTimeout(() => { const el = this.bodyRef.el; if (el) el.scrollTop = el.scrollHeight; }, 30); }
    remember() { try { if (this.state.chatId) sessionStorage.setItem(KEY, String(this.state.chatId)); else sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ } }

    /* ---------------- asking */
    async ask(text) {
        const question = String(text ?? this.state.q).trim();
        if (!question || this.state.busy) return;
        const mine = ++this.seq;
        const ctxIn = this.state.ctx;
        this.state.q = ""; this.state.view = "chat"; this.state.hi = -1; this.state.dlOpen = null;
        this.state.msgs.push({ role: "user", text: question });
        this.state.busy = true; this.scrollDown();
        try {
            const r = await rpc("/kra_kpi/ai_assistant/ask", { question: question.slice(0, 1000), period: "today", context: ctxIn || {}, chat_id: this.state.chatId || null });
            if (mine !== this.seq) return;
            if (!r || r.status === false) throw new Error((r && r.message) || "The assistant couldn't answer that.");
            this.state.msgs.push({ role: "bot", res: r, q: question, ctxIn });
            this.state.ctx = r.context || {};
            if (r.chat_id) { this.state.chatId = r.chat_id; this.state.chats = null; this.remember(); }
            if (this.props.onAnswer) { try { this.props.onAnswer(r, question); } catch (_) { /* a page hook must not break the chat */ } }
        } catch (e) {
            if (mine === this.seq) this.state.msgs.push({ role: "err", text: (e && (e.data?.message || e.message)) || "Something went wrong.", q: question });
        } finally {
            if (mine === this.seq) { this.state.busy = false; this.scrollDown(); }
        }
    }
    stop() { this.seq++; this.state.busy = false; this.state.msgs.push({ role: "note", text: "Stopped." }); }
    newChat() {
        this.seq++; this.state.busy = false; this.state.msgs.splice(0); this.state.ctx = {}; this.state.q = "";
        this.state.chatId = null; this.state.view = "chat"; this.remember();
        this.inputRef.el && this.inputRef.el.focus();
    }
    onKeyDown(e) {
        const list = this.typeAhead;
        if (list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            this.state.hi = e.key === "ArrowDown" ? (this.state.hi + 1) % list.length : (this.state.hi <= 0 ? list.length - 1 : this.state.hi - 1);
        } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.ask(this.state.hi >= 0 && list[this.state.hi] ? list[this.state.hi] : undefined);
        } else if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
            this.state.hi = -1;
        }
    }
    openTask(id) {
        if (!this.props.docked) this.setOpen(false);
        this.action.doAction({ type: "ir.actions.act_window", res_model: "kra.kpi", res_id: id, views: [[false, "form"]], target: "current" });
    }

    /* ---------------- find a task */
    onFindInput() {
        clearTimeout(this._findT);
        this._findT = setTimeout(() => this.searchTasks(), 250);
    }
    async searchTasks() {
        const q = this.state.findText.trim();
        try {
            const r = await rpc("/kra_kpi/ai_assistant/find_tasks", { query: q.slice(0, 100), limit: 8 });
            if (q === this.state.findText.trim()) this.state.findRows = (r && r.tasks) || [];
        } catch (_) { this.state.findRows = []; }
    }

    /* ---------------- history */
    async showHistory() {
        if (this.state.view === "history") { this.setView("chat"); return; }
        this.state.view = "history"; this.state.histErr = ""; this.state.dlOpen = null;
        try {
            const r = await rpc("/kra_kpi/ai_assistant/chats", { limit: 100 });
            if (!r || r.status === false) throw new Error((r && r.message) || "Could not load your chats.");
            this.state.chats = r.chats || [];
        } catch (e) { this.state.histErr = e.message || "Could not load your chats."; }
    }
    async loadChat(id, quiet) {
        try {
            const c = await rpc("/kra_kpi/ai_assistant/chat", { chat_id: Number(id) });
            if (!c || c.status === false) throw new Error((c && c.message) || "Could not open that chat.");
            this.seq++; this.state.busy = false;
            this.state.msgs.splice(0, this.state.msgs.length, ...(c.messages || []));
            this.state.ctx = c.context || {}; this.state.chatId = c.id; this.state.view = "chat"; this.remember(); this.scrollDown();
        } catch (e) {
            if (quiet) { this.state.chatId = null; this.remember(); } else this.state.histErr = e.message;
        }
    }
    openChat(id) { this.state.histErr = ""; return this.loadChat(id, false); }
    async removeChat(id) {
        try {
            const r = await rpc("/kra_kpi/ai_assistant/chat_delete", { chat_id: Number(id) });
            if (!r || r.status === false) throw new Error((r && r.message) || "Could not delete that chat.");
            this.state.chats = (this.state.chats || []).filter((c) => c.id !== id);
            if (id === this.state.chatId) { this.state.msgs.splice(0); this.state.ctx = {}; this.state.chatId = null; this.remember(); }
        } catch (e) { this.state.histErr = e.message; }
    }

    /* ---------------- downloads */
    toggleDl(key) { this.state.dlErr = ""; this.state.dlOpen = this.state.dlOpen === key ? null : key; }
    async fullSection(i) {
        const m = this.state.msgs[i];
        const prev = this.state.msgs[i - 1];
        const question = m.q || (prev && prev.role === "user" ? prev.text : "");
        const cut = (m.res.blocks || []).some((b) => b.type === "table" && b.more > 0);
        let res = m.res;
        if (cut && question) {
            const r = await rpc("/kra_kpi/ai_assistant/export", { question: question.slice(0, 1000), period: m.res.period || "today", context: m.ctxIn || {} });
            if (!r || r.status === false) throw new Error((r && r.message) || "Could not prepare the download.");
            res = r;
        }
        return { question, res };
    }
    async runDownload(kind, getSections, meta) {
        this.state.dlBusy = kind; this.state.dlErr = "";
        try {
            const sections = (await getSections()).filter((s) => exportable(s.res));
            if (!sections.length) throw new Error("There is nothing to download yet.");
            const blob = kind === "pdf" ? buildPdf(sections, meta) : await buildDocx(sections, meta);
            saveBlob(blob, `369-AI-${slug(meta.name || sections[0].res.title)}-${stamp()}.${kind}`);
            this.state.dlOpen = null;
        } catch (e) {
            this.state.dlErr = (e && (e.data?.message || e.message)) || "Download failed.";
        } finally { this.state.dlBusy = ""; }
    }
    downloadOne(kind, i) {
        return this.runDownload(kind, async () => [await this.fullSection(i)],
            { user: user && user.name, subtitle: "Answer", name: this.state.msgs[i].res.title });
    }
    downloadAll(kind) {
        const idx = this.botIdx;
        const first = this.state.msgs[idx[0]];
        return this.runDownload(kind, async () => {
            const out = [];
            for (const i of idx) out.push(await this.fullSection(i));
            return out;
        }, { user: user && user.name, subtitle: `Chat - ${idx.length} answer${idx.length === 1 ? "" : "s"}`, name: `chat-${(first && first.q) || "assistant"}` });
    }
}
