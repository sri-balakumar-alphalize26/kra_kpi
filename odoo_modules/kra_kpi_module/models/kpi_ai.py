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
import time
import urllib.error
import urllib.request

from odoo import api, models

_logger = logging.getLogger(__name__)

_UA = 'Mozilla/5.0 (Odoo KRA-KPI Module)'
_TIMEOUT = 30

PARAM_GEMINI = 'kra_kpi.gemini_api_key'
PARAM_GROQ = 'kra_kpi.groq_api_key'
PARAM_ANTHROPIC = 'kra_kpi.anthropic_api_key'

# A fourth, deliberately generic provider: any OpenAI-compatible
# /chat/completions endpoint -- a self-hosted model, OpenRouter, Azure. It is
# tried FIRST when a URL is set, because somebody who went to the trouble of
# configuring an endpoint means it to be used, ahead of a key left over from
# an earlier experiment.
PARAM_CUSTOM_URL = 'kra_kpi.custom_api_url'
PARAM_CUSTOM_KEY = 'kra_kpi.custom_api_key'
PARAM_CUSTOM_MODEL = 'kra_kpi.custom_model'

# Transcription. One Groq key covers this and the summaries, which is why
# Groq is the default of the four.
PARAM_OPENAI_KEY = 'kra_kpi.openai_api_key'
PARAM_WHISPER_MODEL = 'kra_kpi.whisper_model'
PARAM_TRANSCRIBE_PROVIDER = 'kra_kpi.transcribe_provider'

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

# Checked against the live provider APIs on 19 Oct 2026 with this install's
# own keys. The previous defaults were BOTH dead:
#   llama-3.1-8b-instant -> HTTP 404 model_not_found
#   gemini-2.0-flash     -> HTTP 404 "no longer available"
# which is exactly the rot the comment above predicted. The key was fine in
# both cases; only the model name had expired, and the cascade swallowed it
# as "provider failed".
#
# 'gemini-flash-latest' is an alias Google moves forward, chosen over a
# pinned version so this particular failure does not come back.
DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b'
DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

# A FLOOR on the token budget, for every provider.
#
# Current models spend tokens thinking before they emit anything. Ask
# gpt-oss-120b for a one-line JSON object in 60 tokens and the reasoning uses
# the whole budget: the reply comes back empty, _loads returns None, and the
# cascade reports "no provider answered" for a key and model that are both
# perfectly fine. Measured here: the same call failed at 60 tokens and
# succeeded at 900. Gemini failed at 300 and succeeded at 1500.
#
# The floor costs nothing in practice -- the prompts ask for a few sentences,
# so the models stop long before it -- and it removes a failure that looks
# exactly like a bad key.
MIN_COMPLETION_TOKENS = 2000

