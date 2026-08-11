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
import * as FileSystem from 'expo-file-system';

import { createLogger } from '../api/logger';

const log = createLogger('taskWidget');

// Must match STATE_FILE in plugins/withTaskWidget.js.
const WIDGET_FILE = 'task_widget.json';

// Skip writes that would not change anything. This is called on every live-status
// poll (15s), and rewriting an identical file that often is pure IO for nothing.
let lastPayload = '';

function fileUri() {
  const dir = FileSystem.documentDirectory;
  return dir ? dir + WIDGET_FILE : null;
}

/**
 * Publish the current running-task state to the widget.
 *
 * @param {object}  live  the live_status payload (services/kpiActions.liveStatus)
 */
export async function publishWidgetState(live) {
  if (Platform.OS !== 'android') return;
  const uri = fileUri();
  if (!uri) return;

  try {
    // active_tasks is the full list when multitasking; active_task is the first
    // of them and only exists for older servers. The widget shows the first task
    // by name and the count, because a home-screen widget has room for one line.
    const running = live?.active_tasks?.length
      ? live.active_tasks
      : (live?.active_task ? [live.active_task] : []);
    const first = running[0];

    // timer_start is an ISO-with-Z string; the widget needs epoch ms so it can
    // convert into SystemClock.elapsedRealtime terms for the Chronometer.
    const startedAtMs = first?.timer_start ? Date.parse(first.timer_start) : 0;

    const state = {
      running: !!(first && startedAtMs),
      task_name: first?.name || '',
      task_count: running.length,
      started_at_ms: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
      // Time already banked on this task before the current run, so the widget
      // shows the task's total rather than only this sitting.
      base_seconds: Math.max(0, Math.round(first?.timer_total_seconds || 0)),
      workday_open: !!live?.workday_open,
    };

    const payload = JSON.stringify(state);
    if (payload === lastPayload) return;
    lastPayload = payload;

    await FileSystem.writeAsStringAsync(uri, payload);
    log.info('widget state published', { running: state.running, count: state.task_count });
  } catch (e) {
    log.warn('widget publish failed', e?.message);
  }
}

/** Clear the widget — on logout, or when the workday ends. */
export async function clearWidgetState() {
  if (Platform.OS !== 'android') return;
  const uri = fileUri();
  if (!uri) return;
  try {
    lastPayload = '';
    await FileSystem.writeAsStringAsync(
      uri,
      JSON.stringify({ running: false, task_name: '', task_count: 0, workday_open: false }),
    );
  } catch (e) {
    log.warn('widget clear failed', e?.message);
  }
}
