# KRA/KPI — session handover (14 Aug 2026)

Replaces the earlier 14 Aug handover (recoverable from git history). Everything here was verified
against the live database, the served asset bundle or the running server — not recalled.

---

## 0. The environment changed: neonize was upgraded

**`neonize 0.4.1.post0` → `0.4.3.post0`.** This is a pip install on the server, so **no git
checkout reproduces it** — a fresh machine needs it done again.

It fixed three things at once, all of which the previous handover recorded as permanent:

- `get_joined_groups()` — was dying inside the Go binary, now returns all **61** groups with names.
- `get_group_info(jid)` — was unusable, now works.
- `SendMessageReturnFunction` — group sends dispatched fine but the *reply* would not parse, so a
  delivered message was recorded as `failed`. Now parses.

**Backup, for rollback:** the 0.4.1 package directory and the pairing database were copied to
`neonize-backup-20260814/` (`pkg/neonize`, `pkg/neonize-0.4.1.post0.dist-info`, `sessions/`).
**That copy is currently in a session temp folder and needs moving somewhere durable.** Without it a
rollback means re-pairing the OTP number by QR: whatsmeow migrates the session `.db` forward on
first use by a newer version and does not migrate back.

Rollback = stop both services, restore `pkg/neonize` over site-packages **and** the
`369application_session_2.db` pairing file, start.

### Two hypotheses that were investigated and disproven — do not re-chase

- **Protobuf version mismatch.** No. The generated code declares `Protobuf Python Version: 7.34.1`
  and validates against exactly the installed 7.34.1. neonize is also the only package in the
  environment that depends on protobuf.
- **Schema drift between separately-sourced halves.** No. `neonize-windows-amd64.dll` and
  `proto/Neonize_pb2.py` share one timestamp — they shipped in the same wheel.
  `NO CHECKED-IN PROTOBUF GENCODE` is a routine protoc marker, and the odd
  `from waVnameCert import …` imports are simply how neonize ships.

It was a plain library bug with a plain upgrade path.

---

## 1. What the WhatsApp group feature does now

**Proven end to end today** — a real group send finally succeeded (`whatsapp_message` 1517, `sent`,
to a throwaway group named "Alpha"). Every earlier attempt in this project used a fabricated JID,
so this was the one open verification from the previous handover.

- **Group picker** lists all 61 joined groups with real WhatsApp names, member counts and a filter,
  merged with groups learned from inbound messages (`kpi.wa.group`) so it still works with the phone
  offline.
- **Per-event control** (`kpi.wa.group.event`, new): each update has its own switch and its own
  editable wording, with a live preview, click-to-insert fields, Reset to default and its own
  Send test. Registry lives in `models/kpi_wa_group_event.py` — adding an event is a dict entry.

  | event | default |
  |---|---|
  | `workday_start`, `workday_end` | **on** (existing behaviour) |
  | `complete`, `final_approved`, `start`, `pause`, `resume` | **off** |

  New events are seeded **off** deliberately: task-level reporting for nine developers is hundreds
  of messages a day.

- Task events hook `kpi_notify._notify()` **before** its four early returns, because those govern
  per-person DMs (master switch, per-event mute, whether anyone has a phone). The group is a
  separate channel with its own switch. `workday_started` is explicitly excluded from that hook —
  it already posts from `_get_or_open_today`, and hooking it in both places double-posts.

- Wording is rendered with `str.replace`, **never `str.format`**: templates are hand-written and
  contain emoji, quotes and sometimes a stray brace, all of which make `format()` raise. Ending a
  workday is one-way, so a typo in a message must never be able to block it. Unknown `{tokens}`
  survive as literal text. Covered by `scripts`-free unit checks that read the real function and the
  real defaults out of the source.

- A line whose tokens **all** resolved to empty is dropped, decoration included — otherwise an empty
  note renders as a bare `📝 ""`. The test is on the tokens, not on how the finished line looks: an
  emoji is enough to defeat a text-based check.

---

## 2. The client-group incident — read this before touching the picker

Four test messages were posted into **"Nex Gen 369Ai.biz"**, a live client group, because:

1. **Captured groups had no names.** `record_seen(jid, name='')` stored only the id, so the picker
   showed `120363405315530367@g.us` and it was assumed to be the dev group.
2. **A delivered message was reported as failed.** The `SendMessageReturnFunction` parse error made
   every successful send look like a failure, which invited a retry — one mistake became four.

Guards now in place, all of which should stay:

- A group **cannot be selected until it is named**, enforced in the route as well as the button.
- Selecting *and* testing both require a confirmation naming the destination; `/kpi_wa_group/test`
  and `/kpi_wa_group/test_event` refuse unless the caller echoes back `confirm_jid`.
