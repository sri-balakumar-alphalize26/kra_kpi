/* Our own dropdown for the WhatsApp link pages (wa_task_layout).
 *
 * Every <select> on the page is kept — hidden — so forms submit, page scripts
 * read .value and listen for "change" exactly as before. On top sits a button
 * that shows the chosen option and opens a list in our own style: a search box
 * when the list is long, the chosen one ticked, disabled options greyed.
 *
 * Page scripts fill some selects later (servers → databases) and set .value
 * themselves, so the list is rebuilt when options change (MutationObserver)
 * and the button label re-reads the value on a light timer.
 */
(function () {
    'use strict';
    var SEARCH_FROM = 8;   // show a search box from this many options
    var all = [];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function enhance(sel) {
        if (sel.dataset.kp || sel.multiple) { return; }
        sel.dataset.kp = '1';
        var wrap = document.createElement('div');
        wrap.className = 'kp';
        sel.parentNode.insertBefore(wrap, sel);
        wrap.appendChild(sel);
        sel.classList.add('kp-native');
        // A hidden required select blocks submit with no visible message; the
        // server already checks every required choice and says so on the page.
        if (sel.required) { sel.required = false; sel.dataset.kpRequired = '1'; }
        sel.tabIndex = -1;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kp-btn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.innerHTML = '<span class="kp-label"></span><span class="kp-caret" aria-hidden="true">▾</span>';
        wrap.appendChild(btn);

        var panel = document.createElement('div');
        panel.className = 'kp-panel';
        panel.hidden = true;
        panel.innerHTML = '<input type="search" class="kp-search" placeholder="Search…" autocomplete="off"/>' +
            '<div class="kp-list" role="listbox"></div>';
        wrap.appendChild(panel);
        var search = panel.querySelector('.kp-search');
        var list = panel.querySelector('.kp-list');

        function placeholderText() {
            var first = sel.options[0];
            return first && first.value === '' ? first.textContent : 'Choose…';
        }
        function syncLabel() {
            var o = sel.options[sel.selectedIndex];
            var empty = !o || o.value === '';
            btn.querySelector('.kp-label').textContent = empty ? placeholderText() : o.textContent;
            btn.classList.toggle('kp-empty', empty);
            btn.disabled = sel.disabled;
            wrap.classList.toggle('kp-disabled', sel.disabled);
        }
        function render() {
            var q = search.value.trim().toLowerCase();
            var html = '', shown = 0;
            Array.prototype.forEach.call(sel.options, function (o, i) {
                if (o.value === '' && i === 0) { return; }          // the "Choose…" row is the label, not a choice
                if (q && o.textContent.toLowerCase().indexOf(q) === -1) { return; }
                shown++;
                var on = o.value === sel.value;
                html += '<div class="kp-opt' + (on ? ' on' : '') + (o.disabled ? ' off' : '') + '" role="option"' +
                    ' aria-selected="' + on + '" data-i="' + i + '" tabindex="-1">' +
                    '<span>' + esc(o.textContent) + '</span>' + (on ? '<b aria-hidden="true">✓</b>' : '') + '</div>';
            });
            list.innerHTML = html || '<div class="kp-none">' + (q ? 'Nothing matches' : 'Nothing to choose') + '</div>';
            search.hidden = sel.options.length <= SEARCH_FROM;
        }
        function open() {
            if (sel.disabled) { return; }
            all.forEach(function (p) { if (p !== api) { p.close(); } });
            search.value = '';
            render();
            panel.hidden = false;
            wrap.classList.add('kp-open');
            btn.setAttribute('aria-expanded', 'true');
            if (!search.hidden) { search.focus(); }
            var on = list.querySelector('.kp-opt.on');
            if (on) { on.scrollIntoView({ block: 'nearest' }); }
        }
        function close() {
            panel.hidden = true;
            wrap.classList.remove('kp-open');
            btn.setAttribute('aria-expanded', 'false');
        }
        function pick(i) {
            var o = sel.options[i];
            if (!o || o.disabled) { return; }
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncLabel();
            close();
            btn.focus();
        }

        btn.addEventListener('click', function () { if (panel.hidden) { open(); } else { close(); } });
        search.addEventListener('input', render);
        list.addEventListener('click', function (e) {
            var row = e.target.closest('.kp-opt');
            if (row) { pick(+row.getAttribute('data-i')); }
        });
        panel.addEventListener('keydown', function (e) {
            var rows = Array.prototype.slice.call(list.querySelectorAll('.kp-opt:not(.off)'));
            var at = rows.indexOf(document.activeElement);
            if (e.key === 'Escape') { close(); btn.focus(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); (rows[at + 1] || rows[0] || {}).focus && (rows[at + 1] || rows[0]).focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (at > 0) { rows[at - 1].focus(); } else { search.hidden ? null : search.focus(); } }
            else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); pick(+rows[at].getAttribute('data-i')); }
        });
        btn.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); open();
                var first = list.querySelector('.kp-opt.on, .kp-opt:not(.off)');
                if (first && search.hidden) { first.focus(); }
            }
        });
        sel.addEventListener('change', syncLabel);
        new MutationObserver(function () { syncLabel(); if (!panel.hidden) { render(); } })
            .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

        var api = { close: close, syncLabel: syncLabel, wrap: wrap };
        all.push(api);
        syncLabel();
    }

    function enhanceAll(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('select'), enhance);
    }

    document.addEventListener('click', function (e) {
        all.forEach(function (p) { if (!p.wrap.contains(e.target)) { p.close(); } });
    });
    // Page scripts set .value directly (refill after an error, "only one server").
    setInterval(function () { all.forEach(function (p) { p.syncLabel(); }); }, 400);
    // Selects added later (a section shown by a page script).
    new MutationObserver(function (muts) {
        muts.forEach(function (m) {
            Array.prototype.forEach.call(m.addedNodes, function (n) {
                if (n.nodeType !== 1) { return; }
                if (n.tagName === 'SELECT') { enhance(n); } else { enhanceAll(n); }
            });
        });
    }).observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { enhanceAll(); });
    } else {
        enhanceAll();
    }
})();
