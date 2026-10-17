@echo off
REM Install whatsapp_neonize Python dependencies into the active Python.
REM Usage: run this from the Odoo Python environment, e.g.:
REM   "C:\Program Files\Odoo 19.0.20260310\python\python.exe" -m pip install -r ..\requirements.txt
REM Or just double-click if `python` on PATH is the Odoo Python.
REM
REM For a specific Python interpreter, run:
REM   "<full-path-to-python.exe>" -m pip install neonize qrcode[pil] Pillow

python -m pip install --disable-pip-version-check neonize "qrcode[pil]" Pillow
if errorlevel 1 (
    echo.
    echo Install failed. Try invoking the Odoo Python directly:
    echo   "C:\Program Files\Odoo 19.0.20260310\python\python.exe" -m pip install neonize "qrcode[pil]" Pillow
    exit /b 1
)
echo.
echo Done. Restart Odoo so the new packages are loaded.
