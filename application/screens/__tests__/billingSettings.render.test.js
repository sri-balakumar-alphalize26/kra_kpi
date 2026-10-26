// BillingSettings renders against the service's mock data (no server), which is
// the /kpi_billing/config shape. What this pins down: the Default section opens
// with its prices, a client with no price of its own and no Default for a work
// type is counted as "missing", and a server refusal shows the lock instead of
// a form whose every save would fail.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ getConnection: jest.fn(async () => ({ serverUrl: '' })) }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const billing = require('../../services/billing');
const BillingSettings = require('../BillingSettings').default;

describe('BillingSettings', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows the Default prices and the missing ones for a client', async () => {
    const { getByText, getAllByText } = render(<BillingSettings onBack={() => {}} />);
    await waitFor(() => getByText('Default (every client)'), { timeout: 8000 });
    // The mock Default has a Requirement price only.
    expect(getByText('₹ 5000.00')).toBeTruthy();
    // Demo Client: Requirement falls back to the Default, the other three are missing.
    expect(getByText('3 missing')).toBeTruthy();
    fireEvent.press(getByText('Demo Client'));
    expect(getByText('Send invoices')).toBeTruthy();
    expect(getAllByText('⚠ No price: no bill can be made').length).toBe(3);
    // First render in the file pays the module warm-up.
  }, 30000);

  it('opens the price editor from Add price', async () => {
    const { getByText } = render(<BillingSettings onBack={() => {}} />);
    await waitFor(() => getByText('Add price'));
    fireEvent.press(getByText('Add price'));
    expect(getByText('New price')).toBeTruthy();
    expect(getByText('Amount (per task)')).toBeTruthy();
  });

  it('shows the lock when the server refuses', async () => {
    jest.spyOn(billing, 'fetchBilling').mockResolvedValue({ status: false, message: 'Only an admin can change billing.' });
    const { getByText, queryByText } = render(<BillingSettings onBack={() => {}} />);
    await waitFor(() => getByText('Admins only'));
    expect(getByText('Only an admin can change billing.')).toBeTruthy();
    expect(queryByText('Add price')).toBeNull();
  });
});
