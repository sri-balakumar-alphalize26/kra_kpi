import logging
import subprocess
import sys

_logger = logging.getLogger(__name__)

# =============================================================================
# AUTO-INSTALL PYTHON DEPENDENCIES
# =============================================================================
# This ensures the client never has to manually run pip install.
# Dependencies are installed automatically when Odoo loads this module.
# =============================================================================

_REQUIRED_PACKAGES = {
    'neonize': 'neonize',
    'qrcode': 'qrcode[pil]',
    'PIL': 'Pillow',
}


def _auto_install_dependencies():
    """Auto-install required pip packages if missing."""
    missing = []
    for import_name, pip_name in _REQUIRED_PACKAGES.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append(pip_name)

    if missing:
        _logger.info(
            "WhatsApp Neonize: Installing missing dependencies: %s",
            ', '.join(missing)
        )
        try:
            subprocess.check_call([
                sys.executable, '-m', 'pip', 'install',
                '--quiet', '--disable-pip-version-check',
                *missing
            ])
            _logger.info(
                "WhatsApp Neonize: Successfully installed: %s",
                ', '.join(missing)
            )
        except subprocess.CalledProcessError as e:
            _logger.error(
                "WhatsApp Neonize: Failed to install dependencies: %s\n"
                "Please run manually: pip install %s",
                e, ' '.join(missing)
            )


_auto_install_dependencies()

from . import models
from . import controllers
from . import wizards


def _post_init_hook(env):
    """Called after module install — does nothing special on first install."""
    pass


def _auto_reconnect_on_startup(env):
    """Reconnect WhatsApp sessions when Odoo server starts."""
    try:
        sessions = env['whatsapp.session'].sudo().search([
            ('auto_reconnect', '=', True),
            ('db_path', '!=', False),
        ])
        for session in sessions:
            import os
            if session.db_path and os.path.exists(session.db_path):
                _logger.info(
                    "Auto-reconnecting WhatsApp session: %s", session.name
                )
                try:
                    session.action_connect()
                except Exception as e:
                    _logger.error(
                        "Auto-reconnect failed for %s: %s", session.name, e
                    )
        if sessions:
            env.cr.commit()
    except Exception as e:
        _logger.error("WhatsApp auto-reconnect error: %s", e)
