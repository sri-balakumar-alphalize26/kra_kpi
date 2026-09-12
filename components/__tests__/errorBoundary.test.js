// The boundary exists because a release bundle gives no second chance: an
// uncaught render error unmounts everything and the native splash never lifts.
// These tests pin the two behaviours that rescue the app — containment, and
// letting the parent carry on without the broken subtree.
import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import ErrorBoundary from '../ErrorBoundary';

function Boom() {
  throw new Error('kaboom');
}

// React logs caught render errors through console.error; silence it so a
// deliberate throw does not look like a failing suite.
let spy;
beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

test('renders children when nothing throws', () => {
  const r = render(
    <ErrorBoundary name="t"><Text>alive</Text></ErrorBoundary>
  );
  expect(r.getByText('alive')).toBeTruthy();
});

test('contains a throwing child instead of propagating', () => {
  const r = render(
    <ErrorBoundary name="t"><Boom /></ErrorBoundary>
  );
  // Default fallback shown, and the app is still standing.
  expect(r.getByText('Something went wrong')).toBeTruthy();
});

test('fallback={null} renders nothing — for a subtree the app can live without', () => {
  const r = render(
    <ErrorBoundary name="splash" fallback={null}><Boom /></ErrorBoundary>
  );
  expect(r.toJSON()).toBeNull();
});

test('onError fires so the parent can move on (the splash path)', () => {
  const onError = jest.fn();
  render(
    <ErrorBoundary name="splash" fallback={null} onError={onError}><Boom /></ErrorBoundary>
  );
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].message).toBe('kaboom');
});

test('a throwing onError still leaves the boundary standing', () => {
  // The handler runs after logging precisely so it cannot cost us the diagnosis.
  const r = render(
    <ErrorBoundary name="t" fallback={null} onError={() => { throw new Error('handler'); }}>
      <Boom />
    </ErrorBoundary>
  );
  expect(r.toJSON()).toBeNull();
});

test('logs the message and the component stack', () => {
  render(<ErrorBoundary name="board"><Boom /></ErrorBoundary>);
  const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(logged).toContain('kaboom');
  expect(logged).toContain('componentStack');
});
