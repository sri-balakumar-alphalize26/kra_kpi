/* The client's WhatsApp form page (views/wa_client_form_templates.xml,
 * controllers/kpi_wa_client_form.py). A plain script, NOT an Odoo asset: the
 * page is public and loads only this file.
 *
 * Dropdowns load from the token's client, the description is tidied by AI when
 * the client finishes typing, the New Database name is checked as it is typed,
 * a live Preview mirrors every field, and Create opens a confirmation popup
 * showing the same preview before the form is sent. The server re-checks all
 * of it on submit. */
(function () {
    'use strict';
    var B = window.KF_BOOT || {};
    var KIND = B.kind;
    var V = B.values || {};
    var RESERVED = ['postgres', 'template0', 'template1', 'odoo', 'root'];

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function rpc(path, params) {
        return fetch('/kpi/wa/client/' + B.token + '/' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: params || {} })
        }).then(function (r) { return r.json(); }).then(function (d) {
            var res = (d && d.result) || {};
            if (res.expired) { window.location.reload(); }
            return res;
        });
    }

    var form = $('kf'), server = $('kfServer'), db = $('kfDb'), name = $('kfName');
    var desc = $('kfDesc'), reqs = $('kfReqs'), dbName = $('kfDbName');
    var user = $('kfUser'), pass = $('kfPass'), files = $('kfFiles');
    var picked = [];          // the files chosen so far
    var dbNameOk = false;     // New Database: server says the name is good

    // ---- server / database ------------------------------------------------
    (B.servers || []).forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id; o.textContent = s.name;
        server.appendChild(o);
    });
    if (!(B.servers || []).length) {
        server.innerHTML = '<option value="">No servers available</option>';
    }

    function loadDbs(keep) {
        if (!db) { return Promise.resolve(); }
        db.disabled = true;
        db.innerHTML = '<option value="">' + (server.value ? 'Loading…' : 'Choose the server first') + '</option>';
        if (!server.value) { onDb(); return Promise.resolve(); }
        return rpc('dbs', { server_id: +server.value }).then(function (res) {
            var list = res.dbs || [];
            db.innerHTML = '<option value="">' + (list.length ? 'Choose a database' : 'No live databases on this server') + '</option>';
            list.forEach(function (d) {
                var o = document.createElement('option');
                o.value = d.id; o.textContent = d.label && d.label !== d.name ? d.name + ' — ' + d.label : d.name;
                o.setAttribute('data-name', d.name);
                db.appendChild(o);
            });
            db.disabled = !list.length;
            if (keep && list.some(function (d) { return String(d.id) === String(keep); })) { db.value = keep; }
            else if (list.length === 1) { db.value = list[0].id; }
            return onDb(V.parent_id);
        });
    }

    function onDb(keepParent) {
        preview();
        if (!reqs) { return Promise.resolve(); }
        if (!db.value) {
            reqs.innerHTML = '<span class="mini">Choose the server and database first.</span>';
            return Promise.resolve();
        }
        reqs.innerHTML = '<span class="mini">Loading tasks…</span>';
        return rpc('tasks', { server_id: +server.value, db_id: +db.value }).then(function (res) {
            var list = res.tasks || [];
            if (!list.length) {
                reqs.innerHTML = '<span class="mini">There are no requirements on this database yet — use ✨ New Requirement instead.</span>';
                preview();
                return;
            }
            reqs.innerHTML = list.map(function (t) {
                return '<label><input type="radio" name="parent_id" value="' + t.id + '"' +
                    (String(t.id) === String(keepParent || '') ? ' checked' : '') +
                    ' data-ref="' + esc(t.ref) + '" data-name="' + esc(t.name) + '"/>' +
                    '<span><span class="ref">' + esc(t.ref) + '</span>' + esc(t.name) +
                    '<small>' + esc(t.date) + '</small></span></label>';
            }).join('');
            filterReqs();
            preview();
        });
    }

    // Search the parent list (already newest first) by ref or name.
    var reqSearch = $('kfReqSearch');
    function filterReqs() {
        if (!reqs || !reqSearch) { return; }
        var q = reqSearch.value.trim().toLowerCase();
        reqs.querySelectorAll('label').forEach(function (l) {
            // style, not [hidden]: .req-list label sets display:flex.
            l.style.display = q && l.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
        });
    }
    if (reqSearch) { reqSearch.addEventListener('input', filterReqs); }

    server.addEventListener('change', function () {
        if (KIND === 'newdb') { checkDbName(); preview(); } else { loadDbs(); }
    });
    if (db) { db.addEventListener('change', function () { onDb(); }); }
    if (reqs) { reqs.addEventListener('change', preview); }

    // ---- task name: first letter capital ----------------------------------
    if (name) {
        name.addEventListener('input', function () {
            var v = name.value;
            if (v && v[0] !== v[0].toUpperCase()) {
                var at = name.selectionStart;
                name.value = v[0].toUpperCase() + v.slice(1);
                name.setSelectionRange(at, at);
            }
            preview();
        });
        name.addEventListener('blur', function () {
            name.value = name.value.replace(/\s+/g, ' ').trim();
            preview();
        });
    }

    // ---- description: AI tidy-up when they finish typing ------------------
    var lastTidy = '';
    if (desc) {
        var note = $('kfDescNote');
        desc.addEventListener('input', preview);
        desc.addEventListener('blur', function () {
            var raw = desc.value.trim();
            if (raw.length < 3 || raw === lastTidy) { return; }
            note.textContent = '✨ Tidying…';
            rpc('polish', { text: raw }).then(function (res) {
                if (desc.value.trim() !== raw) { note.textContent = ''; return; }   // typed again meanwhile
                if (res.text) { desc.value = res.text; lastTidy = res.text.trim(); }
                note.textContent = res.source === 'heuristic'
                    ? '✨ Tidied (basic) — edit it if you like.'
                    : '✨ Tidied by AI — edit it if you like.';
                preview();
                // Tapped Create while still typing: the popup shows the tidied text too.
                if (!$('kfModal').hidden) { $('kfModalPreview').innerHTML = html(rows()); }
            }).catch(function () { note.textContent = ''; });
        });
    }

    // ---- New Database: name rules, username, password ---------------------
    function nameRules(s) {
        var errs = [];
        if (!s) { return ['Type the database name.']; }
        if (/\s/.test(s)) { errs.push('No spaces — join the words with _'); }
        if (/[a-z]/.test(s)) { errs.push('Use CAPITAL letters only (found small letters)'); }
        var bad = (s.match(/[^A-Za-z0-9_\s]/g) || []).filter(function (c, i, a) { return a.indexOf(c) === i; });
        if (bad.length) { errs.push('Not allowed: ' + bad.join(' ') + ' — only A-Z, 0-9 and _'); }
        if (/^[0-9_]/.test(s)) { errs.push('Must start with a letter'); }
        if (s.indexOf('__') >= 0) { errs.push('Only one _ between words'); }
        if (/_$/.test(s)) { errs.push('Cannot end with _'); }
        if (s.length < 3 || s.length > 63) { errs.push('Must be 3 to 63 characters'); }
        if (RESERVED.indexOf(s.toLowerCase()) >= 0) { errs.push('"' + s + '" is a reserved name'); }
        return errs;
    }
    function suggest(s) {
        return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    }
    function showDbState(errs, fix) {
        var ul = $('kfDbErrs'), fx = $('kfDbFix'), ok = $('kfDbOk');
        ul.hidden = !errs.length;
        ul.innerHTML = errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('');
        fx.hidden = !(errs.length && fix && fix !== dbName.value);
        if (!fx.hidden) {
            fx.innerHTML = 'Did you mean <button type="button">' + esc(fix) + '</button>?';
            fx.querySelector('button').onclick = function () { dbName.value = fix; checkDbName(); };
        }
        ok.hidden = !dbNameOk;
        user.disabled = !dbNameOk;
        user.placeholder = dbNameOk ? 'admin' : 'Valid name first';
        if (dbNameOk && !user.value) { user.value = 'admin'; }
        preview();
    }
    var checkTimer = null, checkSeq = 0;
    function checkDbName() {
        if (!dbName) { return; }
        var s = dbName.value.trim();
        dbNameOk = false;
        var errs = nameRules(s);
        clearTimeout(checkTimer);
        if (errs.length) { showDbState(s ? errs : [], suggest(s)); return; }
        showDbState([], '');
        var seq = ++checkSeq;
        checkTimer = setTimeout(function () {
            rpc('check_db', { name: s, server_id: server.value ? +server.value : null }).then(function (res) {
                if (seq !== checkSeq) { return; }
                dbNameOk = !!res.ok;
                showDbState(res.errors || [], res.clean);
            });
        }, 350);
    }
    if (dbName) {
        dbName.addEventListener('input', checkDbName);
        user.addEventListener('input', preview);
        pass.addEventListener('input', preview);
        $('kfGen').addEventListener('click', function () {
            var n = new Uint32Array(1);
            (window.crypto || window.msCrypto).getRandomValues(n);
            pass.value = String(100000 + (n[0] % 900000));
            preview();
        });
    }

    // ---- files -------------------------------------------------------------
    function syncFiles() {
        try {
            var dt = new DataTransfer();
            picked.forEach(function (f) { dt.items.add(f); });
            files.files = dt.files;
        } catch (e) { /* old browser: whatever is in the input is sent */ }
        var chips = $('kfChips');
        chips.innerHTML = picked.map(function (f, i) {
            return '<span class="chip"><button type="button" class="open" data-view="' + i +
                '" title="Tap to view">' + esc(f.name) + '</button> · ' + size(f.size) +
                ' <button type="button" data-i="' + i + '" aria-label="Remove">×</button></span>';
        }).join('');
        preview();
    }

    // ---- 🎤 voice note, WhatsApp style --------------------------------------
    // Record → ⏸ Pause: listen to everything recorded so far → ▶ Resume to add
    // more → ➤ Attach (or 🗑 to throw it away). Nothing joins the file list
    // until Attach; Attach while recording stops and attaches in one tap.
    var VOICE_MAX_MS = 5 * 60 * 1000;
    function setupVoice() {
        var btn = $('kfVoice'), msg = $('kfVoiceMsg'), modal = $('kfRec');
        if (!btn || !modal) { return; }
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)) {
            btn.disabled = true;
            msg.textContent = 'Voice recording is not available in this browser — attach an audio file instead.';
            return;
        }
        var pauseBtn = $('kfRecPause'), sendBtn = $('kfRecSend'), delBtn = $('kfRecDel'),
            audio = $('kfRecAudio'), dot = $('kfRecDot'), time = $('kfRecTime'), stateEl = $('kfRecState'),
            canvas = $('kfRecWave'), ctx2d = canvas.getContext('2d');
        var rec = null, stream = null, chunks = [], mime = '', count = 0;
        var elapsed = 0, runFrom = 0, tick = null, cap = null;
        var actx = null, analyser = null, raf = null, levels = [];
        var previewUrl = null, previewWanted = false, attachAfterStop = false;

        function ms() { return elapsed + (rec && rec.state === 'recording' ? Date.now() - runFrom : 0); }
        function fmt(t) { var s = Math.floor(t / 1000); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
        function show(t) { time.textContent = fmt(t); }
        var barColor = (getComputedStyle(document.documentElement).getPropertyValue('--brand') || '').trim() || '#1E40AF';
        function draw() {
            raf = requestAnimationFrame(draw);
            if (analyser && rec && rec.state === 'recording') {
                var buf = new Uint8Array(analyser.fftSize);
                analyser.getByteTimeDomainData(buf);
                var peak = 0;
                for (var i = 0; i < buf.length; i++) { peak = Math.max(peak, Math.abs(buf[i] - 128)); }
                levels.push(Math.min(1, peak / 64));
                if (levels.length > 120) { levels.shift(); }
            }
            var w = canvas.width, h = canvas.height, bw = w / 120;
            ctx2d.clearRect(0, 0, w, h);
            ctx2d.fillStyle = barColor;
            levels.forEach(function (v, i) {
                var bh = Math.max(3, v * h);
                ctx2d.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 2), bh);
            });
        }
        function cleanupAudio() {
            cancelAnimationFrame(raf); raf = null;
            if (actx) { try { actx.close(); } catch (e) { /* closed already */ } actx = null; analyser = null; }
            if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
            clearInterval(tick); clearTimeout(cap);
        }
        function dropPreview() {
            audio.pause();
            if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
            audio.removeAttribute('src'); audio.hidden = true;
        }
        function ui(mode) {           // 'recording' | 'paused' | 'done' (hit the 5-minute cap)
            pauseBtn.hidden = mode === 'done' || typeof (rec && rec.pause) !== 'function';
            pauseBtn.textContent = mode === 'paused' ? '▶ Resume' : '⏸ Pause';
            dot.classList.toggle('paused', mode !== 'recording');
            stateEl.textContent = mode === 'recording' ? 'Recording… pause to listen to it'
                : mode === 'paused' ? 'Paused — listen below, resume to record more, or attach'
                : 'That is the 5-minute limit — listen, then attach';
            if (mode === 'recording') { dropPreview(); }
        }
        // Everything recorded so far, playable while the recording is paused.
        function buildPreview() {
            dropPreview();
            if (!chunks.length) { return; }
            previewUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
            audio.src = previewUrl;
            audio.hidden = false;
        }
        function start() {
            dropPreview();
            chunks = []; elapsed = 0; levels = []; attachAfterStop = false; previewWanted = false; rec = null;
            show(0);
            stateEl.textContent = 'Allow the microphone…';
            pauseBtn.hidden = true;
            modal.hidden = false;
            navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
                stream = s;
                var type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
                    .filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0];
                rec = type ? new MediaRecorder(s, { mimeType: type }) : new MediaRecorder(s);
                mime = (rec.mimeType || type || 'audio/webm').split(';')[0];
                rec.ondataavailable = function (e) {
                    if (e.data && e.data.size) { chunks.push(e.data); }
                    if (previewWanted && rec && rec.state === 'paused') { previewWanted = false; buildPreview(); }
                };
                rec.onstop = finished;
                try {
                    var AC = window.AudioContext || window.webkitAudioContext;
                    actx = new AC();
                    analyser = actx.createAnalyser(); analyser.fftSize = 512;
                    actx.createMediaStreamSource(s).connect(analyser);
                } catch (e) { analyser = null; }   // no waveform, still records
                rec.start(250);
                runFrom = Date.now();
                ui('recording');
                tick = setInterval(function () { show(ms()); }, 250);
                cap = setTimeout(function () { stopRec(); }, VOICE_MAX_MS);
                draw();
            }).catch(function () {
                cleanupAudio();
                modal.hidden = true;
                msg.textContent = 'Microphone not allowed. Allow it in the browser, or attach an audio file instead.';
            });
        }
        function stopRec() {
            if (!rec || rec.state === 'inactive') { return; }
            // Bank the running stretch BEFORE stopping: once stopped, ms() no longer counts it.
            if (rec.state === 'recording') { elapsed += Date.now() - runFrom; }
            rec.stop();
        }
        function finished() {
            cleanupAudio();
            show(elapsed);
            if (!chunks.length) {
                modal.hidden = true;
                msg.textContent = 'Nothing was recorded — try again.';
                return;
            }
            if (attachAfterStop) { attach(); return; }
            ui('done');                // the cap stopped it: listen, then attach
            buildPreview();
        }
        function attach() {
            var ext = mime.indexOf('mp4') >= 0 ? 'm4a' : mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
            count += 1;
            var file = new File([new Blob(chunks, { type: mime })],
                'Voice note ' + count + ' (' + fmt(elapsed).replace(':', 'm') + 's).' + ext, { type: mime });
            addFiles([file]);
            msg.textContent = '✓ Voice note ' + count + ' attached — tap its name to play it.';
            dropPreview();
            rec = null;
            modal.hidden = true;
        }
        function discard() {
            if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); }
            cleanupAudio();
            dropPreview();
            rec = null; chunks = [];
            modal.hidden = true;
        }

        btn.addEventListener('click', function () { msg.textContent = ''; start(); });
        pauseBtn.addEventListener('click', function () {
            if (!rec) { return; }
            if (rec.state === 'recording') {
                rec.pause();
                elapsed += Date.now() - runFrom;
                show(elapsed);
                ui('paused');
                // Flush what is buffered so the preview has every second up to now.
                previewWanted = true;
                try { rec.requestData(); } catch (e) { previewWanted = false; buildPreview(); }
            } else if (rec.state === 'paused') {
                rec.resume();
                runFrom = Date.now();
                ui('recording');
            }
        });
        delBtn.addEventListener('click', discard);
        sendBtn.addEventListener('click', function () {
            if (rec && rec.state !== 'inactive') { attachAfterStop = true; stopRec(); return; }
            if (chunks.length) { attach(); }
        });
    }

    // ---- 📷 / 🎥 preview what the camera took, then Retake or Attach ------
    function setupCamera() {
        var modal = $('kfShot');
        if (!modal) { return; }
        var body = $('kfShotBody'), current = null, input = null, url = null;
        function close() {
            body.innerHTML = '';                    // stops a playing video
            if (url) { URL.revokeObjectURL(url); url = null; }
            modal.hidden = true; current = null;
        }
        function open(file, from) {
            close();
            current = file; input = from;
            url = URL.createObjectURL(file);
            var isVideo = (file.type || '').indexOf('video/') === 0;
            var el = document.createElement(isVideo ? 'video' : 'img');
            el.src = url;
            if (isVideo) { el.controls = true; el.playsInline = true; } else { el.alt = file.name; }
            body.appendChild(el);
            $('kfShotTitle').textContent = isVideo ? '🎥 Video preview' : '📷 Photo preview';
            $('kfShotMeta').textContent = size(file.size);
            modal.hidden = false;
        }
        ['kfCamPhoto', 'kfCamVideo'].forEach(function (id) {
            var cam = $(id);
            if (!cam) { return; }
            cam.addEventListener('change', function () {
                var f = cam.files && cam.files[0];
                cam.value = '';
                if (f) { open(f, cam); }
            });
        });
        $('kfShotUse').addEventListener('click', function () {
            if (!current) { return; }
            var isVideo = (current.type || '').indexOf('video/') === 0;
            // Camera files all arrive as image.jpg / video.mp4 -- give each its own name.
            var stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
            var ext = (current.name.match(/\.[A-Za-z0-9]+$/) || [isVideo ? '.mp4' : '.jpg'])[0];
            addFiles([new File([current], (isVideo ? 'Video ' : 'Photo ') + stamp + ext, { type: current.type })]);
            close();
        });
        $('kfShotRetake').addEventListener('click', function () { var i = input; close(); if (i) { i.click(); } });
        $('kfShotCancel').addEventListener('click', close);
    }

    // ---- viewer: tap a file to see it before sending -----------------------
    var viewUrl = null;
    function kindOf(f) {
        var t = (f.type || '').toLowerCase(), n = (f.name || '').toLowerCase();
        if (t.indexOf('image/') === 0 || /\.(jpe?g|png|gif|webp|bmp|heic)$/.test(n)) { return 'image'; }
        if (t.indexOf('video/') === 0 || /\.(mp4|mov|webm|mkv|3gp|avi)$/.test(n)) { return 'video'; }
        if (t.indexOf('audio/') === 0 || /\.(mp3|wav|ogg|opus|m4a|aac|amr)$/.test(n)) { return 'audio'; }
        if (t === 'application/pdf' || /\.pdf$/.test(n)) { return 'pdf'; }
        if (t.indexOf('text/') === 0 || /\.txt$/.test(n)) { return 'text'; }
        return 'other';
    }
    function closeViewer() {
        var body = $('kfViewerBody');
        body.innerHTML = '';                 // stops a playing video / audio
        $('kfViewer').hidden = true;
        if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = null; }
    }
    function openViewer(f) {
        closeViewer();
        viewUrl = URL.createObjectURL(f);
        var body = $('kfViewerBody'), k = kindOf(f), el;
        if (k === 'image') { el = document.createElement('img'); el.alt = f.name; }
        else if (k === 'video') { el = document.createElement('video'); el.controls = true; el.playsInline = true; }
        else if (k === 'audio') { el = document.createElement('audio'); el.controls = true; }
        else if (k === 'pdf' || k === 'text') { el = document.createElement('iframe'); el.title = f.name; }
        if (el) {
            el.src = viewUrl;
            body.appendChild(el);
            if (k === 'pdf') {
                // Phones often refuse to show a PDF inside a page: offer it full-screen too.
                var a = document.createElement('a');
                a.href = viewUrl; a.target = '_blank'; a.className = 'mini';
                a.textContent = 'Not showing? Open it full screen';
                body.appendChild(a);
            }
        } else {
            body.innerHTML = '<p class="mini" style="text-align:center;padding:24px 0;">This file type cannot be previewed here.<br/>Use Download to open it.</p>';
        }
        $('kfViewerName').textContent = f.name;
        $('kfViewerMeta').textContent = size(f.size) + (f.type ? ' · ' + f.type : '');
        var dl = $('kfViewerDl');
        dl.href = viewUrl; dl.setAttribute('download', f.name);
        $('kfViewer').hidden = false;
    }
    if ($('kfViewer')) {
        $('kfViewerClose').addEventListener('click', closeViewer);
        $('kfViewer').addEventListener('click', function (e) { if (e.target === this) { closeViewer(); } });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('kfViewer').hidden) { closeViewer(); } });
    }
    function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
    function addFiles(list) {
        Array.prototype.forEach.call(list || [], function (f) {
            if (!picked.some(function (p) { return p.name === f.name && p.size === f.size; })) { picked.push(f); }
        });
        syncFiles();
    }
    if (files) {
        files.addEventListener('change', function () { addFiles(files.files); });
        // 📷 / 🎥 / 🎤: the phone's own camera and a recorder. Each shows a preview
        // first; only Attach adds the result to the main list (syncFiles copies it in).
        setupCamera();
        setupVoice();
        $('kfChips').addEventListener('click', function (e) {
            var v = e.target.getAttribute('data-view');
            if (v !== null) { openViewer(picked[+v]); return; }
            var i = e.target.getAttribute('data-i');
            if (i !== null) { picked.splice(+i, 1); syncFiles(); }
        });
    }

    // ---- type / urgency / needed by ------------------------------------------
    var otherBox = $('kfDelivOther');
    function typeText() {
        var out = [];
        form.querySelectorAll('input[name="deliverable_type"]:checked').forEach(function (c) {
            if (c.value === 'other') {
                var t = otherBox.value.trim();
                if (t) { out.push(t); }      // Other with nothing typed counts as missing
            } else {
                out.push(c.parentNode.textContent.trim());
            }
        });
        return out.join(', ');
    }
    if (otherBox) {
        var otherChk = $('kfDeliv_other');
        var showOther = function () {
            otherBox.style.display = otherChk.checked ? '' : 'none';
            if (otherChk.checked) { otherBox.focus(); }
            preview();
        };
        otherChk.addEventListener('change', showOther);
        otherBox.addEventListener('input', preview);
        form.querySelectorAll('input[name="deliverable_type"]').forEach(function (c) {
            if (c !== otherChk) { c.addEventListener('change', preview); }
        });
    }
    form.querySelectorAll('input[name="priority"]').forEach(function (r) { r.addEventListener('change', preview); });
    if ($('kfNeeded')) { $('kfNeeded').addEventListener('change', preview); }

    // ---- preview -------------------------------------------------------------
    function text(sel) { return sel && sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].textContent : ''; }
    function parent() { return form.querySelector('input[name="parent_id"]:checked'); }
    function rows() {
        var r = [['Server', text(server), true]];
        if (KIND === 'newdb') {
            r.push(['Database name', dbName.value.trim() + (dbName.value.trim() && !dbNameOk ? '  (not valid yet)' : ''), true]);
            r.push(['Username', user.disabled ? '' : user.value.trim(), true]);
            r.push(['Password', pass.value ? pass.value : '', true]);
            return r;
        }
        r.push(['Database', db && db.value ? (db.options[db.selectedIndex].getAttribute('data-name') || text(db)) : '', true]);
        if (KIND === 'dbdisconnect') {
            r.push(['Database URL', $('kfDbUrl').value.trim(), true]);
            r.push(['User ID', $('kfDUser').value.trim(), true]);
            r.push(['Password', $('kfDPass').value ? '••••••' : '', true]);
        }
        if (KIND === 'requirement') { r.push(['Task name', name.value.trim(), true]); }
        if (KIND === 'bug' || KIND === 'update') {
            var p = parent();
            r.push(['About task', p ? p.getAttribute('data-ref') + ' — ' + p.getAttribute('data-name') : '', true]);
            r.push(['New ref', p ? (KIND === 'bug' ? 'BUG' : 'UPT') + '### under ' + p.getAttribute('data-ref') : '', false]);
        }
        if (KIND === 'requirement') { r.push(['Type', typeText(), true]); }
        if (KIND !== 'dbdisconnect') {
            var pr = form.querySelector('input[name="priority"]:checked');
            r.push(['Urgency', pr ? form.querySelector('label[for="' + pr.id + '"]').textContent : 'Regular', false]);
            var nb = $('kfNeeded');
            r.push(['Needed by', nb && nb.value ? nb.value.split('-').reverse().join('-') : 'Not set', false]);
        }
        r.push([KIND === 'dbdisconnect' ? 'Reason' : 'Summary', desc.value.trim(), true]);
        if (files) { r.push(['Attachments', picked.length ? picked.map(function (f) { return f.name; }).join(', ') : 'None', false]); }
        return r;
    }
    function html(list) {
        return list.map(function (x) {
            var empty = x[2] && !x[1];
            return '<dt>' + esc(x[0]) + '</dt><dd' + (empty ? ' class="empty"' : '') + '>' +
                (empty ? 'missing' : esc(x[1])) + '</dd>';
        }).join('');
    }
    function preview() { $('kfPreview').innerHTML = html(rows()); }
    ['kfDbUrl', 'kfDUser', 'kfDPass'].forEach(function (id) {
        if ($(id)) { $(id).addEventListener('input', preview); }
    });

    // ---- create → confirm popup → send ------------------------------------
    function problems() {
        var out = [];
        rows().forEach(function (x) { if (x[2] && !x[1]) { out.push(x[0]); } });
        if (KIND === 'newdb' && dbName.value.trim() && !dbNameOk) { out.push('a valid database name'); }
        var total = picked.reduce(function (s, f) { return s + f.size; }, 0);
        if (total > (B.filesMax || 52428800)) { out.push('attachments under 50 MB'); }
        return out;
    }
    var modal = $('kfModal'), err = $('kfErr');
    $('kfCreate').addEventListener('click', function () {
        var p = problems();
        err.hidden = !p.length;
        if (p.length) { err.textContent = 'Please fill in: ' + p.join(', ') + '.'; return; }
        $('kfModalPreview').innerHTML = html(rows());
        agree.checked = false;
        $('kfConfirm').disabled = true;
        modal.hidden = false;
    });
    // Confirm stays off until the client ticks "all details are accurate".
    var agree = $('kfAgree');
    agree.addEventListener('change', function () { $('kfConfirm').disabled = !agree.checked; });
    $('kfBack').addEventListener('click', function () { modal.hidden = true; });
    $('kfConfirm').addEventListener('click', function () {
        if (!agree.checked) { return; }
        var b = $('kfConfirm');
        b.disabled = true; b.textContent = 'Sending…';
        $('kfBack').disabled = true;
        // Sent by XHR so the upload of photos / videos shows its progress on
        // the button. The server's answer is the next page, drawn in place.
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable) { return; }
            var pct = Math.floor(e.loaded / e.total * 100);
            b.textContent = pct < 100 ? 'Sending… ' + pct + '%' : 'Saving…';
        };
        xhr.onload = function () {
            document.open(); document.write(xhr.responseText); document.close();
        };
        xhr.onerror = function () {
            // No connection: fall back to a plain submit, which the browser retries.
            form.submit();
        };
        xhr.send(new FormData(form));
    });

    // ---- start: refill after a server-side error ---------------------------
    if (V.name && name) { name.value = V.name; }
    if (V.description && desc) { desc.value = V.description; lastTidy = V.description.trim(); }
    if (V.db_name && dbName) { dbName.value = V.db_name; }
    if (V.username && user) { user.value = V.username; }
    if (V.db_url && $('kfDbUrl')) { $('kfDbUrl').value = V.db_url; }
    if (V.username && $('kfDUser')) { $('kfDUser').value = V.username; }
    if (V.priority && $('kfPrio_' + V.priority)) { $('kfPrio_' + V.priority).checked = true; }
    if (V.needed_by && $('kfNeeded')) { $('kfNeeded').value = V.needed_by; }
    (V.deliverable || []).forEach(function (code) { var c = $('kfDeliv_' + code); if (c) { c.checked = true; } });
    if (otherBox && V.deliverable_other) { otherBox.value = V.deliverable_other; }
    if (otherBox && $('kfDeliv_other').checked) { otherBox.style.display = ''; }
    var only = (B.servers || []).length === 1 ? String(B.servers[0].id) : '';
    server.value = V.server_id || only;
    if (KIND === 'newdb') { checkDbName(); preview(); }
    else if (server.value) { loadDbs(V.db_id); } else { preview(); }
})();
