# -*- coding: utf-8 -*-
"""Verify the multi-file attachment table landed. No data is moved.

WHY
---
Progress updates and task manuals used to hold exactly one file each, on their own
Binary field (`kpi.progress.uploaded_file`, `kpi.user.manual.manual_file`). This
release lets one entry carry several, with the 2nd..Nth in the new
`kpi.file.attachment` table.

The first file DELIBERATELY stays on the parent's own field — /kpi/progress/download,
/kpi/progress/view, the file_b64 routes and the mobile app all read it, and the app is
not changing. So an entry written before this release is already correct as it stands.

WHAT this does
--------------
Nothing to the data. The reader that builds the files[] payload
(`_entry_files_payload` in controllers/kra_api.py) puts the parent's own file first
and appends the attachment rows, so a pre-existing single-file entry already comes
back as a one-item list without any row in the new table.

This exists so a half-installed upgrade fails HERE, loudly, rather than the first time
somebody tries to attach a second file.

NOTE on why there are no row counts here
----------------------------------------
An earlier version of this script counted existing files with
`SELECT ... FROM kpi_progress WHERE uploaded_file IS NOT NULL` and blew up: Binary
fields are attachment-backed by default in Odoo, so `uploaded_file` has no SQL column
at all — the bytes live in ir_attachment. Counting them means going through the ORM,
which is not worth doing for a log line during an upgrade.
"""

import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        SELECT 1 FROM information_schema.tables
         WHERE table_name = 'kpi_file_attachment'
    """)
    if not cr.fetchone():
        raise RuntimeError(
            "kpi_file_attachment table is missing after upgrade — the multi-file "
            "attachment model did not install. Check models/__init__.py and the "
            "ir.model.access.csv rows for kpi.file.attachment."
        )

    _logger.info(
        "kra_kpi_module 19.0.4.5: multi-file attachments enabled. Existing progress "
        "entries and manuals keep their single file on the parent record and need "
        "no backfill."
    )
