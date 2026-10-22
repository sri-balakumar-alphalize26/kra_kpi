/* Live check of link boxes on the WhatsApp link pages (task page, My work).
 *
 * As soon as something is pasted or typed into a "links" box or a GitHub
 * repository box, it is checked: a wrong link turns the box red with a line
 * saying what is wrong, and that form's submit button stays off until it is
 * fixed. Same rules as KPI details (kpi_action.js linkBad, TaskExtras
 * linkProblem). The server still checks again on save.
 */
(function () {
    'use strict';

    function webLinkProblem(w) {
        var u = null;
        try { u = new URL(w); } catch (e) { u = null; }
        if (!u || !/^https?:$/.test(u.protocol) || u.hostname.indexOf('.') < 0) {
            return '“' + (w.length > 40 ? w.slice(0, 40) + '…' : w) +
                '” is not a web link. Links must start with https:// — e.g. https://drive.google.com/…';
        }
        return '';
    }
    function problem(input) {
        var v = (input.value || '').trim();
        if (!v) { return ''; }
        if (input.name === 'gh_url') {
            if (/\s/.test(v)) { return 'One GitHub link only — no spaces.'; }
            var bad = webLinkProblem(v);
            if (bad) { return 'This is not a web link — it should look like https://github.com/username/repository'; }
            var u = new URL(v);
            if (u.hostname.replace(/^www\./, '') !== 'github.com') {
                return 'This is not a GitHub link — it should look like https://github.com/username/repository';
            }
            if (!/^\/[^/]+\/[^/]+/.test(u.pathname)) {
                return 'Not a repository link — it should look like https://github.com/username/repository';
            }
            return '';
        }
        var words = v.split(/\s+/);
        for (var i = 0; i < words.length; i++) {
            var p = webLinkProblem(words[i]);
            if (p) { return p; }
        }
        return '';
    }

    function check(input) {
        var msg = problem(input);
        var line = input._lkLine;
        if (!line) {
            line = document.createElement('div');
            line.className = 'lk-bad';
            line.setAttribute('role', 'alert');
            input.insertAdjacentElement('afterend', line);
            input._lkLine = line;
        }
        line.textContent = msg ? '⚠ ' + msg : '';
        line.hidden = !msg;
        input.classList.toggle('lk-invalid', !!msg);
        var form = input.form;
        if (input.name === 'gh_url' && form) { mainPill(form, input, !msg && !!(input.value || '').trim()); }
        if (form) {
            var anyBad = Array.prototype.some.call(form.querySelectorAll('input[name="links"], input[name="gh_url"]'),
                function (i) { return !!problem(i); });
            Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"], button:not([type])'), function (b) {
                if (anyBad) { b.disabled = true; b.dataset.lkOff = '1'; }
                else if (b.dataset.lkOff) { b.disabled = false; delete b.dataset.lkOff; }
            });
        }
    }

    /* The branch is "main" most of the time: once there is a good repo link and
       the Branch box is empty, a 🌿 main pill fills it in one tap (as on the
       web board and in Odoo's KPI details). Not a silent default. */
    function mainPill(form, gh, repoOk) {
        var br = form.querySelector('input[name="gh_branch"]');
        if (!br) { return; }
        var pill = br._lkPill;
        if (!pill) {
            pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'lk-pill';
            pill.textContent = '🌿 main';
            pill.title = 'Use the main branch';
            pill.addEventListener('click', function () {
                br.value = 'main';
                br.dispatchEvent(new Event('input', { bubbles: true }));
                pill.hidden = true;
            });
            br.insertAdjacentElement('afterend', pill);
            br._lkPill = pill;
            br.addEventListener('input', function () { mainPill(form, gh, !problem(gh) && !!gh.value.trim()); });
        }
        pill.hidden = !(repoOk && !(br.value || '').trim());
    }

    function wire(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('input[name="links"], input[name="gh_url"]'),
            function (input) {
                if (input.dataset.lk) { return; }
                input.dataset.lk = '1';
                ['input', 'paste', 'change', 'blur'].forEach(function (ev) {
                    input.addEventListener(ev, function () { setTimeout(function () { check(input); }, 0); });
                });
                if (input.value) { check(input); }
            });
    }
    // Never let a wrong link through by Enter either.
    document.addEventListener('submit', function (e) {
        var bad = Array.prototype.filter.call(e.target.querySelectorAll('input[name="links"], input[name="gh_url"]'),
            function (i) { return !!problem(i); });
        if (bad.length) { e.preventDefault(); e.stopPropagation(); bad.forEach(check); bad[0].focus(); }
    }, true);

    var css = document.createElement('style');
    css.textContent = '.lk-invalid{border-color:#DC2626 !important;background:#FEF2F2 !important}' +
        '.lk-bad{color:#DC2626;font-size:12.5px;font-weight:700;margin-top:4px}.lk-bad[hidden]{display:none}' +
        '.lk-pill{margin-top:6px;padding:4px 12px;border-radius:999px;border:1px solid var(--border,#E5E9F0);' +
        'background:var(--sel-bg,#E0ECFF);color:var(--sel-text,#1E40AF);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}' +
        '.lk-pill[hidden]{display:none}';
    document.head.appendChild(css);
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { wire(); }); }
    else { wire(); }
})();
