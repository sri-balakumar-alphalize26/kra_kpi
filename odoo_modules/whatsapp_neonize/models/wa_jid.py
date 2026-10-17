"""WhatsApp JID normalisation -- the ONE place the `@g.us` convention lives.

Transport is Evolution API (self-hosted). The directory is still named
`whatsapp_neonize` for dependency and XML-ID stability; neonize itself is gone.

THE BUG THIS FILE EXISTS TO END
-------------------------------
The old neonize gateway *stripped* the `@g.us` suffix when recording an inbound
message, while the kra_kpi outbound patch wrote the full `...@g.us`. The same
conversation therefore had two different keys, and
`whatsapp.message._compute_is_group` -- which tests `'@g.us' in phone` -- was
ALWAYS False for inbound group rows. That in turn meant
`kpi_wa_inbound_hook._kpi_maybe_handle_reply`, which skips on the same test,
never actually skipped group chatter: it handed a group id to the reply parser
as if it were a client's phone number.

THE CONVENTION, STATED ONCE
---------------------------
* `whatsapp.message.remote_jid` -- verbatim from the wire. The new truth.
* `whatsapp.message.phone`      -- bare digits for 1:1 (so res.partner matching
                                   keeps working), and the FULL `<id>@g.us` for
                                   groups (so `is_group` is correct and the KPI
                                   hook's skip fires).

Every send path calls `normalize_target()`; every inbound path calls
`split_jid()`. Nothing else may reimplement either.
"""

import re

# WhatsApp server suffixes we may see on the wire.
USER_SUFFIXES = ('@s.whatsapp.net', '@c.us')
GROUP_SUFFIX = '@g.us'
LID_SUFFIX = '@lid'
BROADCAST_SUFFIX = '@broadcast'

# A group id is a long numeric that conventionally starts with 120.
# Used only as a fallback when no suffix is present (legacy rows).
_GROUP_BARE_RE = re.compile(r'^120\d{10,}$')

_NON_DIGITS = re.compile(r'[^\d]')


def strip_formatting(raw):
    """'+91 98765-43210' -> '919876543210'. Suffixes are NOT removed here."""
    return _NON_DIGITS.sub('', raw or '')


def is_group_jid(raw):
    """True for a group, whether or not the suffix survived.

    Replaces whatsapp_group.looks_like_group_jid and the private
    `_is_group_target` helper in kra_kpi_module/models/whatsapp_group_patch.py.
    """
    s = (raw or '').strip()
    if not s:
        return False
    if GROUP_SUFFIX in s:
        return True
    return bool(_GROUP_BARE_RE.match(s))


def normalize_target(raw):
    """OUTBOUND. Return what Evolution should receive in its `number` field.

    Evolution accepts a bare MSISDN for 1:1 and a full `...@g.us` for a group,
    so this is the whole of the group-send fix: the neonize build had to
    hand-assemble a JID struct because `build_jid()` produced the nonsense
    `120363...@g.us@s.whatsapp.net`. That is why kra_kpi had to override
    send_message -- and why send_image/send_document, which were never
    overridden, silently went nowhere for every group.
    """
    s = (raw or '').strip()
    if not s:
        return ''
    if GROUP_SUFFIX in s:
        # Already a group JID; pass through untouched.
        return s.split('@', 1)[0].strip() + GROUP_SUFFIX
    for suffix in USER_SUFFIXES + (LID_SUFFIX, BROADCAST_SUFFIX):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
            break
    digits = strip_formatting(s)
    if not digits:
        return ''
    if _GROUP_BARE_RE.match(digits):
        # A bare group id that lost its suffix somewhere. Put it back.
        return digits + GROUP_SUFFIX
    return digits


def split_jid(remote_jid):
    """INBOUND. `remote_jid` -> (phone_for_storage, is_group).

    Groups keep the full suffix; 1:1 is reduced to bare digits.
    """
    s = (remote_jid or '').strip()
    if not s:
        return '', False
    if GROUP_SUFFIX in s:
        return s.split('@', 1)[0].strip() + GROUP_SUFFIX, True
    bare = s.split('@', 1)[0].strip()
    digits = strip_formatting(bare)
    if digits and _GROUP_BARE_RE.match(digits):
        return digits + GROUP_SUFFIX, True
    # A LID has no phone digits we can trust; keep the raw id so it is at least
    # addressable, and let the caller resolve it later.
    return (digits or bare), False


def participant_phone(participant_jid):
    """The in-group sender's bare number, or '' when it is a LID.

    Evolution puts the participant in `data.key.participant`. On current
    WhatsApp builds this is often a `...@lid`, which carries no phone digits --
    callers must treat '' as "unresolved", not as "absent".
    """
    s = (participant_jid or '').strip()
    if not s or s.endswith(LID_SUFFIX):
        return ''
    bare = s.split('@', 1)[0].strip()
    return strip_formatting(bare)
