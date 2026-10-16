"""One LLM provider cascade, reusable from anywhere in the module.

Before this, the only LLM call in the codebase was inline in
controllers/kpi_reports_api.py (/kpi_requirements/suggest_tasks). A second
caller would have meant a second copy of the provider chain, the API-key
lookups and the JSON-repair logic -- three things you do not want drifting.

Order and config keys are IDENTICAL to that route, deliberately:
    ir.config_parameter kra_kpi.gemini_api_key    -> gemini-2.0-flash
    ir.config_parameter kra_kpi.groq_api_key      -> llama-3.3-70b-versatile
    ir.config_parameter kra_kpi.anthropic_api_key -> claude-haiku-4-5-20251001

NOTE: none of those three is set on this database today, so every call here
falls back to the deterministic path below. That is a supported state, not a
failure -- the WhatsApp flow must work with no AI at all.

The User-Agent spoof is not decoration: Groq/Cloudflare 403s a bare
`Python-urllib`, which is what the original route discovered the hard way.
"""

import json
import logging
import re
import urllib.request

from odoo import api, models

_logger = logging.getLogger(__name__)

_UA = 'Mozilla/5.0 (Odoo KRA-KPI Module)'
_TIMEOUT = 30

PARAM_GEMINI = 'kra_kpi.gemini_api_key'
PARAM_GROQ = 'kra_kpi.groq_api_key'
PARAM_ANTHROPIC = 'kra_kpi.anthropic_api_key'

# Model names are config, not constants.
#
# Providers retire models without warning and the call then 404s silently
# behind this cascade's try/except. Groq retired `llama-3.3-70b-versatile` on
# 16 Aug 2026 -- the model still hard-coded in
# controllers/kpi_reports_api.py's suggest_tasks route, where it is now a dead
# leg. Overriding a system parameter is a config change; editing a literal in
# two files is a release.
PARAM_GEMINI_MODEL = 'kra_kpi.gemini_model'
PARAM_GROQ_MODEL = 'kra_kpi.groq_model'
PARAM_ANTHROPIC_MODEL = 'kra_kpi.anthropic_model'

DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'
DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'
DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

# Areas offered in the WhatsApp picker. Kept here so the prompt and the menu
# cannot disagree about what a valid area is.
WORK_AREAS = [
    ('pos', 'POS / Billing'),
    ('print', 'Print / Invoice / Label'),
    ('hardware', 'Scale / Printer / Hardware'),
    ('apk', 'Mobile App / APK'),
    ('server', 'Server / Hosting'),
    ('report', 'Reports'),
    ('website', 'Website / Other'),
]
WORK_AREA_CODES = [c for c, _l in WORK_AREAS]
AREA_LABEL = dict(WORK_AREAS)

DOC_TYPES = ('requirement', 'update', 'bug')


