# Meeting room (meet.alphalize.com)

Our own video call server. Client and team calls from WhatsApp and Odoo run here instead of the public meet.jit.si, which since 18 Oct 2026 blocks every call until someone signs in with Google.

It runs on the same PC as Odoo and WhatsApp, inside Docker, and comes back by itself after a restart.

```
 Client taps the WhatsApp link
        |
        v
 krakpi.alphalize.com/kpi/meet/...   (Odoo page: checks the number, gives a pass)
        |
        v
 meet.alphalize.com                  (this server: lets in only people with a pass)
   page + chat  -> Cloudflare tunnel -> this PC, port 8000
   sound/video  -> office router     -> this PC, UDP port 10000
```

## What is in this folder

| Path | What it is |
|---|---|
| `server/.env.example` | All server settings, with notes. Setup copies it to `server/.env`, which holds the secrets and is never committed. |
| `server/setup-meeting.ps1` | One-time setup. It fills in the secrets and downloads the official Jitsi files into `server/jitsi/`. Run it again to update Jitsi. |
| `server/start-meeting.cmd` | Start, or apply a change to settings or branding. |
| `server/stop-meeting.cmd` | Stop. Calls in progress end. Nothing is deleted. |
| `server/docker-compose.override.yml` | Our only addition to Jitsi's official files: the logo. |
| `branding/` | The look and behaviour of the call screen. See "Change the look" below. |

## First-time setup

1. Install Docker Desktop (needs admin and one PC restart), and tick "Start Docker Desktop when you sign in".
2. In `server/`, run `powershell -ExecutionPolicy Bypass -File setup-meeting.ps1`. At the end it prints a **Jitsi App ID** and a **Jitsi App Secret**.
3. Run `server/start-meeting.cmd`.
4. Cloudflare tunnel: in `C:\Users\shan\.cloudflared\config.yml`, add these lines above the `http_status:404` line:
   ```
     - hostname: meet.alphalize.com
       service: http://localhost:8000
   ```
   Then run `cloudflared tunnel route dns ead12143-37e0-4df0-bcf2-103df71fad5c meet.alphalize.com` and restart the "cloudflared" Windows service.
5. Router: forward **UDP port 10000** to this PC (192.168.1.211). In Windows Firewall, allow inbound UDP 10000.
6. In Odoo, go to Settings › AI & Transcription › Meeting Server. Set **Self-hosted Jitsi URL** to `https://meet.alphalize.com` and paste the App ID and App Secret. Leave the 8x8 boxes empty, then press **Test Meeting Server**.

## Change the look

Edit a file in `branding/`, run `server/start-meeting.cmd`, then reload the meeting page.

| What | Where |
|---|---|
| Logo in the call corner | replace `branding/images/alphalize-logo.png` (keep the name) |
| Name ("Alphalize Meet"), logo link, background colour, app prompts | `branding/custom-interface_config.js` |
| Language, camera or mic off on join, video quality, buttons on a directly opened room | `branding/custom-config.js` |
| Lobby (waiting room), welcome page | `server/.env` (`ENABLE_LOBBY`, `ENABLE_WELCOME_PAGE`) |

### Who decides what

Clients and staff open calls through the Odoo page, and **that page has the last word** on these, whatever `branding/` says:

- the buttons: only microphone, camera, screen share and leave
- no name screen (the name comes from Odoo)
- the "You left the meeting" box after hang-up
- whether Jitsi's corner logo shows (currently hidden)

These are set in `odoo_modules/kra_kpi_module/controllers/kpi_meeting_page.py`, in the `configOverwrite` and `interfaceConfigOverwrite` blocks. To show our logo in Odoo calls, `SHOW_JITSI_WATERMARK` there has to become `true`.

## Where the meeting code lives

Odoo only loads code from inside its module, so this part stays there:

| File | Does |
|---|---|
| `odoo_modules/kra_kpi_module/models/kpi_meeting.py` | Meeting records. `meet_jwt()` signs the pass, `meet_domain()` names the server, and `_start_recorder()` starts the recorder. |
| `odoo_modules/kra_kpi_module/controllers/kpi_meeting_page.py` | The page clients open: checks the number, embeds the call, reports joins and leaves. |
| `odoo_modules/kra_kpi_module/tools/meeting_recorder.py` | The recorder: a hidden browser that joins the call and records the sound. |
| `odoo_modules/kra_kpi_module/models/kpi_ai_config.py` + `views/kpi_ai_config_views.xml` | The Meeting Server settings screen and its Test button. |
| `web/components/settings/AiConfig.jsx` | The same settings screen in the web app. |

## When something is wrong

| Symptom | Likely cause |
|---|---|
| Meeting page shows a log-in box | Odoo's App ID or Secret doesn't match `server/.env`. Press Test Meeting Server. |
| People join but can't hear or see each other | UDP 10000 isn't reaching this PC (router or firewall), or the public IP changed. Update `JVB_ADVERTISE_IPS` in `server/.env`, then start again. |
| meet.alphalize.com doesn't open | Docker Desktop isn't running, or the cloudflared service is stopped. |
