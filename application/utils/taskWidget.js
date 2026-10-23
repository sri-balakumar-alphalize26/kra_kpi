// Feeds the Android home-screen widget (plugins/withTaskWidget.js).
//
// Writes a small JSON file into the app's own filesDir. expo-file-system's
// documentDirectory maps to /data/user/0/<pkg>/files on Android, which is
// exactly what Kotlin's context.filesDir returns — same UID, same directory —
// so the widget can read it with no bridge, no native module and no new
// dependency. AsyncStorage would NOT work here: on Android it is SQLite, and a
// widget process cannot open it.
//
// Everything here is best-effort. The widget is an extra; a failure to update it
// must never surface to the developer or interrupt what they were doing, so every
// path swallows its errors and simply leaves the last good state on screen.
//
// No-ops on iOS and in Expo Go (there is no widget to feed in either case).

import { Platform } from 'react-native';
// /legacy, and it is load-bearing. SDK 54 split this module: the bare specifier
// now exports only Paths/File/Directory, and every legacy name is left as a stub.
// documentDirectory simply came back undefined here, so fileUri() returned null
// and publishWidgetState bailed at its own `if (!uri) return` — silently, every
// time, with no log and no throw. The widget's state file was never written, so
// the widget could only ever render "No task running". Ten other files in this
// app already import from /legacy; this one was the holdout.
import * as FileSystem from 'expo-file-system/legacy';

import { createLogger } from '../api/logger';
// The measured device-minus-server clock offset. The widget ticks on the device
// clock, so every server anchor is shifted by it — the app's own timers correct
// for the same offset through serverNow(), and the two must agree.
import { clockSkewMs } from '../api/odooApi';
// Guarded internally — no-ops in Expo Go and on any build made before the native
// module existed, so importing it is always safe.
import { refreshTaskWidget } from '../modules/expo-task-widget-bridge';
// The decisions that can be silently wrong — which task, which anchors, what the
// button does — are pure and unit-tested. This file only writes the file.
import { shapeTaskWidget, emptyTaskWidgetState } from './taskWidgetState';

const log = createLogger('taskWidget');

// Must match STATE_FILE in plugins/withTaskWidget.js.
const WIDGET_FILE = 'task_widget.json';

// Skip writes that would not change anything: this is called on every live-status
// poll (15s), and rewriting an identical file that often is pure IO for nothing.
//
// EXCEPT every TOUCH_MS. The file carries `published_at`, and the widget reads it
// to tell "the app is open and nothing has changed" from "the app was closed an
// hour ago and this is stale" (plugins/withTaskWidget.js marks the latter). An
// unchanged payload therefore still has to be re-stamped now and then, or a quiet
// afternoon on one task would be flagged stale with the app in the foreground.
// 5 min against the widget's 20-min threshold leaves plenty of room.
const TOUCH_MS = 5 * 60 * 1000;
let lastPayload = '';
let lastWriteAt = 0;

function fileUri() {
  const dir = FileSystem.documentDirectory;
  return dir ? dir + WIDGET_FILE : null;
}

// Write the state (stamped) and ask Android to repaint. Returns true when a
// write happened. Never throws: callers log and move on.
async function put(state) {
  if (Platform.OS !== 'android') return false;
  const uri = fileUri();
  if (!uri) return false;

  const payload = JSON.stringify(state);
  const now = Date.now();
  if (payload === lastPayload && now - lastWriteAt < TOUCH_MS) return false;
  lastPayload = payload;
  lastWriteAt = now;

  await FileSystem.writeAsStringAsync(uri, JSON.stringify({ ...state, published_at: now }));
  // Then tell Android to repaint. Writing the file is only half the channel —
  // without this the widget shows the new state whenever the OS next gets round
  // to it, and its floor is 30 MINUTES, so a task switch left the old task's
  // name on the home screen for up to half an hour.
  //
  // Reached on a real change, or once per TOUCH_MS otherwise, so this costs one
  // broadcast per state change plus a handful an hour — not one per 15 s poll.
  refreshTaskWidget();
  return true;
}

/**
 * Publish the current running-task state to the widget.
 *
 * @param {object}  live  the live_status payload (services/kpiActions.liveStatus)
 */
export async function publishWidgetState(live) {
  try {
    const state = shapeTaskWidget(live, { skewMs: clockSkewMs() });
    if (await put(state)) {
      log.info('widget state published', { running: state.running, count: state.task_count });
    }
  } catch (e) {
    log.warn('widget publish failed', e?.message);
  }
}

/** Clear the widget — on logout, or when the workday ends. */
export async function clearWidgetState() {
  try {
    // Force the write: the last payload may already be the empty state from an
    // earlier day, and the stamp still has to move so the widget is not stale.
    lastPayload = '';
    // Repaint here too, and arguably it matters more: ending the workday and
    // still seeing a task "running" on the home screen half an hour later is the
    // version of this bug people would actually report.
    await put(emptyTaskWidgetState());
  } catch (e) {
    log.warn('widget clear failed', e?.message);
  }
}
