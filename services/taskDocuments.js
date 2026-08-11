// Task Related Documents — every task you are on, and the files attached to it.
//
// Wraps the same two routes the web screen uses:
//   /task_documents/list     — your tasks + per-task document counts
//   /task_documents/details  — one task's files / links / GitHub / manuals / docs
//
// Both are scoped server-side: the list ORs over the stored contributor fields
// (assignee, contributors, developers, testers, coordinators, leads) and the
// detail goes through _may_view_kpi_details. So there is nothing to filter here.
//
// Note the list route was returning an empty set to every developer until the
// domain was fixed — it searched a non-stored computed field, Odoo raised, and a
// bare except turned it into {status: False, tasks: []}. If this screen is ever
// blank again, check the server log first: the payload cannot tell "no tasks"
// apart from "the query blew up" on its own.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('TaskDocuments');

const MOCK_LIST = {
  status: true,
  assignees: [{ id: 1, name: 'Ravi' }],
  tasks: [
    {
      id: 1, name: 'Fix login bug', external_ref: 'BUG-001',
      assignee: 'Ravi', assignee_id: 1,
      priority: 'urgent', doc_count: 2, link_count: 1, github_count: 1,
      manual_count: 0, drive_count: 1, task_doc_count: 0, has_attachments: true,
    },
  ],
};

const MOCK_DETAILS = {
  status: true,
  task: { external_ref: 'REQ-001', related_req_ref: '', delivery_version: '', description: '' },
  documents: { files: [], links: [], github: [], manuals: [], task_docs: [] },
};

/** Every task the signed-in developer is on, with document counts. */
export async function fetchTaskDocuments(assigneeId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchTaskDocuments — no server, mock');
    return { ...MOCK_LIST, isMock: true };
  }
  const params = assigneeId ? { assignee_id: assigneeId } : {};
  const res = await jsonRpc(serverUrl, '/task_documents/list', params);
  log.info('task documents ←', { tasks: res?.tasks?.length ?? 0, status: res?.status });
  return res || { status: false, tasks: [], assignees: [] };
}

/** One task's documents, grouped by kind. */
export async function fetchTaskDocumentDetails(taskId) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchTaskDocumentDetails — no server, mock');
    return { ...MOCK_DETAILS, isMock: true };
  }
  const res = await jsonRpc(serverUrl, '/task_documents/details', { task_id: taskId });
  log.info('task document details ←', { task_id: taskId, status: res?.status });
  return res || { status: false, documents: {} };
}
