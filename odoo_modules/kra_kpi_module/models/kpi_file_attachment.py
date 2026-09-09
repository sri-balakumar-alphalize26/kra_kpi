from odoo import models, fields


class KpiFileAttachment(models.Model):
    """Extra files hanging off a progress update or a task manual.

    Both parents were built one-file-per-row: kpi.progress.uploaded_file and
    kpi.user.manual.manual_file are single Binary fields, so attaching three
    screenshots to one note meant writing the same note three times. This holds the
    2nd, 3rd, Nth file of a single entry.

    One model with two optional parents rather than a table each, so backup and
    cleanup have ONE new table to learn about instead of two that must be kept in
    step — they already have to be taught about every blob-bearing model by hand.

    The FIRST file of an entry still lives on the parent's own field. That is not
    redundancy for its own sake: /kpi/progress/download, /kpi/progress/view,
    /kpi/manual/view, the file_b64 routes and the mobile app all read those scalar
    fields, and the app is not being changed. Old entries therefore keep working
    unchanged, and a new multi-file entry still shows its first file to a client
    that knows nothing about this table.
    """

    _name = "kpi.file.attachment"
    _description = "KPI Entry Attachment (extra files)"
    _order = "sequence, id"

    progress_id = fields.Many2one(
        'kpi.progress',
        string='Progress Update',
        ondelete='cascade',
        index=True,
    )

    manual_id = fields.Many2one(
        'kpi.user.manual',
        string='Task Manual',
        ondelete='cascade',
        index=True,
    )

    # Stated rather than relied on: attachment=True is already the Binary default,
    # but this table exists to hold SEVERAL files per entry, so "the bytes live in
    # the filestore, not in this table" is the one property here worth being
    # explicit about. Same reasoning as kpi.user.manual.manual_file.
    file = fields.Binary(
        string='File',
        attachment=True,
        required=True,
    )

    file_name = fields.Char(string='File Name', required=True)

    mimetype = fields.Char(string='MIME Type')

    # Upload order, so a set of screenshots reads back in the order it was picked
    # rather than by insert id.
    sequence = fields.Integer(string='Sequence', default=10)
