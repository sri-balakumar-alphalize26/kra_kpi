/* Tap a file on a WhatsApp link page (task page, My work) → it opens in a
 * popup on the same page instead of downloading: photos, videos, voice notes /
 * audio and PDFs are shown; anything else offers Download.
 *
 * Works on every <a> whose href is one of the pages' own file routes
 * (/kpi/wa/.../file?...). The file is served inline with its real type and
 * Range support (kra_api.serve_file), so a video can be seeked.
 */
(function () {
    'use strict';
    var IMG = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
    var VID = /\.(mp4|webm|mov|m4v|3gp|mkv)$/i;
    var AUD = /\.(mp3|m4a|ogg|opus|wav|aac|amr|oga)$/i;
    var PDF = /\.pdf$/i;
    var TXT = /\.(txt|csv|log|json)$/i;

    function isFileLink(a) {
        return a && a.href && /\/kpi\/wa\/[^?]*\/file\?/.test(a.href);
    }
    function fileName(a) {
        // A link around a picture has no text: fall back to the picture's alt.
        var img = a.querySelector('img');
        var t = (a.getAttribute('data-name') || a.textContent || (img && img.alt) || '').trim();
        return t.replace(/^[^\w(]+/, '').trim() || 'file';   // drop a leading 📎 / 📄
    }
    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (html != null) { e.innerHTML = html; }
        return e;
    }

    var box;
    function close() {
        if (!box) { return; }
        box.querySelectorAll('video, audio').forEach(function (m) { try { m.pause(); } catch (e) { /* gone */ } });
        box.remove();
        box = null;
        document.body.style.overflow = '';
    }
    function open(url, name) {
        close();
        var dl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
        box = el('div', 'fv');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        var card = el('div', 'fv-card');
        var hd = el('div', 'fv-hd');
        var title = el('b', 'fv-name');
        title.textContent = name;
        var acts = el('span', 'fv-acts');
        var a1 = el('a', 'fv-btn', '⬇ Download'); a1.href = dl;
        var a2 = el('a', 'fv-btn', '↗ Open'); a2.href = url; a2.target = '_blank'; a2.rel = 'noopener';
        var x = el('button', 'fv-btn fv-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
        x.onclick = close;
        acts.appendChild(a1); acts.appendChild(a2); acts.appendChild(x);
        hd.appendChild(title); hd.appendChild(acts);
        var bd = el('div', 'fv-bd');
        var m;
        if (IMG.test(name)) { m = el('img'); m.src = url; m.alt = name; }
        else if (VID.test(name)) { m = el('video'); m.src = url; m.controls = true; m.playsInline = true; m.setAttribute('playsinline', ''); m.preload = 'metadata'; }
        else if (AUD.test(name)) { m = el('audio'); m.src = url; m.controls = true; m.preload = 'metadata'; }
        else if (PDF.test(name) || TXT.test(name)) { m = el('iframe'); m.src = url; m.title = name; }
        else {
            m = el('div', 'fv-none', 'This file cannot be shown here.<br/>Use <b>Download</b> to open it.');
        }
        bd.appendChild(m);
        card.appendChild(hd); card.appendChild(bd);
        box.appendChild(card);
        box.addEventListener('click', function (e) { if (e.target === box) { close(); } });
        document.body.appendChild(box);
        document.body.style.overflow = 'hidden';
    }

    document.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('a') : null;
        if (!isFileLink(a) || a.hasAttribute('download') || /[?&]download=1/.test(a.href)) { return; }
        e.preventDefault();
        open(a.href, fileName(a));
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { close(); } });

    var css = el('style', null,
        '.fv{position:fixed;inset:0;z-index:100;background:rgba(16,24,40,.6);display:flex;align-items:center;justify-content:center;padding:12px}' +
        '.fv-card{background:#fff;border-radius:12px;width:100%;max-width:900px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.3)}' +
        '.fv-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #E5E9F0}' +
        '.fv-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}' +
        '.fv-acts{display:flex;gap:6px;flex-shrink:0}' +
        '.fv-btn{font:inherit;font-size:13px;font-weight:700;padding:6px 10px;border-radius:8px;border:1px solid #E5E9F0;background:#F4F7FB;color:#1F2937;text-decoration:none;cursor:pointer}' +
        '.fv-x{min-width:34px}' +
        '.fv-bd{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#0b0f17;overflow:auto}' +
        '.fv-bd img,.fv-bd video{max-width:100%;max-height:80vh;display:block}' +
        '.fv-bd audio{width:92%;margin:28px 0}' +
        '.fv-bd iframe{width:100%;height:80vh;border:0;background:#fff}' +
        '.fv-none{color:#fff;text-align:center;padding:40px 16px;line-height:1.6}');
    document.head.appendChild(css);
})();
