# client-portal-invoices

Client **portal** half of `screens/ClientInvoices.js` (`portal=true`, route `myinvoices`,
[App.js:653](../../App.js#L653)). Yesterday's 15 shots in `6a6e591:screenshots/client-invoices/`
covered the **admin** half only; this is the other side of the same screen.

Tablet `R52N410F5QE`, Expo Go over Wi-Fi, live `369application`, logged in as client **Athul**
(3 invoices: one DUE, one CLAIMED, one PAID).

| File | What it evidences |
|---|---|
| `00-portal-home.png` | Client home — `REPORTS → Invoices` is the entry point |
| `01-invoice-list.png` | Header `Invoices` with **no `+`**; 4 chips `All 3 · Unpaid 1 · Claimed 1 · Paid 1`; row actions **Open · PDF · Share** only — no Mark Paid, no Revert; all three payment badges (`DUE` / `CLAIMED` / `PAID`) in one screen |
| `02-chip-unpaid.png` | **Unpaid excludes claims** — only `INV/2026/0189`; the CLAIMED one is absent, so `due` and `claimed` are genuinely separate |
| `03-chip-claimed.png` | `INV/2026/0171` — the same invoice `08-claimed-filter-finds-one.png` found admin-side, now reachable by the client too |
| `04-chip-paid.png` | `INV/2026/0082` |
| `05-detail-claimed.png` | `You reported paying this invoice.` + `Awaiting confirmation…`, **no** `Confirm payment` / `Not received`; button reads `Payment claim sent` so a client cannot claim twice; lines show `Quoted` with **no `· Actual`** |
| `06-detail-paid.png` | `Paid` badge; **no** admin paid-record banner (method/date/notes correctly withheld). **But `Paid · Administrator` is shown — see finding below** |
| `07-detail-due.png` | Zero-rate `per_task` invoice, 20 REQ/TASK lines, `Amount: 0.00` |
| `08-detail-due-bottom.png` | `I've paid` present; no Finalize / Send / Revise / Reset / Delete |
| `09-report-payment-dialog.png` | `Report payment` — 5 methods, Bank Transfer defaulted, optional reference. **Not submitted** (would notify admins and is admin-only to undo) |
| `10-pdf.png`, `11-pdf-folder-confirm.png`, `12-pdf-saved.png` | PDF download: SAF folder picker → Expo Go permission → back to invoice |
| `13-share.png` | Share sheet with `Invoice_INV_2026_0189_UNPAID.pdf` — no folder pick needed |

PDF verified on disk, not just by the absence of an error:
`/sdcard/Download/Apps/Invoice_INV_2026_0189_UNPAID.pdf`, 176 kB, 11:10.

## Finding — `paid_by_name` reaches the client

`06-detail-paid.png` shows **`Paid · Administrator`** to a client. It should not be there.

- `_serialize_for_ui(for_client=True)` exists precisely to strip this class of field, and its
  docstring is explicit: *"a client can read the JSON response straight out of the browser, so a
  template-only guard hides nothing at all."* It strips `payment_notes`, `payment_method`,
  `payment_method_label` and **`paid_by`**.
- But `paid_by_name` is set in `_serialize_for_list()`
  ([kpi_client_invoice.py:697](../../odoo_modules/kra_kpi_module/models/kpi_client_invoice.py#L697)),
  which `_serialize_for_ui` calls unconditionally before the `for_client` strip — so the sibling
  field carrying the same value survives.
- The app then renders it at [ClientInvoices.js:606](../../screens/ClientInvoices.js#L606) with
  **no `!portal` gate**, unlike the paid-record block immediately below it — whose comment claims
  *"the server withholds these fields from clients"*. For this field it does not.
- `payment_date` (line 696) rides along the same way; the portal happens not to render it.

Fix belongs server-side, in the `for_client` strip — hiding it in the app alone would leave it on
the wire, which is the exact failure the docstring warns about.

## Not verifiable in this account

No invoice in Athul's set has `unpaid_reason`, so the §1 claim that a reversal is published
*"both sides"* is still **unproven on the portal side**. Needs an admin to revert one, then a
re-check of the list red line and the detail banner.

---

# AFTER — the fixes (18 Aug)

Four gaps against the web, plus the leak. App reloaded from Metro (Expo Go restarted against
`exp://10.90.130.175:8081` — Fast Refresh did not pick the edits up), same client **Athul**.

| File | What it evidences |
|---|---|
| `14-AFTER-list-ive-paid.png` | **Gap 1 fixed.** `INV/2026/0189` (DUE) gains a green **`I've paid`** on the row; `INV/2026/0171` (CLAIMED) shows amber **`Awaiting confirmation`**; `INV/2026/0082` (PAID) gets neither. Matches the web, where the button has always been on the row |
| `15-AFTER-detail-claim-echo.png` | **Gap 2 fixed.** Was *"You reported paying this invoice."* — now *"You reported paying this invoice **by Bank Transfer on 2026-08-14 07:38:36**."* |
| `16-AFTER-detail-paid-no-staff-name.png` | **Leak closed.** `Status Finalized` alone — compare `06-detail-paid.png`, which read `Paid · Administrator` |

## Verified

- `npx jest` — 96 passing, unchanged.
- `screens/ClientInvoices.js` parses under `babel-preset-expo`; both changed Python files parse.

## Code-complete but NOT visually proven

Gaps 3 and 4 have no data to render in this account. Confirmed by reading the database rather than
assuming:

```
SELECT id, name, COALESCE(client_paid_notes,'<NULL>'), client_paid_method, revision_count ...
171|INV/2026/0171|<NULL>|bank_transfer|0
189|INV/2026/0189|<NULL>||0
82 |INV/2026/0082|<NULL>|bank_transfer|0
```

- **Gap 3** (client's own reference note, `!portal` gate removed) — every `client_paid_notes` is
  NULL, so there is nothing to show. Proving it needs a claim submitted *with* a reference.
- **Gap 4** (`revised N times`) — every `revision_count` is 0, so the `> 1` branch never fires.

## Server fix — WRITTEN, NOT DEPLOYED

`_serialize_for_list(for_client=False)` now pops `paid_by_name` and `payment_date`, and both the
detail route (via `_serialize_for_ui`) and the **list** route pass the flag. Until the module is
copied into the Program Files addons directory and Odoo restarted, **the fields are still on the
wire** — the app's own `!portal` gate is what is currently hiding them, which is exactly the
template-only guard the server docstring warns is not enough.

Python-only change, no new fields and no manifest bump, so this needs a plain **restart** — not
`-u kra_kpi_module`.
