// Configuration screen data service — mirrors the Odoo web "Configuration"
// screen (kpi_configuration.js). Wraps the /kpi_config/* + /kpi_multitask/*
// routes in controllers/kra_api.py. Falls back to mock data with no server.

import { getConnection } from '../api/session';
import { jsonRpc } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('Config');

// Load away-minutes, urgent recipients, country/mobile format, and developers.
export async function fetchConfig() {
  const { serverUrl } = await getConnection();
  if (!serverUrl) {
    log.info('fetchConfig — no server, mock');
    return {
      isMock: true,
      away_after_minutes: 5,
      urgent_recipients: '',
      country_id: false,
      country_dial_code: '91',
      mobile_length: 10,
      countries: [
        { id: 104, name: 'India', code: 'IN', phone_code: 91 },
        { id: 165, name: 'Oman', code: 'OM', phone_code: 968 },
      ],
      developers: [
        { id: 3, name: 'Dev One', login: 'dev1', allow_multitask: false, wa_number: '' },
      ],
    };
  }
  const cfg = await jsonRpc(serverUrl, '/kpi_config/get', {});
  const devs = await jsonRpc(serverUrl, '/kpi_multitask/list', {});
  return {
    isMock: false,
    away_after_minutes: cfg?.away_after_minutes ?? 5,
    urgent_recipients: cfg?.urgent_recipients || '',
    country_id: cfg?.country_id || false,
    country_dial_code: String(cfg?.country_dial_code || '91'),
    mobile_length: Number(cfg?.mobile_length) || 10,
    countries: cfg?.countries || [],
    developers: (devs?.developers) || [],
  };
}

export async function setAway(minutes) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_config/set_away', { minutes });
}

export async function setUrgent(recipients) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, recipients };
  return jsonRpc(serverUrl, '/kpi_config/set_urgent', { recipients });
}

export async function setCountry(country_id) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, dial: '91', mobile_length: 10 };
  return jsonRpc(serverUrl, '/kpi_config/set_country', { country_id });
}

export async function setMultitask(user_id, allow) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true };
  return jsonRpc(serverUrl, '/kpi_multitask/set', { user_id, allow });
}

export async function setDevWa(user_id, wa_number) {
  const { serverUrl } = await getConnection();
  if (!serverUrl) return { status: true, wa_number };
  return jsonRpc(serverUrl, '/kpi_multitask/set_wa', { user_id, wa_number });
}
