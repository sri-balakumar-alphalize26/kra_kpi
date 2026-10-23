from odoo import api, models, fields


class KpiUserManual(models.Model):
    _name = "kpi.user.manual"
    _description = "KPI User Manual Documentation"
    _order = "upload_date desc"

    kpi_id = fields.Many2one(
        'kra.kpi',
        string='KPI Task',
        required=True,
        ondelete='cascade'
    )
    
    # attachment=True keeps the bytes in the FILESTORE, not a DB bytea column.
    # Every other binary in this module already does this (kra.kpi.requirement_document,
    # signed_certificate, kra.master.logo, kpi.backup.backup_file); this one was
    # the odd one out. It matters now that clients attach photos/video from the
    # app: in-DB blobs bloat the database AND every backup forever, and any read
    # of the field pulls the whole file into memory.
    # NOTE: rows created before this change keep their bytea until rewritten.
    manual_file = fields.Binary(
        string='Manual File',
        attachment=True,
        help='Image / video / document attached to this task'
    )
    
    file_name = fields.Char(
        string='File Name'
    )
    # When the file now on manual_file was saved (see kpi.progress.file_at).
    # Empty on older rows → upload_date.
    file_at = fields.Datetime(string='File Saved On', readonly=True, copy=False)

    related_links = fields.Text(
        string='Related Links',
        help='Store documentation links as JSON array'
    )
    
    uploaded_by = fields.Many2one(
        'res.users',
        string='Uploaded By',
        required=True,
        default=lambda self: self.env.user,
        readonly=True
    )
    
    upload_date = fields.Datetime(
        string='Upload Date',
        required=True,
        default=fields.Datetime.now,
        readonly=True
    )
    
    description = fields.Text(
        string='Description',
        help='Brief description of this manual'
    )

    # A photo / video attached on Upload Requirements, with its reason in
    # description (/kpi_requirements/attach_media). Kept here so the queue
    # screens list it, but it is NOT the task's user manual: Full Complete
    # and the manual badges leave it out.
    is_intake_media = fields.Boolean(string='Photo / video from upload', default=False, readonly=True)
    
    # Related fields for easy access
    kpi_name = fields.Char(
        related='kpi_id.name',
        string='Task Name',
        store=True
    )
    
    uploader_name = fields.Char(
        related='uploaded_by.name',
        string='Uploader Name',
        store=True
    )