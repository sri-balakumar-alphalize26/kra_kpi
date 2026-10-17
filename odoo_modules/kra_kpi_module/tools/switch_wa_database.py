"""Restart Odoo onto a different database, and put it back if that fails.

This runs OUTSIDE Odoo, as a detached process, because it stops the very
server that started it. Odoo cannot restart itself inside a request: the
response would never be sent and the worker would be killed mid-write.

It is deliberately dumb and self-contained -- no Odoo imports, standard
library only -- so that it still works when the thing it is repairing is the
Odoo install itself.

  python switch_wa_database.py <conf> <backup> <expected_db> <service> <log>

The contract:
  * restart the service
  * wait for Odoo to answer, serving exactly <expected_db>
  * if it does not, copy <backup> back over <conf> and restart again

The rollback is the whole point. Writing db_name by hand and restarting is
easy; the failure mode -- a service that will not boot and a config nobody
remembers changing -- is what makes people not do it.
"""
import json
import shutil
import subprocess
import sys
import time
import urllib.request

BOOT_TIMEOUT = 150      # seconds to wait for Odoo to come up
POLL_EVERY = 3
URL = 'http://localhost:8069/web/database/list'


def say(log, msg):
    line = '%s  %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line)
    try:
        with open(log, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except OSError:
        pass


def sc(verb, service, log):
    """Stop or start the service. Never raises -- the caller decides."""
    try:
        out = subprocess.run(['sc', verb, service], capture_output=True,
                             text=True, timeout=90)
        say(log, 'sc %s %s -> rc=%s' % (verb, service, out.returncode))
        return out.returncode
    except Exception as exc:
        say(log, 'sc %s %s FAILED: %s' % (verb, service, exc))
        return -1


def restart(service, log):
    sc('stop', service, log)
    # NSSM reports the stop before the process is really gone; starting too
    # soon gets "service is marked for deletion" or a port still in use.
    time.sleep(6)
    sc('start', service, log)


def served_database(log):
    """What database is Odoo serving right now? None if it is not answering."""
    body = json.dumps({'jsonrpc': '2.0', 'method': 'call',
                       'params': {}}).encode()
    req = urllib.request.Request(
        URL, data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8', 'replace'))
        names = data.get('result') or []
        return names[0] if len(names) == 1 else (names or None)
    except Exception:
        return None


def wait_for(expected, log):
    deadline = time.time() + BOOT_TIMEOUT
    while time.time() < deadline:
        got = served_database(log)
        if got == expected:
            say(log, 'Odoo is up and serving %r' % expected)
            return True
        if got:
            say(log, 'Odoo is up but serving %r, not %r' % (got, expected))
            return False
        time.sleep(POLL_EVERY)
    say(log, 'Odoo did not answer within %ss' % BOOT_TIMEOUT)
    return False


def main():
    if len(sys.argv) != 6:
        print(__doc__)
        return 2
    conf, backup, expected, service, log = sys.argv[1:6]

    # Let the HTTP response that triggered this finish first; otherwise the
    # admin's browser gets a connection reset instead of the confirmation.
    time.sleep(3)

    say(log, '=== switching Odoo to %r ===' % expected)
    restart(service, log)

    if wait_for(expected, log):
        say(log, 'DONE. Open WhatsApp Sessions in %s and press Connect '
                 'WhatsApp so Evolution points its webhook here.' % expected)
        return 0

    say(log, 'FAILED. Putting the old configuration back.')
    try:
        shutil.copyfile(backup, conf)
        say(log, 'restored %s from %s' % (conf, backup))
    except Exception as exc:
        say(log, 'COULD NOT RESTORE: %s -- restore %s by hand' % (exc, backup))
        return 1

    restart(service, log)
    if wait_for_any(log):
        say(log, 'Rolled back. Odoo is running on the old database again.')
        return 1
    say(log, 'Odoo is DOWN and the rollback did not bring it back. '
             'Check odoo.log, then: sc start %s' % service)
    return 1


def wait_for_any(log):
    """After a rollback, any answer at all is good news."""
    deadline = time.time() + BOOT_TIMEOUT
    while time.time() < deadline:
        if served_database(log):
            return True
        time.sleep(POLL_EVERY)
    return False


if __name__ == '__main__':
    sys.exit(main())
