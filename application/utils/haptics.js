// Haptics — the app's whole vocabulary of "you did a thing", in one place.
//
// WHY A WRAPPER AND NOT expo-haptics DIRECTLY: three reasons, all of which bit
// other cross-cutting concerns in this codebase first.
//
//  1. ONE VOCABULARY. Buttons that buzz differently for the same kind of outcome
//     read as bugs. Callers here say what HAPPENED (tap / ok / err / warn /
//     select), never which native effect to fire, so Start and Complete cannot
//     drift apart.
//  2. ONE OFF SWITCH. Vibration is the one feedback channel a user cannot look
//     away from, so it needs a real toggle. Reading AsyncStorage on every tap
//     would add latency to the exact moment that must feel instant, so the flag
//     is cached in memory and refreshed by setHapticsEnabled / loadHaptics.
//  3. NEVER THROW. A haptic is decoration. On a device with no vibrator (or an
//     emulator) expo-haptics rejects, and an unhandled rejection inside an
//     onPress would take down the action the user actually asked for. Every
//     call here is fire-and-forget with the rejection swallowed.
//
// expo-haptics IS bundled in Expo Go, so unlike notifee this works today without
// waiting for a dev build.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { createLogger } from '../api/logger';

const log = createLogger('haptics');

const K_HAPTICS = 'kpi_haptics_enabled';

// Cached so the hot path (a button press) never awaits storage. Defaults ON:
// the feature is opt-out, and a first launch before loadHaptics resolves should
// still feel right.
let enabled = true;

export async function loadHaptics() {
  try {
    const raw = await AsyncStorage.getItem(K_HAPTICS);
    // Only an explicit '0' turns it off, so an unset key stays on.
    enabled = raw !== '0';
  } catch (_) {
    enabled = true;
  }
  return enabled;
}

export function hapticsEnabled() {
  return enabled;
}

export async function setHapticsEnabled(on) {
  enabled = !!on;
  try {
    await AsyncStorage.setItem(K_HAPTICS, enabled ? '1' : '0');
  } catch (_) {}
}

// iOS ignores these on a device with Reduce Motion / silent switch quirks and
// web has no vibrator at all — bail early rather than build a rejected promise
// on every tap.
const supported = () => Platform.OS === 'android' || Platform.OS === 'ios';

function fire(fn) {
  if (!enabled || !supported()) return;
  try {
    const p = fn();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    // Once, not per tap — a broken vibrator must not fill the log.
    log.warn('haptic failed', e?.message);
  }
}

// ---- The vocabulary -------------------------------------------------------

/** A primary action was tapped: Start, Pause, Resume, Complete, Switch. */
export const tap = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));

/** A heavier, more deliberate commitment: End Workday, the alarm taking over. */
export const heavy = () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));

/** The action succeeded — task started, completed, workday opened. */
export const ok = () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));

/** Refused or failed: a blocked Start, a rejected upload, a validation alert. */
export const err = () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));

/** Something paused or needs attention but did not fail. */
export const warn = () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));

/** A value changed: a checkbox, a filter, a tab, a list crossing a boundary. */
export const select = () => fire(() => Haptics.selectionAsync());

// ---- Scroll ---------------------------------------------------------------
// A tick per scrolled "notch". Rate-limited hard: selectionAsync fires at
// whatever rate you call it, and onScroll on Android fires every frame, so the
// naive version is a continuous buzz that people switch off within a minute —
// worse than having none. MIN_GAP_MS is the floor between ticks and MIN_DELTA
// the distance that must be travelled, so both a fast fling and a slow drag feel
// like discrete notches rather than a motor.
const MIN_GAP_MS = 120;
const MIN_DELTA = 48;

let lastAt = 0;
let lastY = 0;

/** Feed this the contentOffset.y from an onScroll handler. */
export function scrollTick(y) {
  if (!enabled || !supported()) return;
  const now = Date.now();
  if (Math.abs(y - lastY) < MIN_DELTA) return;
  lastY = y;
  if (now - lastAt < MIN_GAP_MS) return;
  lastAt = now;
  select();
}

/** Call when a scrollable mounts or its content swaps, so the first tick of a
 *  new list isn't measured against the last position of the old one. */
export function resetScrollTick(y = 0) {
  lastY = y;
  lastAt = 0;
}

export default {
  tap, heavy, ok, err, warn, select,
  scrollTick, resetScrollTick,
  loadHaptics, setHapticsEnabled, hapticsEnabled,
};
