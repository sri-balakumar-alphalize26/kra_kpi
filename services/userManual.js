// USER MANUAL — wraps the `app.user.manual` model (369 App User Manual module).
// Role-based PDF manuals: the server role-filters get_manuals()/get_manual()
// (a client can never fetch an admin doc), and only admins may create / write /
// unlink. The module may not be installed on a given server, so every call
// fails soft — the screen then shows an empty / unavailable state.

import { getConnection } from '../api/session';
import { callKw } from '../api/odooApi';
import { createLogger } from '../api/logger';

const log = createLogger('UserManual');
const MODEL = 'app.user.manual';

async function base() {
  const { serverUrl } = await getConnection();
  return serverUrl || '';
}

// The screen's single load: role-filtered manual list + whether this user may
// edit (admins only) + their role (to label the Everyone/role picker).
export async function fetchManualBundle() {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  try {
    const res = await callKw(b, MODEL, 'app_bundle', []);
    return {
      status: true,
      canEdit: !!res?.can_edit,
      role: res?.role || 'developer',
      manuals: Array.isArray(res?.manuals) ? res.manuals : [],
    };
  } catch (e) {
    // Most likely the module isn't installed on this server yet — treat as "no
    // manuals" rather than an error the user has to act on.
    log.info('bundle failed (module not installed?)', e?.message);
    return { status: false, notInstalled: true, message: e?.message || 'Unavailable' };
  }
}

// One document's PDF bytes (base64) — role-gated server-side.
export async function fetchManualData(id) {
  const b = await base();
  if (!b) return { status: false };
  try {
    const res = await callKw(b, MODEL, 'get_manual', [Number(id)]);
    if (!res) return { status: false, message: 'Not available' };
    return { status: true, id: res.id, name: res.name, filename: res.filename, data: res.data };
  } catch (e) {
    log.warn('get_manual failed', e?.message);
    return { status: false, message: e?.message || 'Could not open' };
  }
}

// Admin: create (no id) or update (id) a manual. `base64` is optional on edit —
// omit it to keep the existing PDF and just change the title / role / order.
export async function saveManual({ id, name, filename, base64, role, sequence }) {
  const b = await base();
  if (!b) return { status: false, message: 'No server connection' };
  const vals = {};
  if (name != null) vals.name = name;
  if (role != null) vals.role = role;
  if (sequence != null) vals.sequence = sequence;
  if (base64) {
    vals.pdf_file = base64;
    vals.pdf_filename = filename || (name ? `${name}.pdf` : 'manual.pdf');
  } else if (filename != null) {
    vals.pdf_filename = filename;
  }
  try {
    if (id) {
      await callKw(b, MODEL, 'write', [[Number(id)], vals]);
      return { status: true, id: Number(id) };
    }
    const newId = await callKw(b, MODEL, 'create', [vals]);
    return { status: true, id: newId };
  } catch (e) {
    log.warn('save failed', e?.message);
    return { status: false, message: e?.message || 'Could not save' };
  }
}

// Admin: delete a manual.
export async function deleteManual(id) {
  const b = await base();
  if (!b) return { status: false };
  try {
    await callKw(b, MODEL, 'unlink', [[Number(id)]]);
    return { status: true };
  } catch (e) {
    log.warn('delete failed', e?.message);
    return { status: false, message: e?.message || 'Could not delete' };
  }
}
