/** @odoo-module **/
/* View task files in a popup instead of downloading them (KPI details,
 * Task Documents and every other KRA/KPI screen).
 *
 * One document-level click handler: a tap on any link to a task file route
 * opens the inline version in a popup -- photos, videos (seekable: the routes
 * honour Range, kra_api.serve_file), audio and PDFs are shown; anything else
 * offers Download. Links that say "Download", or carry a `download`
 * attribute, still download.
 */

const ROUTES = [
    // [match, how to turn it into the inline URL]
    [/\/kpi\/progress\/download\?/, (u) => u.replace("/kpi/progress/download?", "/kpi/progress/view?")],
    [/\/kpi\/progress\/view\?/, (u) => u],
    [/\/kpi\/attachment\/download\?/, (u) => u + "&inline=1"],
    [/\/kpi\/manual\/download\/\d+/, (u) => u.replace("/kpi/manual/download/", "/kpi/manual/view/")],
    [/\/kpi\/manual\/view\/\d+/, (u) => u],
    [/\/kpi_completion_cert\/download_doc\?/, (u) => u + "&inline=1"],
    [/\/web\/content\?model=kra\.kpi[^#]*field=uploaded_file/, (u) => u.replace(/download=true/, "download=false")],
];

function inlineUrl(href) {
    for (const [re, fn] of ROUTES) {
        if (re.test(href)) {
            return fn(href);
        }
    }
    return null;
}

function downloadUrl(href) {
    return href
        .replace("/kpi/progress/view?", "/kpi/progress/download?")
        .replace("/kpi/manual/view/", "/kpi/manual/download/")
        .replace(/[&?]inline=1/, "")
        .replace(/download=false/, "download=true");
}

function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    if (html != null) {
        e.innerHTML = html;
    }
    return e;
}

let box = null;

function close() {
    if (!box) {
        return;
    }
    box.querySelectorAll("video, audio").forEach((m) => {
        try {
            m.pause();
        } catch {
            /* gone */
        }
    });
    box.remove();
    box = null;
}

/** The real type, from the server: a 1-byte ranged GET answers with it. */
async function typeOf(url) {
    try {
        const r = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" });
        return (r.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    } catch {
        return "";
    }
}

export async function openFileViewer(href, name) {
    close();
    const url = inlineUrl(href) || href;
    box = el("div", "kfv");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const card = el("div", "kfv-card");
    const hd = el("div", "kfv-hd");
    const title = el("b", "kfv-name");
    title.textContent = name || "File";
    const acts = el("span", "kfv-acts");
    const dl = el("a", "btn btn-sm btn-primary", '<i class="fa fa-download"></i> Download');
    dl.href = downloadUrl(url);
    const nt = el("a", "btn btn-sm btn-light border", '<i class="fa fa-external-link"></i> Open');
    nt.href = url;
    nt.target = "_blank";
    nt.rel = "noopener";
    const x = el("button", "btn btn-sm btn-light border", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.onclick = close;
    acts.append(dl, nt, x);
    hd.append(title, acts);
    const bd = el("div", "kfv-bd", '<div class="kfv-none">Loading…</div>');
    card.append(hd, bd);
    box.append(card);
    box.addEventListener("click", (e) => {
        if (e.target === box) {
            close();
        }
    });
    document.body.append(box);

    const mime = await typeOf(url);
    if (!box) {
        return;
    }
    let m;
    if (mime.startsWith("image/")) {
        m = el("img");
        m.src = url;
        m.alt = name || "";
    } else if (mime.startsWith("video/")) {
        m = el("video");
        m.src = url;
        m.controls = true;
        m.playsInline = true;
        m.preload = "metadata";
    } else if (mime.startsWith("audio/")) {
        m = el("audio");
        m.src = url;
        m.controls = true;
        m.preload = "metadata";
    } else if (mime === "application/pdf" || mime.startsWith("text/")) {
        m = el("iframe");
        m.src = url;
        m.title = name || "File";
    } else {
        m = el("div", "kfv-none", "This file cannot be shown here.<br/>Use <b>Download</b> to open it.");
    }
    bd.replaceChildren(m);
}

document.addEventListener(
    "click",
    (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a || e.ctrlKey || e.metaKey || e.shiftKey) {
            return;
        }
        const href = a.getAttribute("href") || "";
        if (!inlineUrl(href)) {
            return;
        }
        // Buttons that say Download keep downloading; file names and View open the popup.
        const label = (a.textContent || "").trim();
        if (a.hasAttribute("download") || (/download/i.test(label) && !/view/i.test(label))) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const name = /^view$/i.test(label) ? "" : label.replace(/^[^\w(]+/, "").trim();
        openFileViewer(href, name || a.getAttribute("title") || "File");
    },
    true
);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        close();
    }
});
