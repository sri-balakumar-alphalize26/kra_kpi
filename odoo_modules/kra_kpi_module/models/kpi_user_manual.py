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