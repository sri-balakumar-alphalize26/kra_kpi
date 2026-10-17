#!/usr/bin/env bash
# Install whatsapp_neonize Python dependencies into the active Python.
# Usage:
#   chmod +x install_deps.sh
#   ./install_deps.sh                 # uses `python3` on PATH
#   PYTHON=/opt/odoo/venv/bin/python3 ./install_deps.sh    # explicit interpreter
set -euo pipefail

PYTHON="${PYTHON:-python3}"

echo "Using Python: $($PYTHON -c 'import sys; print(sys.executable)')"
"$PYTHON" -m pip install --disable-pip-version-check neonize 'qrcode[pil]' Pillow

echo
echo "Done. Restart Odoo so the new packages are loaded."
