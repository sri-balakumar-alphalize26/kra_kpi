# Latest fixes, 22 Oct 2026 (evening)

All of these are live on the server and pushed to GitHub (branch `senior`).

## 1. Client requests no longer wait for a second approval

- **Problem:** it happened when a client created a new requirement (e.g. REQ-011). The admin accepted it and gave it a developer. The developer then could not start for 5 minutes, and saw "REQ-011 is waiting for the client to approve who works on it". The client was being asked to approve something they had asked for themselves.
- **Bugs and updates too:** the same 5-minute wait applied to a client's Bug and Update, for example BUG-002 and UPT-001 today. Nobody happened to try to start those inside the 5 minutes, so it went unnoticed.
- **Fix:** anything the client raises (Requirement, Bug or Update, from the WhatsApp form, the client portal or the app) can start as soon as the admin accepts it and assigns a developer.
- **Still the same:** tasks the team creates for a client (KPI Action ▸ New Task) still ask the client to approve.
- **Wording:** messages and screens now say "It can start now". This covers the admin Accept page, the manager's WhatsApp reply, the client portal, and the Configuration screens in Odoo, web and app.

## 2. Photos and videos open in the popup on the admin Accept / Refuse page

- **Problem:**
  - Tapping a client's photo opened a popup titled "file" that said "This file cannot be shown here".
  - Videos only played in their small box.
- **Fix:**
  - Photos open in the popup.
  - Videos show a ▶ preview, and a tap plays them in the popup with controls.
- **Also:** the Type in the confirm popup now shows the name typed for "Other", e.g. "Other: Website", instead of only "Other".
- **Note:** an iPhone `.MOV` video may not play in some browsers. Download still works.

## 3. No duplicate menu in the WhatsApp staff group

- **Problem:** after a developer took a task, the menu arrived twice, once as a poll and again as a numbered text list ("Reply with the number").
- **Cause:** the live server was restarting at that moment. The poll was sent, but saving its id failed, so the bot thought it had failed and sent the text copy too.
- **Fix:** the text copy is only sent when the poll itself fails to send.
- **Also:** live restarts are now kept to quiet times unless asked.

## 4. Team replies to a client go through the chat page

- **Before:** a team reply from 💬 Chat was pasted into the client's WhatsApp group.
- **Now:** the group gets a short note with a link: "the Alphalize team replied about REQ-… — open the chat to read it and reply". The conversation carries on there.

## 5. Typed "stop" in the staff group means pause

- "stop" / "stop task": the bot asks first, then asks for the reason.
- "cancel" / "exit" only answer someone who is partway through a step, so the bot no longer replies "Stopped." to everyone.

## Good to know

- The group member "🥰Venikarthick🥰" is linked to the user Nishanthini, so their WhatsApp messages run as Nishanthini. Correct the link in the WhatsApp group members setup if they are different people.
