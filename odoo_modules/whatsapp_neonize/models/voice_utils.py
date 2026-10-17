"""Voice transcription utility for WhatsApp voice notes.

Pure-Python module (NOT an Odoo model). Exposes `transcribe_audio(audio_bytes)`
which honors the `transcription_provider` selection on `wa.voice.config`
and uses the configured per-provider API key + model.

Return shape:
    {'text': str, 'language': str, 'duration': float, 'error': str | None}
"""

import base64
import logging
import os
import re
import tempfile

_logger = logging.getLogger(__name__)

# Minimum audio size — anything below is too short to be real speech.
# WhatsApp voice notes encode to ~3-4KB/second at 16kbps; <2KB ≈ silent click.
MIN_AUDIO_BYTES = 2000

# Maximum acceptable mean no_speech_prob from Whisper segments. Above this
# threshold the audio is mostly silence and the transcription is a
# hallucination from training data.
MAX_NO_SPEECH_PROB = 0.55

# Below this avg_logprob (Whisper's per-segment confidence) the transcription
# is too unsure to trust.
MIN_AVG_LOGPROB = -1.0

# Known Whisper hallucination phrases across languages. Matched
# case-insensitively as substrings. Add new ones as they appear in the wild.
HALLUCINATION_PATTERNS = [
    # English
    r'thanks?\s+for\s+watching',
    r'subscribe\s+to\s+my\s+channel',
    r'don.?t\s+forget\s+to\s+subscribe',
    r'see\s+you\s+next\s+time',
    r'please\s+like\s+and\s+subscribe',
    # Hindi / Punjabi / Urdu — "Thanks for watching" variants
    r'देखने\s*के\s*लिए\s*धन्यवाद',
    r'ਦੇਖਣ\s*ਲਈ\s*ਧੰਨਵਾਦ',
    # Malayalam
    r'കാണുന്നതിന്\s*നന്ദി',
    # Arabic
    r'شكرا\s*للمشاهدة',
    # Japanese / Chinese — common YouTube training noise
    r'ご視聴ありがとうございました',
    r'感谢观看',
]
_HALLUCINATION_RE = re.compile('|'.join(HALLUCINATION_PATTERNS), re.IGNORECASE)


def _looks_hallucinated(text):
    """True if `text` matches any known Whisper hallucination phrase."""
    if not text:
        return False
    return bool(_HALLUCINATION_RE.search(text))


# --------------------------- Public API ---------------------------


def transcribe_audio(audio_bytes, env=None):
    """Transcribe audio bytes (typically OGG/Opus from WhatsApp) to text.

    Honors `wa.voice.config.transcription_provider` — uses ONLY the
    selected provider. If that provider's key is empty, returns an
    error explaining which key to set.

    Falls back to env vars (GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)
    if no `wa.voice.config` record exists.
    """
    result = {'text': '', 'language': 'unknown', 'duration': 0.0, 'error': None}

    if not audio_bytes:
        result['error'] = 'No audio bytes received'
        return result

    # Filter 1: drop tiny clips before spending an API call. WhatsApp voice
    # at 16kbps Opus ≈ 2KB/sec; <MIN_AUDIO_BYTES means it's a stray click,
    # not speech — and any transcription Whisper returns is hallucinated.
    if len(audio_bytes) < MIN_AUDIO_BYTES:
        _logger.info(
            "Voice clip too short (%d bytes < %d) — skipping transcription",
            len(audio_bytes), MIN_AUDIO_BYTES,
        )
        result['error'] = '[Voice — too short to transcribe]'
        return result

    settings = _read_config(env)
    provider = settings['provider']

    handler = {
        'groq': _try_groq,
        'openai': _try_openai,
        'gemini': _try_gemini,
    }.get(provider)

    if not handler:
        result['error'] = f"Unknown transcription_provider '{provider}'"
        return result

    api_key = settings.get(f'{provider}_api_key', '')
    if not api_key:
        result['error'] = (
            f"{provider.capitalize()} API key not set. Open WA Tracker → "
            f"Configuration → AI / Voice Settings, paste the key, save."
        )
        return result

    model = settings.get(f'{provider}_model', '')
    translate = bool(settings.get('translate_to_english', True))

    try:
        r = handler(audio_bytes, api_key, model, translate=translate)
        if r and r.get('text'):
            text = r['text']
            # Filter 2: known-hallucination phrase match.
            if _looks_hallucinated(text):
                _logger.info(
                    "Voice transcription dropped — looks like Whisper "
                    "hallucination: %r", text[:80],
                )
                result['error'] = '[Voice — silent / hallucinated]'
                return result
            # Filter 3: Whisper verbose_json segment-level confidence.
            # Set by _try_groq / _try_openai when available.
            if r.get('no_speech_prob', 0.0) > MAX_NO_SPEECH_PROB:
                _logger.info(
                    "Voice transcription dropped — no_speech_prob %.2f > %.2f: %r",
                    r['no_speech_prob'], MAX_NO_SPEECH_PROB, text[:80],
                )
                result['error'] = '[Voice — mostly silence]'
                return result
            if r.get('avg_logprob', 0.0) < MIN_AVG_LOGPROB:
                _logger.info(
                    "Voice transcription dropped — avg_logprob %.2f < %.2f: %r",
                    r['avg_logprob'], MIN_AVG_LOGPROB, text[:80],
                )
                result['error'] = '[Voice — low-confidence transcription]'
                return result
            _logger.info(
                "Voice transcribed via %s (%s): %r",
                provider, model or 'default', text[:60],
            )
            return r
        result['error'] = (
            f"{provider.capitalize()} returned an empty transcription."
        )
        return result
    except Exception as e:
        _logger.warning("Voice transcribe via %s failed: %s", provider, e)
        result['error'] = f"{provider.capitalize()} error: {e}"
        return result


