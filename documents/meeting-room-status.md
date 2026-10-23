# Our own meeting room: where we are (23 Oct 2026)

## Why

Client and team calls opened on the public meet.jit.si. Since 18 Oct 2026 it blocks every call until someone logs in with Google. We are moving calls to our own meeting room at **meet.alphalize.com**, running on the same PC as Odoo. No new computer is needed.

```
This same PC
 ├── Odoo             (already running)
 ├── WhatsApp server  (already running)
 ├── Web app          (already running)
 └── Meeting room     (new, being added)
```

Odoo stays in charge of who gets in. It sends the WhatsApp link, checks the client's number and hands them a short-lived pass. The meeting room only runs the call itself: sound, camera and screen share.

## Done

- [x] **Phone app** moved into its own folder, `application\`. All 388 tests pass, and the Android build works again (`expo-asset` pinned to the Expo 54 version).
- [x] **`meeting\` folder:** server settings, setup/start/stop scripts, branding (logo, name, colours, language, buttons) and a README.
- [x] **Odoo code:** passes for our own server, App ID and Secret boxes in Settings on both Odoo and web, a Test button, and the recorder able to find calls on meet.alphalize.com. Written and committed, **not live yet**.
- [x] **On this PC:** WSL and Docker Desktop installed, and a Windows Firewall rule allowing UDP 10000.
- [x] Everything committed on `senior` (1ab9c12, f0efc18), **not pushed yet**.

## Not done

| Step | Who | Notes |
|---|---|---|
| Open UDP port 10000 through the 3 routers | Network person | See the request below |
| Restart the PC once | Claude, after hours | About 5 minutes of downtime for Odoo and WhatsApp |
| Log in to the PC after the restart | Someone in the office | WhatsApp and Docker only start after a login |
| Switch on the meeting room, connect meet.alphalize.com through Cloudflare | Claude | |
| Put the Odoo code live, then fill in the App ID and Secret | Claude | Only after the meeting room works; backup first |
| Real call test from a phone on mobile data | Claude + you | Needs the router port open |
| Check that clients don't get moderator powers | Claude | During the call test |

## The office network

There are three routers in a row, so the port has to be forwarded on all three:

```
 Internet (2 lines)
      |
 192.168.3.1    provider modem/router
      |
 192.168.0.1    D-Link (combines the 2 lines)
      |
 192.168.1.99   FortiGate firewall (admin page closed to office computers)
      |
 192.168.1.211  this PC
```

## Ports

| Program | Port | Open to the internet? |
|---|---|---|
| Odoo | 8069 | No (reached through Cloudflare) |
| WhatsApp server | 8080 | No |
| Web app | 3100 | No |
| Meeting room page | 8000 | No (reached through Cloudflare) |
| **Meeting room sound and video** | **UDP 10000** | **Yes, this is the only new opening** |
| Remote Desktop | 3389 | **No, use FortiClient VPN instead** |

## Request for the network person

> **Request: open one port for our video-call server**
>
> 1. **Forward UDP port 10000** from the internet to **192.168.1.211**, through each box in turn:
>    - provider modem **192.168.3.1** → forward UDP 10000 to the D-Link
>    - D-Link **192.168.0.1** → forward UDP 10000 to the FortiGate's outside address
>    - FortiGate **192.168.1.99** → Virtual IP UDP 10000 → 192.168.1.211, plus an Accept policy (NAT off)
> 2. **Keep it on one internet line.** We have two lines, so UDP 10000 must come in and go out on the same one. Please tell us **that line's public IP address**, and whether it's fixed or changes.
> 3. **Only add rules.** No bridge mode, no DMZ, no change to existing settings. Odoo and WhatsApp run on this PC and must not go down. Please do it after office hours, and note the old settings first.
> 4. **Please don't open Remote Desktop (3389) to the internet.** If staff need to reach this PC from outside, please set up FortiClient VPN instead.
>
> Please reply with: **done**, the **public IP** of the line used, and whether that IP is **fixed**.

## What opening the port means

**Outsiders can't:** open Odoo, the database, WhatsApp or files, log in to the PC, or join or listen to a meeting (they'd need an Odoo pass, and calls are encrypted).

**Real issues:**

| Issue | How bad | Protection |
|---|---|---|
| The office's internet address becomes visible to everyone in a call (today Cloudflare hides it) | Medium, the main new thing | The FortiGate still blocks everything except UDP 10000 |
| Scanning bots notice the open port | Low | They only find the call relay, which ignores traffic that isn't part of a real call |
| Someone floods the port with junk | Low chance; calls stutter and the office internet slows down | The FortiGate can limit it; `stop-meeting.cmd` switches the meeting room off in seconds |
| A security hole in Jitsi | Low | Keep Jitsi updated (one line in `meeting\server\.env`, then run setup again) |

## Keeping the server up

- The network person only **adds** rules: no bridge mode, no DMZ, after hours, old settings noted first.
- The meeting room gets at most 4 GB of memory and 1 of the 2 processors, so calls can't starve Odoo.
- The meeting room is separate: if it crashes or is stopped, Odoo, WhatsApp and the web app carry on.
- The Odoo change goes live only after the meeting room works, with a backup first. Without the App ID and Secret filled in, Odoo behaves exactly as today.
- The only planned downtime is the one restart, about 5 minutes, after hours.

## The other option: a rented cloud server

About $5–10 a month. Everything built so far works there unchanged: the same `meeting\` folder, and Odoo only needs the new address.

| | This PC | Cloud server |
|---|---|---|
| Monthly cost | $0 | About $5–10 |
| Router changes | Yes, all 3 routers | None |
| Office address visible in calls | Yes | No, the server's address is |
| Shares CPU with Odoo | Yes | No |
| Public IP must stay fixed | Yes, or calls lose sound until updated | Fixed by the provider |

**Recommendation:** since Odoo and the database live on this PC, the cloud server is the safer choice. This PC works too, if the network person can open the port and the public IP is fixed.

## Starting by itself after a restart

| Part | After a restart |
|---|---|
| Odoo, database, Cloudflare tunnel | Start by themselves (Windows services) |
| WhatsApp server | Starts by itself (service `EvolutionAPI`, set up 23 Oct; takes over at the next restart) |
| Web app (3100) | Starts by itself (service `KraKpiWeb`, set up 23 Oct; takes over at the next restart) |
| Meeting room (Docker) | Only after someone logs in. Decided after choosing this PC or a cloud server |

## To discuss

- [ ] This PC or a cloud server?
- [ ] If this PC: has the network person replied (done, public IP, fixed or not)?
- [ ] Set the PC to log in to Windows by itself after a restart (truly always on, but anyone at the PC gets straight in)?
- [ ] Show our logo inside Odoo calls (one setting on the Odoo meeting page)?
- [ ] Push today's commits to GitHub?
- [ ] Later: move WhatsApp, the web app and Odoo into Docker too, and move the Odoo module into `odoo\`.
