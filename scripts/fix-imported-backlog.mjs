// Reconcile the imported backlog in the new KRA/KPI database against the three
// live source databases, copying every field verbatim.
//
// The original worklog-CSV import inverted task states, inflated times and fabricated
// estimates. Rather than infer corrections, this reads the sources directly. They are
// LIVE PRODUCTION and are opened STRICTLY READ-ONLY (search_read and friends only).
//
//   node scripts/fix-imported-backlog.mjs                 # dry run, writes nothing
//   node scripts/fix-imported-backlog.mjs --apply         # write
//
// Credentials come from the environment; nothing is hard-coded:
//   SRC_URL SRC_DBS SRC_LOGIN SRC_PWD
//   TARGET_URL TARGET_DB TARGET_LOGIN TARGET_PWD
//
// Everything is assigned absolutely, never incrementally, so re-running is a no-op.

const APPLY = process.argv.includes('--apply');

const SRC = {
  url: process.env.SRC_URL || 'https://krakpi.alphalize.com',
  dbs: (process.env.SRC_DBS || 'KRAKPI-01,KRAKPI-02,KRAKPI_LIVE').split(',').map((s) => s.trim()).filter(Boolean),
  login: process.env.SRC_LOGIN || 'admin',
  pwd: process.env.SRC_PWD || '',
};
const TARGET = {
  url: process.env.TARGET_URL || 'http://localhost:8069',
  db: process.env.TARGET_DB || '369application',
  login: process.env.TARGET_LOGIN || 'admin',
  pwd: process.env.TARGET_PWD || 'admin',
};

// Client user attached to every root KRA (already in group "KRA / KPI Client").
const CLIENT_LOGIN = process.env.CLIENT_LOGIN || 'athul';

