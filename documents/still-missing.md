# KRA KPI: still missing (updated 23 Oct 2026)

**Key:** ✅ done · ❌ missing

## Features

| Feature | Odoo | Web | WhatsApp | App |
|---|---|---|---|---|
| Fix a declined request (client) | ✅ | ✅ | ✅ | ✅ |
| New / Destroy Database (client) | ✅ | ✅ | ✅ | ✅ |
| Live Databases (client) | ✅ | ✅ | ✅ | ✅ |
| Chat with the team (client) | ✅ | ✅ | ✅ | ✅ |
| Manager picks a developer for a discuss | ❌ | ✅ | ✅ | ❌ |

The client buttons open the same pages a client gets from WhatsApp. Fix and New / Destroy Database show only when the client has a WhatsApp group.

## Work left

- [ ] **Pick a developer in Odoo and the app.** Odoo and the app have no screen that lists client messages, so build a small Client messages screen in each: list, Reply, 👨‍💻 Ask a developer. Reuse `kpi.doubt.chat_dev_options()` / `action_ask_developer()` the way the web does.
- [ ] **Try the client buttons as a real client:**
  - web portal home: "More you can do"
  - app: Requests screen, the row at the top
- [ ] **Commit:** the client buttons are live on Odoo but not committed yet.

## Web vs Odoo (deep check, 23 Oct)

Every Odoo screen was compared with its web page. Done on the web today: the client send-back alert, the "Welcome back" popup after auto-away, Meetings (Draft with AI, Record this meeting, Recordings, Log tab, Employee and Removed columns), Databases "See the tasks", WhatsApp group Advanced (invite link / group id), and the full Create KPI form (user group, actions, next KPI, warehouse, file, related links, name heads-up, "+" quick creates, checklist and guideline library) plus KPI Details.

Also done (23 Oct, later):
- [x] **Client Talks on the web**: 💬 Discussions, 📅 Meetings (Full / Compact), ❓ Questions, same as Odoo's new menu, plus 📅 Meetings in the task panel. "📅 Open meeting" opens `/meetings?id=…`.
- [x] **Odoo "Draft with AI" now keeps the summary** (live 7.78).
- [x] **Upload Requirements "Add photos / video" works** in Odoo, the app and the web (live 7.81). New route `/kpi_requirements/attach_media`. These photos never count as the user manual.

**Done on the web, 23 Oct (evening): admin lists, task board and small items, the same as Odoo**

**Admin lists**
- [x] Setup screens: search box, filters, group-by (all of them).
- [x] Databases: filters (Suspended, Disconnected, Expiring in 30 days, Expired, No client, Archived), bulk Suspend / Disconnect / Reactivate, form rules and alerts, hide "Tell the client" when refusing.
- [x] WhatsApp Groups: client per member row, Sub-clients and Client Users tabs, Ours / Client lock each other.
- [x] Approvals desk: search, "Waiting over a week", group by client or day, Open on database items.
- [x] Login Management: role filter, login under each name.
- [x] Action Log: source and Successful filters, user agent and contact.
- [x] AI Assistant Chats: full answer, time, search, My chats / Today.
- [x] Invoices list: PDF, Mark paid and Revert per row; Invoice Date and Quoted / Adjust columns; date presets on New invoice.
- [x] Backups: incremental reference date, last full backup, restored by. (Access stays System-only on purpose.)

**Task board (small)**
- [x] More buttons on the card itself (Switch, Undo start, Reassign, Approve / Reject, Add time, Delete).
- [x] Switch on any running task and to any startable task.
- [x] Card: "Client sent it back N×" with media, Full complete prompt, Bill now.
- [x] Files tab: sort menus, "View note", View for the task's own file, "Show more" on long notes.
- [x] Wording of Undo start and Revert sign-off; admin delete reason and self-created send-back note optional.
- [x] Search in the "Not on a task?" meeting picker; presence line in the End Workday summary.

**Other small items**
- [x] Reminders: link to a whole client; Owner field for System users.
- [x] Meetings list: Upcoming and No time set filters, search, group by client.
- [x] Attention report: Oldest pause and Recent pauses tiles, Clear filters.
- [x] Employee tracker: Sessions column and sessions table.
- [x] Daily reports: see older than the last 90.
- [x] Refresh buttons on Snapshots and My Workday.

## Left out on purpose

- WhatsApp Needs Linking list and queue badges: WhatsApp has no queue list, by design.
- Web differs from Odoo on purpose: WhatsApp number is the login mobile, logo saved as PNG, Partial finish sits inside Complete, fixed board lanes, Client Files includes existing tasks by default, developer country is edited in Login Management.
