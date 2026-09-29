// Feeds the admin Live Tracking home-screen widget (plugins/withLiveTrackingWidget.js).
//
// Same channel as utils/taskWidget.js and for the same reasons: a small JSON file
// in the app's own filesDir, which is exactly what Kotlin's context.filesDir
// returns — same UID, same directory — so the widget reads it with no bridge and
// no new dependency. AsyncStorage would NOT work: on Android it is SQLite, and a
// widget process cannot open it.
//
// Everything here is best-effort. The widget is an extra; a failure to update it
// must never surface to the user or interrupt what they were doing, so every path
// swallows its errors and leaves the last good state on screen.
//
// No-ops on iOS and in Expo Go (there is no widget to feed in either case).

import { Platform } from 'react-native';
// /legacy, and it is load-bearing. SDK 54 split this module: the bare specifier
// now exports only Paths/File/Directory, and every legacy name is left as a stub.
// documentDirectory came back undefined in utils/taskWidget.js for exactly this
// reason, so fileUri() returned null and the write bailed at its own guard —
// silently, every time, with no log and no throw. The widget could only ever
// render its empty state, and it took a day to notice.
import * as FileSystem from 'expo-file-system/legacy';

import { createLogger } from '../api/logger';
// Guarded internally — no-ops in Expo Go and on any build made before the native
// module existed, so importing it is always safe.
import { refreshLiveTrackingWidget } from '../modules/expo-task-widget-bridge';
// The decisions that can be silently wrong — who to show, and what to say when
// there is nothing — are pure and unit-tested.
import { shapeLiveTracking, signedOutState } from './liveTrackingWidgetState';

const log = createLogger('ltWidget');

// Must match STATE_FILE in plugins/withLiveTrackingWidget.js.
const WIDGET_FILE = 'live_tracking_widget.json';

// Skip writes that would not change anything. Called on every poll, and rewriting
// an identical file is pure IO for nothing.
//
// EXCEPT every TOUCH_MS. The file carries `published_at`, which the widget reads
// to tell "the app is open and the team has not moved" from "the app was closed
// an hour ago" (plugins/withLiveTrackingWidget.js marks the latter stale). An
// unchanged payload is therefore re-stamped now and then, or a quiet hour would be
// flagged stale with the app in the foreground. Same rule as utils/taskWidget.js.
const TOUCH_MS = 5 * 60 * 1000;
let lastPayload = '';
let lastWriteAt = 0;

function fileUri() {
  const dir = FileSystem.documentDirectory;
  return dir ? dir + WIDGET_FILE : null;
}

async function put(state) {
  if (Platform.OS !== 'android') return;
  const uri = fileUri();
  if (!uri) return;
  try {
    const payload = JSON.stringify(state);
    const now = Date.now();
    if (payload === lastPayload && now - lastWriteAt < TOUCH_MS) return;
    lastPayload = payload;
    lastWriteAt = now;

    await FileSystem.writeAsStringAsync(uri, JSON.stringify({ ...state, published_at: now }));
    // Then tell Android to repaint. Writing the file is only half the channel —
    // without this the widget shows the new state whenever the OS next gets round
    // to it, and its floor is 30 MINUTES.
    refreshLiveTrackingWidget();
    log.info('live tracking widget published', { ok: state.ok, rows: state.rows?.length || 0 });
  } catch (e) {
    log.warn('live tracking widget publish failed', e?.message);
  }
}

/**
 * Publish the current Live Tracking state to the widget.
 *
 * @param {object} res  the /kpi_owner/live_tracking payload
 */
export async function publishLiveTrackingState(res) {
  await put(shapeLiveTracking(res));
}

/** Clear it on logout, so a signed-out device stops showing the team's day. */
export async function clearLiveTrackingState() {
  lastPayload = '';
  await put(signedOutState());
}
