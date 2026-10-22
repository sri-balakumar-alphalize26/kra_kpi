/* Our own "Choose files" button for the WhatsApp link pages (wa_task_layout).
 *
 * The real <input type="file"> stays in the form (so upload, size checks and
 * page scripts are untouched) and is hidden; a styled button opens it and the
 * chosen files are listed under it with their sizes. Inputs a page already
 * hides behind its own control (the client form's 📎 drop area) are left alone.
 */
(function () {
    'use strict';

    function size(b) {
        return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    }

    function enhance(input) {
        if (input.dataset.fp) { return; }
        input.dataset.fp = '1';
        // Already wrapped in a page's own control (e.g. <label class="drop">) or hidden.
        if (input.closest('label') || getComputedStyle(input).display === 'none') { return; }

        var wrap = document.createElement('div');
        wrap.className = 'fp';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.classList.add('fp-native');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fp-btn';
        btn.innerHTML = '📎 ' + (input.multiple ? 'Choose files' : 'Choose a file');
        var list = document.createElement('div');
        list.className = 'fp-list';
        wrap.appendChild(btn);
        wrap.appendChild(list);

        function render() {
            var files = Array.prototype.slice.call(input.files || []);
            if (!files.length) {
                list.innerHTML = '<span class="fp-none">No file chosen</span>';
                btn.classList.remove('fp-has');
                return;
            }
            btn.classList.add('fp-has');
            btn.innerHTML = '📎 ' + (input.multiple ? 'Change files' : 'Change file');
            var total = files.reduce(function (s, f) { return s + f.size; }, 0);
            list.innerHTML = files.map(function (f) {
                var span = document.createElement('span');
                span.textContent = f.name;
                return '<div class="fp-file">' + span.innerHTML + ' <small>' + size(f.size) + '</small></div>';
            }).join('') + (files.length > 1 ? '<small class="fp-total">' + files.length + ' files · ' + size(total) + '</small>' : '');
        }
        btn.addEventListener('click', function () { input.click(); });
        input.addEventListener('change', render);
        // A form reset (after a page script clears it) empties the list too.
        if (input.form) { input.form.addEventListener('reset', function () { setTimeout(render, 0); }); }
        render();
    }

    function enhanceAll(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('input[type="file"]'), enhance);
    }

    var css = document.createElement('style');
    css.textContent =
        '.fp-native{position:absolute !important;width:1px !important;height:1px;opacity:0;pointer-events:none;min-height:0 !important;padding:0 !important;border:0 !important}' +
        '.fp{display:flex;flex-direction:column;gap:6px;position:relative}' +
        '.fp-btn{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:10px 16px;font:inherit;font-weight:800;' +
        'color:var(--brand,#1E40AF);background:var(--sel-bg,#E0ECFF);border:1.5px dashed var(--brand,#1E40AF);border-radius:var(--r,8px);cursor:pointer}' +
        '.fp-btn:hover{filter:brightness(.97)}.fp-btn.fp-has{border-style:solid}' +
        '.fp-list{display:flex;flex-direction:column;gap:3px;font-size:13px}' +
        '.fp-file{padding:6px 10px;border:1px solid var(--border,#E5E9F0);border-radius:var(--r,8px);background:var(--input,#F4F7FB);overflow-wrap:anywhere}' +
        '.fp-file small,.fp-total,.fp-none{color:var(--subtlest,#6B7280)}';
    document.head.appendChild(css);

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { enhanceAll(); }); }
    else { enhanceAll(); }
})();
