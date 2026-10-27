"""A developer files their own task -- one implementation for every channel.

This was the body of the /kra_kpi/task/self_create route. WhatsApp's "Create my
own task" needs exactly the same rules and the same record, so the body lives
here and the route and the WhatsApp menu both call it, acting as the user in
self.env.user. Behaviour is unchanged.
"""

import logging

from odoo import api, models

from .kpi import clean_deliverable

_logger = logging.getLogger(__name__)


class KraKpiSelfCreate(models.Model):
    _inherit = 'kra.kpi'

    @api.model
    def self_create_task(self, params):
        """Developer self-creates a task.

        It lands in the separate "Pending Review" lane
        (is_self_created=True, admin_accepted=False): assigned to the creator,
        and kept OUT of the official flow until it is accepted. It climbs the
        approval chain (kpi_escalation.py) like a client request; nothing is
        accepted automatically. Then the client approves, then work starts.
        """
        user = self.env.user
        if not (user.has_group('kra_kpi_module.group_kra_developer')
                or user.has_group('base.group_system')):
            return {'status': False, 'message': 'Only developers can create their own tasks.'}

        is_admin = (user.has_group('kra_kpi_module.group_kra_admin')
                    or user.has_group('base.group_system'))

        # Creating a task is work, so it needs an open workday — the same gate
        # every Start already passes through. _actor_workday_open exempts admins
        # itself, so the rule stays in one place.
        if not self._actor_workday_open():
            return {'status': False,
                    'message': 'Start your workday before creating a task.'}

        # Who the task is for. Admins may pick anyone assignable; a developer is
        # always the assignee of their own task, whatever the client sent.
        assignee = user
        if is_admin and params.get('user_id'):
            try:
                candidate = self.env['res.users'].sudo().browse(int(params['user_id']))
            except (TypeError, ValueError):
                candidate = self.env['res.users']
            # Mirrors /kra_kpi/get_users, which populates the picker — a client or
            # portal account cannot open the board, so it cannot own a task.
            if (not candidate.exists() or not candidate.active
                    or candidate.share or candidate.id == 1
                    or candidate.kpi_role == 'client'):
                return {'status': False, 'message': 'Please choose a valid developer.'}
            assignee = candidate

        name = (params.get('name') or '').strip()
        kra_id = params.get('kra_id')
        try:
            est_h = int(params.get('estimate_hours') or 0)
            est_m = int(params.get('estimate_minutes') or 0)
        except (TypeError, ValueError):
            est_h, est_m = 0, 0
        priority = params.get('priority') or 'regular'
        # The developer's view of the type. Unknown values fall back to
        # 'requirement' rather than being stored raw — this feeds a Selection.
        req_doc_type = params.get('doc_type')
        if req_doc_type not in ('requirement', 'update', 'bug'):
            req_doc_type = 'requirement'
        description = (params.get('description') or '').strip()
        dv, deliverable_err = clean_deliverable(params.get('deliverable_type'), params.get('deliverable_other'))
        if deliverable_err:
            return {'status': False, 'message': deliverable_err}

        if not name:
            return {'status': False, 'message': 'Task name is required.'}
        if not kra_id:
            return {'status': False, 'message': 'Please choose a project (KRA).'}
        kra = self.env['kra.master'].sudo().browse(int(kra_id))
        if not kra.exists():
            return {'status': False, 'message': 'Selected project not found.'}
        # Estimate is OPTIONAL: a developer raising a task often does not yet know
        # how long it takes. The admin sets or corrects it when they accept it.

        # Provisional ref — a "+ New Task" gets TASK-### until an admin accepts it
        # and picks the real type (REQ/UPT/BUG), which re-numbers it.
        task_ref_n = self._next_ref_for_prefix('TASK')
        rec = self.sudo().create({
            'name': name,
            'kra_id': int(kra_id),
            'estimate_hours': est_h,
            'estimate_minutes': est_m,
            'priority': priority,
            # What the developer ASKED for as well as what is in force; the admin
            # may change `priority` on Accept and can see what they overrule.
            'requested_priority': priority,
            'requested_doc_type': req_doc_type,
            'deliverable_type': dv['deliverable_type'],
            'deliverable_other': dv['deliverable_other'],
            'description': description,
            'task_state': 'assigned',
            'published': True,
            'user_id': assignee.id,
            'is_self_created': True,
            'admin_accepted': False,
            # Who ASKED for it stays the actual caller either way.
            'requested_by_id': user.id,
            'external_ref': 'TASK-%03d' % task_ref_n,
        })

        # Notify owner + coordinator that a task is waiting for review.
        try:
            rec._notify('self_task_submitted',
                        title=rec.name, dev=user.name, project=kra.name,
                        estimate=(f"{est_h}h {est_m}m" if (est_h or est_m) else 'not set'),
                        priority=priority)
        except Exception as exc:
            _logger.warning("self_task_submitted notify failed: %s", exc)
        # The approval chain, step 1 (or every managing admin when there is no
        # chain), each with a private WhatsApp link to accept or refuse
        # (kpi_wa_admin_link.py). Nothing is accepted automatically. Never raises.
        rec._wa_ask_admins('self_task')

        stage = rec.approval_stage_label or 'Waiting for approval'
        return {'status': True, 'id': rec.id, 'external_ref': rec.external_ref,
                'approval_stage_label': stage,
                'message': 'Task created. ⏳ %s.' % stage}
