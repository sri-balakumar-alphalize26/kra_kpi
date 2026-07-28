# -*- coding: utf-8 -*-
"""Arm the two auto-advance clocks on existing data, without a stampede.

19.0.2.4 stops either approval gate blocking a developer forever:

  * a task nobody accepts auto-accepts after res.company.admin_accept_minutes;
  * a task the client ignores auto-RELEASES after client_approval_minutes.

Release is deliberately not approval — it writes no decision and no decided-by,
so the mistake 19.0.2.3 had to reverse ("Auto-approved (no response)" recorded
as the client's consent) cannot come back. Section 5 asserts that.

The hazard this file exists to manage is the backlog. Both crons sweep every
minute, so on the first tick after the upgrade EVERY currently-waiting task
would fire at once: every provisional TASK-### re-numbered to REQ-### (breaking
refs clients have already seen) and every client notified in the same second.

So nothing inherits a deadline in the past. Each waiting row gets a FULL fresh
window measured from upgrade time, floored at GRACE_FLOOR_MIN, plus a per-row
stagger. Oldest-waiting first, so the longest-suffering client is served first.
The per-tick caps in kpi_workflow (ADMIN_ACCEPT_BATCH_MAX / AUTO_RELEASE_BATCH_MAX)
are the second line of defence if the arithmetic here is ever wrong.
"""
import logging

from odoo import SUPERUSER_ID, api, fields
from odoo.addons.kra_kpi_module.models.kpi_workflow import ADMIN_ACCEPT_BATCH_MAX

_logger = logging.getLogger(__name__)

# The string the OLD auto-approve wrote. Must never appear again — see §5.
AUTO_MARK = 'Auto-approved (no response)'

# Nothing accepts or releases within this many minutes of the upgrade, however
# short the configured windows are. A 5-minute client window is fine day to day
# but must not mean "5 minutes after the deploy, the whole backlog goes".
GRACE_FLOOR_MIN = 1440          # 24h
# Spread the armed deadlines over this many minutes so they don't co-fire.
STAGGER_MODULO = 120            # 2h band

LEGACY_CLIENT_APPROVAL_DEFAULT = 5


def _refs(recs):
    return ', '.join((r.external_ref or r.name or str(r.id)) for r in recs) or '(none)'


