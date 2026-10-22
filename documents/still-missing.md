# KRA KPI: still missing (22 Oct 2026)

**Key:** ✅ done · ❌ missing

## Missing features

| Feature | Odoo | Web | WhatsApp | App |
|---|---|---|---|---|
| Fix a declined request (client) | ❌ | ❌ | ✅ | ❌ |
| New / Destroy Database (client) | ❌ | ❌ | ✅ | ❌ |
| Live Databases (client) | ❌ | ❌ | ✅ | ❌ |
| Chat with the team (client) | ❌ | ❌ | ✅ | ❌ |
| Manager picks a developer for a discuss | ❌ | ✅ | ✅ | ❌ |

## Work left

- [ ] **Job 1: client links.** Add one new server door that gives a logged-in client a fresh link to the same page they use from WhatsApp. Then add four buttons in each of Odoo, Web and App: Fix declined request, New / Destroy Database, Live Databases, Chat.
- [ ] **Job 2: pick a developer.** The server part and the web button are done (kra-kpi-88: `kpi_doubt.chat_dev_options()` / `action_ask_developer()`, web Approvals ▸ 👨‍💻 Ask a developer). Still to add: the same button in Odoo and the app.
- [ ] **Check the web:** build it and click through New request (Photo / Video / Voice buttons).
- [ ] **Check the app:** run it on a phone and look at:
  - the task's 👤 Client section
  - the 💬 Chat reply
  - the Bug / Update requirement picker
  - the Needs Linking screen
- [ ] **Commit:** everything from today is still uncommitted (waiting for the go-ahead).

## Left out on purpose

- WhatsApp Needs Linking list and queue badges: WhatsApp has no queue list, by design.
