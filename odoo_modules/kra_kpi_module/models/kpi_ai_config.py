"""The AI & Transcription settings screen.

Why this exists: not one `kra_kpi.*` parameter was set on this database, and
there was nowhere to set one. An admin had to switch on developer mode and
hand-create `ir.config_parameter` rows -- which two error messages in the
module actually told them to do, because there was nothing to point at.

A TransientModel over ir.config_parameter, NOT a new store. `kpi.ai` and
`voice_utils` keep reading the parameters they always read, so neither needed
changing to pick these up, and anything already configured by hand survives.

Keys are stored in parameters, shown as passwords, and never logged. The test
buttons exist because `kpi.ai.complete_json` is designed never to raise: with
no test, the first sign of a wrong key is a meeting that quietly has no
summary.
"""

import logging
import time

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Every field here maps to exactly one system parameter. One table rather
# than two dozen get_param/set_param lines, so default_get and action_save
# cannot drift apart -- which is the usual bug in a screen like this.
#
# Written out rather than imported from kpi_ai: a module-level `from . import
# kpi_ai` here breaks registry setup with KeyError: 'kpi.ai'. The parameter
# NAMES are the stable contract between this screen and the clients that read
# them, and they are documented at the top of kpi_ai.py.
_TEXT_PARAMS = {
    'gemini_api_key': 'kra_kpi.gemini_api_key',
    'gemini_model': 'kra_kpi.gemini_model',
    'groq_api_key': 'kra_kpi.groq_api_key',
    'groq_model': 'kra_kpi.groq_model',
    'anthropic_api_key': 'kra_kpi.anthropic_api_key',
    'anthropic_model': 'kra_kpi.anthropic_model',
    'custom_api_url': 'kra_kpi.custom_api_url',
    'custom_api_key': 'kra_kpi.custom_api_key',
    'custom_model': 'kra_kpi.custom_model',
    'openai_api_key': 'kra_kpi.openai_api_key',
    'whisper_model': 'kra_kpi.whisper_model',
    'transcribe_provider': 'kra_kpi.transcribe_provider',
    # The meeting server. All three JaaS values are needed together.
    'jaas_app_id': 'kra_kpi.jaas_app_id',
    'jaas_api_key_id': 'kra_kpi.jaas_api_key_id',
    'jaas_private_key': 'kra_kpi.jaas_private_key',
    'meet_base_url': 'kra_kpi.meet_base_url',
    # Our own Jitsi with token login: both needed together.
    'meet_jwt_app_id': 'kra_kpi.meet_jwt_app_id',
    'meet_jwt_secret': 'kra_kpi.meet_jwt_secret',
}

# Must match kpi_ai.py. Both the old defaults were retired models that
# 404'd with a perfectly good key, so these were verified against the live
# APIs before being written here.
DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b'
DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
DEFAULT_WHISPER_MODEL = 'whisper-large-v3'

# Recording behaviour. Integers, with the defaults the recorder uses when
# nothing is set, so an empty screen and an unconfigured server behave the
# same way.
_INT_PARAMS = {
    # 5 rather than 20: a segment is only uploaded when it closes, so this is
    # how much audio a crashed browser costs. 5 minutes is ~1.2 MB and still
    # far under the 25 MB the speech services accept.
    'segment_minutes': ('kra_kpi.meet_segment_minutes', 5),
    'bot_alone_seconds': ('kra_kpi.meet_bot_alone_seconds', 120),
    'idle_seconds': ('kra_kpi.meet_idle_seconds', 300),
    'record_keep_days': ('kra_kpi.meet_record_keep_days', 180),
}

_BOOL_PARAMS = {
    'auto_summary': ('kra_kpi.meet_auto_summary', True),
    'auto_post_summary': ('kra_kpi.meet_auto_post_summary', False),
}