- Test messages are prefixed `🧪 Test message — no real activity.`
- A send whose receipt cannot be parsed is recorded as `sent`, not `failed`, so nothing retries.

---

## 3. Answered: §2 of the previous handover

The ask was *"the dev numbers are assigned so when logged in send the msg in the grp from their
number"*.

**Rejected, with the user's agreement.** Sending *as* a number is not possible from a stored number:
WhatsApp only lets software send as an account once that account authorises it as a linked device
(a one-time QR or 8-character code from the person's own phone — `PairPhone` exists in neonize and
would work). Group membership is not a substitute; membership lets *their* number post, linking lets
*Odoo* post as them, and both would be needed.

Decision: **one company number posts and @-mentions the developer.**

---

## 4. Traps in this environment

- **Deploy is a copy.** Robocopy repo → `C:\Program Files\Odoo 19.0.20260119\server\odoo\addons\`,
  then stop services → `-u kra_kpi_module --stop-after-init` → start. Verify with
  `select state, latest_version from ir_module_module`, never the exit code. Live db is
  **`369application`** (not `sales_test`, which several scripts still assume).
- **Python changes need a full service restart.** Neither service runs with `--dev=reload`, so a
  registry reload does not re-import edited modules.
- **The asset URL only changes when the bundle content does — and the `/odoo` HTML that references
  it can itself be cached.** Bump the manifest version on every JS change and hard-reload when
  testing. Delete `ir.attachment` rows matching `web.assets%` to force regeneration, then read the
  bundle back: verified-in-source is not verified-as-shipped.
- **A Go-level access violation is a process kill, not an exception.** No Python `try/except` can
  contain it — it takes the whole Odoo server down. That is why the invite-link routes
  (`wa_group_peek`, `wa_group_join`) are still refused in Python rather than re-armed; with 61
  groups listed by name they solve a problem that no longer exists.
- **`odoo_modules/whatsapp_neonize/` in this repo is stale and is NOT what runs.** `addons_path`
  covers only the Program Files directory. Read the installed copy when reasoning about gateway
  behaviour. This cost real time today.
- **Do not install `whatsapp_gateway`** (present in the addons directory, uninstalled). Its
  migration drops six columns this feature reads.
- **`--logfile=-` writes a file literally named `-`.** Use `Select-String` on the output instead.
- **`node --check` cannot see unbalanced tags inside a template literal.** Always also parse the OWL
  template as XML.
- **Odoo refuses remote calls to `_`-prefixed methods.**

---

## 5. Open — nothing here is done

1. **OTP has not been re-proven since the neonize upgrade.** The most recent personal send in
   `whatsapp_message` is 6 Aug. The session reconnects and the client is live, but only a real
   mobile-app login proves the channel. **This is the highest-priority check**, and the rollback
   above exists for it.
2. **`sales_test` is broken** — `column res_company.kpi_wa_group_jid does not exist`. The Python is
   shared from the addons directory but that database was never upgraded. **The e2e suites run
   against it, so the test baseline is currently meaningless.** Fix with `-u kra_kpi_module`, then
   re-run: baseline was `e2e-client-flow 27/27`, `e2e-billing-dedup 4/4`,
   `e2e-invoice-payments 45/45`, `jest 71/71`.
3. **Developer numbers: 0 of 14** have `kpi_wa_number`, so every `{dev}` mention renders as a plain
   name rather than a tap-able mention. Entered at Configuration → Developers;
   `normalize_wa` already prefixes the dial code, so saved numbers clear the ≥11-digit bar.
4. **The reply parser has still never seen a real inbound message.** It was dead from 24 Jul until
   it was repaired, and now runs from a `whatsapp.message` create hook.
5. **The React Native Configuration screen has not been updated** for per-event control — web only.
6. **Move the neonize backup somewhere durable** (see §0).
7. `scripts/deploy-upgrade.mjs` hardcodes `DB = 'sales_test'`; it should take the database as an
   argument the way `check-bundle.mjs` does.
8. **Auto-closed workdays post nothing** — `_close_overdue` and `_cron_close_idle_workdays` call
   `_finalize_day_cleanup` directly and never `action_end_day`, where the group hook lives. A
   developer who forgets to end their day gets a start post and no end post. Flagged, not fixed.
9. The app still needs an EAS build for its half of the earlier work.

---

## 6. `[APITEST]` fixtures

Root clients are stable (the suites reuse a fixed tree). **Tasks and invoices still grow on every
run** by design. `scripts/cleanup-apitest.mjs` removes them (dry-run by default, `--yes` to act);
the user chose to keep them.
