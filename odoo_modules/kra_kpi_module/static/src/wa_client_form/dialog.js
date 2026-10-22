/* Our own confirm / alert popup for the WhatsApp link pages (wa_task_layout),
 * instead of the browser's "krakpi.alphalize.com says…" box.
 *
 *   kpiConfirm(text, {title, ok, cancel, danger}) -> Promise<boolean>
 *   kpiAlert(text, {title, ok})                   -> Promise<void>
 *
 * The first line of `text` is the title unless one is given; the rest is the
 * body (line breaks kept). Enter = OK, Escape / tap outside = Cancel.
 */
(function () {
    'use strict';

    function show(text, opts, withCancel) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var lines = String(text || '').split('\n');
            var title = opts.title || lines.shift();
            var body = lines.join('\n').replace(/^\n+/, '');

            var box = document.createElement('div');
            box.className = 'kd';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            var card = document.createElement('div');
            card.className = 'kd-card';
            var h = document.createElement('div');
            h.className = 'kd-title';
            h.textContent = title;
            card.appendChild(h);
            if (body) {
                var p = document.createElement('div');
                p.className = 'kd-body';
                p.textContent = body;
                card.appendChild(p);
            }
            var ft = document.createElement('div');
            ft.className = 'kd-ft';
            var cancel = null;
            if (withCancel) {
                cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'btn ghost';
                cancel.textContent = opts.cancel || 'Cancel';
                ft.appendChild(cancel);
            }
            var ok = document.createElement('button');
            ok.type = 'button';
            ok.className = opts.danger ? 'btn danger' : 'btn primary';
            ok.textContent = opts.ok || 'OK';
            ft.appendChild(ok);
            card.appendChild(ft);
            box.appendChild(card);

            function close(v) {
                document.removeEventListener('keydown', onKey, true);
                box.remove();
                resolve(v);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); close(false); }
                else if (e.key === 'Enter') { e.preventDefault(); close(true); }
            }
            ok.addEventListener('click', function () { close(true); });
            if (cancel) { cancel.addEventListener('click', function () { close(false); }); }
            box.addEventListener('click', function (e) { if (e.target === box) { close(false); } });
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(box);
            ok.focus();
        });
    }

    window.kpiConfirm = function (text, opts) { return show(text, opts, true); };
    window.kpiAlert = function (text, opts) { return show(text, opts, false).then(function () {}); };

    var css = document.createElement('style');
    css.textContent =
        '.kd{position:fixed;inset:0;z-index:120;background:rgba(16,24,40,.45);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.kd-card{background:var(--surface,#fff);border-radius:var(--r-card,12px);width:100%;max-width:440px;box-shadow:0 18px 50px rgba(16,24,40,.25);' +
        'border-top:4px solid var(--brand,#1E40AF);overflow:hidden}' +
        '.kd-title{padding:16px 18px 6px;font-size:16px;font-weight:800;color:var(--text,#1F2937)}' +
        '.kd-body{padding:4px 18px 4px;color:var(--subtle,#374151);white-space:pre-wrap;line-height:1.5;max-height:50vh;overflow:auto}' +
        '.kd-ft{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px}';
    document.head.appendChild(css);
})();
