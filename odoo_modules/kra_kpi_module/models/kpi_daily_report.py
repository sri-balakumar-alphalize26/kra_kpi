# Daily employee task report — one consolidated PDF per day, delivered to admins.
#
# WHY SERVER-SIDE (reportlab) AND NOT THE BROWSER jsPDF EXPORT: this is fired by
# a cron, which has no browser. The app's existing "export to PDF" uses jsPDF /
# autotable loaded as CDN backend assets — client-only, unusable here. Same
# reasoning as the workday snapshot image (drawn server-side with Pillow).
#
# The report content is NOT re-derived: kpi.employee.report.get_report_data()
# already groups every employee's tasks for a date range (tasks, estimate vs
# actual, dated progress, completion/approval, performance). We call it for a
# single day and enrich it with attendance from kpi.work.session, then lay the
# whole thing out as one PDF: a team summary page + one section per employee.

import base64
import io
import logging
from datetime import timedelta

from dateutil.relativedelta import relativedelta
import pytz

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

_IST = pytz.timezone('Asia/Kolkata')


def _fmt_secs(seconds):
    """Integer seconds → 'Hh Mm' (matches the module's other summaries)."""
    s = int(seconds or 0)
    h, rem = divmod(s, 3600)
    m = rem // 60
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def _ist_hm(dt, fmt='%H:%M'):
    """A naive-UTC datetime → IST 'HH:MM' string ('—' when empty)."""
    if not dt:
        return '—'
    try:
        return pytz.UTC.localize(dt).astimezone(_IST).strftime(fmt)
    except Exception:
        try:
            return dt.strftime(fmt)
        except Exception:
            return '—'


