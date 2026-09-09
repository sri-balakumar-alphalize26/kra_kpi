import base64
import logging

from dateutil.relativedelta import relativedelta

from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class KpiReportDownload(models.Model):
    """A KRA Report file an admin downloaded, kept so it can be fetched again.

    The KRA Report's PDF, Excel and ZIP are built entirely in the browser (JSZip,
    jsPDF, ExcelJS) and handed straight to a Blob URL — the server never saw them,
    so a report you downloaded last month was gone the moment you lost the file.
    This stores the bytes that were actually handed over, alongside the filters
    that produced them, so "send me that September pack again" does not mean
    reconstructing the filter selection from memory and hoping the underlying data
    has not moved.

    Kept deliberately as the FILE and not as a recipe: a regenerated report reflects
    today's data, which is exactly what you do not want when someone asks what you
    sent them.

    That does mean it grows the filestore — a ZIP of PDFs is not small — which is
    why retention is configurable and defaults to 30 days rather than forever.
    """

    _name = "kpi.report.download"
    _description = "KRA Report Download History"
    _order = "generated_at desc, id desc"

    user_id = fields.Many2one(
        'res.users', string='Downloaded By', required=True, index=True,
        default=lambda self: self.env.user, readonly=True,
    )

    generated_at = fields.Datetime(
        string='Downloaded On', required=True, index=True,
        default=fields.Datetime.now, readonly=True)

    # attachment=True keeps the bytes in the filestore rather than a Postgres bytea
    # column. The house rule everywhere in this module (see kpi.user.manual and
    # kpi.workday.snapshot), and it matters most here: these are the largest blobs
    # the module stores.
    file = fields.Binary(string='File', attachment=True)
    filename = fields.Char(string='File Name')
    file_size = fields.Integer(
        string='Size (bytes)',
        help="Stored rather than computed from the blob: reading an attachment "
             "field pulls the whole file off disk, and the history list shows this "
             "for every row.")

    kind = fields.Selection(
        [('pdf', 'PDF'), ('excel', 'Excel'), ('zip', 'ZIP pack')],
        string='Format', required=True, default='zip')

    from_date = fields.Date(string='From')
    to_date = fields.Date(string='To')
    row_count = fields.Integer(string='Rows')

    # The filter selection as JSON, so the list can say what a file covered without
    # a column per filter — and so a future "run this again" has something to read.
    filters_json = fields.Text(string='Filters (JSON)')
    filters_display = fields.Char(
        string='Covering', compute='_compute_filters_display', store=False)

    @api.depends('from_date', 'to_date', 'row_count')
    def _compute_filters_display(self):
        for rec in self:
            span = ' to '.join(x for x in [
                rec.from_date and str(rec.from_date) or '',
                rec.to_date and str(rec.to_date) or '',
            ] if x) or 'all dates'
            rec.filters_display = '%s · %s row(s)' % (span, rec.row_count or 0)

    @api.model
    def record_download(self, vals):
        """Store one downloaded file. Returns the new row's id.

        `vals['data_b64']` is the base64 the browser just handed the user.
        """
        data_b64 = vals.get('data_b64') or ''
        try:
            size = len(base64.b64decode(data_b64)) if data_b64 else 0
        except Exception:
            # A file we cannot decode is a file we cannot hand back later, so it is
            # not worth a row — but the download itself already succeeded in the
            # browser, so this must not raise at the caller.
            _logger.warning("record_download: undecodable payload, not stored")
            return False
        rec = self.sudo().create({
            'user_id': self.env.user.id,
            'file': data_b64,
            'filename': vals.get('filename') or 'report',
            'file_size': size,
            'kind': vals.get('kind') or 'zip',
            'from_date': vals.get('from_date') or False,
            'to_date': vals.get('to_date') or False,
            'row_count': int(vals.get('row_count') or 0),
            'filters_json': vals.get('filters_json') or '',
        })
        return rec.id

    # ------------------------------------------------------------------ #
    # Retention — daily cron deletes old downloads                       #
    # ------------------------------------------------------------------ #
    @api.model
    def _gc_downloads(self):
        """Delete stored downloads older than the company's configured retention
        (res.company.kpi_download_retention_number/_unit; number <= 0 = keep
        forever). Whole record — the file IS the record here, and a row without its
        bytes would only advertise a download nobody can fetch."""
        company = self.env.company
        number = company.kpi_download_retention_number or 0
        if number <= 0:
            return 0
        unit = company.kpi_download_retention_unit or 'days'
        cutoff = fields.Datetime.now() - relativedelta(**{unit: number})
        old = self.sudo().search([('generated_at', '<', cutoff)])
        count = len(old)
        if old:
            old.unlink()
        _logger.info("report download GC: deleted %s file(s) older than %s (%s %s)",
                     count, cutoff, number, unit)
        return count
