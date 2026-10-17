{
    'name': 'WhatsApp and Email Integration (Evolution API)',
    'version': '19.0.3.0.0',
    'category': 'Tools',
    'summary': 'WhatsApp via a self-hosted Evolution API server + Email; auto-send for Sales / Purchase / POS / Vendor Bills',
    'description': """
        WhatsApp Integration for Odoo 19 via Evolution API
        ===================================================

        Transport is a SELF-HOSTED EVOLUTION API SERVER reached over HTTP.
        Odoo sends with REST calls and receives on a webhook. Nothing WhatsApp
        related runs inside the Odoo worker any more.

        *** WHY THE TECHNICAL NAME IS STILL `whatsapp_neonize` ***
        ----------------------------------------------------------
        Neonize (an in-process Python/Go WhatsApp client) WAS the transport and
        is now entirely removed. The DIRECTORY NAME is retained on purpose:

          * kra_kpi_module depends on this module. Uninstalling a dependency
            makes Odoo cascade-uninstall the dependant, which would DROP around
            40 kra_* / kpi_* tables. Renaming forces exactly that uninstall.
          * kra_kpi_module/views/menu.xml references the XML id
            `whatsapp_neonize.action_whatsapp_session` at load time.
          * kra_kpi_module imports this package by path, inside a try/except
            that silently degrades its whole inbound reply parser on failure.

        DO NOT UNINSTALL THIS MODULE. Upgrade it in place.

        Features:
        ---------
        * QR code scanning directly in the Odoo UI (served by Evolution)
        * Send/receive text, images, documents, audio -- to people AND groups
        * Message log with partner auto-detection and group attribution
        * Multi-session support; state lives only in Postgres + Evolution
        * Send WhatsApp from any Odoo record (Invoice, Sale Order, etc.)
        * Wizard for quick message sending
        * Partner WhatsApp message history

        Requirements:
        -------------
        * A reachable Evolution API server (https://github.com/EvolutionAPI/evolution-api)
        * Its global API key in the system parameter
          `whatsapp_neonize.evolution_global_apikey`
        * No pip packages beyond what Odoo already ships.
    """,
    'author': 'Alphalize Technologies',
    'website': 'https://www.alphalize.com',
    'depends': [
        'base', 'mail', 'contacts',
        'point_of_sale', 'sale', 'purchase', 'account',
    ],
    'data': [
        'security/whatsapp_security.xml',
        'security/ir.model.access.csv',
        'views/whatsapp_session_views.xml',
        'views/whatsapp_message_views.xml',
        'views/whatsapp_group_views.xml',
        'views/whatsapp_config_views.xml',
        'wizards/send_message_wizard_views.xml',
        'wizards/send_channel_wizard_views.xml',
        'views/res_partner_views.xml',
        'views/email_session_views.xml',
        'views/sale_order_views.xml',
        'views/purchase_order_views.xml',
        'views/account_payment_send_views.xml',
        # menu.xml loads LAST so all referenced actions + parent menus exist.
        'views/menu.xml',
        'data/ir_cron.xml',
    ],
    # No external_dependencies. neonize and qrcode are both gone: Evolution
    # holds the WhatsApp session server-side and returns the QR pre-rendered as
    # a base64 PNG, so there is nothing left to generate or bind locally.
    'images': ['static/description/icon.png'],
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
    'post_init_hook': '_post_init_hook',
}