# --------------------------- Config / key resolution ---------------------------


def _read_config(env):
    """Return dict {provider, gemini_api_key, gemini_model, groq_api_key,
    groq_model, openai_api_key, openai_model} pulled from wa.voice.config
    (record search) with environment-variable fallback."""
    settings = {
        'provider': 'groq',
        'translate_to_english': True,
        'gemini_api_key': os.environ.get('GEMINI_API_KEY', '') or '',
        'gemini_model': 'gemini-2.5-flash',
        'groq_api_key': os.environ.get('GROQ_API_KEY', '') or '',
        'groq_model': 'whisper-large-v3',
        'openai_api_key': os.environ.get('OPENAI_API_KEY', '') or '',
        'openai_model': 'whisper-1',
    }

    if env is None:
        return settings

    try:
        Config = env['wa.voice.config']
    except KeyError:
        _logger.warning("wa.voice.config model not found in registry")
        return settings

    cfg = Config.sudo().search([], limit=1)
    if not cfg:
        _logger.info("No wa.voice.config record yet — using env-var fallback")
        return settings

    settings['provider'] = cfg.transcription_provider or settings['provider']
    settings['translate_to_english'] = bool(getattr(cfg, 'translate_to_english', True))

    # Gemini — handle 'custom' selection
    settings['gemini_api_key'] = cfg.gemini_api_key or settings['gemini_api_key']
    if cfg.gemini_model == 'custom' and cfg.gemini_custom_model:
        settings['gemini_model'] = cfg.gemini_custom_model
    elif cfg.gemini_model:
        settings['gemini_model'] = cfg.gemini_model

    # Groq
    settings['groq_api_key'] = cfg.groq_api_key or settings['groq_api_key']
    settings['groq_model'] = cfg.groq_model or settings['groq_model']

    # OpenAI
    settings['openai_api_key'] = cfg.openai_api_key or settings['openai_api_key']
    settings['openai_model'] = cfg.openai_model or settings['openai_model']

    return settings


# --------------------------- Backend: Groq ---------------------------


def _try_groq(audio_bytes, api_key, model, translate=False):
    import requests
    model = model or 'whisper-large-v3'
    # Whisper's /translations endpoint forces English output regardless of
    # spoken language. /transcriptions keeps the source language.
    endpoint = 'translations' if translate else 'transcriptions'
    path = _write_temp_audio(audio_bytes)
    try:
        with open(path, 'rb') as af:
            resp = requests.post(
                f'https://api.groq.com/openai/v1/audio/{endpoint}',
                headers={'Authorization': f'Bearer {api_key}'},
                files={'file': ('audio.ogg', af, 'audio/ogg')},
                data={'model': model, 'response_format': 'verbose_json'},
                timeout=60,
            )
        if resp.status_code != 200:
            raise RuntimeError(f'HTTP {resp.status_code}: {resp.text[:200]}')
        data = resp.json()
        segs = data.get('segments') or []
        return {
            'text': (data.get('text') or '').strip(),
            'language': data.get('language') or 'unknown',
            'duration': float(data.get('duration') or 0.0),
            'no_speech_prob': _avg(s.get('no_speech_prob') for s in segs),
            'avg_logprob': _avg(s.get('avg_logprob') for s in segs),
            'error': None,
        }
    finally:
        _unlink(path)


# --------------------------- Backend: OpenAI ---------------------------


