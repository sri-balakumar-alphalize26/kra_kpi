/* The admin's WhatsApp decision page (views/wa_admin_decide_templates.xml,
 * controllers/kpi_wa_admin_decide.py). A plain script, not an Odoo asset.
 *
 * Pick Accept / Refuse (or Approve / Send back), fill what that needs, see the
 * Preview, then confirm in a popup before anything is sent. The server checks
 * everything again through the web admin's own routes. */
(function () {
    'use strict';
    var B = window.AD_BOOT || {};
    var KIND = B.kind;
    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    var form = $('ad'), go = $('adGo'), err = $('adErr'), modal = $('adModal');
    var yesPart = $('adYesPart'), noPart = $('adNoPart'), notePart = $('adNotePart'),
        tellPart = $('adTellPart'), noteLbl = $('adNoteLbl'), note = $('adNote');

    function action() { var r = form.querySelector('input[name="action"]:checked'); return r ? r.value : ''; }
    function sel(el) { return el && el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent : ''; }
    function radio(name) {
        var r = form.querySelector('input[name="' + name + '"]:checked');
        return r ? form.querySelector('label[for="' + r.id + '"]').textContent : '';
    }
    function noteNeeded() {
        var a = action();
        if (KIND === 'disconnect') { return !!a; }
        if (a !== 'no') { return false; }
        if (KIND === 'qa') { return true; }
        if (KIND === 'new_request' || KIND === 'new_database') { return !($('adReason') && $('adReason').value); }
        return false;                               // self_task: optional
    }
    function layout() {
        var a = action();
        yesPart.hidden = a !== 'yes';
        noPart.hidden = a !== 'no';
        notePart.hidden = !(a === 'no' || (KIND === 'disconnect' && a));
        if (tellPart) { tellPart.hidden = !a || (KIND === 'new_database' && a === 'yes'); }
        noteLbl.textContent = KIND === 'qa' ? 'What needs fixing? (the developer sees this)'
            : KIND === 'disconnect' ? 'Note (recorded, and shown to the client)'
            : KIND === 'self_task' ? 'Note to the developer (optional)'
            : 'In your own words (the client sees this)';
        noteLbl.textContent += noteNeeded() ? ' *' : '';
        go.disabled = !a;
        go.className = 'btn ' + (a === 'no' || (KIND === 'disconnect' && a === 'yes') ? 'danger' : 'primary');
        go.textContent = a === 'yes' ? B.yes : a === 'no' ? B.no : 'Continue';
        preview();
    }
    function rows() {
        var a = action(), r = [['Task', B.ref, false], ['Decision', a === 'yes' ? B.yes : a === 'no' ? B.no : '', true]];
        if (a === 'yes') {
            if ($('adDev')) { r.push([KIND === 'new_database' ? 'Built by' : 'Developer', sel($('adDev')), true]); }
            if (KIND === 'new_request') {
                r.push(['Estimate', ($('adH').value || 0) + 'h ' + ($('adM').value || 0) + 'm', false]);
                r.push(['Urgency', radio('priority'), false]);
                var t = [];
                form.querySelectorAll('input[name="deliverable_type"]:checked').forEach(function (c) {
                    t.push(c.parentNode.textContent.trim());
                });
                r.push(['Type', t.join(', ') || '—', false]);
            }
            if (KIND === 'self_task') { r.push(['Type', radio('doc_type'), false]); r.push(['Urgency', radio('priority'), false]); }
        }
        if (a === 'no' && $('adReason')) { r.push(['Reason', sel($('adReason')), false]); }
        if (a === 'no' && $('adDiscard')) { r.push(['Discard', $('adDiscard').checked ? 'Yes — archive it' : 'No — send back to fix', false]); }
        if (!notePart.hidden) { r.push(['Note', note.value.trim(), noteNeeded()]); }
        if (tellPart && !tellPart.hidden) { r.push(['Tell the client', sel2($('adTell')), false]); }
        return r;
    }
    function sel2(el) { return el ? el.options[el.selectedIndex].textContent : ''; }
    function html(list) {
        return list.map(function (x) {
            var empty = x[2] && !x[1];
            return '<dt>' + esc(x[0]) + '</dt><dd' + (empty ? ' class="empty"' : '') + '>' +
                (empty ? 'missing' : esc(x[1])) + '</dd>';
        }).join('');
    }
    function preview() { $('adPreview').innerHTML = html(rows()); }

    form.addEventListener('change', layout);
    form.addEventListener('input', preview);
    go.addEventListener('click', function () {
        var missing = rows().filter(function (x) { return x[2] && !x[1]; }).map(function (x) { return x[0]; });
        if ($('adM') && action() === 'yes' && (+$('adM').value > 59 || +$('adM').value < 0)) { missing.push('minutes 0–59'); }
        err.hidden = !missing.length;
        if (missing.length) { err.textContent = 'Please fill in: ' + missing.join(', ') + '.'; return; }
        $('adModalPreview').innerHTML = html(rows());
        $('adModalTitle').firstChild.textContent = (action() === 'yes' ? B.yes : B.no) + ' ' + B.ref + '?';
        $('adConfirm').className = go.className;
        modal.hidden = false;
    });
    $('adBack').addEventListener('click', function () { modal.hidden = true; });
    $('adConfirm').addEventListener('click', function () {
        var b = $('adConfirm');
        b.disabled = true; b.textContent = 'Saving…';
        form.submit();
    });

    // After a server-side error: put back what they had chosen.
    var V = B.values || {};
    if (V.action && $(V.action === 'yes' ? 'adYes' : 'adNo')) { $(V.action === 'yes' ? 'adYes' : 'adNo').checked = true; }
    if (V.note) { note.value = V.note; }
    if (V.user_id && $('adDev')) { $('adDev').value = V.user_id; }
    if (V.reason_id && $('adReason')) { $('adReason').value = V.reason_id; }
    layout();
})();
