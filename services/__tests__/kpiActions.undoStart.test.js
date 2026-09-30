// The two new server calls: Undo start, and the Module / App / EXE type on a
// self-created task. Same mock setup as attendance.test.js.

const mockConn = { serverUrl: '' };
const mockRpc = jest.fn();

jest.mock('../../api/session', () => ({
  getConnection: jest.fn(async () => mockConn),
}));
jest.mock('../../api/odooApi', () => ({
  jsonRpc: (...args) => mockRpc(...args),
  httpUpload: jest.fn(),
}));

const { undoTaskStart, selfCreateTask } = require('../kpiActions');

describe('kpiActions — undo start and deliverable type', () => {
  beforeEach(() => { mockRpc.mockReset(); mockConn.serverUrl = ''; });

  it('posts the task id to /kra_kpi/task/undo_start', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockResolvedValueOnce({ status: true, new_state: 'paused' });
    const res = await undoTaskStart(7);
    expect(mockRpc).toHaveBeenCalledWith('https://odoo.example.com', '/kra_kpi/task/undo_start', { kpi_id: 7 }, 30000);
    expect(res.new_state).toBe('paused');
  });

  it('sends nothing with no server configured', async () => {
    const res = await undoTaskStart(7);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(res.status).toBe(true);
  });

  it('sends deliverable_type on a new task', async () => {
    mockConn.serverUrl = 'https://odoo.example.com';
    mockRpc.mockResolvedValueOnce({ status: true });
    await selfCreateTask({ name: 'Build installer', kraId: 4, deliverableType: 'exe' });
    const [, path, params] = mockRpc.mock.calls[0];
    expect(path).toBe('/kra_kpi/task/self_create');
    expect(params.deliverable_type).toBe('exe');
  });
});