def _try_openai(audio_bytes, api_key, model, translate=False):
    import requests
    model = model or 'whisper-1'
    # /translations is only supported on whisper-1. gpt-4o-* don't expose it
    # yet — fall back to /transcriptions for those models.
    use_translate = translate and model == 'whisper-1'
    endpoint = 'translations' if use_translate else 'transcriptions'
    path = _write_temp_audio(audio_bytes)
    try:
        with open(path, 'rb') as af:
            data_form = {'model': model}
            # Only whisper-1 supports verbose_json; gpt-4o variants return plain
            if model == 'whisper-1':
                data_form['response_format'] = 'verbose_json'
            resp = requests.post(
                f'https://api.openai.com/v1/audio/{endpoint}',
                headers={'Authorization': f'Bearer {api_key}'},
                files={'file': ('audio.ogg', af, 'audio/ogg')},
                data=data_form,
                timeout=60,
            )
        if resp.status_code != 200:
            raise RuntimeError(f'HTTP {resp.status_code}: {resp.text[:200]}')
        data = resp.json()
        segs = data.get('segments') or []
        return {
            'text': (data.get('text') or '').strip(),
            'language': data.get('language') or 'unknown',
            'duration': float(data.get('duration') or 0.0),
            'no_speech_prob': _avg(s.get('no_speech_prob') for s in segs),
            'avg_logprob': _avg(s.get('avg_logprob') for s in segs),
            'error': None,
        }
    finally:
        _unlink(path)


# --------------------------- Backend: Gemini ---------------------------


def _try_gemini(audio_bytes, api_key, model, translate=False):
    import requests
    model = model or 'gemini-2.5-flash'
    b64 = base64.b64encode(audio_bytes).decode('ascii')
    if translate:
        prompt_text = (
            'Transcribe the following audio and translate it to English. '
            'Respond with the English text only — no commentary, no quotes, '
            'no labels like "Translation:". If the audio is silent or '
            'unintelligible, respond with an empty string.'
        )
    else:
        prompt_text = (
            'Transcribe the following audio verbatim. '
            'Respond with the transcription only, no commentary.'
        )
    payload = {
        'contents': [{
            'parts': [
                {'text': prompt_text},
                {'inline_data': {'mime_type': 'audio/ogg', 'data': b64}},
            ]
        }]
    }
    url = (
        f'https://generativelanguage.googleapis.com/v1beta/models/'
        f'{model}:generateContent?key={api_key}'
    )
    resp = requests.post(url, json=payload, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f'HTTP {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    text = ''
    try:
        text = data['candidates'][0]['content']['parts'][0]['text'].strip()
    except (KeyError, IndexError, TypeError):
        pass
    return {
        'text': text,
        'language': 'auto',
        'duration': 0.0,
        'error': None,
    }


# --------------------------- Helpers ---------------------------


def _avg(values):
    """Mean of an iterable, ignoring None. Returns 0.0 if empty."""
    nums = [v for v in values if v is not None]
    if not nums:
        return 0.0
    return sum(nums) / len(nums)


def _write_temp_audio(audio_bytes):
    f = tempfile.NamedTemporaryFile(suffix='.ogg', delete=False)
    try:
        f.write(audio_bytes)
    finally:
        f.close()
    return f.name


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


# --------------------------- Voice download helper ---------------------------


def download_voice_audio(client, message_wrapper, audio_obj):
    """Try every neonize download API in turn until one returns bytes.

    Args:
        client:           the neonize NewClient instance.
        message_wrapper:  the outer Message proto (event.Message).
        audio_obj:        the inner audioMessage or pttMessage sub-proto.

    Returns: bytes on success, None on failure. Logs the specific failure.
    """
    last_err = None
    candidates = []

    # 1. Most common — universal downloader on the wrapper
    if hasattr(client, 'download_any'):
        candidates.append(('download_any(message)', lambda: client.download_any(message_wrapper)))
        if audio_obj is not None:
            candidates.append(('download_any(audio_obj)', lambda: client.download_any(audio_obj)))
    # 2. Some builds use download_media
    if hasattr(client, 'download_media'):
        candidates.append(('download_media(message)', lambda: client.download_media(message_wrapper)))
        if audio_obj is not None:
            candidates.append(('download_media(audio_obj)', lambda: client.download_media(audio_obj)))
    # 3. Fallback download() — older API
    if hasattr(client, 'download'):
        if audio_obj is not None:
            candidates.append(('download(audio_obj)', lambda: client.download(audio_obj)))
        candidates.append(('download(message)', lambda: client.download(message_wrapper)))
    # 4. Capitalised variant some versions ship
    if hasattr(client, 'Download'):
        if audio_obj is not None:
            candidates.append(('Download(audio_obj)', lambda: client.Download(audio_obj)))

    if not candidates:
        _logger.error(
            "Voice download: neonize client has no recognised download method. "
            "Available methods: %s",
            [m for m in dir(client) if 'down' in m.lower()],
        )
        return None

    for label, fn in candidates:
        try:
            data = fn()
            if data and isinstance(data, (bytes, bytearray)) and len(data) > 0:
                _logger.info("Voice download OK via %s (%d bytes)", label, len(data))
                return bytes(data)
            _logger.warning(
                "Voice download via %s returned empty/non-bytes: %r",
                label, type(data).__name__,
            )
        except Exception as e:
            last_err = e
            _logger.warning("Voice download via %s failed: %s", label, e)

    _logger.error(
        "Voice download: all neonize methods failed. Last error: %s", last_err,
    )
    return None
