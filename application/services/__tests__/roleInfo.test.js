// The role lookup must never turn a network blip into "not an admin". What this
// pins down: a real answer is cached per uid; a failed lookup answers the cached
// role (fromServer:false) instead of guessing; the route's own {status:false}
// is a failure, not an empty role; and no server at all is the offline demo.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn() }));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const session = require('../../api/session');
const { jsonRpc } = require('../../api/odooApi');
const { fetchRoleInfo, cachedKpiRole } = require('../roleInfo');

beforeEach(async () => {
  await AsyncStorage.clear();
  jsonRpc.mockReset();
  jest.spyOn(session, 'getConnection').mockResolvedValue({ serverUrl: 'http://x' });
});
afterEach(() => jest.restoreAllMocks());

it('caches the server answer and reuses it when the server is unreachable', async () => {
  jsonRpc.mockResolvedValueOnce({ status: true, kpi_role: 'admin', is_admin: true });
  const ok = await fetchRoleInfo(7);
  expect(ok).toMatchObject({ fromServer: true, kpiRole: 'admin' });
  expect(await cachedKpiRole(7)).toBe('admin');

  jsonRpc.mockRejectedValueOnce(new Error('Network Error'));
  const off = await fetchRoleInfo(7);
  expect(off).toMatchObject({ fromServer: false, kpiRole: 'admin' });
});

it('treats {status:false} as a failure, not as a role', async () => {
  await session.saveRoleState(3, { kpiRole: 'admin' });
  jsonRpc.mockResolvedValueOnce({ status: false, message: 'boom' });
  const r = await fetchRoleInfo(3);
  expect(r.fromServer).toBe(false);
  expect(r.kpiRole).toBe('admin');           // the cached answer, untouched
  expect(await cachedKpiRole(3)).toBe('admin');
});

it('answers an empty role when it has never resolved one', async () => {
  jsonRpc.mockRejectedValueOnce(new Error('timeout'));
  const r = await fetchRoleInfo(99);
  expect(r).toMatchObject({ fromServer: false, kpiRole: '' });
});

it('derives the role from the flags on an older server and keeps other cached keys', async () => {
  await session.saveRoleState(5, { kpiRole: 'developer', other: 1 });
  jsonRpc.mockResolvedValueOnce({ status: true, is_owner: true });
  const r = await fetchRoleInfo(5);
  expect(r.kpiRole).toBe('admin');
  expect(await session.getRoleState(5)).toEqual({ kpiRole: 'admin', other: 1 });
});

it('is the offline demo when no server is configured', async () => {
  session.getConnection.mockResolvedValue({ serverUrl: '' });
  const r = await fetchRoleInfo(1);
  expect(r.offlineDemo).toBe(true);
  expect(jsonRpc).not.toHaveBeenCalled();
});
