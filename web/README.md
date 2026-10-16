# KRA KPI web

Browser frontend for the KRA KPI system — a Jira-style UI on top of the
`kra_kpi_module` Odoo backend. Same stack and architecture as the 369Mart site:
Next.js (App Router) + React, plain JavaScript, hand-written CSS, one proxy
route to Odoo, httpOnly session cookie.

The mobile app in the parent folder is untouched; this app copies its services
and utilities, never imports across.

## Run it

```
cp .env.example .env.local      # set ODOO_URL and ODOO_DB
npm install
npm run dev                     # http://localhost:3100
```

Sign in with a mobile number set up in Login management (same as the phone),
or with an Odoo login on the second tab.

## How it is wired

- `app/api/kpi/[...path]/route.js` — the one door to Odoo. `/api/kpi/<route>` →
  `<ODOO_URL>/<route>`; wraps/unwraps JSON-RPC, streams downloads, forwards
  multipart uploads, maps Odoo errors to HTTP statuses, carries the session cookie.
- `app/api/auth/*` — sign-in (`/kpi_app/login`, `/web/session/authenticate`,
  WhatsApp OTP), `me`, `logout`. These are the only routes that set cookies.
- `middleware.js` — cookie-presence gating and role routing (`/portal` for
  clients, everything else for developers and admins).
- `lib/api.js` — browser side: `rpc`, `read` (15 s cache), `upload`, `href`,
  `serverNow`. `lib/useFetch.js` — `useResource` (polling, keep-last) and `useAction`.
- `components/shell` — Gate (who am I), Shell (top nav, sidebar, avatar menu, flags).
- `app/themes/tokens.css` — the five looks as CSS variables; `data-theme` on `<html>`.
  Exported from the design canvas; the component classes in `components/ui/ui.css` too.

## Adding a screen

1. Port the mobile service (`../services/x.js`) to `lib/services/x.js`:
   `jsonRpc(serverUrl, path, params)` → `rpc(path, params)`; drop `getConnection()`.
2. Build the page under `app/(work)/<section>/page.jsx` (or `app/portal/...`)
   from the matching artboard on the canvas, using `components/ui`.
3. Add it to `lib/nav.js` if it needs a sidebar or top-nav entry.
