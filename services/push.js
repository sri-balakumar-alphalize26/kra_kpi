// Push-notification service. Registers this device's Expo push token with the
// Odoo backend (/kpi_push/register), so the server can send a phone banner when
// a task is assigned. Mirrors services/notifications.js conventions.
//
// IMPORTANT: remote push does NOT work in Expo Go on Android (SDK 53+). A
// development/standalone build is required. This module degrades gracefully
// (logs + returns null) so the app never crashes when push is unavailable.

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Push');

// The EAS projectId is required by getExpoPushTokenAsync in SDK 54. It's
// injected into expoConfig.extra.eas.projectId once `eas init` has run.
function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

// Ask permission, ensure the Android channel exists, fetch the Expo token, and
// register it with Odoo. Returns the token string, or null if unavailable.
export async function registerForPushAsync() {
  try {
    if (!Device.isDevice) {
      log.info('not a physical device — skipping push registration');
      return null;
    }

    // Android: a channel must exist before the OS shows heads-up banners.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Task notifications',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#1E40AF',
      });
    }

    // Permission (ask only if not already granted).
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') {
      log.warn('push permission not granted');
      return null;
    }

    const projectId = getProjectId();
    if (!projectId) {
      // Without a projectId (no eas init yet) the token call throws — bail
      // cleanly so the app still runs. Remote push is inert until EAS is set up.
      log.warn('no EAS projectId configured — remote push unavailable until `eas init`');
      return null;
    }

    const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResp?.data;
    if (!token) {
      log.warn('no Expo push token returned');
      return null;
    }
    log.info('expo push token', token.slice(0, 24) + '...');

    // Register with Odoo (auth='user' → scoped to the logged-in user by cookie).
    const { serverUrl } = await getConnection();
    if (serverUrl) {
      await jsonRpc(serverUrl, '/kpi_push/register', {
        token,
        platform: Platform.OS,
        device: Device.deviceName || Device.modelName || '',
      });
      log.info('registered push token with server');
    }
    return token;
  } catch (e) {
    log.warn('registerForPushAsync failed', e?.message);
    return null;
  }
}

// Deactivate a token on the server (logout). Best-effort.
export async function unregisterPush(token) {
  if (!token) return;
  try {
    const { serverUrl } = await getConnection();
    if (serverUrl) {
      await jsonRpc(serverUrl, '/kpi_push/unregister', { token });
      log.info('unregistered push token');
    }
  } catch (e) {
    log.warn('unregisterPush failed', e?.message);
  }
}