class KpiDailyReport(models.Model):
    _name = 'kpi.daily.report'
    _description = 'Daily Employee Task Report (generated PDF)'
    _order = 'report_date desc, id desc'
    _rec_name = 'report_date'

    report_date = fields.Date(string='Report Date', required=True, index=True)
    # attachment=True keeps the PDF bytes in the FILESTORE, not a db bytea column
    # — the house rule (see kpi.workday.snapshot.image / kpi.user.manual.manual_file).
    pdf_file = fields.Binary(string='Report PDF', attachment=True)
    pdf_filename = fields.Char(string='File Name')
    employee_count = fields.Integer(string='Employees')
    task_count = fields.Integer(string='Tasks')
    generated_at = fields.Datetime(string='Generated At')

    # ONE report per day. Regenerating a day upserts this row rather than adding a
    # second. models.Constraint, NOT _sql_constraints — Odoo 19 silently ignores
    # the old attribute (see the note on kpi.workday.snapshot._uniq_user_day).
    _uniq_report_day = models.Constraint(
        'UNIQUE (report_date)',
        'A daily report already exists for this date.',
    )

    # ------------------------------------------------------------------ #
    # Data collection — reuse kpi.employee.report + kpi.work.session     #
    # ------------------------------------------------------------------ #
    def _collect_payload(self, day):
        """Build the consolidated per-employee payload for one date (a date obj).

        Employees included = union of (had a work session that day) ∪ (had task
        activity that day per kpi.employee.report). Returns a dict ready for
        _build_pdf, or None when nobody worked (caller skips the send).
        """
        # Task detail per employee, straight from the existing report engine.
        wiz = self.env['kpi.employee.report'].sudo().create({
            'from_date': day, 'to_date': day,
        })
        try:
            emp_reports = wiz.get_report_data() or []
        finally:
            wiz.sudo().unlink()  # transient — don't leak rows
        by_uid = {e['employee_id']: e for e in emp_reports}

        # Attendance from work sessions (presence / productive / login-logout).
        sessions = self.env['kpi.work.session'].sudo().search(
            [('session_date', '=', day)])
        att = {}
        for s in sessions:
            uid = s.user_id.id
            a = att.get(uid)
            if not a:
                a = att[uid] = {
                    'name': s.user_id.name,
                    'login_at': s.login_at,
                    'logout_at': s.logout_at,
                    'presence_seconds': 0.0,
                    'productive_seconds': 0.0,
                    'sessions': 0,
                    'auto_closed': False,
                    'notes': [],
                }
            a['presence_seconds'] += s.presence_seconds or 0.0
            a['productive_seconds'] += s.productive_seconds or 0.0
            a['sessions'] += 1
            a['auto_closed'] = a['auto_closed'] or bool(s.auto_closed)
            if s.login_at and (not a['login_at'] or s.login_at < a['login_at']):
                a['login_at'] = s.login_at
            if s.logout_at and (not a['logout_at'] or s.logout_at > a['logout_at']):
                a['logout_at'] = s.logout_at
            if s.note:
                a['notes'].append(s.note)

        # Merge: one row per employee in either source.
        uids = list(dict.fromkeys(list(by_uid.keys()) + list(att.keys())))
        employees = []
        total_tasks = 0
        for uid in uids:
            rep = by_uid.get(uid) or {}
            a = att.get(uid) or {}
            tasks = rep.get('tasks', [])
            total_tasks += len(tasks)
            employees.append({
                'name': rep.get('employee_name') or a.get('name') or 'Unknown',
                'email': rep.get('employee_email') or '',
                'login_display': _ist_hm(a.get('login_at')),
                'logout_display': _ist_hm(a.get('logout_at')) if a.get('logout_at') else 'open',
                'presence_display': _fmt_secs(a.get('presence_seconds')),
                'productive_display': _fmt_secs(a.get('productive_seconds')),
                'sessions': a.get('sessions', 0),
                'auto_closed': a.get('auto_closed', False),
                'notes': a.get('notes', []),
                'total_tasks': rep.get('total_tasks', len(tasks)),
                'completed_tasks': rep.get('completed_tasks', 0),
                'in_progress_tasks': rep.get('in_progress_tasks', 0),
                'pending_tasks': rep.get('pending_tasks', 0),
                'total_estimated_display': rep.get('total_estimated_hours_display', '0h 0m'),
                'total_actual_display': rep.get('total_actual_hours_display', '0h 0m'),
                'tasks': tasks,
            })

        if not employees:
            return None

        employees.sort(key=lambda e: e['name'].lower())
        return {
            'report_date': day,
            'date_display': day.strftime('%d %b %Y (%A)'),
            'company': self.env.company.name,
            'generated_display': _ist_hm(fields.Datetime.now(), '%d %b %Y %H:%M') + ' IST',
            'employees': employees,
            'total_employees': len(employees),
            'total_tasks': total_tasks,
        }

    # ------------------------------------------------------------------ #
    # PDF rendering — reportlab (lazy import, like Pillow in the snapshot) #
    # ------------------------------------------------------------------ #
    def _build_pdf(self, p):
        """Render the payload to PDF bytes with reportlab.platypus."""
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak,
        )

        ink = colors.HexColor('#0F172A')
        muted = colors.HexColor('#64748B')
        line = colors.HexColor('#E2E8F0')
        head_bg = colors.HexColor('#1E40AF')
        panel = colors.HexColor('#F8FAFC')

        styles = getSampleStyleSheet()
        h_title = ParagraphStyle('t', parent=styles['Title'], textColor=ink, fontSize=20, spaceAfter=2)
        h_meta = ParagraphStyle('m', parent=styles['Normal'], textColor=muted, fontSize=9, spaceAfter=1)
        h_emp = ParagraphStyle('e', parent=styles['Heading2'], textColor=head_bg, fontSize=14, spaceBefore=4, spaceAfter=2)
        cell = ParagraphStyle('c', parent=styles['Normal'], textColor=ink, fontSize=8, leading=10)
        cell_b = ParagraphStyle('cb', parent=cell, fontName='Helvetica-Bold')
        note = ParagraphStyle('n', parent=styles['Normal'], textColor=muted, fontSize=8, leading=10, spaceAfter=1)

        buf = io.BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4,
            leftMargin=14 * mm, rightMargin=14 * mm,
            topMargin=14 * mm, bottomMargin=14 * mm,
            title='Daily Employee Task Report',
        )
        story = []

        # ---- Summary page ------------------------------------------------
        story.append(Paragraph('Daily Employee Task Report', h_title))
        story.append(Paragraph(p['company'], h_meta))
        story.append(Paragraph('For %s' % p['date_display'], h_meta))
        story.append(Paragraph('Generated %s' % p['generated_display'], h_meta))
        story.append(Paragraph(
            '%s employee(s) • %s task(s) worked' % (p['total_employees'], p['total_tasks']),
            h_meta))
        story.append(Spacer(1, 8))

        head = ['Employee', 'Login → Logout', 'Presence', 'Productive', 'Tasks', 'Done']
        rows = [head]
        for e in p['employees']:
            rows.append([
                Paragraph(e['name'], cell_b),
                Paragraph('%s → %s' % (e['login_display'], e['logout_display']), cell),
                e['presence_display'], e['productive_display'],
                str(e['total_tasks']), str(e['completed_tasks']),
            ])
        summary = Table(rows, colWidths=[46 * mm, 40 * mm, 24 * mm, 24 * mm, 14 * mm, 14 * mm], repeatRows=1)
        summary.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), head_bg),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('ALIGN', (2, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, panel]),
            ('GRID', (0, 0), (-1, -1), 0.4, line),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        story.append(summary)

        # ---- One section per employee -----------------------------------
        for e in p['employees']:
            story.append(PageBreak())
            story.append(Paragraph(e['name'], h_emp))
            meta_bits = [
                '%s → %s' % (e['login_display'], e['logout_display']),
                'Presence %s' % e['presence_display'],
                'Productive %s' % e['productive_display'],
                'Tasks %s (done %s, in-progress %s, pending %s)' % (
                    e['total_tasks'], e['completed_tasks'],
                    e['in_progress_tasks'], e['pending_tasks']),
            ]
            if e['auto_closed']:
                meta_bits.append('workday auto-closed')
            story.append(Paragraph(' • '.join(meta_bits), h_meta))
            if e['email']:
                story.append(Paragraph(e['email'], h_meta))
            story.append(Spacer(1, 6))

            if not e['tasks']:
                story.append(Paragraph('No task activity recorded for this day.', note))
                for n in e['notes']:
                    story.append(Paragraph('End-of-day note: %s' % n, note))
                continue

            t_head = ['Task', 'KRA / Project', 'Priority', 'State', 'Est', 'Actual', 'Perf']
            t_rows = [t_head]
            for t in e['tasks']:
                perf = (t.get('performance') or {}).get('display', 'N/A')
                kra = t.get('kra_name') or ''
                if t.get('parent_kra_name'):
                    kra = '%s / %s' % (t['parent_kra_name'], kra)
                t_rows.append([
                    Paragraph(t.get('name') or '', cell),
                    Paragraph(kra, cell),
                    Paragraph((t.get('priority') or '').title(), cell),
                    Paragraph(t.get('task_state_display') or '', cell),
                    t.get('estimated_hours_display') or '—',
                    t.get('actual_hours_display') or '—',
                    perf,
                ])
            tt = Table(t_rows, colWidths=[44 * mm, 40 * mm, 18 * mm, 24 * mm, 14 * mm, 14 * mm, 14 * mm], repeatRows=1)
            tt.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), panel),
                ('TEXTCOLOR', (0, 0), (-1, 0), ink),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 8),
                ('ALIGN', (4, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('GRID', (0, 0), (-1, -1), 0.4, line),
                ('TOPPADDING', (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ]))
            story.append(tt)

            # Progress notes for the day, per task (only tasks that have any).
            progress_blocks = []
            for t in e['tasks']:
                lines = []
                for d in (t.get('daily_progress') or []):
                    for s in (d.get('summaries') or []):
                        summ = (s.get('summary') or '').strip()
                        if summ:
                            lines.append('• %s — %s' % (s.get('time', ''), summ))
                if lines:
                    progress_blocks.append((t.get('name') or '', t.get('actual_hours_display') or '', lines))
            if progress_blocks:
                story.append(Spacer(1, 6))
                story.append(Paragraph('Progress notes', cell_b))
                for name, dur, lines in progress_blocks:
                    story.append(Paragraph('<b>%s</b> — %s' % (name, dur), note))
                    for ln in lines:
                        story.append(Paragraph(ln, note))

            for n in e['notes']:
                story.append(Spacer(1, 4))
                story.append(Paragraph('End-of-day note: %s' % n, note))

        doc.build(story)
        return buf.getvalue()

    # ------------------------------------------------------------------ #
    # Generate + upsert                                                  #
    # ------------------------------------------------------------------ #
    def _generate_for_date(self, day):
        """Collect → render → upsert the row for `day`. Returns the record, or an
        empty recordset when there was no activity (nothing to report)."""
        payload = self._collect_payload(day)
        if not payload:
            _logger.info("daily report: no activity on %s — nothing generated", day)
            return self.browse()
        pdf = self._build_pdf(payload)
        vals = {
            'report_date': day,
            'pdf_file': base64.b64encode(pdf),
            'pdf_filename': 'daily-task-report-%s.pdf' % day,
            'employee_count': payload['total_employees'],
            'task_count': payload['total_tasks'],
            'generated_at': fields.Datetime.now(),
        }
        rec = self.sudo().search([('report_date', '=', day)], limit=1)
        if rec:
            rec.write(vals)
        else:
            rec = self.sudo().create(vals)
        _logger.info("daily report generated: %s (%s employees, %s tasks, %s bytes)",
                     day, payload['total_employees'], payload['total_tasks'], len(pdf))
        return rec

    # ------------------------------------------------------------------ #
    # Delivery — in-app notification + push to admins                    #
    # ------------------------------------------------------------------ #
    def _notify_admins(self, report):
        """Notify owner + coordinator that the day's report is ready. Mirrors
        _fire_daily_summary: _notify lives on kra.kpi, so we anchor on any task
        and pass the report id through the context (the persist block stamps it
        onto each notification as report_id, making the row tappable)."""
        if not report:
            return
        anchor = self.env['kra.kpi'].sudo().search([], order='id desc', limit=1)
        if not anchor:
            _logger.info("daily_report: no kra.kpi to anchor _notify; skipping")
            return
        ctx = {
            'date': report.report_date.strftime('%d %b %Y'),
            'employee_count': report.employee_count,
            'task_count': report.task_count,
        }
        try:
            anchor.with_context(kpi_daily_report_id=report.id)._notify('daily_report', **ctx)
        except Exception as exc:
            _logger.warning("daily_report _notify failed: %s", exc)

    # ------------------------------------------------------------------ #
    # Cron — config-driven gate (fires once at/after the configured IST time) #
    # ------------------------------------------------------------------ #
    @api.model
    def _cron_daily_report(self):
        """Runs every 15 min. Generates + sends the daily report once per day,
        at/after the company's configured IST send time. The server clock is UTC;
        we convert so the configured hour means IST."""
        company = self.env.company
        if not company.kpi_daily_report_enabled:
            return
        now_ist = pytz.UTC.localize(fields.Datetime.now()).astimezone(_IST)
        today_ist = now_ist.date()

        last = company.kpi_daily_report_last_sent
        if last and last >= today_ist:
            return  # already sent today
        send_hour = company.kpi_daily_report_hour or 10.0
        now_hour = now_ist.hour + now_ist.minute / 60.0
        if now_hour < send_hour:
            return  # not yet time today

        if (company.kpi_daily_report_coverage or 'yesterday') == 'today':
            day = today_ist
        else:
            day = today_ist - timedelta(days=1)

        try:
            report = self._generate_for_date(day)
            if report:
                self._notify_admins(report)
        except Exception as exc:
            # Leave last_sent unset so a transient failure retries next tick.
            _logger.exception("daily report cron failed for %s: %s", day, exc)
            return
        # Mark done even when there was no activity, so we don't retry all day.
        company.sudo().kpi_daily_report_last_sent = today_ist

    # ------------------------------------------------------------------ #
    # Retention — daily cron deletes old reports                         #
    # ------------------------------------------------------------------ #
    @api.model
    def _gc_reports(self):
        """Delete report rows older than the company's configured retention
        (res.company.kpi_report_retention_number/_unit; number <= 0 = keep
        forever). Whole record — the PDF has no stats worth keeping once purged."""
        company = self.env.company
        number = company.kpi_report_retention_number or 0
        if number <= 0:
            return 0
        unit = company.kpi_report_retention_unit or 'months'
        cutoff = fields.Date.context_today(self) - relativedelta(**{unit: number})
        old = self.sudo().search([('report_date', '<', cutoff)])
        count = len(old)
        if old:
            old.unlink()
        _logger.info("daily report GC: deleted %s report(s) older than %s (%s %s)",
                     count, cutoff, number, unit)
        return count

    # ------------------------------------------------------------------ #
    # Backend button — Generate now (for testing / on-demand)            #
    # ------------------------------------------------------------------ #
    def action_generate_now(self):
        """Generate the previous day's report on demand from the backend."""
        day = fields.Date.context_today(self) - timedelta(days=1)
        rec = self._generate_for_date(day)
        if not rec:
            raise UserError(
                _("No employee activity found for %s — nothing to report.") % day)
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'kpi.daily.report',
            'res_id': rec.id,
            'view_mode': 'form',
            'target': 'current',
        }
