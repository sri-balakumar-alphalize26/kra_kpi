{
    'name': 'WhatsApp Neonize Integration',
    'version': '19.0.1.0.0',
    'category': 'Tools',
    'summary': 'QR-based WhatsApp messaging inside Odoo using Neonize (Pure Python)',
    'description': """
        WhatsApp Integration for Odoo 19 using Neonize (Pure Python)
        =============================================================

        This module provides WhatsApp messaging capabilities directly inside Odoo
        without any external Node.js service or WhatsApp Business API.

        Features:
        ---------
        * QR Code scanning directly in Odoo UI
        * Send/receive text messages
        * Send PDF reports, images, documents
        * Message log with partner auto-detection
        * Multi-session support
        * Send WhatsApp from any Odoo record (Invoice, Sale Order, etc.)
        * Auto-reconnect on Odoo restart
        * Wizard for quick message sending
        * Partner WhatsApp message history

        Requirements:
        -------------
        * pip install neonize qrcode[pil] Pillow
    """,
    'author': 'Alphalize Technologies',
    'website': 'https://www.alphalize.com',
    'depends': ['base', 'mail', 'contacts', 'point_of_sale'],
    'data': [
        'security/whatsapp_security.xml',
        'security/ir.model.access.csv',
        'views/whatsapp_session_views.xml',
        'views/whatsapp_message_views.xml',
        'views/whatsapp_config_views.xml',
        'wizards/send_message_wizard_views.xml',
        'views/res_partner_views.xml',
        'views/menu.xml',
        'data/ir_cron.xml',
    ],
    'external_dependencies': {
        'python': ['neonize', 'qrcode'],
    },
    'images': ['static/description/icon.png'],
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
    'post_init_hook': '_post_init_hook',
}
