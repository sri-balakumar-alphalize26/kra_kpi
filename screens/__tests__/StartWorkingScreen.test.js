import React from 'react';
import { render } from '@testing-library/react-native';

// Control what the PIN screen sees from the server.
jest.mock('../../services/pairing', () => ({
  generatePin: jest.fn(),
  pairingStatus: jest.fn().mockResolvedValue({ paired: false, mode: 'start', dayDone: false }),
  boardWebUrl: jest.fn().mockResolvedValue(''),
}));
// Pure-visual children that pull in native drawing → render nothing in tests.
jest.mock('../../components/GradientBackground', () => () => null);
jest.mock('../../components/PairArt', () => () => null);

import StartWorkingScreen from '../StartWorkingScreen';
import { generatePin } from '../../services/pairing';

const noop = () => {};

describe('StartWorkingScreen — Start / Continue / Ended states', () => {
  afterEach(() => jest.clearAllMocks());

  test('fresh start → "Start Working"', async () => {
    generatePin.mockResolvedValue({ pin: '1234', expires_at: null, mode: 'start', done: false });
    const { findByText } = render(
      <StartWorkingScreen onBack={noop} onLogout={noop} onPaired={noop} />,
    );
    expect(await findByText('Start Working')).toBeTruthy();
  });

  test('open-but-unpaired → "Continue Working"', async () => {
    generatePin.mockResolvedValue({ pin: '5678', expires_at: null, mode: 'resume', done: false });
    const { findByText } = render(
      <StartWorkingScreen onBack={noop} onLogout={noop} onPaired={noop} />,
    );
    expect(await findByText('Continue Working')).toBeTruthy();
  });

  test('already ended today → "Workday ended for today" and NO PIN', async () => {
    generatePin.mockResolvedValue({ done: true });
    const { findAllByText, queryByText } = render(
      <StartWorkingScreen onBack={noop} onLogout={noop} onPaired={noop} />,
    );
    // Text appears in both the brand header and the card title.
    expect((await findAllByText('Workday ended for today')).length).toBeGreaterThan(0);
    // The "How it works" steps + regenerate must be gone in the ended state.
    expect(queryByText('Regenerate PIN')).toBeNull();
  });
});
