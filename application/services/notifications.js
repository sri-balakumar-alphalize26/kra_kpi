// Notifications data service. Mirrors the Odoo controller routes in kra_api.py
// (/kpi_notifications/*). The server scopes every row to the logged-in user, so
// admins/owner/coordinator get notifications for all employees' assignment/upload
// events while a developer only gets rows for their own tasks — no client-side
// role logic is needed. Falls back to mock data when no server is configured.
//
// Notification shape (from get_notifications map_rec):
//   { id, kpi_id, kpi_name, developer, client_name, event, title, body, role,
//     is_read, created_at }
// `developer` + `client_name` let the feed show WHO and WHICH CLIENT each row is
// about — only rendered for admins (see isAdmin below), since a developer seeing
// their own name on every row is noise.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Notifications');

const MOCK_ITEMS = [
  {
    id: 1, kpi_id: 101, kpi_name: '[Update] Fix login redirect',
    event: 'task_assigned', title: 'New task assigned',
    body: '🎯 Task assigned to Dev\n[Update] Fix login redirect',
    role: 'developer', is_read: false, created_at: '2026-07-13 10:15:00',
  },
  {
    id: 2, kpi_id: 102, kpi_name: 'REQ-0007 Export to PDF',
    event: 'task_created', title: 'New task added',
    body: '🆕 New Task Created\nREQ-0007 Export to PDF',
    role: 'coordinator', is_read: true, created_at: '2026-07-13 09:40:00',
  },
];

// Fetch the feed. Returns { items, unreadCount, isAdmin, isMock }.
export async function fetchNotifications({ limit = 50, offset = 0, onlyUnread = false } = {}) {
  const { serverUrl } = await getConnection();
  if (serverUrl) {
    const res = await jsonRpc(serverUrl, '/kpi_notifications/get', {
      limit, offset, only_unread: onlyUnread,
    });
    const items = res?.items || [];
    log.info('fetchNotifications ←', { count: items.length, unread: res?.unread_count, isAdmin: !!res?.is_admin });
    return { items, unreadCount: res?.unread_count || 0, isAdmin: !!res?.is_admin, isMock: false };
  }
  log.info('fetchNotifications — no server, using mock');
  await new Promise((r) => setTimeout(r, 300));
  const items = onlyUnread ? MOCK_ITEMS.filter((i) => !i.is_read) : MOCK_ITEMS;
  return {
    items,
    unreadCount: MOCK_ITEMS.filter((i) => !i.is_read).length,
    isAdmin: true,          // offline demo → show the admin view
    isMock: true,
  };
}

// Mark notifications read. Pass an array of ids, or omit to mark ALL read.
// Returns { unreadCount, isMock }.
export async function markRead(ids) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('markRead (mock, not sent)', ids);
    return { unreadCount: 0, isMock: true };
  }
  const params = ids && ids.length ? { ids } : {};
  const res = await jsonRpc(serverUrl, '/kpi_notifications/mark_read', params);
  return { unreadCount: res?.unread_count || 0, isMock: false };
}

// Cheap badge poll — just the unread count. Returns a number.
export async function fetchUnreadCount() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return MOCK_ITEMS.filter((i) => !i.is_read).length;
  const res = await jsonRpc(serverUrl, '/kpi_notifications/unread_count', {});
  return res?.unread_count || 0;
}
