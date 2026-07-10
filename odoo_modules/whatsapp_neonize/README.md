# WhatsApp Neonize Integration for Odoo 19

**100% Python WhatsApp Integration — No Node.js, No External Services**

## Overview

This Odoo 19 module provides QR-code based WhatsApp messaging directly inside
Odoo using the **Neonize** Python library. It works exactly like WhatsApp Web —
scan a QR code with your phone, and you're connected.

## Features

- QR Code scanning directly in Odoo UI
- Send and receive text messages
- Send PDF reports, images, and documents
- Message log with auto-detection of contacts
- Multi-session support
- Send WhatsApp from any Odoo record (Invoice, Sale Order, etc.)
- Auto-reconnect on Odoo server restart
- Wizard for quick message sending
- Partner WhatsApp message history
- Group/User based access control
- WhatsApp button on partner form

## Odoo 19 Compatibility

This module is built specifically for Odoo 19 with:
- Python expression based `invisible`/`readonly` (no legacy `attrs`)
- OWL 3 compatible JS components
- Updated `_render_qweb_pdf` API
- String interpolation in `_()` using `%s` format

## Requirements

```bash
pip install neonize qrcode[pil] Pillow
```

## Installation

```bash
# Install Python dependencies
pip install neonize qrcode[pil] Pillow

# Create session storage
mkdir -p /opt/odoo/whatsapp_sessions
chown odoo:odoo /opt/odoo/whatsapp_sessions

# Copy to addons path
cp -r whatsapp_neonize /opt/odoo/addons/

# Restart Odoo and install from Apps
sudo systemctl restart odoo
```

## Usage

### Connect WhatsApp

1. Go to **WhatsApp > Sessions**
2. Create a new session
3. Click **Connect WhatsApp**
4. Scan QR with: WhatsApp → Settings → Linked Devices → Link a Device
5. Click **Refresh Status** after scanning

### Send Messages Programmatically

```python
# From any Python code inside Odoo
session = self.env['whatsapp.session'].search(
    [('status', '=', 'connected')], limit=1
)
session.send_message('919876543210', 'Hello from Odoo 19!')
session.send_odoo_report('919876543210', 'account.account_invoices', invoice)
```

### Using the Mixin

```python
class SaleOrder(models.Model):
    _inherit = ['sale.order', 'whatsapp.mixin']

    def action_confirm_and_notify(self):
        self.action_confirm()
        self.wa_send_text(message=f'Order {self.name} confirmed!')
        self.wa_send_report(report_xmlid='sale.report_saleorder')
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/whatsapp/send` | POST | Send text message |
| `/whatsapp/send/document` | POST | Send document |
| `/whatsapp/qr/image/<id>` | GET | Get QR code image |
| `/whatsapp/qr/status/<id>` | POST | Poll connection status |

## License

LGPL-3

## Author

Alphalize Technologies - https://www.alphalize.com