# The cascade order, and each provider's key / model parameter, default model
# and `source` tag. Configuration > 369 AI Assistant edits these parameters.
PROVIDERS = ('gemini', 'groq', 'anthropic')
SOURCE = {'gemini': 'ai-gemini', 'groq': 'ai-groq', 'anthropic': 'ai-claude'}
KEY_PARAM = {'gemini': PARAM_GEMINI, 'groq': PARAM_GROQ, 'anthropic': PARAM_ANTHROPIC}
MODEL_PARAM = {'gemini': PARAM_GEMINI_MODEL, 'groq': PARAM_GROQ_MODEL, 'anthropic': PARAM_ANTHROPIC_MODEL}
DEFAULT_MODEL = {'gemini': DEFAULT_GEMINI_MODEL, 'groq': DEFAULT_GROQ_MODEL, 'anthropic': DEFAULT_ANTHROPIC_MODEL}

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
    def _custom_endpoint(self):
        """-> (url, key, model). A URL with no key is valid: a model on the
        local network often needs no authentication.

        NOT named `_custom`. That is a reserved BaseModel attribute -- the
        boolean marking a model created through the UI -- and
        _add_manual_models deletes every registry entry whose `_custom` is
        truthy. A method by that name is truthy, so naming it `_custom` made
        kpi.ai delete ITSELF from the registry during setup, surfacing much
        later as `KeyError: 'kpi.ai'` on the next module upgrade. Same family
        of trap as `display_name` on kpi.meeting.participant.
        """
        p = self.env['ir.config_parameter'].sudo()
        return ((p.get_param(PARAM_CUSTOM_URL, '') or '').strip(),
                (p.get_param(PARAM_CUSTOM_KEY, '') or '').strip(),
                (p.get_param(PARAM_CUSTOM_MODEL, '') or '').strip())

    @api.model
    def _model(self, param, default):
        return self.env['ir.config_parameter'].sudo().get_param(param, default) or default

    @api.model
    def is_available(self):
        return bool(self._custom_endpoint()[0]) or any(self._keys())

    @api.model
    def providers_configured(self):
        """Which providers could answer, in the order they are tried.

        Used by the settings screen and by anything that wants to say what it
        will do before doing it.
        """
        gemini, groq, anthropic = self._keys()
        url, _k, _m = self._custom_endpoint()
        return [name for name, on in (('custom', bool(url)),
                                      ('gemini', bool(gemini)),
                                      ('groq', bool(groq)),
                                      ('anthropic', bool(anthropic))) if on]

    @api.model
    def transcribe(self, audio_bytes, mimetype=None, hint=None):
        """Speech to text. -> {'text', 'language', 'duration', 'error'}.

        One entry point over the Whisper client in whatsapp_neonize, which
        already carries the quality gates worth keeping: a minimum size, a
        hallucination-phrase blacklist, and Whisper's own per-segment
        no_speech_prob and avg_logprob. Never raises.
        """
        try:
            from odoo.addons.whatsapp_neonize.models import voice_utils
        except Exception as exc:
            _logger.warning('kpi.ai: transcription unavailable: %s', exc)
            return {'text': '', 'language': 'unknown', 'duration': 0.0,
                    'error': 'Transcription module unavailable: %s' % exc}
        try:
            return voice_utils.transcribe_audio(
                audio_bytes, env=self.env, mimetype=mimetype, hint=hint)
        except Exception as exc:
            _logger.warning('kpi.ai: transcription failed: %s', exc)
            return {'text': '', 'language': 'unknown', 'duration': 0.0,
                    'error': str(exc)}

    @api.model
    def _post(self, url, payload, headers, timeout=None):
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'), method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', _UA)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout or _TIMEOUT) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            # Carry the provider's own words into the exception. Bare
            # "HTTP Error 400: Bad Request" is what the log used to say, and
            # it hid a one-line cause: these APIs refuse a JSON response
            # format unless the prompt contains the word "json", and they say
            # so plainly in the body nobody was reading.
            try:
                detail = exc.read().decode('utf-8', 'replace')[:400]
            except Exception:
                detail = ''
            raise RuntimeError('HTTP %s: %s' % (exc.code, detail)) from None

    @api.model
    def _chat_url(self, base):
        """Accept whatever form of the endpoint somebody pasted.

        People paste the host, the /v1 root, or the full completions path.
        Rejecting two of the three would be the single most likely reason
        this screen appears not to work.
        """
        url = (base or '').strip().rstrip('/')
        if url.endswith('/chat/completions'):
            return url
        if url.endswith('/v1'):
            return url + '/chat/completions'
        return url + '/v1/chat/completions'

    @staticmethod
    def _turns(messages):
        """Normalise [{role: user|assistant, text}] for every provider: drop
        empty turns, merge two turns in a row from the same side, and make the
        list start and end with the user (Anthropic rejects anything else)."""
        out = []
        for m in messages or []:
            role = 'assistant' if (m.get('role') in ('assistant', 'bot', 'model')) else 'user'
            text = (m.get('text') or '').strip()
            if not text:
                continue
            if out and out[-1]['role'] == role:
                out[-1]['text'] += '\n\n' + text
            else:
                out.append({'role': role, 'text': text})
        while out and out[0]['role'] != 'user':
            out.pop(0)
        while out and out[-1]['role'] != 'user':
            out.pop()
        return out

    @api.model
    def _call(self, provider, key, system_prompt, turns, max_tokens, timeout=None):
        """One provider, one request -> the model's raw reply text. Raises."""
        # See MIN_COMPLETION_TOKENS: too small a budget is spent on reasoning
        # and returns an empty answer, which is indistinguishable from a bad
        # key at the call site.
        max_tokens = max(int(max_tokens or 0), MIN_COMPLETION_TOKENS)
        if provider == 'custom':
            url, custom_key, custom_model = self._custom_endpoint()
            headers = {}
            if custom_key:
                headers['Authorization'] = 'Bearer %s' % custom_key
            out = self._post(
                self._chat_url(url),
                {'model': custom_model or 'gpt-4o-mini',
                 'response_format': {'type': 'json_object'},
                 'max_tokens': max_tokens,
                 'messages': [{'role': 'system', 'content': system_prompt}]
                             + [{'role': t['role'], 'content': t['text']} for t in turns]},
                headers, timeout)
            return out['choices'][0]['message']['content']
        if provider == 'gemini':
            out = self._post(
                'https://generativelanguage.googleapis.com/v1beta/models/'
                '%s:generateContent?key=%s' % (self._model(PARAM_GEMINI_MODEL, DEFAULT_GEMINI_MODEL), key),
                {'contents': [{'role': 'model' if t['role'] == 'assistant' else 'user',
                               'parts': [{'text': t['text']}]} for t in turns],
                 'systemInstruction': {'parts': [{'text': system_prompt}]},
                 'generationConfig': {'responseMimeType': 'application/json',
                                      'maxOutputTokens': max_tokens}}, {}, timeout)
            return out['candidates'][0]['content']['parts'][0]['text']
        if provider == 'groq':
            out = self._post(
                'https://api.groq.com/openai/v1/chat/completions',
                {'model': self._model(PARAM_GROQ_MODEL, DEFAULT_GROQ_MODEL),
                 'response_format': {'type': 'json_object'},
                 'max_tokens': max_tokens,
                 'messages': [{'role': 'system', 'content': system_prompt}]
                             + [{'role': t['role'], 'content': t['text']} for t in turns]},
                {'Authorization': 'Bearer %s' % key}, timeout)
            return out['choices'][0]['message']['content']
        if provider == 'anthropic':
            out = self._post(
                'https://api.anthropic.com/v1/messages',
                {'model': self._model(PARAM_ANTHROPIC_MODEL, DEFAULT_ANTHROPIC_MODEL),
                 'max_tokens': max_tokens,
                 'system': system_prompt,
                 'messages': [{'role': t['role'], 'content': t['text']} for t in turns]},
                {'x-api-key': key, 'anthropic-version': '2023-06-01'}, timeout)
            return out['content'][0]['text']
        raise ValueError('Unknown provider %r' % provider)

    @api.model
    def complete_chat_json(self, system_prompt, messages, max_tokens=800, timeout=None, only=None):
        """A conversation -> (data: dict|None, source: str). Never raises.

        `messages` is [{role: 'user'|'assistant', text}], oldest first, ending
        with the question to answer. Providers are tried in the fixed order
        custom endpoint (when a URL is set), Gemini, Groq, Claude; `only`
        limits it to one of them (Test button)."""
        turns = self._turns(messages)
        if not turns:
            return None, 'none'
        # OpenAI-compatible endpoints refuse a json_object response format
        # unless the word "json" appears somewhere in the messages, and the
        # refusal is a 400 that reads like an authentication problem. Every
        # prompt in this module happens to say "JSON object", but a future
        # caller that does not would hit a baffling failure, so make it
        # true rather than hope.
        if 'json' not in (system_prompt or '').lower() \
                and not any('json' in t['text'].lower() for t in turns):
            system_prompt = (system_prompt or '') + '\nReply with json.'
        url = self._custom_endpoint()[0]
        cascade = [('custom', url)] + list(zip(PROVIDERS, self._keys()))
        for provider, key in cascade:
            if not key or (only and provider != only):
                continue
            try:
                data = self._loads(self._call(provider, key, system_prompt, turns, max_tokens, timeout))
                if data is not None:
                    return data, SOURCE.get(provider, 'ai-custom')
            except Exception as exc:
                # Never log the key, and never log the body: a failing
                # endpoint often echoes the request back.
                _logger.warning('kpi.ai %s failed: %s', provider, exc)
        return None, 'none'

    @api.model
    def complete_json(self, system_prompt, user_text, max_tokens=800):
        """-> (data: dict|None, source: str). Never raises."""
        return self.complete_chat_json(system_prompt, [{'role': 'user', 'text': user_text}], max_tokens)

    @api.model
    def test_provider(self, provider):
        """Configuration > Test: one tiny request to one provider.
        -> {status, source, ms} or {status: False, message}."""
        key = dict(zip(PROVIDERS, self._keys())).get(provider)
        if not key:
            return {'status': False, 'message': 'No key saved for this provider.'}
        t0 = time.time()
        try:
            text = self._call(provider, key, 'Reply as JSON only.',
                              [{'role': 'user', 'text': 'Reply with {"ok": true}'}], 50, 20)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode('utf-8', 'replace')[:300]
            except Exception:
                body = ''
            return {'status': False, 'message': 'HTTP %s: %s' % (exc.code, body or exc.reason)}
        except Exception as exc:
            return {'status': False, 'message': str(exc)[:300]}
        if self._loads(text) is None:
            return {'status': False, 'message': 'The provider answered, but not with JSON: %s' % (text or '')[:200]}
        return {'status': True, 'source': SOURCE[provider], 'ms': int((time.time() - t0) * 1000)}

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