def migrate(cr, version):
    if not version:
        return

    env = api.Environment(cr, SUPERUSER_ID, {})
    Kpi = env['kra.kpi'].with_context(active_test=False)
    now = fields.Datetime.now()

    _logger.info("=" * 72)
    _logger.info("kra_kpi_module 19.0.2.4: arming auto-accept + auto-release clocks")
    _logger.info("=" * 72)

    # ------------------------------------------------------------------ #
    # 1. New boolean columns — NULL is not False to Postgres.             #
    # ------------------------------------------------------------------ #
    cr.execute("UPDATE kra_kpi SET pre_approval_auto_released = FALSE "
               "WHERE pre_approval_auto_released IS NULL")
    released_backfill = cr.rowcount
    cr.execute("UPDATE kra_kpi SET admin_accepted_auto = FALSE "
               "WHERE admin_accepted_auto IS NULL")
    _logger.info("1. backfilled pre_approval_auto_released on %s row(s), "
                 "admin_accepted_auto on %s row(s)", released_backfill, cr.rowcount)
    # admin_accepted_at / admin_accepted_by_id are left NULL on purpose: for
    # historical acceptances we genuinely do not know who or when, and inventing
    # a value would be worse than an empty one.
    cr.execute("SELECT count(*) FROM kra_kpi WHERE admin_accepted AND admin_accepted_at IS NULL")
    _logger.info("1b. %s historical acceptance(s) have no timestamp/actor — expected, "
                 "that data was never recorded", cr.fetchone()[0])

    # ------------------------------------------------------------------ #
    # 2. Company settings.                                                #
    #    A changed field default only affects NEW databases, so seed the   #
    #    new column here. client_approval_minutes is DELIBERATELY NOT      #
    #    touched: it is the value the customer configured, and the whole   #
    #    point of the feature is that it is theirs to set.                 #
    # ------------------------------------------------------------------ #
    cr.execute("UPDATE res_company SET admin_accept_minutes = %s "
               "WHERE admin_accept_minutes IS NULL",
               (LEGACY_CLIENT_APPROVAL_DEFAULT,))
    _logger.info("2. admin_accept_minutes seeded on %s compan(y/ies); "
                 "client_approval_minutes left exactly as configured", cr.rowcount)

    # Window used for the grace calculation below — read per company would be
    # nicer, but kra.kpi has no company_id (this module is single-company), and
    # _client_approval_minutes() makes the same assumption.
    company = env.company
    client_window = max(1, int(company.client_approval_minutes
                               or LEGACY_CLIENT_APPROVAL_DEFAULT))
    admin_window = max(1, int(company.admin_accept_minutes
                              or LEGACY_CLIENT_APPROVAL_DEFAULT))
    client_grace = max(client_window, GRACE_FLOOR_MIN)
    admin_grace = max(admin_window, GRACE_FLOOR_MIN)
    reminder_max = env['kra.kpi'].PRE_APPROVAL_REMINDER_MAX
    client_gap = max(1, client_grace // (reminder_max + 1))

    # ------------------------------------------------------------------ #
    # 3. The pending-approval backlog → arm pre_approval_release_at.       #
    # ------------------------------------------------------------------ #
    # pre_approval_held rows are excluded: Hold means "do not release", and an
    # upgrade must not override a client's explicit instruction.
    # user_id IS NOT NULL mirrors the cron domain — arming a dev-less row would
    # create a deadline that can never fire.
    cr.execute("""
        WITH ordered AS (
            SELECT id,
                   row_number() OVER (ORDER BY pre_approval_deadline_at NULLS LAST, id) AS rn
              FROM kra_kpi
             WHERE task_state = 'pre_approval_pending'
               AND active
               AND user_id IS NOT NULL
               AND COALESCE(pre_approval_held, FALSE) = FALSE
        )
        UPDATE kra_kpi k
           SET pre_approval_release_at  = %(now)s::timestamp
                                        + (%(grace)s || ' minutes')::interval
                                        + ((o.rn %% %(mod)s) || ' minutes')::interval,
               pre_approval_deadline_at = %(now)s::timestamp
                                        + (%(gap)s || ' minutes')::interval
                                        + ((o.rn %% %(mod)s) || ' minutes')::interval,
               -- Restart the reminder ladder: rows that burned all their nudges
               -- under the old cron had their deadline cleared and would
               -- otherwise never be chased again before releasing.
               pre_approval_reminder_count = 0
          FROM ordered o
         WHERE o.id = k.id
        RETURNING k.id
    """, {'now': now, 'grace': client_grace, 'gap': client_gap, 'mod': STAGGER_MODULO})
    armed_release_ids = [r[0] for r in cr.fetchall()]
    _logger.warning(
        "3. armed auto-release on %s pending task(s): first no earlier than %s min "
        "from now, spread over %s min. Refs: %s",
        len(armed_release_ids), client_grace, STAGGER_MODULO,
        _refs(Kpi.browse(armed_release_ids)))

    # Leave a trail. Without it, support sees deadlines reappear months later on
    # tasks whose deadline was cleared long ago, with nothing explaining why.
    for rec in Kpi.browse(armed_release_ids):
        try:
            rec._log_action(
                'pre_approval_release_scheduled_by_upgrade', source='system',
                payload={'release_at': str(rec.pre_approval_release_at),
                         'grace_min': client_grace,
                         'reason': '19.0.2.4 upgrade grace window'})
        except Exception:      # never let bookkeeping abort an upgrade
            pass

    held = Kpi.search([('task_state', '=', 'pre_approval_pending'),
                       ('pre_approval_held', '=', True)])
    if held:
        _logger.info("3b. %s held task(s) left un-armed on purpose — Hold means the "
                     "client stopped the clock: %s", len(held), _refs(held))

    # ------------------------------------------------------------------ #
    # 4. The un-accepted backlog → arm admin_accept_deadline_at.           #
    # ------------------------------------------------------------------ #
    # Excludes self_needs_resume_reason: an admin explicitly sent those back, so
    # auto-accepting them would overturn a decision a human actually made.
    cr.execute("""
        WITH ordered AS (
            SELECT id, row_number() OVER (ORDER BY create_date, id) AS rn
              FROM kra_kpi
             WHERE COALESCE(admin_accepted, FALSE) = FALSE
               AND active
               AND user_id IS NOT NULL
               AND COALESCE(self_needs_resume_reason, FALSE) = FALSE
               AND task_state NOT IN ('completed', 'awaiting_client')
        )
        UPDATE kra_kpi k
           SET admin_accept_deadline_at = %(now)s::timestamp
                                        + (%(grace)s || ' minutes')::interval
                                        + ((o.rn %% %(mod)s) || ' minutes')::interval
          FROM ordered o
         WHERE o.id = k.id
        RETURNING k.id
    """, {'now': now, 'grace': admin_grace, 'mod': STAGGER_MODULO})
    armed_accept_ids = [r[0] for r in cr.fetchall()]
    _logger.warning(
        "4. armed auto-accept on %s un-accepted task(s): none before %s min from now, "
        "spread over %s min, max %s per cron tick. Refs: %s",
        len(armed_accept_ids), admin_grace, STAGGER_MODULO,
        ADMIN_ACCEPT_BATCH_MAX, _refs(Kpi.browse(armed_accept_ids)))

    sent_back = Kpi.search([('admin_accepted', '=', False),
                            ('self_needs_resume_reason', '=', True)])
    if sent_back:
        _logger.info("4b. %s sent-back task(s) left un-armed on purpose — an admin said "
                     "no to those; they re-arm when the developer responds: %s",
                     len(sent_back), _refs(sent_back))

    # ------------------------------------------------------------------ #
    # 5. Regression guard for the defect 19.0.2.3 reversed.                #
    # ------------------------------------------------------------------ #
    cr.execute("SELECT count(*) FROM kra_kpi WHERE pre_approval_decided_by_name = %s",
               (AUTO_MARK,))
    faked = cr.fetchone()[0]
    if faked:
        _logger.error(
            "5. FOUND %s task(s) still stamped %r. Nothing in 19.0.2.4 writes this — "
            "its presence means the pre-19.0.2.3 auto-approve is running again. "
            "Auto-release must NEVER record a decision the client did not make.",
            faked, AUTO_MARK)
    else:
        _logger.info("5. no forged client approvals present — as expected")

    # ------------------------------------------------------------------ #
    # 6. Rename the pre-approval cron.                                     #
    #    Its record still reads "Auto-flip pre-approval to partial after 5 #
    #    min" — behaviour removed in 19.0.2.3 and replaced again here, so  #
    #    an admin scanning the cron list is told it does something it has  #
    #    not done for two versions. The record is noupdate, and the stored #
    #    ir_model_data flag wins over the XML attribute, so the data file  #
    #    cannot fix this; it has to be done here.                          #
    # ------------------------------------------------------------------ #
    NEW_CRON_NAME = 'KRA/KPI: Client approval reminders + auto-release'
    cron = env.ref('kra_kpi_module.ir_cron_kpi_pre_approval_timeout',
                   raise_if_not_found=False)
    if cron and cron.cron_name != NEW_CRON_NAME:
        old = cron.cron_name
        # Write `name`, NOT `cron_name`: cron_name is a stored COMPUTED field
        # (_compute_cron_name) fed by ir_actions_server_id.name, so setting it
        # directly is undone the next time it recomputes. `name` reaches the
        # server action through ir.cron's _inherits and cron_name follows.
        # Only the label changes — interval, active and the called method are
        # deliberately left alone so an ops tweak in the UI survives.
        cron.write({'name': NEW_CRON_NAME})
        _logger.info("6. renamed cron %r -> %r", old, NEW_CRON_NAME)
    else:
        _logger.info("6. pre-approval cron already correctly named")

    _logger.info("=" * 72)
    _logger.info("kra_kpi_module 19.0.2.4: migration complete")
    _logger.info("=" * 72)