class KpiAi(models.AbstractModel):
    _name = 'kpi.ai'
    _description = 'LLM helper (provider cascade)'

    # ------------------------------------------------------------------
    @api.model
    def _keys(self):
        p = self.env['ir.config_parameter'].sudo()
        return (p.get_param(PARAM_GEMINI, ''),
                p.get_param(PARAM_GROQ, ''),
                p.get_param(PARAM_ANTHROPIC, ''))

    @api.model
    def _model(self, param, default):
        return self.env['ir.config_parameter'].sudo().get_param(param, default) or default

    @api.model
    def is_available(self):
        return any(self._keys())

    @api.model
    def _post(self, url, payload, headers):
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'), method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', _UA)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return json.loads(resp.read().decode('utf-8'))

    @api.model
    def complete_json(self, system_prompt, user_text, max_tokens=800):
        """-> (data: dict|None, source: str). Never raises."""
        gemini, groq, anthropic = self._keys()

        if gemini:
            try:
                out = self._post(
                    'https://generativelanguage.googleapis.com/v1beta/models/'
                    '%s:generateContent?key=%s' % (self._model(PARAM_GEMINI_MODEL, DEFAULT_GEMINI_MODEL), gemini),
                    {'contents': [{'parts': [{'text': user_text}]}],
                     'systemInstruction': {'parts': [{'text': system_prompt}]},
                     'generationConfig': {'responseMimeType': 'application/json',
                                          'maxOutputTokens': max_tokens}}, {})
                txt = out['candidates'][0]['content']['parts'][0]['text']
                data = self._loads(txt)
                if data is not None:
                    return data, 'ai-gemini'
            except Exception as exc:
                _logger.warning('kpi.ai gemini failed: %s', exc)

        if groq:
            try:
                out = self._post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {'model': self._model(PARAM_GROQ_MODEL, DEFAULT_GROQ_MODEL),
                     'response_format': {'type': 'json_object'},
                     'max_tokens': max_tokens,
                     'messages': [{'role': 'system', 'content': system_prompt},
                                  {'role': 'user', 'content': user_text}]},
                    {'Authorization': 'Bearer %s' % groq})
                data = self._loads(out['choices'][0]['message']['content'])
                if data is not None:
                    return data, 'ai-groq'
            except Exception as exc:
                _logger.warning('kpi.ai groq failed: %s', exc)

        if anthropic:
            try:
                out = self._post(
                    'https://api.anthropic.com/v1/messages',
                    {'model': self._model(PARAM_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_MODEL),
                     'max_tokens': max_tokens,
                     'system': system_prompt,
                     'messages': [{'role': 'user', 'content': user_text}]},
                    {'x-api-key': anthropic, 'anthropic-version': '2023-06-01'})
                data = self._loads(out['content'][0]['text'])
                if data is not None:
                    return data, 'ai-claude'
            except Exception as exc:
                _logger.warning('kpi.ai anthropic failed: %s', exc)

        return None, 'none'

    @api.model
    def _loads(self, text):
        """Parse JSON that may be wrapped in prose or a code fence."""
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            pass
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
        return None

    # ------------------------------------------------------------------
    _PROMPT = (
        "You clean up short work requests sent over WhatsApp by shop staff in "
        "India and Oman. The English is often broken, abbreviated or ALL CAPS.\n"
        "Return ONLY this JSON object, nothing else:\n"
        '{"title": "<corrected one-line title, <=90 chars, sentence case>",\n'
        ' "doc_type": "requirement|update|bug",\n'
        ' "area": "%s",\n'
        ' "urgent": true|false,\n'
        ' "confidence": 0.0}\n'
        "Rules: keep the author's meaning and their product nouns exactly; do "
        "NOT invent detail; fix only spelling, casing and grammar. "
        "'not working' / 'error' / 'vanishing' means bug. "
        "'need' / 'add' / 'required' means requirement. "
        "A change to something that already exists means update. "
        "urgent=true only if they actually say urgent/immediately/today."
    ) % '|'.join(WORK_AREA_CODES)

    @api.model
    def correct_and_classify(self, raw_text, hint_doc_type=None, hint_area=None):
        """Tidy a free-text request and work out its type and area.

        Returns a dict ALWAYS -- callers never have to handle None:
            {title, doc_type, area, urgent, confidence, source}
        `source` is 'ai-*' when a model answered and 'heuristic' when the
        deterministic path ran, so the UI can be honest about which it was.
        """
        raw = (raw_text or '').strip()
        fallback = self._heuristic(raw, hint_doc_type, hint_area)
        if not raw or not self.is_available():
            return fallback

        data, source = self.complete_json(self._PROMPT, raw, max_tokens=400)
        if not isinstance(data, dict):
            return fallback

        # Coerce everything. A prompt is not a guarantee.
        title = str(data.get('title') or '').strip()[:90] or fallback['title']
        doc_type = str(data.get('doc_type') or '').lower()
        if doc_type not in DOC_TYPES:
            doc_type = fallback['doc_type']
        area = str(data.get('area') or '').lower()
        if area not in WORK_AREA_CODES:
            area = fallback['area']
        try:
            conf = max(0.0, min(1.0, float(data.get('confidence', 0.5))))
        except (TypeError, ValueError):
            conf = 0.5
        return {'title': title, 'doc_type': hint_doc_type or doc_type,
                'area': hint_area or area, 'urgent': bool(data.get('urgent')),
                'confidence': conf, 'source': source}

    @api.model
    def _heuristic(self, raw, hint_doc_type=None, hint_area=None):
        """No key, or the model failed. Deterministic and always available."""
        text = (raw or '').strip()
        low = text.lower()
        doc_type = hint_doc_type or 'requirement'
        if not hint_doc_type:
            if any(w in low for w in ('not working', 'error', 'issue', 'bug',
                                      'crash', 'wrong', 'fail', 'vanish',
                                      'problem', 'stuck')):
                doc_type = 'bug'
            elif any(w in low for w in ('change', 'update', 'modify', 'instead',
                                        'increase', 'bigger', 'add column')):
                doc_type = 'update'
        area = hint_area or 'website'
        if not hint_area:
            for code, words in (
                ('print', ('print', 'invoice', 'bill', 'label', 'a5', 'a4', 'receipt')),
                ('hardware', ('scale', 'printer', 'kot', 'vfd', 'barcode', 'weigh')),
                ('apk', ('apk', 'mobile', 'android', 'app ')),
                ('server', ('server', 'gateway', 'backup', 'hosting', 'database', 'db ')),
                ('report', ('report', 'ledger', 'statement')),
                ('pos', ('pos', 'billing', 'counter', 'cashier')),
            ):
                if any(w in low for w in words):
                    area = code
                    break
        # Sentence-case a shouted message; leave mixed case alone.
        title = text
        if title.isupper() and len(title) > 3:
            title = title.capitalize()
        return {'title': title[:90], 'doc_type': doc_type, 'area': area,
                'urgent': any(w in low for w in ('urgent', 'urjent', 'immediately',
                                                 'asap', 'today')),
                'confidence': 0.3, 'source': 'heuristic'}