class KpiAiConfig(models.TransientModel):
    _name = 'kpi.ai.config'
    _description = 'AI & Transcription Settings'

    # ---- summaries ----------------------------------------------------- #
    custom_api_url = fields.Char(
        string='Custom Endpoint URL',
        help='Any OpenAI-compatible endpoint: a self-hosted model, '
             'OpenRouter, Azure. Paste the host, the /v1 root or the full '
             '/v1/chat/completions path -- all three work.\n'
             'When this is set it is tried FIRST, ahead of the keys below.')
    custom_api_key = fields.Char(string='Custom Endpoint Key',
                                 help='Leave empty if the endpoint needs no '
                                      'authentication.')
    custom_model = fields.Char(string='Custom Model')

    gemini_api_key = fields.Char(string='Google Gemini Key')
    gemini_model = fields.Char(string='Gemini Model')
    groq_api_key = fields.Char(
        string='Groq Key',
        help='The one key that covers BOTH summaries and transcription, '
             'because Groq serves Whisper as well as a chat model. If you '
             'only set one key, set this one.')
    groq_model = fields.Char(string='Groq Model')
    anthropic_api_key = fields.Char(string='Anthropic Key')
    anthropic_model = fields.Char(string='Anthropic Model')

    # ---- transcription -------------------------------------------------- #
    transcribe_provider = fields.Selection(
        [('groq', 'Groq (Whisper large v3)'),
         ('openai', 'OpenAI (Whisper)'),
         ('gemini', 'Google Gemini')],
        string='Transcribe With', default='groq')
    whisper_model = fields.Char(string='Speech Model')
    openai_api_key = fields.Char(string='OpenAI Key')

    # ---- recording ------------------------------------------------------ #
    segment_minutes = fields.Integer(
        string='Recording Segment (min)',
        help='Audio is saved in pieces this long. Each piece is a complete, '
             'playable file, so a browser that dies loses one segment rather '
             'than the meeting -- and each stays under the 25 MB that the '
             'speech services accept.')
    bot_alone_seconds = fields.Integer(
        string='Leave After Alone (sec)',
        help='Once everybody else has left, the recorder waits this long and '
             'then ends the meeting. This is what closes a meeting nobody '
             'closed.')
    idle_seconds = fields.Integer(
        string='Idle Cut-off (sec)',
        help='If nobody speaks and nobody joins or leaves for this long, the '
             'recorder stops and the meeting is closed as of the last thing '
             'that happened -- not as of now, so the duration stays honest.')
    record_keep_days = fields.Integer(
        string='Keep Audio (days)',
        help='Audio is deleted this long after the summary is posted. The '
             'transcript and the summary are kept.')
    auto_summary = fields.Boolean(
        string='Summarise Automatically',
        help='Write the summary when the meeting ends.')
    auto_post_summary = fields.Boolean(
        string='Send Summary To The Group',
        help='OFF by default on purpose: a summary written from a recording '
             'should be read by one of us before the client sees it.')

    # ---- the meeting server --------------------------------------------- #
    #
    # The public meet.jit.si stopped starting conferences without a logged-in
    # moderator, which blocks clients and staff as well as the recorder. A
    # JWT is the way in, and these are what sign it.
    jaas_app_id = fields.Char(
        string='8x8 JaaS App ID',
        help='From the 8x8 JaaS console. Setting this switches meetings to '
             '8x8 and every link starts carrying a token.')
    jaas_api_key_id = fields.Char(
        string='JaaS API Key ID',
        help='The key id shown beside the key you generated. It goes in the '
             "token's header; a wrong one shows as a blank meeting.")
    jaas_private_key = fields.Text(
        string='JaaS Private Key (PEM)',
        help='The whole file, -----BEGIN PRIVATE KEY----- line included.')
    meet_base_url = fields.Char(
        string='Self-hosted Jitsi URL',
        help='Only for a Jitsi of your own. Leave empty when using 8x8.')
    meet_jwt_app_id = fields.Char(
        string='Jitsi App ID',
        help="The JWT_APP_ID your Jitsi server was set up with. With the "
             "secret below, every link carries a short-lived pass and people "
             "without one are refused.")
    meet_jwt_secret = fields.Char(
        string='Jitsi App Secret',
        help="The JWT_APP_SECRET from the same server setup.")
    meet_server_html = fields.Html(readonly=True, sanitize=False)

    # ---- read-only status ----------------------------------------------- #
    status_html = fields.Html(string='Status', readonly=True, sanitize=False)

    # ------------------------------------------------------------------
    @api.model
    def default_get(self, fields_list):
        res = super().default_get(fields_list)
        p = self.env['ir.config_parameter'].sudo()
        for fname, param in _TEXT_PARAMS.items():
            val = p.get_param(param, '')
            if val:
                res[fname] = val
        # Model names fall back to what kpi.ai would actually use, so the
        # screen shows the truth rather than an empty box.
        res.setdefault('gemini_model', DEFAULT_GEMINI_MODEL)
        res.setdefault('groq_model', DEFAULT_GROQ_MODEL)
        res.setdefault('anthropic_model', DEFAULT_ANTHROPIC_MODEL)
        res.setdefault('whisper_model', DEFAULT_WHISPER_MODEL)
        res.setdefault('transcribe_provider', 'groq')
        for fname, (param, default) in _INT_PARAMS.items():
            raw = p.get_param(param, '')
            try:
                res[fname] = int(raw) if raw not in ('', None, False) else default
            except (TypeError, ValueError):
                res[fname] = default
        for fname, (param, default) in _BOOL_PARAMS.items():
            raw = p.get_param(param, '')
            if raw in ('', None, False):
                res[fname] = default
            else:
                res[fname] = str(raw).strip().lower() in ('1', 'true', 'yes')
        res['status_html'] = self._status_html()
        res['meet_server_html'] = self._meet_server_html()
        return res

    def _meet_server_html(self):
        """Say plainly which meeting server is in use, and whether it works."""
        Meeting = self.env['kpi.meeting']
        app, _kid, _pem = Meeting._jaas()
        if app:
            return ('<p>Meetings run on <b>8x8 (%s)</b> and every link '
                    'carries a token, so guests are admitted without '
                    'logging in and the recorder can join by itself.</p>'
                    % Meeting.meet_domain())
        base = self.env['ir.config_parameter'].sudo().get_param(
            'kra_kpi.meet_base_url', '')
        if base and 'meet.jit.si' not in base:
            if Meeting._self_jwt()[0]:
                return ('<p>Meetings run on your own Jitsi at <b>%s</b>. '
                        'Every link carries a pass, so only people Odoo lets '
                        'in can join, and the recorder joins by itself.</p>'
                        % base)
            return ('<p class="text-warning">Meetings run on your own Jitsi '
                    'at <b>%s</b>, but without passes: anyone who has a room '
                    'address can join. Fill in the App ID and Secret.</p>'
                    % base)
        return (
            '<p class="text-danger"><b>Meetings are pointed at the public '
            'meet.jit.si, which no longer works.</b> Since 18 October 2026 it '
            'refuses to start a call until somebody logs in as moderator — '
            '"The conference has not yet started because no moderators have '
            'yet arrived". That stops your clients and staff joining, not '
            'just the recorder.</p>'
            '<p>Fill in the 8x8 details below, or point '
            '<b>Self-hosted Jitsi URL</b> at a Jitsi of your own.</p>')

    def _status_html(self):
        Ai = self.env['kpi.ai']
        configured = Ai.providers_configured()
        rows = []
        if configured:
            rows.append(
                '<p>Summaries will be tried in this order: <b>%s</b>.</p>'
                % ' &rarr; '.join(configured))
        else:
            rows.append(
                '<p class="text-warning"><b>No provider is configured.</b> '
                'Meetings will still run and still post a recap; they will '
                'simply have no written summary.</p>')
        p = self.env['ir.config_parameter'].sudo()
        if not p.get_param('kra_kpi.groq_api_key', ''):
            rows.append(
                '<p class="text-warning">No Groq key, so <b>nothing can be '
                'transcribed</b>. Recordings would be saved but never turned '
                'into words.</p>')
        return ''.join(rows)

    # ------------------------------------------------------------------
    def action_save(self):
        self.ensure_one()
        self._check_admin()
        p = self.env['ir.config_parameter'].sudo()
        for fname, param in _TEXT_PARAMS.items():
            val = (self[fname] or '').strip()
            # set_param with an empty value DELETES the parameter, which is
            # what clearing a box should mean.
            p.set_param(param, val)
        for fname, (param, _d) in _INT_PARAMS.items():
            p.set_param(param, str(int(self[fname] or 0)))
        for fname, (param, _d) in _BOOL_PARAMS.items():
            p.set_param(param, '1' if self[fname] else '0')
        _logger.info('kpi.ai.config saved by %s: providers=%s',
                     self.env.user.login,
                     self.env['kpi.ai'].providers_configured())
        return {'type': 'ir.actions.act_window', 'res_model': 'kpi.ai.config',
                'view_mode': 'form', 'target': 'new'}

    def _check_admin(self):
        if not (self.env.user.has_group('kra_kpi_module.group_kra_admin')
                or self.env.user.has_group('base.group_system')):
            raise UserError(_('Only an administrator can change these.'))

    # ------------------------------------------------------------------
    def action_test_summary(self):
        """One trivial completion, saved values first.

        Saves before testing on purpose: testing the box contents while the
        stored parameters say something else tells you nothing about what a
        real meeting will do.
        """
        self.ensure_one()
        self.action_save()
        Ai = self.env['kpi.ai']
        if not Ai.is_available():
            raise UserError(_(
                'Nothing to test: no endpoint and no key is set.'))
        started = time.time()
        # The word "json" has to appear in the prompt. OpenAI-compatible
        # endpoints -- Groq included -- reject a request that asks for a JSON
        # response format without it, with a 400 that reads like a bad key.
        # This test used to fail for that reason alone while real summaries
        # worked perfectly.
        data, source = Ai.complete_json(
            'You are a test. Reply with the json object {"ok": true} '
            'and nothing else.',
            'Reply with that json object now.')
        took = time.time() - started
        if not isinstance(data, dict):
            raise UserError(_(
                'No provider answered.\n\n'
                'Tried: %(tried)s\n'
                'Took: %(took).1f seconds\n\n'
                'The key, the model name or the URL is wrong, or the server '
                'cannot reach the internet. The Odoo log has the reason from '
                'each provider -- search it for "kpi.ai".') % {
                    'tried': ', '.join(Ai.providers_configured()) or 'nothing',
                    'took': took})
        raise UserError(_(
            'Working.\n\n'
            'Answered by: %(source)s\n'
            'Took: %(took).1f seconds\n'
            'Replied: %(reply)s') % {
                'source': source, 'took': took, 'reply': str(data)[:200]})

    def action_test_meeting_server(self):
        """Sign a token and check it. Catches a bad key before a real call.

        A wrong private key or key id does not error anywhere: the meeting
        page just renders an empty Jitsi frame. This is the only place that
        failure is cheap to find.
        """
        self.ensure_one()
        self.action_save()
        Meeting = self.env['kpi.meeting']
        app, kid, pem = Meeting._jaas()
        if not app and Meeting._self_jwt()[0]:
            return self._test_own_jitsi()
        if not app:
            base = self.meet_base_url or ''
            if base and 'meet.jit.si' not in base:
                raise UserError(_(
                    'Meetings will use your own Jitsi at %s. There is no '
                    'token to test — open a meeting and check it joins.')
                    % base)
            raise UserError(_(
                'No meeting server is configured.\n\n'
                'All three 8x8 values are needed together: App ID, API Key '
                'ID and the private key. Without them meetings fall back to '
                'the public meet.jit.si, which no longer starts a call at '
                'all.'))

        # Sign against a throwaway record, then verify the signature with the
        # public half of the same key, which is what 8x8 will do.
        probe = Meeting.new({'name': 'token test', 'room_name': 'tokentest'})
        token = probe.meet_jwt('Token test', moderator=True)
        if not token:
            raise UserError(_(
                'The token could not be signed. The private key is not a '
                'valid PEM, or it is not an RSA key.\n\n'
                'Paste the whole file including the '
                '-----BEGIN PRIVATE KEY----- line. The Odoo log has the '
                'exact error — search it for "meeting token".'))
        try:
            import jwt as _jwt
            from cryptography.hazmat.primitives import serialization
            priv = serialization.load_pem_private_key(
                pem.encode('utf-8'), password=None)
            pub = priv.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo)
            claims = _jwt.decode(token, pub, algorithms=['RS256'],
                                 audience='jitsi')
            header = _jwt.get_unverified_header(token)
        except Exception as exc:
            raise UserError(_(
                'The token was signed but will not verify: %s') % exc)

        raise UserError(_(
            'The meeting token works.\n\n'
            'Server: %(domain)s\n'
            'Tenant: %(tenant)s\n'
            'Key id in the token: %(kid)s\n'
            'Admitted as moderator: %(mod)s\n'
            'Valid for: %(hours)s hours\n\n'
            'Clients will be admitted without logging in, and the recorder '
            'can join on its own. 8x8 still has to recognise this key id — '
            'if a real meeting shows an empty box, that is what is wrong.') % {
                'domain': Meeting.meet_domain(),
                'tenant': Meeting.meet_tenant(),
                'kid': header.get('kid') or '(none)',
                'mod': claims.get('context', {}).get('user', {}).get(
                    'moderator'),
                'hours': 6})

    def _test_own_jitsi(self):
        """Sign a pass for our own Jitsi, check it, and check the server answers."""
        Meeting = self.env['kpi.meeting']
        own_app, secret = Meeting._self_jwt()
        probe = Meeting.new({'name': 'token test', 'room_name': 'tokentest'})
        token = probe.meet_jwt('Token test', moderator=True)
        if not token:
            raise UserError(_(
                'The pass could not be signed. The Odoo log has the exact '
                'error — search it for "meeting token".'))
        try:
            import jwt as _jwt
            claims = _jwt.decode(token, secret, algorithms=['HS256'],
                                 audience='jitsi')
        except Exception as exc:
            raise UserError(_('The pass was signed but will not verify: %s')
                            % exc)
        domain = Meeting.meet_domain()
        try:
            import urllib.request
            with urllib.request.urlopen(
                    'https://%s/external_api.js' % domain, timeout=15) as resp:
                reachable = resp.status == 200
        except Exception as exc:
            raise UserError(_(
                'The pass works, but the server at %(domain)s did not answer: '
                '%(err)s\n\nCheck the meeting server is running and the '
                'address is right.') % {'domain': domain, 'err': exc})
        raise UserError(_(
            'Your own Jitsi is ready.\n\n'
            'Server: %(domain)s (answering: %(ok)s)\n'
            'App ID in the pass: %(iss)s\n'
            'Admitted as moderator: %(mod)s\n'
            'Valid for: 6 hours\n\n'
            'If a real meeting still shows a log-in box, the App ID or '
            'Secret here does not match the server.') % {
                'domain': domain, 'ok': 'yes' if reachable else 'no',
                'iss': claims.get('iss'),
                'mod': claims.get('context', {}).get('user', {}).get(
                    'moderator')})

    def action_test_transcribe(self):
        """Send a real, tiny WAV and see whether words come back.

        A key that authenticates for chat can still be wrong for audio -- a
        different endpoint, a retired speech model -- so this exercises the
        audio path rather than inferring it from the chat test.
        """
        self.ensure_one()
        self.action_save()
        import math
        import struct

        # One second of speech-shaped noise. Whisper will return little or
        # nothing for it, and that is fine: we are testing that the request is
        # ACCEPTED, not that it understands a tone.
        rate = 16000
        frames = b''.join(
            struct.pack('<h', int(6000 * math.sin(2 * math.pi * 180 * i / rate)
                                  * math.sin(2 * math.pi * 3 * i / rate)))
            for i in range(rate))
        wav = (b'RIFF' + struct.pack('<I', 36 + len(frames)) + b'WAVEfmt '
               + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16)
               + b'data' + struct.pack('<I', len(frames)) + frames)

        started = time.time()
        res = self.env['kpi.ai'].transcribe(wav, mimetype='audio/wav')
        took = time.time() - started
        err = res.get('error') or ''
        # The quality gates rejecting a test tone means the PATH works: the
        # request was accepted and Whisper answered. Only a transport or auth
        # failure is a real failure here.
        gate = err.startswith('[')
        if err and not gate:
            raise UserError(_(
                'Transcription failed.\n\n'
                'Provider: %(prov)s\nTook: %(took).1f seconds\n\n'
                '%(err)s') % {'prov': self.transcribe_provider,
                              'took': took, 'err': err})
        raise UserError(_(
            'Speech-to-text is reachable.\n\n'
            'Provider: %(prov)s\n'
            'Took: %(took).1f seconds\n'
            'Heard: %(text)s\n\n'
            '%(note)s') % {
                'prov': self.transcribe_provider, 'took': took,
                'text': (res.get('text') or '(nothing)')[:120],
                'note': _('A test tone is not speech, so hearing nothing is '
                          'the expected result. What matters is that the '
                          'service accepted the audio.')})
