{
    'name': '369 App User Manual',
    'version': '19.0.1.1.0',
    'category': 'Tools',
    'summary': 'Role-based mobile app user-manual PDFs stored in the database',
    'description': """
App User Manual
===============
Holds the mobile app's user-manual PDF documents in the database, so they
can be uploaded / replaced / removed from the Odoo backend (or the app's
admin screen) without shipping a new app build.

Multiple documents are supported: each record is one titled PDF. The app
lists them via ``app.user.manual.get_manuals()`` and fetches a chosen one's
bytes via ``get_manual(id)``.
    """,
    'author': 'Alphalize Technologies',
    'website': 'https://www.alphalize.com',
    'depends': ['base', 'mail', 'kra_kpi_module'],
    'data': [
        'security/ir.model.access.csv',
        'views/app_user_manual_views.xml',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
