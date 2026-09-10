import re

from odoo import api, models, fields
from odoo.tools import float_round
from datetime import datetime, timedelta
from odoo.exceptions import ValidationError


class KpiMaster(models.Model):
    _name = "kra.kpi"
    _description = "KPI Master"
    _rec_name = "name"

    name = fields.Char(string="KPI Name", required=True)

    kra_id = fields.Many2one(
        "kra.master",
        string="Related KRA",
        required=True,
        ondelete="cascade"
    )
    progress_ids = fields.One2many(
        'kpi.progress',
        'kpi_id',
        string='Progress Updates'
    )

    progress_count = fields.Integer(
        string='Updates Count',
        compute='_compute_progress_count'
    )
    
    # 🆕 NEW: Reassignment History
    reassignment_history_ids = fields.One2many(
        'kpi.reassignment.history',
        'kpi_id',
        string='Reassignment History'
    )
    
    reassignment_count = fields.Integer(
        string='Reassignment Count',
        compute='_compute_reassignment_count'
    )
    
    reassignment_log = fields.Text(
        string='Reassignment Log',
        help='Text log of all reassignments for quick reference'
    )
    
    # Basic fields
    estimate_hours = fields.Integer(string="Estimate Hours", default=0)
    estimate_minutes = fields.Integer(string="Estimate Minutes", default=0)

    # ---- Extending an estimate ------------------------------------------- #
    # An estimate was set once at creation and could never be changed, so a task
    # that ran over read as permanently over — and the estimate is what the board
    # and the Paid lane compare worked time against.
    #
    # The reason lives HERE, on the task, not only in kpi.action.log: the point is
    # that anyone looking at the board sees why the number grew. The log keeps the
    # full history (every earlier reason and the original estimate); this field is
    # the latest one, which is what the card shows.
    estimate_extend_reason = fields.Char(
        string='Last Extension Reason', copy=False,
        help="Why the estimate was last extended. Shown on the task card.")
    estimate_extension_count = fields.Integer(
        string='Times Extended', default=0, copy=False)
    estimate_extended_by_id = fields.Many2one(
        'res.users', string='Estimate Extended By', readonly=True, copy=False)
    estimate_extended_at = fields.Datetime(
        string='Estimate Extended On', readonly=True, copy=False)

    # Computed field for total estimate in hours (for calculations)
    estimate = fields.Float(
        string="Estimated Time",
        compute='_compute_estimate',
        store=True,
        help="Total estimate in hours (computed from hours + minutes)"
    )

    # Additional fields for richer KPI definition
    priority = fields.Selection([
        ('urgent', 'Urgent'),
        ('important', 'Important'),
        ('regular', 'Regular'),
    ], string="Priority", default='regular')

    # What the DEVELOPER asked for when they raised the task themselves, kept
    # separately from the priority that is actually in force.
    #
    # Both start equal, so nothing is lost and a fresh self-created task behaves
    # as the developer expects. They diverge the moment an admin decides
    # otherwise on Accept — and that divergence is the point: "asked Urgent, set
    # Regular" is a real, reviewable fact, whereas overwriting `priority` in
    # place threw the request away and left the admin deciding blind.
    #
    # Empty on tasks nobody self-created (client submissions, bulk uploads) —
    # there was no developer request to record.
    requested_priority = fields.Selection([
        ('urgent', 'Urgent'),
        ('important', 'Important'),
        ('regular', 'Regular'),
    ], string="Priority Requested by Developer", copy=False,
        help="The priority the developer chose when creating this task. Shown to "
             "the admin on Accept so they can set the real priority against it. "
             "Never changed after creation — it is a record of what was asked.")

    # Same idea as requested_priority, for the REQ / UPT / BUG classification.
    #
    # There is no `doc_type` field to mirror: the type is expressed through
    # external_ref (REQ-012 / UPT-004 / BUG-021) and the name prefix, both of
    # which the admin sets on Accept. So this is purely the developer's opinion —
    # they know whether they are writing a bug or an update — captured so the
    # admin decides with it in front of them rather than guessing from a title.
    # The ADMIN's choice is what gets saved; this never overrides it.
    requested_doc_type = fields.Selection([
        ('requirement', 'Requirement'),
        ('update', 'Update'),
        ('bug', 'Bug'),
    ], string="Type Requested by Developer", copy=False,
        help="What the developer said this task is when they created it. Shown to "
             "the admin on Accept and used to pre-select the type; the admin's "
             "choice is what is actually applied.")

    user_group_id = fields.Many2one('res.groups', string='User Group')
    user_id = fields.Many2one('res.users', string='Assignee')

    # Multi-developer contributors — extras (beyond user_id) who can log time on this KPI.
    contributor_ids = fields.Many2many(
        'res.users',
        'kra_kpi_contributor_rel',
        'kpi_id',
        'user_id',
        string='Contributors',
        help='Developers (in addition to the primary assignee) authorized to log time.'
    )

    # Role-based contributor lists — used by the Completion Certificate to break time down by role.
    # A user may appear in multiple role lists (e.g. dev + tester). For reporting we take the union.
    developer_ids = fields.Many2many(
        'res.users', 'kra_kpi_developer_rel', 'kpi_id', 'user_id',
        string='Developers')
    tester_ids = fields.Many2many(
        'res.users', 'kra_kpi_tester_rel', 'kpi_id', 'user_id',
        string='Testers')
    coordinator_ids = fields.Many2many(
        'res.users', 'kra_kpi_coordinator_rel', 'kpi_id', 'user_id',
        string='Coordinators')
    lead_ids = fields.Many2many(
        'res.users', 'kra_kpi_lead_rel', 'kpi_id', 'user_id',
        string='Leads')

    # Union of user_id + contributor_ids + role lists — used for auth checks and reporting.
    effective_contributor_ids = fields.Many2many(
        'res.users',
        compute='_compute_effective_contributors',
        string='Effective Contributors',
        help='user_id union contributor_ids union role lists — anyone who may log time on this KPI.'
    )

    # Client-quoted (billable) time at the KPI level.
    client_quoted_hours = fields.Integer(string='Client Quoted Hours', default=0)
    client_quoted_minutes = fields.Integer(string='Client Quoted Minutes', default=0)
    client_quoted = fields.Float(
        string='Client Quoted Time',
        compute='_compute_kpi_client_quoted',
        store=True,
        help='client_quoted_hours + client_quoted_minutes/60 — billable figure for invoices.'
    )

    # Cached nearest is_client ancestor of this KPI's KRA — for record rules and invoicing.
    client_kra_id = fields.Many2one(
        'kra.master',
        string='Client KRA',
        compute='_compute_client_kra',
        store=True,
        help='Nearest ancestor KRA where is_client=True.'
    )

    # Double-billing lock: reverse link to the invoice lines this task appears on,
    # plus a stored flag that is True once the task is on a FINALIZED/SENT invoice
    # (draft invoices don't lock — still editable). Auto-maintained, so it back-fills
    # on upgrade and clears itself when an invoice is reset to draft or deleted.
    invoice_line_ids = fields.One2many('kpi.client.invoice.line', 'kpi_id', string='Invoice Lines')
    is_invoiced = fields.Boolean(
        string='Already Billed', compute='_compute_is_invoiced', store=True,
        help='True when this task is on a finalized/sent client invoice — it cannot be billed again.')
    invoiced_on_id = fields.Many2one(
        'kpi.client.invoice', string='Billed On', compute='_compute_is_invoiced', store=True,
        help='The finalized/sent invoice this task was billed on.')

    # Optional delivery / build version label shown on the completion certificate
    delivery_version = fields.Char(string='Delivery Version',
        help='Optional version label for the completion certificate (e.g. "APK v1.0.5").')

    # External reference / ID from the source spreadsheet (REQ-001, UPD-001, BUG-001).
    # Used to cross-reference back to the client's requirement / bug tracker.
    external_ref = fields.Char(string='External Ref', index=True,
        help='ID from the source document (REQ-001, UPD-001, BUG-001, etc.).')

    # For updates / bugs: the external_ref of the parent requirement they amend or relate to.
    related_req_ref = fields.Char(string='Linked To Req',
        help='If this is an Update or Bug, the external_ref of the parent requirement.')

    # Resolved Many2one to the parent requirement KPI (computed from related_req_ref within
    # the same project subtree). Null if no match found.
    related_req_kpi_id = fields.Many2one('kra.kpi',
        string='Linked Requirement KPI',
        compute='_compute_related_req_kpi', store=True,
        help='Resolved parent requirement KPI (matched by external_ref within the same project).')

    # Client-supplied requirement document (PDF/Doc) — attached when issuing the certificate
    requirement_document = fields.Binary(string='Requirement Document', attachment=True,
        help='The original requirement document the client provided (PDF, DOC, etc.).')
    requirement_document_name = fields.Char(string='Requirement Document Filename')
    requirement_version = fields.Char(string='Requirement Version',
        help='Version of the original client requirement (e.g. "v1.1").')

    # Updates / errors / change-log document — captures iterations after the initial requirement
    updates_document = fields.Binary(string='Updates & Errors Document', attachment=True,
        help='Document tracking client-side updates, errors, and new features added during development.')
    updates_document_name = fields.Char(string='Updates Document Filename')

    # Client-signed completion certificate — uploaded by admin after the client signs,
    # OR auto-generated when the client digitally approves via the Client Portal.
    signed_certificate = fields.Binary(string='Signed Completion Certificate', attachment=True,
        help='The completion certificate, signed by the client (uploaded PDF or auto-generated).')
    signed_certificate_name = fields.Char(string='Signed Certificate Filename')
    signed_certificate_date = fields.Date(string='Signed On',
        help='Date the client signed the certificate.')

    # Admin / Manager has reviewed the dev's work and QA-approved it.
    # Set by approve_task(). When True (and state=partially_completed) the task appears
    # in the Client Portal's Completions list — client then signs to finalize.
    admin_approved = fields.Boolean(string='Admin Approved (QA passed)', default=False,
        help='Coordinator reviewed the completed work. Client now sees it in the portal for sign-off.')
    admin_approved_by = fields.Many2one('res.users', string='Admin Approved By', readonly=True)
    admin_approved_date = fields.Datetime(string='Admin Approved On', readonly=True)

    # Stamped the FIRST time a coordinator opens this task while it's in
    # `partially_completed`.  Surfaces the gap between "developer completed"
    # and "coordinator approved/rejected" in the audit log.  Set by the
    # /kpi_review/mark_started endpoint; idempotent (write once).
    coordinator_review_started_at = fields.Datetime(
        string='Coordinator Review Started At', readonly=True, copy=False)
    coordinator_review_started_by = fields.Many2one(
        'res.users', string='Coordinator Review Started By', readonly=True, copy=False)

    # Digital client approval — captured when client signs via the Client Portal.
    client_signature_text = fields.Char(string='Client Signature (typed)',
        help='Typed name the client entered as their digital signature in the portal.')
    client_signed_datetime = fields.Datetime(string='Client Signed At',
        help='Exact server timestamp of the client-portal digital approval.')
    client_approval_notes = fields.Text(string='Client Approval Notes',
        help='Any comments the client added when approving.')
    # Client checklist — must all be true for the client to submit approval.
    client_chk_delivered = fields.Boolean(string='Delivered as specified', default=False)
    client_chk_works = fields.Boolean(string='Works as expected', default=False)
    client_chk_authorized = fields.Boolean(string='Authorized as complete', default=False)

    action_config_id = fields.Many2one("kpi.config.screen", string="Actions")

    next_kpi_id = fields.Many2one('kra.kpi', string='Next KPI')
    warehouse_id = fields.Many2one('kra.warehouse', string="Warehouse")

    description = fields.Text(string='Description')
    checklist = fields.Text(string='Checklist')
    guidelines = fields.Text(string='Guidelines')

    deadline = fields.Date(string='Deadline')
    
    # Reminder interval in days, hours, minutes format
    reminder_days = fields.Integer(string='Reminder Days', default=0)
    reminder_hours = fields.Integer(string='Reminder Hours', default=0)
    reminder_minutes = fields.Integer(string='Reminder Minutes', default=0)
    
    # Track last reminder time and deadline alert shown
    last_reminder_shown = fields.Datetime(string='Last Reminder Shown')
    deadline_alert_shown = fields.Boolean(string='Deadline Alert Shown', default=False)

    points = fields.Float(string='KPI Points')

    # flags
    is_mandatory = fields.Boolean(string='Is Mandatory')
    auto_assign = fields.Boolean(string='Auto Assign')
    auto_estimated = fields.Boolean(string='Auto Estimated')
    is_permanent = fields.Boolean(string='Is Permanent')
    service_kpi = fields.Boolean(string='Service KPI')
    is_meeting = fields.Boolean(string='Is Meeting')
    is_manager_review_needed = fields.Boolean(string='Is Manager Review Needed')
    is_customer_review_needed = fields.Boolean(string='Is Customer Review Needed')

    # file attachment
    uploaded_file = fields.Binary(string='Upload File')
    file_name = fields.Char(string='File Name')

    # 🆕 NEW: Related Links field
    related_links = fields.Text(
        string='Related Links',
        help='JSON array of related links for this KPI'
    )

    # User Manual fields
    user_manual_ids = fields.One2many(
        'kpi.user.manual',
        'kpi_id',
        string='User Manuals'
    )

    user_manual_count = fields.Integer(
        string='Manual Count',
        compute='_compute_user_manual_count'
    )

    @api.depends('user_manual_ids')
    def _compute_user_manual_count(self):
        for rec in self:
            rec.user_manual_count = len(rec.user_manual_ids)

    active = fields.Boolean(string='Active', default=True)

    # Published = admin has reviewed & approved the task for the team to start working.
    # Tasks submitted by clients (portal or bulk import) start published=False and live in
    # the admin's "Client Task Queue" until reviewed. Set True for all legacy/admin-created tasks.
    published = fields.Boolean(string='Published to Team', default=True, index=True,
        help='Tasks become visible to developers once an admin reviews them and clicks Publish.')
    submitted_by_uid = fields.Many2one('res.users', string='Submitted By', readonly=True,
        help='User who originally submitted this task (typically the client portal user).')
    # Set at create time when the submitter is a client (submitted_by_uid alone can't
    # tell them apart — coordinators/owners also submit with published=False).
    # Drives: the client-only Task Queue, auto-approve-on-timeout, and the
    # no-escalation rule (only the submitting client approves).
    client_submitted = fields.Boolean(string='Submitted by Client', default=False,
        readonly=True, index=True,
        help='True when a client user created this task from the app/portal.')
    # Admin re-nudge for a queued client task. Same shape as the pre-approval
    # escalation (frequent cron + per-record due timestamp): the gap lives in
    # res.company.queue_nudge_minutes, not in the cron interval.
    queue_nudge_next_at = fields.Datetime(string='Queue Nudge Next At', copy=False, index=True,
        help='When the admins get re-notified that this client task still has no developer. '
             'Cleared once an admin reads the notification or a developer is assigned.')
    queue_nudge_count = fields.Integer(string='Queue Nudge Count', default=0, copy=False,
        help='How many times the admins have been re-nudged about this queued task.')
    # Admin re-nudge for a 🚨 Urgent pause — same shape as the queue nudge above.
    # The gap lives in res.company.urgent_nudge_minutes (default 5).
    urgent_nudge_next_at = fields.Datetime(string='Urgent Nudge Next At', copy=False, index=True,
        help='When the admins get re-notified that this task is still Urgent-paused. '
             'Cleared once an admin reads the notification or the task resumes/completes.')
    urgent_nudge_count = fields.Integer(string='Urgent Nudge Count', default=0, copy=False,
        help='How many times the admins have been re-nudged about this urgent pause.')
    # Client pressed Hold on their approval → the auto-approve clock is stopped by
    # clearing pre_approval_deadline_at (the cron requires it to be set). This flag
    # is what makes that state explicit rather than inferred from "pending + no
    # deadline", so the board/queue can show "Client held".
    pre_approval_held = fields.Boolean(string='Client Held Approval', default=False, copy=False,
        help="Client paused the auto-approve countdown; the task waits for their "
             "decision instead of approving itself.")

    # Developer self-created tasks — created from the KPI Action Board "New Task"
    # button.  They sit in a separate "Pending Review" lane: workable immediately
    # by the creator (timer runs), but kept OUT of the official flow (no client
    # pre-approval, not billable) until an admin Accepts them.  On Accept the task
    # enters the normal flow and the already-accrued time carries over untouched.
    is_self_created = fields.Boolean(string='Self-Created', default=False, index=True,
        help='Task created by a developer via the board New Task button.')
    # Default False: EVERY task now waits for an admin to accept it before the
    # client is asked to approve.  Client pre-approval is fired by the admin
    # accept endpoint, never by create() — see kpi_workflow.create().
    admin_accepted = fields.Boolean(string='Admin Accepted', default=False,
        help='False while a task waits for admin acceptance; set True when an '
             'admin accepts it into the official flow, which then asks the client.')
    # Admin acceptance is time-boxed.  A task nobody triages used to block its
    # developer forever — it never even reached the client, because pre-approval
    # is only fired on accept.  The deadline is armed the moment a task exists
    # with a developer but no acceptance (kpi_workflow._arm_admin_accept_deadline)
    # and reaped by _cron_admin_accept_timeout.  Cleared by a manual accept, by a
    # send-back (an explicit "no" must stop the clock), and by the auto-accept.
    admin_accept_deadline_at = fields.Datetime(
        string='Admin Accept Deadline', index=True, copy=False,
        help='When this task auto-accepts if no admin has acted. Empty means no '
             'clock is running (already accepted, sent back, or auto-accept off).')
    admin_accepted_at = fields.Datetime(string='Admin Accepted At', readonly=True, copy=False)
    admin_accepted_by_id = fields.Many2one(
        'res.users', string='Admin Accepted By', readonly=True, copy=False,
        help='Who accepted the task. Empty when the acceptance window elapsed and '
             'the system let it through — see admin_accepted_auto.')
    admin_accepted_auto = fields.Boolean(
        string='Auto-Accepted (No Admin Action)', default=False, index=True, copy=False,
        help='True when the admin acceptance window elapsed with nobody acting. NOT '
             'an admin decision: the admin may still re-categorise or reject it.')
    # Set ONLY by a genuine client final sign-off (record_client_final_decision
    # approve path, or approve_task when the client signed offline).  Invoicing
    # keys off this, never off task_state alone.
    # How many "client, please decide" reminders the cron has already sent for
    # the CURRENT approval request.  Capped so a task nobody ever answers can
    # not nudge forever; reset by request_client_pre_approval().
    pre_approval_reminder_count = fields.Integer(
        string='Approval Reminders Sent', default=0, copy=False)
    client_final_approved = fields.Boolean(
        string='Client Signed Off', default=False, index=True, copy=False,
        help='True once the CLIENT has approved the completed task. Only tasks '
             'with this flag are billable.')
    requested_by_id = fields.Many2one('res.users', string='Requested By', readonly=True,
        help='Developer who self-created the task.')
    self_review_note = fields.Char(string='Send-Back Note',
        help="Admin's note shown on the card when a self-created task is sent back to the developer.")
    self_review_by = fields.Char(string='Sent Back By',
        help="Name of the admin who sent the task back.")
    self_resume_note = fields.Char(string='Developer Response',
        help="Developer's note when resuming a sent-back task (what they changed).")
    self_resume_by = fields.Char(string='Resumed By',
        help="Name of the developer who responded / resumed.")
    self_needs_resume_reason = fields.Boolean(string='Needs Resume Reason', default=False,
        help="True after an admin sends the task back; the developer must enter a reason on Resume.")

    # Task state — original 9 values + Advanced Workflow MVP additions.
    # 'partially_completed' stays as the storage value; its display label flips to
    # "Verification Pending" to match the new spec.  New states are additive so
    # existing rows continue to load.
    task_state = fields.Selection([
        ('assigned', 'Assigned'),
        ('urgent', 'Urgent'),
        ('important', 'Important'),
        ('regular', 'Regular'),
        ('queue_waiting', 'Queued'),
        ('pre_approval_pending', 'Pre-Approval Pending'),
        ('pre_approval_approved', 'Pre-Approval Approved'),
        ('pre_approval_partial', 'Partially Approved (Prep Only)'),
        ('in_progress', 'In Progress'),
        ('paused', 'Paused'),
        ('hold', 'On Hold'),
        ('rework', 'Rework Required'),
        ('partially_completed', 'Verification Pending'),
        ('awaiting_client', 'Awaiting Client Sign-off'),  # admin approved, client to sign
        ('completed', 'Completed'),
    ], string='Task State', default='assigned')

    # 🆕 NEW: Approval fields
    # ---- Revert out of "Awaiting Client Sign-off" ------------------------ #
    # An admin can pull a task back off the client's desk when the work turns
    # out to need more doing. Only from 'awaiting_client' — a fully completed,
    # client-signed task is deliberately NOT revertable, because its signature
    # is what invoicing is built on.
    #
    # Modelled as a Selection with one value rather than a boolean so that adding
    # 'completed' later is a value, not a migration.
    reverted_from = fields.Selection([
        ('awaiting_client', 'Reverted from Awaiting Client'),
    ], string='Reverted From', readonly=True, copy=False,
        help="Set when an admin pulls a task back out of client sign-off. Cleared "
             "when the task is completed again, so the badge marks a task that IS "
             "back, not one that once was.")
    reverted_at = fields.Datetime(string='Reverted On', readonly=True, copy=False)
    reverted_by_id = fields.Many2one('res.users', string='Reverted By',
                                     readonly=True, copy=False, ondelete='set null')
    revert_reason = fields.Text(string='Revert Reason', readonly=True, copy=False)

    completed_by = fields.Many2one('res.users', string='Completed By', readonly=True)
    completion_date = fields.Datetime(string='Completion Date', readonly=True)
    approved_by = fields.Many2one('res.users', string='Approved By', readonly=True)
    approval_date = fields.Datetime(string='Approval Date', readonly=True)

    timer_total_seconds = fields.Float(string='Total Time (seconds)', default=0.0)
    timer_start_datetime = fields.Datetime(string='Timer Start')
    paused_reason = fields.Text(string='Paused Reason')

    # Advanced Workflow MVP — pause classification + client pre-approval flow.
    pause_reason_code = fields.Selection([
        ('break',               'Break'),
        ('priority_task',       'Another Priority Task'),
        ('awaiting_approval',   'Waiting for Approval'),
        ('technical_issue',     'Technical Issue'),
        ('leave',               'Leave'),
        ('lunch',               'Lunch'),
        ('meeting',             'Meeting'),
        # Stopping for the day. Deliberately only a LABEL — it does not end the
        # workday, because End Workday cannot be undone for the date and a
        # mis-tap in a reason list must not be able to bury someone's day.
        #
        # There is no matching kpi.break.log type on purpose: start_break files
        # any code outside its _KNOWN_TYPES under 'other', which is already
        # inside `other_secs` and therefore already metered. A reason that
        # reached the break log as an unmetered type would drop out of
        # `metered` and surface as unexplained idle instead.
        ('day_end',             'Day End'),
        ('other',               'Other'),
        # Not idle auto-detection any more — that is retired. This is now time a
        # task was stopped by the SYSTEM rather than by the developer: Pause
        # Workday and the midnight close both pause via reason_code='away'.
        ('away',                'Away (system)'),
        ('urgent',              'Urgent'),
    ], string='Pause Reason Code')

    approval_token = fields.Char(string='Client Approval Token', index=True, copy=False)
    approval_token_expires = fields.Datetime(string='Token Expires', copy=False)
    approval_token_used = fields.Boolean(string='Token Used', default=False, copy=False)

    pre_approval_decision = fields.Selection([
        ('approve',  'Approve'),
        ('reject',   'Reject'),
        ('hold',     'Hold'),
        ('clarify',  'Need Clarification'),
    ], string='Client Pre-Approval Decision', readonly=True)
    pre_approval_decided_at = fields.Datetime(string='Pre-Approval Decided At', readonly=True)
    pre_approval_decided_by_name = fields.Char(string='Pre-Approval Decided By (Name)', readonly=True)
    pre_approval_decided_by_partner_id = fields.Many2one(
        'res.partner', string='Pre-Approval Decided By (Partner)', readonly=True)
    pre_approval_source = fields.Selection([
        ('web',      'Web'),
        ('whatsapp', 'WhatsApp'),
    ], string='Pre-Approval Source', readonly=True)
    pre_approval_feedback = fields.Text(string='Pre-Approval Feedback')
    # Two DIFFERENT clocks, deliberately separate:
    #   pre_approval_deadline_at — the REMINDER tick. Pushed forward after every
    #     nudge, so one task is chased at most once per gap and at most
    #     PRE_APPROVAL_REMINDER_MAX times. Cleared once the reminders run out.
    #   pre_approval_release_at  — the HARD release moment. Armed exactly once by
    #     request_client_pre_approval() and never pushed forward, so the window
    #     means what res.company.client_approval_minutes says it means.
    # Folding them into one field would make the real wait window × (MAX + 1).
    pre_approval_deadline_at = fields.Datetime(string='Pre-Approval Deadline', index=True)
    pre_approval_release_at = fields.Datetime(
        string='Pre-Approval Auto-Release At', index=True, copy=False,
        help="When the client's silence stops blocking the developer. Cleared by any "
             'real decision, by Hold, and by the release itself.')
    # Auto-release is permission to WORK, never permission to BILL.  When this is
    # True the developer may start, but pre_approval_decision stays empty: the
    # client never said yes, so nothing here may ever be read as consent.  The
    # invoice gate is client_final_approved, set only by a real stage-2 sign-off.
    pre_approval_auto_released = fields.Boolean(
        string='Auto-Released (No Client Reply)', default=False, index=True, copy=False,
        help='The approval window elapsed with no client answer, so work may start. '
             'This is NOT consent: the task is still not billable until the client '
             'signs off at completion, and they can still object in the meantime.')
    pre_approval_auto_released_at = fields.Datetime(
        string='Auto-Released At', readonly=True, copy=False)
    pre_approval_auto_released_after_min = fields.Integer(
        string='Auto-Released After (minutes)', readonly=True, copy=False, default=0,
        help='The window that actually elapsed, snapshotted so a later change to '
             'Client Approval Window never rewrites history.')

    pre_approval_notified_user_ids = fields.Many2many(
        'res.users',
        'kra_kpi_pre_approval_notified_rel',
        'kpi_id', 'user_id',
        string='Pre-Approval Notified Clients',
        copy=False,
    )
    pre_approval_next_check_at = fields.Datetime(
        string='Pre-Approval Next Escalation', copy=False, index=True)

    queue_position = fields.Integer(string='Queue Position', index=True)

    _kpi_approval_token_uniq = models.Constraint(
        'UNIQUE (approval_token)',
        'Approval token must be unique.',
    )

    # ✅ ADD THESE FIELDS in kpi.py after line ~60 (near other task_state fields)

    # Employee completion checklist
    employee_checklist_github = fields.Boolean(string='Verify Github URL', default=False)
    employee_checklist_deployed = fields.Boolean(string='Deployed the Task', default=False)
    employee_checklist_manual = fields.Boolean(string='User Manual Uploaded', default=False)
    employee_checklist_docs = fields.Boolean(string='Documentation Submission', default=False)
    employee_checklist_tested = fields.Boolean(string='Manually Tested the Code', default=False)

    # Manager approval checklist
    manager_checklist_reviewed = fields.Boolean(string='Task Reviewed', default=False)
    manager_checklist_manual_reviewed = fields.Boolean(string='User Manual Reviewed', default=False)
    manager_checklist_testing = fields.Boolean(string='Testing Completed', default=False)
    manager_checklist_github = fields.Boolean(string='Verified Github Repositories', default=False)
    manager_checklist_tested_success = fields.Boolean(string='Task Tested Successfully', default=False)
    manager_checklist_docs_approved = fields.Boolean(string='Documentation Approved', default=False)

    @api.model
    def _now(self):
        return fields.Datetime.now()

    def _add_elapsed(self, rec, now_dt=None):
        if not now_dt:
            now_dt = fields.Datetime.now()
        if rec.timer_start_datetime:
            start = fields.Datetime.from_string(rec.timer_start_datetime)
            end = fields.Datetime.from_string(now_dt)
            elapsed = (end - start).total_seconds()
            if elapsed > 0:
                rec.timer_total_seconds = float_round(rec.timer_total_seconds + elapsed, precision_digits=2)

    def start_task(self):
        for rec in self:
            if rec.task_state in ['completed', 'partially_completed', 'awaiting_client']:
                continue
            if not rec.timer_start_datetime:
                rec.timer_start_datetime = self._now()
                # Log time session start
                self.env['kpi.time.log'].start_session(rec.id, self.env.user.id)
            rec.task_state = 'in_progress'
            rec.paused_reason = False

    def pause_task(self, reason='', reason_code='', at=None):
        # reason_code (e.g. 'break', 'lunch', 'away') comes from the
        # /kra_kpi/task/pause route and from the workday-close paths in
        # kpi_work_session (_pause_running_task); accept it here (was missing →
        # TypeError when a pause carried a reason).
        #
        # `at` CAPS when the work stopped (default = now). It must reach BOTH
        # sinks or they disagree: _add_elapsed grows timer_total_seconds, and
        # stop_session closes the kpi.time.log interval. The midnight close passes
        # the local day-end so a late cron cannot credit task time to a session
        # that had already ended.
        for rec in self:
            if rec.timer_start_datetime:
                self._add_elapsed(rec, now_dt=at)
                rec.timer_start_datetime = False
                # Log time session stop
                self.env['kpi.time.log'].stop_session(rec.id, self.env.user.id, at=at)
            rec.task_state = 'paused'
            rec.paused_reason = reason or rec.paused_reason
            if reason_code:
                rec.pause_reason_code = reason_code

    def resume_task(self):
        for rec in self:
            if rec.task_state in ['completed', 'partially_completed', 'awaiting_client']:
                continue
            if not rec.timer_start_datetime:
                rec.timer_start_datetime = self._now()
                # Log time session start
                self.env['kpi.time.log'].start_session(rec.id, self.env.user.id)
            rec.task_state = 'in_progress'

    # 🆕 UPDATED: Complete task now goes to partially_completed
    def complete_task(self, employee_checklist=None):
        """Employee marks task as complete with checklist - goes to Partially Completed"""
        for rec in self:
            # A reverted task that has been worked and re-submitted is no longer
            # "back from client sign-off" — it is on its way forward again. The
            # badge marks a task that IS back, not one that once was, so it is
            # cleared here rather than left as permanent history (the audit trail
            # lives in kpi.action.log).
            if rec.reverted_from:
                rec.reverted_from = False
            if rec.timer_start_datetime:
                self._add_elapsed(rec)
                rec.timer_start_datetime = False
                # Log time session stop
                self.env['kpi.time.log'].stop_session(rec.id, self.env.user.id)
            
            # ✅ Save employee checklist
            if employee_checklist:
                rec.employee_checklist_github = employee_checklist.get('verify_github', False)
                rec.employee_checklist_deployed = employee_checklist.get('deployed_task', False)
                rec.employee_checklist_manual = employee_checklist.get('user_manual', False)
                rec.employee_checklist_docs = employee_checklist.get('documentation', False)
                rec.employee_checklist_tested = employee_checklist.get('tested_code', False)
            
            rec.task_state = 'partially_completed'
            rec.completed_by = self.env.user
            rec.completion_date = self._now()

    # 🆕 UPDATED: Two-stage approval flow.
    # Stage 1 — approve_task() = admin/manager QA approval (this method). Task STAYS in
    #           partially_completed but admin_approved is set to True. The client portal
    #           then shows this task on the Completions page for the client to sign.
    # Stage 2 — client signs from the portal (separate path) which moves task to 'completed'.
    def approve_task(self, manager_checklist=None):
        """Manager/admin QA-approves the task. Does NOT move to 'completed' — just marks
        admin_approved=True so the task appears in the client portal for sign-off.
        Use the client-portal approve endpoint for the final 'completed' transition."""
        for rec in self:
            if rec.task_state != 'partially_completed':
                raise ValidationError("Only partially completed tasks can be approved!")
            # If the client has already signed (e.g. signed offline + admin uploaded the PDF),
            # we go all the way to 'completed' as before.
            client_has_signed = bool(rec.signed_certificate or rec.client_signature_text)
            
            # ✅ Save manager checklist
            if manager_checklist:
                rec.manager_checklist_reviewed = manager_checklist.get('task_reviewed', False)
                rec.manager_checklist_manual_reviewed = manager_checklist.get('manual_reviewed', False)
                rec.manager_checklist_testing = manager_checklist.get('testing_completed', False)
                rec.manager_checklist_github = manager_checklist.get('github_verified', False)
                rec.manager_checklist_tested_success = manager_checklist.get('tested_successfully', False)
                rec.manager_checklist_docs_approved = manager_checklist.get('docs_approved', False)

            # Always record the admin QA approval
            rec.admin_approved = True
            rec.admin_approved_by = self.env.user
            rec.admin_approved_date = self._now()

            if client_has_signed:
                # Client already signed (offline or via portal earlier) — close the task fully.
                rec.task_state = 'completed'
                rec.approved_by = self.env.user
                rec.approval_date = self._now()
                # A real client signature exists, so this is billable.
                rec.client_final_approved = True
            elif not rec._client_approvers():
                # NOBODY can ever sign this off — the KRA has no client users
                # linked. Parking it in 'awaiting_client' would leave it sitting
                # in a queue waiting on a person who does not exist, showing
                # "waiting for the client" on a card that is, in fact, finished.
                #
                # Closed as completed on the ADMIN's approval, which is the last
                # real decision available. client_final_approved stays FALSE: no
                # client signed, so nothing here may be treated as their consent —
                # the same line drawn by the pre-approval no-client path.
                rec.task_state = 'completed'
                rec.approved_by = self.env.user
                rec.approval_date = self._now()
                try:
                    rec._log_action(
                        'completed_no_client', source='web',
                        payload={'reason': 'KRA has no client users linked',
                                 'kra': rec.kra_id.name if rec.kra_id else ''})
                except Exception:
                    pass
            else:
                # Move to a dedicated 'awaiting client sign-off' state so the kanban
                # transitions out of "Pending Approvals". Client portal picks this up.
                rec.task_state = 'awaiting_client'

    # 🆕 NEW: Reject task - sends back to paused state
    def reject_task(self, rejection_reason=''):
        """Manager/HR rejects the task - sends back to Paused with rejection reason"""
        for rec in self:
            if rec.task_state != 'partially_completed':
                raise ValidationError("Only partially completed tasks can be rejected!")
            
            # ✅ FIXED: Send to PAUSED instead of in_progress
            # This prevents timer from auto-starting
            rec.task_state = 'paused'
            rec.timer_start_datetime = False  # ✅ Ensure timer is stopped
            rec.paused_reason = f"🔴 REJECTED - Manager Feedback: {rejection_reason}"
            rec.completed_by = False
            rec.completion_date = False

    @api.model
    def _next_ref_for_prefix(self, prefix):
        """Next N for '<PREFIX>-<NNN>' external_ref — a global, case-insensitive
        counter shared across everyone so REQ/UPT/BUG/TASK each stay unique.
        Mirrors _next_ref_number_for_prefix in kpi_reports_api (used for the
        '+ New Task' TASK-### ref and for re-numbering on admin accept)."""
        if not prefix:
            return 1
        refs = self.sudo().search(
            [('external_ref', '=ilike', '%s-%%' % prefix)]).mapped('external_ref')
        pat = re.compile(r'^%s-(\d+)$' % re.escape(prefix), re.IGNORECASE)
        max_n = 0
        for r in refs:
            m = pat.match((r or '').strip())
            if m:
                try:
                    max_n = max(max_n, int(m.group(1)))
                except ValueError:
                    pass
        return max_n + 1

    def reassign_task(self, user_id, reason):
        """
        🆕 UPDATED: Reassign task with history tracking and state reset
        """
        for rec in self:
            if not user_id:
                continue
            
            # Get current user (manager/admin doing the reassignment)
            current_user = self.env.user
            
            # Store previous assignee info
            previous_assignee = rec.user_id
            previous_state = rec.task_state
            previous_time = rec.timer_total_seconds
            was_paused = (previous_state == 'paused')
            previous_pause_reason = rec.paused_reason if was_paused else ''
            
            # Stop timer if running
            if rec.timer_start_datetime:
                self._add_elapsed(rec)
                rec.timer_start_datetime = False
            # Close the previous assignee's running time-log segment so their time
            # on this task is RECORDED (End Workday popup + Workday Map) even though
            # the task is now moving to someone else. No-op if nothing is running.
            if previous_assignee:
                self.env['kpi.time.log'].sudo().stop_session(rec.id, previous_assignee.id)

            # Create reassignment history record
            history_vals = {
                'kpi_id': rec.id,
                'previous_assignee_id': previous_assignee.id if previous_assignee else False,
                'previous_assignee_name': previous_assignee.name if previous_assignee else 'Unassigned',
                'new_assignee_id': int(user_id),
                'new_assignee_name': self.env['res.users'].browse(int(user_id)).name,
                'reassigned_by_id': current_user.id,
                'reassigned_by_name': current_user.name,
                'reassignment_date': fields.Datetime.now(),
                'reassignment_reason': reason,
                'previous_state': previous_state,
                'time_spent_seconds': previous_time,
                'was_paused': was_paused,
                'pause_reason': previous_pause_reason,
            }
            
            self.env['kpi.reassignment.history'].create(history_vals)
            
            # Update text log for quick reference
            new_assignee = self.env['res.users'].browse(int(user_id))
            log_entry = f"\n[{fields.Datetime.now()}] Reassigned from {previous_assignee.name if previous_assignee else 'Unassigned'} to {new_assignee.name} by {current_user.name}. Reason: {reason}. Previous state: {previous_state}, Time spent: {previous_time}s"
            
            if rec.reassignment_log:
                rec.reassignment_log += log_entry
            else:
                rec.reassignment_log = log_entry
            
            # Reset task to initial state based on priority
            rec.write({
                'user_id': int(user_id),
                'task_state': rec.priority,  # Reset to priority-based state
                'timer_total_seconds': 0.0,  # Reset timer
                'timer_start_datetime': False,  # Clear start time
                'paused_reason': False,  # Clear pause reason
                'completed_by': False,  # Clear completion info
                'completion_date': False,
                'approved_by': False,  # Clear approval info
                'approval_date': False,
            })

    @api.depends('progress_ids')
    def _compute_progress_count(self):
        for rec in self:
            rec.progress_count = len(rec.progress_ids)

    @api.depends('reassignment_history_ids')
    def _compute_reassignment_count(self):
        """🆕 NEW: Compute reassignment count"""
        for rec in self:
            rec.reassignment_count = len(rec.reassignment_history_ids)

    @api.depends('estimate_hours', 'estimate_minutes')
    def _compute_estimate(self):
        """Compute total estimate in hours from hours and minutes"""
        for rec in self:
            total_hours = rec.estimate_hours + (rec.estimate_minutes / 60.0)
            rec.estimate = float_round(total_hours, precision_digits=2)

    @api.constrains('estimate_minutes')
    def _check_estimate_minutes(self):
        """Validate that minutes are between 0 and 59"""
        for rec in self:
            if rec.estimate_minutes < 0 or rec.estimate_minutes > 59:
                raise ValueError("Minutes must be between 0 and 59")

    @api.depends('user_id', 'contributor_ids', 'developer_ids', 'tester_ids', 'coordinator_ids', 'lead_ids')
    def _compute_effective_contributors(self):
        for rec in self:
            rec.effective_contributor_ids = (
                rec.user_id | rec.contributor_ids
                | rec.developer_ids | rec.tester_ids | rec.coordinator_ids | rec.lead_ids
            )

    def _get_user_role(self, user_id):
        """Return a role string for a user on this KPI. First-match order: dev, test, coord, lead.
        If user is the primary assignee but not in any list, falls back to 'developer'."""
        self.ensure_one()
        uid = user_id if isinstance(user_id, int) else user_id.id
        if uid in self.developer_ids.ids:
            return 'developer'
        if uid in self.tester_ids.ids:
            return 'tester'
        if uid in self.coordinator_ids.ids:
            return 'coordinator'
        if uid in self.lead_ids.ids:
            return 'lead'
        if self.user_id and uid == self.user_id.id:
            return 'developer'
        return 'developer'

    @api.depends('client_quoted_hours', 'client_quoted_minutes')
    def _compute_kpi_client_quoted(self):
        for rec in self:
            rec.client_quoted = (rec.client_quoted_hours or 0) + (rec.client_quoted_minutes or 0) / 60.0

    @api.constrains('client_quoted_minutes')
    def _check_client_quoted_minutes(self):
        for rec in self:
            if rec.client_quoted_minutes < 0 or rec.client_quoted_minutes > 59:
                raise ValidationError("Client Quoted Minutes must be between 0 and 59")

    @api.depends('related_req_ref', 'client_kra_id', 'kra_id')
    def _compute_related_req_kpi(self):
        """Resolve related_req_ref → parent requirement KPI within the same client subtree."""
        Kpi = self.env['kra.kpi']
        for rec in self:
            ref = (rec.related_req_ref or '').strip()
            if not ref or not rec.client_kra_id:
                rec.related_req_kpi_id = False
                continue
            client_kra_ids = rec.client_kra_id._get_descendant_ids()
            match = Kpi.search([
                ('external_ref', '=', ref),
                ('kra_id', 'in', client_kra_ids),
                ('id', '!=', rec.id),
            ], limit=1)
            rec.related_req_kpi_id = match.id if match else False

    @api.depends('kra_id', 'kra_id.parent_id', 'kra_id.is_client')
    def _compute_client_kra(self):
        """Walk up the KRA hierarchy to find the nearest is_client=True ancestor."""
        Kra = self.env['kra.master']
        for rec in self:
            cur = rec.kra_id
            found = Kra
            while cur:
                if cur.is_client:
                    found = cur
                    break
                cur = cur.parent_id
            rec.client_kra_id = found

    @api.depends('invoice_line_ids', 'invoice_line_ids.invoice_id.state')
    def _compute_is_invoiced(self):
        """A task is 'billed' once it sits on a finalized or sent invoice line.
        Draft invoices are still editable, so they don't lock the task."""
        for task in self:
            locked = task.invoice_line_ids.filtered(
                lambda l: l.invoice_id and l.invoice_id.state in ('finalized', 'sent'))
            task.is_invoiced = bool(locked)
            task.invoiced_on_id = locked[:1].invoice_id if locked else False

    def get_estimate_display(self):
        """Return estimate in HH:MM format"""
        self.ensure_one()
        return f"{self.estimate_hours:02d}:{self.estimate_minutes:02d}"

    # --------------------------------------------------------------------- #
    # A task's name always starts with a capital letter. Enforced in the model
    # so it holds no matter WHERE the task is created or renamed — the mobile
    # app, the web form, the create_kpi API, imports, or any other code path.
    # Only the first character is touched; the rest of the name is left as-is.
    # --------------------------------------------------------------------- #
    @staticmethod
    def _cap_first(name):
        if not name:
            return name
        stripped = name.strip()
        return (stripped[:1].upper() + stripped[1:]) if stripped else name

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name'):
                vals['name'] = self._cap_first(vals['name'])
        return super().create(vals_list)

    def write(self, vals):
        if vals.get('name'):
            vals['name'] = self._cap_first(vals['name'])
        return super().write(vals)

    @api.model
    def find_name_matches(self, name, kra_id, limit=5):
        """Existing tasks under this KRA whose name matches — for the create form's
        "already used here" hint.

        Advisory only: create_kpi does not refuse a duplicate (see the note there).
        Scoped to the one KRA because that is the only place a repeated name is
        actually confusing; the same name under a different project is normal.
        """
        name = (name or '').strip()
        if not name or not kra_id:
            return []
        try:
            kra_id = int(kra_id)
        except (TypeError, ValueError):
            return []
        rows = self.sudo().search(
            [('name', '=ilike', name), ('kra_id', '=', kra_id)], limit=limit)
        return [{
            'id': r.id,
            'name': r.name or '',
            'external_ref': r.external_ref or '',
            'state': r.task_state or '',
            'assignee': r.user_id.name if r.user_id else '',
        } for r in rows]

    @api.model
    def log_manual_time(self, kpi_id, seconds, user_id=False, work_date=False):
        """Back-fill work that happened off-system, from the report's New Task box.

        Worked time lives in TWO places that are not derived from one another:
        `timer_total_seconds` on the task (what the KRA Report's Time Worked
        column and every total read) and `kpi.time.log` rows (what decides
        whether the task matches a report's date range, and what the per-task
        "who worked on this" breakdown is built from). Writing only one of them
        gives a task that reads 0h, or one that is invisible to its own date
        range — so both happen here, in one call.

        `duration_seconds` and `work_date` on the log are computed+stored from
        start/end, so this sets the times and lets them derive. Midday in the
        user's timezone is used as the anchor so the computed work_date lands on
        the intended day rather than slipping either side of midnight.
        """
        seconds = float(seconds or 0)
        if not kpi_id or seconds <= 0:
            return False

        kpi = self.browse(int(kpi_id))
        if not kpi.exists():
            raise ValidationError("That task no longer exists.")

        user = self.env['res.users'].browse(int(user_id)) if user_id else kpi.user_id
        if not user:
            # A time log is attributed to a person, and feeds invoicing and the
            # employee reports. There is nobody to attribute this to.
            raise ValidationError("Pick an assignee before recording time worked.")

        import pytz
        from datetime import time as _time
        tz_name = user.tz or self.env.user.tz or 'Asia/Kolkata'
        day = fields.Date.to_date(work_date) if work_date else fields.Date.context_today(self)
        try:
            anchor = pytz.timezone(tz_name).localize(datetime.combine(day, _time(12, 0)))
            start = anchor.astimezone(pytz.UTC).replace(tzinfo=None)
        except Exception:
            # Never let a bad tz string stop the time being recorded.
            start = datetime.combine(day, _time(12, 0))

        self.env['kpi.time.log'].sudo().create({
            'kpi_id': kpi.id,
            'user_id': user.id,
            'start_time': start,
            'end_time': start + timedelta(seconds=int(seconds)),
            'is_active': False,
        })
        kpi.sudo().write({
            'timer_total_seconds': (kpi.timer_total_seconds or 0.0) + seconds,
        })
        return True

    @api.model
    def create_kpi(self, vals):
        if isinstance(vals, (list, tuple)) and vals:
            vals = vals[0]
        vals = vals or {}

        kpi_name = vals.get('name', '').strip()
        
        if not kpi_name:
            raise ValidationError("KPI name is required")
        
        # A duplicate task name is NOT refused. It used to raise, which read as a
        # data-integrity rule but is not one: the same piece of work legitimately
        # recurs under a KRA — "Monthly report", "Sprint review" — and the old
        # behaviour forced people to invent "Monthly report 2" to get past it.
        # Unlike kra.master, where a duplicate genuinely makes the tree ambiguous,
        # two tasks with one name are merely two tasks.
        #
        # The warning now lives in the UI instead: kra.kpi.find_name_matches feeds
        # a suggestion under the name field while typing. Callers wanting to check
        # first can use that; nothing here blocks.
        rec_vals = {
            'name': vals.get('name'),
            'kra_id': vals.get('kra_id'),
            'estimate_hours': vals.get('estimate_hours', 0),
            'estimate_minutes': vals.get('estimate_minutes', 0),
            'priority': vals.get('priority', 'regular'),
            'user_group_id': vals.get('user_group_id') or False,
            'user_id': vals.get('user_id') or False,
            'action_config_id': vals.get('action_config_id') or False,
            'next_kpi_id': vals.get('next_kpi_id') or False,
            'warehouse_id': vals.get('warehouse_id') or False,
            'description': vals.get('description'),
            'checklist': vals.get('checklist'),
            'guidelines': vals.get('guidelines'),
            'deadline': vals.get('deadline') or False,
            'reminder_days': vals.get('reminder_days') or 0,
            'reminder_hours': vals.get('reminder_hours') or 0,
            'reminder_minutes': vals.get('reminder_minutes') or 0,
            'points': vals.get('points') or 0.0,
            'is_mandatory': bool(vals.get('is_mandatory')),
            'auto_assign': bool(vals.get('auto_assign')),
            'auto_estimated': bool(vals.get('auto_estimated')),
            'is_permanent': bool(vals.get('is_permanent')),
            'service_kpi': bool(vals.get('service_kpi')),
            'is_meeting': bool(vals.get('is_meeting')),
            'is_manager_review_needed': bool(vals.get('is_manager_review_needed')),
            'is_customer_review_needed': bool(vals.get('is_customer_review_needed')),
            'uploaded_file': vals.get('uploaded_file'),
            'file_name': vals.get('file_name'),
            'related_links': vals.get('related_links', '[]'),
            'active': bool(vals.get('active', True)),
            'contributor_ids': [(6, 0, [int(u) for u in (vals.get('contributor_ids') or [])])],
            'client_quoted_hours': vals.get('client_quoted_hours', 0),
            'client_quoted_minutes': vals.get('client_quoted_minutes', 0),
        }

        # Type -> a real REQ / UPT / BUG ref, when the caller states one.
        #
        # Without this the task lands with no external_ref at all, which means no
        # Type in the KRA Report AND — because the report matches types on that
        # prefix — it is dropped by any Type filter. Self-created tasks stage as
        # TASK-### and get their real ref on admin Accept; a caller that already
        # knows the type (an admin adding from the report) is authoritative, so
        # the ref is minted here. Imported lazily: models/__init__ loads kpi
        # before kpi_workflow.
        doc_type = vals.get('doc_type')
        if doc_type:
            from .kpi_workflow import REF_PREFIX_FOR_DOC_TYPE, NAME_PREFIX_FOR_DOC_TYPE
            prefix = REF_PREFIX_FOR_DOC_TYPE.get(doc_type)
            if prefix:
                rec_vals['external_ref'] = '%s-%03d' % (
                    prefix, self._next_ref_for_prefix(prefix))
                rec_vals['name'] = (
                    NAME_PREFIX_FOR_DOC_TYPE.get(doc_type, '') + (rec_vals['name'] or ''))
                rec_vals['requested_doc_type'] = doc_type

        rec = self.create(rec_vals)
        return rec.id

    def get_completion_certificate_data(self):
        """Return everything the jsPDF certificate generator needs for this KPI."""
        self.ensure_one()
        company = self.env.company

        # Resolve root KRA (= client) and immediate KRA (= project)
        root = self.kra_id
        while root and root.parent_id:
            root = root.parent_id
        project_kra = self.kra_id if self.kra_id and self.kra_id != root else self.env['kra.master']

        # Company logo — same resolution order as the invoice (kpi_client_invoice
        # get_pdf_data): company branding, then the root KRA's own logo, then the
        # module's bundled brand logo. This used to read company.logo unguarded, so a
        # company that never uploaded one printed Odoo's grey "Your logo" placeholder
        # onto the certificate; uses_default_logo is how you tell that apart.
        logo_b64 = ''
        branding_logo = company.logo if not company.uses_default_logo else False
        for candidate in (branding_logo, root.logo if root else False):
            if candidate:
                logo_b64 = candidate.decode() if isinstance(candidate, bytes) else candidate
                break
        if not logo_b64:
            try:
                import base64 as _b64logo
                from odoo.tools import file_open
                with file_open('kra_kpi_module/static/src/img/alphalize_logo.png', 'rb') as f:
                    logo_b64 = _b64logo.b64encode(f.read()).decode()
            except Exception:
                logo_b64 = ''

        # Per-contributor breakdown of actual time on this KPI, plus per-role aggregation.
        logs = self.env['kpi.time.log'].search([
            ('kpi_id', '=', self.id),
            ('is_active', '=', False),
        ])
        by_user = {}
        for l in logs:
            uid = l.user_id.id
            if uid not in by_user:
                by_user[uid] = {
                    'user_id': uid,
                    'name': l.user_id.name or l.user_id.login or 'Unknown',
                    'role': self._get_user_role(uid),
                    'seconds': 0,
                }
            by_user[uid]['seconds'] += (l.duration_seconds or 0)
        contributors = sorted([
            {'user_id': v['user_id'], 'name': v['name'], 'role': v['role'],
             'hours': round(v['seconds'] / 3600.0, 2)}
            for v in by_user.values()
        ], key=lambda d: -d['hours'])

        # If no logs exist but a primary assignee + timer_total_seconds is set, fall back to that.
        if not contributors and self.timer_total_seconds and self.user_id:
            contributors = [{
                'user_id': self.user_id.id,
                'name': self.user_id.name or self.user_id.login or 'Unknown',
                'role': self._get_user_role(self.user_id.id),
                'hours': round((self.timer_total_seconds or 0) / 3600.0, 2),
            }]

        # Aggregate by role for the certificate's role-summary table.
        role_totals = {'developer': 0.0, 'tester': 0.0, 'coordinator': 0.0, 'lead': 0.0}
        for c in contributors:
            role_totals[c['role']] = role_totals.get(c['role'], 0.0) + c['hours']

        total_hours = round((self.timer_total_seconds or 0) / 3600.0, 2)
        estimate_hours = (self.estimate_hours or 0) + (self.estimate_minutes or 0) / 60.0

        def _date(d):
            return d.strftime('%Y-%m-%d') if d else ''

        def _datetime(d):
            return d.strftime('%Y-%m-%d %H:%M') if d else ''

        return {
            'company_name': company.name or '',
            'company_logo_b64': logo_b64,
            'client_name': root.name if root else '',
            'project_name': project_kra.name if project_kra else '',
            'kpi': {
                'id': self.id,
                'name': self.name or '',
                'description': self.description or '',
                'guidelines': self.guidelines or '',
                'checklist': self.checklist or '',
                'task_state': self.task_state or '',
                'priority': self.priority or '',
                'delivery_version': self.delivery_version or '',
                'requirement_version': self.requirement_version or '',
                'requirement_document_name': self.requirement_document_name or '',
                'has_requirement_document': bool(self.requirement_document),
                'updates_document_name': self.updates_document_name or '',
                'has_updates_document': bool(self.updates_document),
                'estimate_hours': round(estimate_hours, 2),
                'actual_hours': total_hours,
                'assigned_date': _datetime(self.create_date),
                'deadline': _date(self.deadline),
                'completion_date': _datetime(self.completion_date),
                'approval_date': _datetime(self.approval_date),
                'primary_assignee': self.user_id.name if self.user_id else '',
                'approved_by': self.approved_by.name if self.approved_by else '',
                'has_signed_certificate': bool(self.signed_certificate),
                'signed_certificate_name': self.signed_certificate_name or '',
                'signed_certificate_date': _date(self.signed_certificate_date),
                # The sign-off itself. None of this was returned here, so the only way
                # to see who signed and what they confirmed was to open the raw .txt
                # receipt — which is exactly what the branded certificate replaces.
                # /kpi_client_approval/get bolted these on afterwards; they belong at
                # the source, where every caller gets them.
                'external_ref': self.external_ref or '',
                'client_signature_text': self.client_signature_text or '',
                'client_signed_datetime': _datetime(self.client_signed_datetime),
                'client_approval_notes': self.client_approval_notes or '',
                'client_chk_delivered': bool(self.client_chk_delivered),
                'client_chk_works': bool(self.client_chk_works),
                'client_chk_authorized': bool(self.client_chk_authorized),
            },
            'contributors': contributors,
            'role_totals': [
                {'role': 'developer',   'label': 'Developer',   'hours': round(role_totals.get('developer', 0.0), 2)},
                {'role': 'tester',      'label': 'Tester',      'hours': round(role_totals.get('tester', 0.0), 2)},
                {'role': 'coordinator', 'label': 'Coordinator', 'hours': round(role_totals.get('coordinator', 0.0), 2)},
                {'role': 'lead',        'label': 'Lead',        'hours': round(role_totals.get('lead', 0.0), 2)},
            ],
            'total_hours': total_hours,
        }