// ── JSON-RPC (same shape as scripts/deploy-upgrade.mjs) ─────────────────────
async function auth({ url, db, login, pwd }) {
  const r = await fetch(`${url}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db, login, password: pwd } }),
  });
  const m = /session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  const d = await r.json().catch(() => ({}));
  if (!d?.result?.uid) throw new Error(`auth failed for ${db}: ${JSON.stringify(d.error?.data?.message || d.error || d)}`);
  return { uid: d.result.uid, cookie: m ? `session_id=${m[1]}` : null };
}

async function kw(conn, model, method, args = [], kwargs = {}) {
  const r = await fetch(`${conn.url}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: conn.cookie },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${model}.${method}: ${JSON.stringify(j.error?.data?.message || j.error)}`);
  return j.result;
}

// The sources are production. Any mutating method reaching this wrapper is a bug —
// fail loudly rather than risk damaging a live database.
const READ_ONLY = new Set(['search_read', 'search_count', 'read', 'read_group', 'search', 'fields_get']);
function ro(conn, model, method, args, kwargs) {
  if (!READ_ONLY.has(method)) throw new Error(`REFUSING to call ${model}.${method} on source ${conn.db}`);
  return kw(conn, model, method, args, kwargs);
}

// ── helpers ────────────────────────────────────────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const dt = (s) => (s || '').slice(0, 19);   // "YYYY-MM-DD HH:MM:SS"
const logKey = (uid, a, b) => `${uid}|${dt(a)}|${dt(b)}`;
const hm = (sec) => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;

const TASK_FIELDS = ['id', 'name', 'external_ref', 'task_state', 'priority',
  'timer_total_seconds', 'estimate_hours', 'estimate_minutes', 'user_id', 'kra_id',
  'admin_approved', 'completed_by', 'completion_date', 'approved_by', 'approval_date'];

(async () => {
  if (!SRC.pwd) { console.log('❌ SRC_PWD is not set — refusing to run.'); process.exit(1); }

  console.log(`mode: ${APPLY ? '\x1b[31mAPPLY (writes)\x1b[0m' : 'DRY RUN (writes nothing)'}`);
  console.log(`target : ${TARGET.db} @ ${TARGET.url}`);
  console.log(`sources: ${SRC.dbs.join(', ')} @ ${SRC.url}  (read-only)\n`);

  const tgt = { ...TARGET, ...(await auth(TARGET)) };

  // ── read every source ────────────────────────────────────────────────────
  const ctx = { context: { active_test: false } };
  // The sources' SCHEMA is 19.0.1.0 while the server runs 19.0.2.3 code, so the ORM's
  // default prefetch selects columns (coordinator_review_started_at, ...) that do not
  // exist there and the query fails outright. prefetch_fields:false restricts the SELECT
  // to the fields actually requested.
  const sctx = { context: { active_test: false, prefetch_fields: false } };
  const sources = {};
  for (const db of SRC.dbs) {
    const conn = { ...SRC, db, ...(await auth({ ...SRC, db })) };
    const tasks = await ro(conn, 'kra.kpi', 'search_read', [[], TASK_FIELDS], sctx);
    const logs = await ro(conn, 'kpi.time.log', 'search_read',
      [[], ['kpi_id', 'user_id', 'start_time', 'end_time']], sctx);
    const users = await ro(conn, 'res.users', 'search_read', [[], ['login', 'name']], sctx);
    const fp = {
      tasks: tasks.length,
      logs: logs.length,
      write: (await ro(conn, 'kra.kpi', 'search_read', [[], ['write_date']],
        { ...sctx, order: 'write_date desc', limit: 1 }))[0]?.write_date || '',
    };
    sources[db] = { conn, tasks, logs, users, fp };
    console.log(`  ${db.padEnd(13)} ${String(tasks.length).padStart(4)} tasks, ${String(logs.length).padStart(4)} logs, last write ${fp.write}`);
  }

  const tTasks = await kw(tgt, 'kra.kpi', 'search_read', [[], TASK_FIELDS], ctx);
  const tLogs = await kw(tgt, 'kpi.time.log', 'search_read', [[], ['kpi_id', 'user_id', 'start_time', 'end_time']]);
  const tUsers = await kw(tgt, 'res.users', 'search_read', [[], ['login', 'name']], ctx);
  const tKras = await kw(tgt, 'kra.master', 'search_read', [[], ['name', 'parent_id', 'client_user_ids']], ctx);
  console.log(`  ${TARGET.db.padEnd(13)} ${String(tTasks.length).padStart(4)} tasks, ${String(tLogs.length).padStart(4)} logs  (target)\n`);

  // ── combined source index, keyed by normalised name ──────────────────────
  // A name in two sources would mean copying the wrong task's data, so abort on collision.
  const index = new Map();          // norm(name) -> {task, db}
  const collisions = [], dupWithinDb = [];
  for (const db of SRC.dbs) {
    for (const t of sources[db].tasks) {
      const k = norm(t.name);
      const prev = index.get(k);
      if (!prev) { index.set(k, { task: t, db }); continue; }
      (prev.db === db ? dupWithinDb : collisions).push(`${t.name}  [${prev.db} + ${db}]`);
    }
  }
  if (collisions.length) {
    console.log(`❌ ${collisions.length} task name(s) appear in more than one source — cannot disambiguate:`);
    collisions.slice(0, 10).forEach((c) => console.log('   ' + c));
    process.exit(1);
  }
  if (dupWithinDb.length) {
    console.log(`⚠️  ${dupWithinDb.length} duplicate name(s) within a single source; first occurrence wins:`);
    dupWithinDb.slice(0, 5).forEach((c) => console.log('   ' + c));
  }

  // ── user resolution: source uid -> target uid, by login then name ────────
  const tByLogin = new Map(tUsers.map((u) => [norm(u.login), u.id]));
  const tByName = new Map(tUsers.map((u) => [norm(u.name), u.id]));
  const uidMap = new Map();         // `${db}:${uid}` -> target uid
  const unresolvedUsers = new Set();
  for (const db of SRC.dbs) {
    for (const u of sources[db].users) {
      const hit = tByLogin.get(norm(u.login)) ?? tByName.get(norm(u.name));
      if (hit) uidMap.set(`${db}:${u.id}`, hit); else unresolvedUsers.add(`${u.login} (${db})`);
    }
  }
  const mapUid = (db, m2o) => (m2o ? uidMap.get(`${db}:${m2o[0]}`) ?? null : null);

  const tKraByName = new Map();
  for (const k of tKras) if (!tKraByName.has(norm(k.name))) tKraByName.set(norm(k.name), k.id);

  // logs grouped by source db + task, and by target task
  const srcLogs = new Map();        // `${db}:${taskId}` -> [log]
  for (const db of SRC.dbs) {
    for (const l of sources[db].logs) {
      const k = `${db}:${l.kpi_id[0]}`;
      if (!srcLogs.has(k)) srcLogs.set(k, []);
      srcLogs.get(k).push(l);
    }
  }
  const tLogsByTask = new Map();
  for (const l of tLogs) {
    const a = tLogsByTask.get(l.kpi_id[0]) || [];
    a.push(l); tLogsByTask.set(l.kpi_id[0], a);
  }

  // Build the field payload copied verbatim from a source task.
  const valsFrom = (p, db) => {
    const v = {
      task_state: p.task_state,
      priority: p.priority || 'regular',
      timer_total_seconds: p.timer_total_seconds || 0,
      estimate_hours: p.estimate_hours || 0,
      estimate_minutes: p.estimate_minutes || 0,
      admin_approved: !!p.admin_approved,
      admin_accepted: true,   // see post-migrate.py:49 — historical rows are accepted
    };
    const cb = mapUid(db, p.completed_by), ab = mapUid(db, p.approved_by);
    if (cb) v.completed_by = cb;
    if (p.completion_date) v.completion_date = p.completion_date;
    if (ab) v.approved_by = ab;
    if (p.approval_date) v.approval_date = p.approval_date;
    return v;
  };
  const wantLogs = (p, db) => (srcLogs.get(`${db}:${p.id}`) || [])
    .map((l) => ({ user_id: mapUid(db, l.user_id), start_time: dt(l.start_time), end_time: dt(l.end_time) }))
    .filter((l) => l.user_id);

  // ── build the change set ─────────────────────────────────────────────────
  const updates = [], logSync = [], creates = [], unmatched = [];
  const unresolvedKra = new Set();
  const claimed = new Set();        // norm(name) of source tasks already present in target
  let droppedLogs = 0;

  for (const t of tTasks) {
    const hit = index.get(norm(t.name));
    if (!hit) { unmatched.push(t.name); continue; }
    claimed.add(norm(t.name));
    const { task: p, db } = hit;
    updates.push({ id: t.id, name: t.name, db, vals: valsFrom(p, db), old: t });

    const raw = srcLogs.get(`${db}:${p.id}`) || [];
    const want = wantLogs(p, db);
    droppedLogs += raw.length - want.length;
    const have = tLogsByTask.get(t.id) || [];
    const wantKeys = new Set(want.map((l) => logKey(l.user_id, l.start_time, l.end_time)));
    const haveKeys = new Set(have.map((l) => logKey(l.user_id?.[0], l.start_time, l.end_time)));
    const same = wantKeys.size === haveKeys.size && [...wantKeys].every((k) => haveKeys.has(k));
    if (!same) {
      logSync.push({
        targetId: t.id,
        del: have.filter((l) => !wantKeys.has(logKey(l.user_id?.[0], l.start_time, l.end_time))).map((l) => l.id),
        add: want.filter((l) => !haveKeys.has(logKey(l.user_id, l.start_time, l.end_time))),
      });
    }
  }

  for (const [key, { task: p, db }] of index) {
    if (claimed.has(key)) continue;
    const kraId = p.kra_id ? tKraByName.get(norm(p.kra_id[1])) : null;
    if (!kraId) { unresolvedKra.add(`${p.kra_id ? p.kra_id[1] : '(none)'} [${db}]`); continue; }
    creates.push({
      db, prodId: p.id, name: p.name,
      vals: {
        ...valsFrom(p, db),
        name: p.name, kra_id: kraId,
        external_ref: p.external_ref || false,
        active: true, published: true,
        ...(mapUid(db, p.user_id) ? { user_id: mapUid(db, p.user_id) } : {}),
      },
    });
  }

  // ── report ───────────────────────────────────────────────────────────────
  const before = {}, after = {};
  for (const t of tTasks) before[t.task_state] = (before[t.task_state] || 0) + 1;
  for (const t of tTasks) {
    const u = updates.find((x) => x.id === t.id);
    const s = u ? u.vals.task_state : t.task_state;
    after[s] = (after[s] || 0) + 1;
  }
  for (const c of creates) after[c.vals.task_state] = (after[c.vals.task_state] || 0) + 1;

  const srcTotal = SRC.dbs.reduce((a, d) => a + sources[d].tasks.length, 0);
  console.log(`source tasks total : ${srcTotal}   (indexed unique: ${index.size})`);
  console.log(`target tasks       : ${tTasks.length}`);
  console.log(`  matched to source: ${updates.length}`);
  console.log(`  no source match  : ${unmatched.length}`);
  console.log(`  to create        : ${creates.length}`);
  console.log(`  log sets to sync : ${logSync.length}`);

  console.log(`\nlane change:`);
  for (const s of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    console.log(`  ${s.padEnd(22)} ${String(before[s] || 0).padStart(3)}  ->  ${String(after[s] || 0).padStart(3)}`);
  }

  const apprBefore = tTasks.filter((t) => t.admin_approved).length;
  const apprAfter = updates.filter((u) => u.vals.admin_approved).length + creates.filter((c) => c.vals.admin_approved).length;
  const apprSrc = SRC.dbs.reduce((a, d) => a + sources[d].tasks.filter((t) => t.admin_approved).length, 0);
  console.log(`\nadmin_approved: ${apprBefore} -> ${apprAfter}   (sources say ${apprSrc})`);

  if (unresolvedUsers.size) {
    console.log(`\n⚠️  unresolved users: ${[...unresolvedUsers].join(', ')}`);
    console.log(`   -> ${droppedLogs} source session(s) cannot be attributed and will NOT be copied.`);
    console.log(`      timer_total_seconds is copied verbatim, so "Time:" stays correct;`);
    console.log(`      only the per-developer breakdown under-reports for these.`);
  }
  if (unresolvedKra.size) console.log(`⚠️  unresolved KRAs (tasks skipped): ${[...unresolvedKra].join(', ')}`);
  if (unmatched.length) {
    console.log(`\n⚠️  ${unmatched.length} target task(s) exist in no source — left untouched:`);
    unmatched.slice(0, 15).forEach((n) => console.log('   ' + n.slice(0, 80)));
  }

  const changed = updates.filter((u) => Math.abs((u.old.timer_total_seconds || 0) - u.vals.timer_total_seconds) > 1);
  if (changed.length) {
    console.log(`\n--- time corrections (${changed.length}), first 8 ---`);
    changed.slice(0, 8).forEach((u) =>
      console.log(`   ${hm(u.old.timer_total_seconds || 0).padStart(10)} -> ${hm(u.vals.timer_total_seconds).padStart(10)}   ${u.name.slice(0, 44)}`));
  }

  if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit.`); return; }

  // ── apply ────────────────────────────────────────────────────────────────
  console.log(`\napplying...`);
  for (const u of updates) await kw(tgt, 'kra.kpi', 'write', [[u.id], u.vals]);
  console.log(`  ${updates.length} task(s) updated`);

  for (const c of creates) {
    const id = await kw(tgt, 'kra.kpi', 'create', [c.vals]);
    for (const l of wantLogs({ id: c.prodId }, c.db)) {
      await kw(tgt, 'kpi.time.log', 'create', [{ kpi_id: id, user_id: l.user_id, start_time: l.start_time, end_time: l.end_time, is_active: false }]);
    }
  }
  console.log(`  ${creates.length} task(s) created`);

  let delN = 0, addN = 0;
  for (const s of logSync) {
    if (s.del.length) { await kw(tgt, 'kpi.time.log', 'unlink', [s.del]); delN += s.del.length; }
    for (const l of s.add) {
      await kw(tgt, 'kpi.time.log', 'create', [{ kpi_id: s.targetId, user_id: l.user_id, start_time: l.start_time, end_time: l.end_time, is_active: false }]);
      addN++;
    }
  }
  console.log(`  time logs: ${delN} removed, ${addN} added`);

  // Client wiring: link the client user to every root KRA so the portal resolves.
  const clientUid = tByLogin.get(norm(CLIENT_LOGIN));
  if (clientUid) {
    const roots = tKras.filter((k) => !k.parent_id && !(k.client_user_ids || []).includes(clientUid));
    if (roots.length) {
      await kw(tgt, 'kra.master', 'write', [roots.map((k) => k.id), { client_user_ids: [[4, clientUid]] }]);
    }
    console.log(`  linked '${CLIENT_LOGIN}' to ${roots.length} root KRA(s)`);
  } else {
    console.log(`  ⚠️  client user '${CLIENT_LOGIN}' not found — client wiring skipped`);
  }

  // ── prove every source is untouched ──────────────────────────────────────
  let ok = true;
  console.log('');
  for (const db of SRC.dbs) {
    const c = sources[db].conn, b = sources[db].fp;
    const now = {
      tasks: await ro(c, 'kra.kpi', 'search_count', [[]], sctx),
      logs: await ro(c, 'kpi.time.log', 'search_count', [[]], sctx),
      write: (await ro(c, 'kra.kpi', 'search_read', [[], ['write_date']],
        { ...sctx, order: 'write_date desc', limit: 1 }))[0]?.write_date || '',
    };
    const same = now.tasks === b.tasks && now.logs === b.logs && now.write === b.write;
    ok = ok && same;
    console.log(`${same ? '✅' : '❌'} ${db}: ${now.tasks} tasks, ${now.logs} logs, last write ${now.write}`);
  }
  console.log(ok ? '✅ all sources untouched' : '❌ A SOURCE CHANGED — investigate immediately');
  process.exitCode = ok ? 0 : 1;
})().catch((e) => { console.log('FATAL', e.message); process.exitCode = 1; });
