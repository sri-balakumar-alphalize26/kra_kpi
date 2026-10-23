"""The client's chat page for one task (/kpi/wa/chat/<token>).

Sent in the client's WhatsApp group when a manager hands their 💬 Discuss
question to a developer (kpi_chat.chat_ask_developer). It shows THAT chat and
nothing else -- the reference, the title and the messages with their times.
No hours, people, files or notes: KPI details are for the team only. Team
messages read "Alphalize team", never a name, and the client is not asked for
one: messages from the page carry the client's company name.

auth='public' like the other WhatsApp pages: the phone opening the link is
not logged in. The token is the key and it lasts CLIENT_CHAT_HOURS.
"""

import base64
import re
import hmac
import logging

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

from .kpi_wa_approval import _render
from .kra_api import _guess_mime, serve_file
from ..models.kpi_chat import CLIENT_CHAT_HOURS, chat_file_kind

_logger = logging.getLogger(__name__)


def _task_for(token):
    """The task this chat link opens, while it is still valid."""
    if not token or len(token) < 16 or len(token) > 64:
        return None
    kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).search(
        [('client_chat_token', '=', token)], limit=1)
    if not kpi or not hmac.compare_digest(kpi.client_chat_token or '', token):
        return None
    if not kpi.client_chat_expires or kpi.client_chat_expires < fields.Datetime.now():
        return None
    return kpi


def _client_login_ok(kpi):
    """A logged-in Client user of this task's client (the client portal's
    "💬 Chat with the team") needs no WhatsApp confirm."""
    user = request.env.user
    if not user or user._is_public():
        return False
    for kra in request.env['kra.master'].sudo().search([('client_user_ids', 'in', [user.id])]):
        if kpi.kra_id.id in kra._get_descendant_ids():
            return True
    return False


def _locked(kpi, who):
    """None when this browser may open the client chat, else what the page
    needs to show the "Confirm on WhatsApp" step."""
    if _client_login_ok(kpi) or (who and kpi.chat_device_allowed(who)):
        return None
    if not who:
        return {'ok': False, 'locked': True}
    return {'ok': False, 'locked': True, 'confirm': kpi.chat_device_start(who),
            'client': kpi.client_kra_id.name or kpi.kra_id.name or ''}


def _person(kpi, who):
    """(name, number) of the confirmed person on this browser, for tagging."""
    dev = request.env['kpi.chat.device'].sudo().search(
        [('browser_id', '=', who or '-'), ('trusted_until', '!=', False)], order='trusted_until desc', limit=1)
    company = kpi.client_kra_id.name or kpi.kra_id.name or 'Client'
    if dev:
        return (dev.name or company), (kpi._chat_digits(dev.number) or '')
    return company, ''


def _rows(kpi, token, who=''):
    """The thread as the client may see it: no staff names. `who` is the
    page's browser id ('c:...'), for its own reactions / edits; file links
    carry it too, so a photo opens only on a confirmed browser."""
    url = '/kpi/wa/chat/%s/file/%%d?w=%s' % (token, who or '')

    def reply(q):
        return q and dict(q, who=q['who'] if q['side'] == 'client' else 'Alphalize team')
    return [{'id': r['id'], 'side': r['side'], 'body': r['body'], 'at': r['at'],
             'files': [{k: f[k] for k in ('id', 'name', 'kind', 'size', 'url')} for f in r['files']],
             'reply': reply(r['reply']),
             'edited': r['edited'], 'deleted': r['deleted'], 'reactions': r['reactions'],
             'can_edit': r['can_edit'], 'can_delete': r['can_delete'], 'info': r['info'], 'v': r['v'],
             'who': r['who'] if r['side'] == 'client' else 'Alphalize team',
             # The tick on the client's own bubbles; the team's errors stay ours.
             'status': r['status'] if r['side'] == 'client' else '',
             'error': r['error'] if r['side'] == 'client' else ''}
            for r in kpi.chat_rows(limit=200, file_url=url, actor=who)]


def chat_upload_files():
    """The 📎 files of a multipart chat post: [(name, bytes, mimetype)]."""
    out = []
    for f in request.httprequest.files.getlist('files'):
        if f and f.filename:
            out.append((f.filename, f.read(), _guess_mime(f.filename, f.mimetype or '')))
    return out


def chat_file_response(kpi, att_id):
    """One 📎 file of `kpi`'s chat, inline with Range so video / audio play
    on phones. 404 when the file is not on this task's chat."""
    att = request.env['kpi.file.attachment'].sudo().browse(int(att_id)).exists()
    if (not att or not att.chat_message_id or att.chat_message_id.kpi_id != kpi
            or att.chat_message_id.deleted_at):
        return request.not_found()
    # Documents download (a PDF still opens in the browser); nothing that a
    # browser would run as a page (SVG / HTML) is shown inline.
    mime = _guess_mime(att.file_name, att.mimetype or '')
    inline = ((chat_file_kind(att.file_name, att.mimetype) != 'document' or mime == 'application/pdf')
              and not re.search(r'svg|html|xml', mime or '', re.I))
    return serve_file(base64.b64decode(att.file or b''), att.file_name, mime, inline=inline)


class KpiClientChat(http.Controller):

    def _expired(self):
        return _render('kra_kpi_module.wa_approval_expired', {
            'meta': 'This chat link can no longer be used.',
            'reason': 'Chat links last %d hours.' % CLIENT_CHAT_HOURS,
            'hint': 'Send “hi” in your WhatsApp group and choose 💬 Discuss to write to us again.'})

    @http.route('/kpi/wa/chat/<string:token>', type='http', auth='public',
                methods=['GET'], csrf=False, website=False)
    def page(self, token, **kw):
        kpi = _task_for(token)
        if not kpi:
            return self._expired()
        return _render('kra_kpi_module.wa_client_chat', {
            'token': token, 'ref': kpi._chat_ref(), 'title': kpi.name or '',
            'client': kpi.client_kra_id.name or kpi.kra_id.name or '',
            'expires': fields.Datetime.to_string(kpi.client_chat_expires),
        })

    @http.route('/kpi/wa/chat/<string:token>/rows', type='json', auth='public',
                methods=['POST'], csrf=False)
    def rows(self, token, visible=False, who='', active=False, **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        locked = _locked(kpi, who)
        if locked:
            return locked
        # visible: the page is on screen (document.visibilityState), so the
        # team's messages are now seen -- blue ✓✓ in the team's windows.
        # active: on screen and touched in the last minute = the client is online.
        if visible:
            kpi.chat_mark_seen('client', active=bool(active))
        return {'ok': True, 'rows': _rows(kpi, token, who)}

    @http.route('/kpi/wa/chat/<string:token>/act', type='json', auth='public',
                methods=['POST'], csrf=False)
    def act(self, token, msg_id=None, action='', emoji=None, text=None, who='', **kw):
        """Long-press on a bubble: react / edit / delete. `who` is the page's
        browser id; the client page may edit / delete any client message."""
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        locked = _locked(kpi, who)
        if locked:
            return locked
        try:
            kpi.chat_act(msg_id, action, who or '', emoji=emoji, text=text)
        except UserError as exc:
            return {'ok': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('client chat act failed for %s: %s', kpi.id, exc)
            return {'ok': False, 'message': 'Sorry — that did not work. Please try again.'}
        return {'ok': True, 'rows': _rows(kpi, token, who)}

    @http.route('/kpi/wa/chat/<string:token>/retry', type='json', auth='public',
                methods=['POST'], csrf=False)
    def retry(self, token, message_id=None, **kw):
        """⚠ on the client's bubble: the manager's poll failed; send it again."""
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        locked = _locked(kpi, kw.get('who'))
        if locked:
            return locked
        try:
            kpi.chat_retry(message_id)
        except UserError as exc:
            return {'ok': False, 'message': str(exc)}
        return {'ok': True, 'rows': _rows(kpi, token, kw.get('who') or '')}

    @http.route('/kpi/wa/chat/<string:token>/send', type='json', auth='public',
                methods=['POST'], csrf=False)
    def send(self, token, text='', name='', reply_to=None, **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        locked = _locked(kpi, kw.get('who'))
        if locked:
            return locked
        # No name is asked for: the confirmed person on this browser, else the company.
        name, number = _person(kpi, kw.get('who'))
        try:
            kpi.chat_post_client(text, name=name, number=number, source='client_page', reply_to=reply_to)
        except UserError as exc:
            return {'ok': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('client chat send failed for %s: %s', kpi.id, exc)
            return {'ok': False, 'message': 'Sorry — that could not be sent. Please try again.'}
        return {'ok': True, 'rows': _rows(kpi, token, kw.get('who') or '')}

    @http.route('/kpi/wa/chat/<string:token>/send_files', type='http', auth='public',
                methods=['POST'], csrf=False)
    def send_files(self, token, text='', **kw):
        """📎 photos / videos / audio (multipart, field `files`), with an optional caption."""
        kpi = _task_for(token)
        if not kpi:
            return request.make_json_response({'ok': False, 'expired': True})
        locked = _locked(kpi, kw.get('who'))
        if locked:
            return request.make_json_response(locked)
        name, number = _person(kpi, kw.get('who'))
        try:
            kpi.chat_post_client(text, name=name, number=number, source='client_page', files=chat_upload_files(),
                                 reply_to=kw.get('reply_to'))
        except UserError as exc:
            return request.make_json_response({'ok': False, 'message': str(exc)})
        except Exception as exc:
            _logger.exception('client chat files failed for %s: %s', kpi.id, exc)
            return request.make_json_response({'ok': False, 'message': 'Sorry — that could not be sent. Please try again.'})
        return request.make_json_response({'ok': True, 'rows': _rows(kpi, token, kw.get('who') or '')})

    @http.route('/kpi/wa/chat/<string:token>/file/<int:att_id>', type='http', auth='public',
                methods=['GET'], csrf=False)
    def file(self, token, att_id, w='', **kw):
        kpi = _task_for(token)
        if not kpi or _locked(kpi, w):
            return request.not_found()
        return chat_file_response(kpi, att_id)


# ---------------------------------------------------------------------------
# 💬 The TEAM's chat page for one task (/kpi/team/chat/<id>): the link in our
# WhatsApp group and in the manager's alert. A logged-in page (a group link
# is shared, so it cannot be a one-person token), WhatsApp style: the team in
# green on the right, the client in white on the left; 📎 photos / videos /
# audio, and hold a message (or right-click) for its actions: reactions,
# reply, edit, info, copy, delete, as on the other chat screens. Open to the team
# (developer / manager / admin roles), never to a client login: the developer
# a manager picks is often not on the task (and nobody is on a general one).
# ---------------------------------------------------------------------------
_TEAM_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat · __REF__</title>
<style>
 *{box-sizing:border-box} [hidden]{display:none!important} body{margin:0;font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#d1d7db;color:#111b21}
 .wrap{max-width:820px;margin:0 auto;height:100vh;display:flex;flex-direction:column;background:#efeae2}
 .top{background:#008069;color:#fff;padding:12px 16px}
 .top b{font-size:16px} .top small{display:block;opacity:.85;font-size:12.5px}
 .list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
 .day{align-self:center;background:#fff;color:#54656f;font-size:12px;padding:3px 12px;border-radius:8px;margin:6px 0;box-shadow:0 1px .5px rgba(11,20,26,.13)}
 .line{display:flex;align-items:center;gap:4px;border-radius:8px;transition:background .4s}
 .line.team{justify-content:flex-end} .line.flash{background:rgba(0,168,132,.18)}
 .col{display:flex;flex-direction:column;align-items:flex-start;max-width:78%} .col.team{align-items:flex-end}
 .msg{max-width:100%;background:#fff;border-radius:8px;padding:6px 9px 4px;box-shadow:0 1px .5px rgba(11,20,26,.13);word-break:break-word;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
 .msg.team{background:#d9fdd3} .msg.gone{opacity:.8}
 .who{font-size:12.5px;font-weight:700;color:#d4572e} .msg.team .who{color:#027eb5}
 .body{white-space:pre-wrap} .deleted{font-style:italic;color:#667781}
 .time{font-size:11px;color:#667781;text-align:right;margin-top:2px}
 .tick{margin-left:4px;letter-spacing:-2px} .tick.failed{cursor:pointer}
 .quote{background:rgba(11,20,26,.06);border-left:3px solid #d4572e;border-radius:6px;padding:3px 8px;margin:2px 0 4px;font-size:12.5px;cursor:pointer}
 .quote.team{border-left-color:#027eb5} .quote b{display:block;color:#d4572e} .quote.team b{color:#027eb5}
 .quote span{display:block;color:#54656f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}
 .file{margin:2px 0 4px} .file img,.file video{display:block;max-width:min(300px,100%);max-height:280px;border-radius:6px}
 .file audio{display:block;width:260px;max-width:100%} .fname{font-size:11px;color:#667781}
 .react{display:flex;flex-wrap:wrap;gap:4px;margin:-6px 6px 2px}
 .rchip{border:1px solid #d1d7db;background:#fff;border-radius:12px;padding:1px 7px;font-size:13px;cursor:pointer;box-shadow:0 1px .5px rgba(11,20,26,.13)}
 .rchip.mine{border-color:#00a884;background:#e7fbf4}
 .scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:50}
 .card{background:#fff;border-radius:14px;min-width:260px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.3);padding:8px 0}
 .strip{display:flex;gap:4px;padding:6px 10px 8px;border-bottom:1px solid #eef0f2;overflow-x:auto}
 .remoji{border:0;background:#f0f2f5;border-radius:50%;width:40px;height:40px;font-size:22px;cursor:pointer;flex:0 0 auto;line-height:1}
 .remoji:hover{background:#e2e5e9} .ghead{display:flex;align-items:center;gap:6px;padding:4px 10px;color:#54656f;font-size:13px}
 .grid{display:grid;grid-template-columns:repeat(8,40px);gap:4px;padding:6px 10px 10px}
 .acts{display:flex;flex-direction:column;padding-top:4px}
 .act{display:flex;align-items:center;gap:12px;border:0;background:none;text-align:left;padding:11px 18px;font:inherit;font-size:15px;color:#111b21;cursor:pointer}
 .act:hover{background:#f0f2f5} .act.danger{color:#c0392b} .aicon{width:22px;text-align:center;color:#54656f}
 .minfo{padding:10px 18px 6px;font-size:14px;display:flex;flex-direction:column;gap:6px} .minfo b{font-size:15px;margin-bottom:4px}
 .minfo .seen{color:#2E90FA} .minfo .act{align-self:flex-end;color:#008069;padding:8px 4px 2px}
 .empty{align-self:center;background:#fff3c4;color:#54656f;border-radius:8px;padding:8px 12px;margin-top:24px;font-size:13px}
 .extra{background:#f0f2f5;padding:6px 12px 0}
 .reply{display:flex;align-items:center;gap:8px;background:#fff;border-left:4px solid #00a884;border-radius:6px;padding:4px 8px;margin-bottom:6px}
 .rtext{flex:1;min-width:0;font-size:12.5px} .rtext b{display:block;color:#008069}
 .rtext span{display:block;color:#667781;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .chips{display:flex;flex-wrap:wrap;gap:6px} .chip{background:#fff;border:1px solid #d1d7db;border-radius:12px;padding:2px 10px;font-size:12.5px}
 .cx{border:0;background:none;color:#c0392b;cursor:pointer;font-size:14px}
 .prog{font-size:12px;color:#667781;margin-top:4px} .prog div{height:6px;background:#00a884;border-radius:3px;width:0;transition:width .2s}
 .bar{display:flex;gap:8px;align-items:flex-end;background:#f0f2f5;padding:10px 12px}
 .bar textarea{flex:1;border:0;border-radius:20px;padding:10px 14px;font:inherit;resize:none;outline:0;max-height:120px}
 .bar .send{width:46px;height:46px;border-radius:50%;border:0;background:#00a884;color:#fff;font-size:20px;cursor:pointer}
 .bar .send:disabled{opacity:.5} .info{background:#f0f2f5;color:#54656f;padding:10px 14px;font-size:13px}
 .pinbox{position:relative} .pin{width:46px;height:46px;border-radius:50%;border:0;background:#fff;font-size:20px;cursor:pointer}
 .menu{position:absolute;bottom:54px;left:0;min-width:200px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:4px 0;z-index:5}
 .menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:11px 14px;font:inherit;cursor:pointer}
 .menu button:hover{background:#f0f2f5} .fin{display:none}
 .pv-shade { position:fixed; inset:0; background:rgba(11,20,26,.94); z-index:4000; display:flex; align-items:center; justify-content:center; }
 .pv-shade img { max-width:96vw; max-height:86vh; object-fit:contain; border-radius:4px; }
 .pv-bar { position:absolute; top:0; left:0; right:0; display:flex; align-items:center; gap:14px; padding:12px 16px; color:#fff; }
 .pv-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
 .pv-x, .pv-dl { background:none; border:0; color:#fff; font-size:24px; cursor:pointer; text-decoration:none; line-height:1; }
 .pv-name b, .pv-name small { display:block; overflow:hidden; text-overflow:ellipsis; } .pv-name small { opacity:.75; font-size:12px; } .pv-cap { position:absolute; left:0; right:0; bottom:0; padding:16px 20px 22px; background:linear-gradient(transparent, rgba(0,0,0,.75)); color:#fff; text-align:center; white-space:pre-wrap; word-break:break-word; max-height:30vh; overflow:auto; font-size:15px; }
 .xt-irow { display:flex; gap:8px; padding:6px 0; font-size:14px; border-bottom:1px solid #f0f2f5; }
 .xt-irow.seen { color:#2E90FA; }
 .xt-imark { width:22px; letter-spacing:-2px; }
 .xt-iwhat { flex:1; }
 .xt-itime { color:#667781; white-space:nowrap; }
 .xt-irow.seen .xt-itime { color:#2E90FA; }
 .xt-recording > *:not(.xt-rec) { display:none !important; }
 .xt-rec { flex:1; display:flex; align-items:center; gap:10px; min-height:46px; }
 .xt-rec button { width:42px; height:42px; border:0; border-radius:50%; background:transparent; font-size:20px; cursor:pointer;
   display:flex; align-items:center; justify-content:center; padding:0; color:#54656f; flex:0 0 auto; }
 .xt-rec .xt-rsend { background:#00a884; color:#fff; margin-left:auto; }
 .xt-rdot { width:10px; height:10px; border-radius:50%; background:#e53935; animation:xt-blink 1s infinite; flex:0 0 auto; }
 .xt-rdot.off { animation:none; background:#9aa5ab; }
 @keyframes xt-blink { 50% { opacity:.25; } }
 .xt-rtime { font-variant-numeric:tabular-nums; color:#111b21; min-width:42px; }
 .xt-raudio { height:36px; flex:1; min-width:0; max-width:320px; }
 .file img{cursor:zoom-in}
 .xt-bl { display:flex; align-items:center; gap:4px; max-width:100%; }
 .xt-bl.r { flex-direction:row-reverse; }
 .xt-bl > ..msg { min-width:0; }
 .xt-quick { display:flex; gap:2px; opacity:0; transition:opacity .15s; flex:0 0 auto; }
 .xt-quick button { width:28px; height:28px; border:0; border-radius:50%; padding:0; color:#54656f; background:rgba(255,255,255,.85);
   display:flex; align-items:center; justify-content:center; cursor:pointer; }
 .xt-quick button:hover { background:#fff; color:#111b21; }
 @media (hover: hover) { .xt-bl:hover .xt-quick { opacity:1; } }
 @media (hover: none) { .xt-quick { display:none; } }
 .xt-tail-r { border-top-right-radius:0 !important; }
 .xt-tail-l { border-top-left-radius:0 !important; }
 .xt-tail-r::after, .xt-tail-l::after { content:''; position:absolute; top:0; width:0; height:0; border-top:8px solid var(----xt-bg); }
 .xt-tail-r::after { right:-7px; border-right:8px solid transparent; }
 .xt-tail-l::after { left:-7px; border-left:8px solid transparent; }
 .xt-caret svg { margin-top:-2px; }
 .xt-icon { width:42px !important; height:42px !important; min-height:42px !important; border:0 !important; border-radius:50% !important;
   background:transparent !important; color:#54656f !important; display:flex !important; align-items:center; justify-content:center;
   padding:0 !important; cursor:pointer; flex:0 0 auto; }
 .xt-icon:hover { background:rgba(11,20,26,.06) !important; }
 .xt-emojibox { position:relative; flex:0 0 auto; }
 .xt-emojis { position:absolute; bottom:48px; left:0; width:300px; max-width:86vw; background:#fff; border-radius:12px;
   box-shadow:0 4px 18px rgba(0,0,0,.18); padding:8px; display:grid; grid-template-columns:repeat(8, 1fr); gap:2px; z-index:8; }
 .xt-emojis button { border:0; background:none; font-size:22px; line-height:34px; height:34px; cursor:pointer; border-radius:6px; padding:0; }
 .xt-emojis button:hover { background:#f0f2f5; }
 .xt-caret { position:absolute; top:2px; right:2px; border:0; width:26px; height:22px; padding:0; border-radius:0 8px 0 10px;
   font-size:16px; line-height:14px; color:#667781; cursor:pointer; opacity:0; transition:opacity .15s;
   background:radial-gradient(circle at 70% 30%, var(--xt-bg) 55%, transparent 80%); }
 @media (hover: hover) { .msg:hover .xt-caret { opacity:1; } }
 @media (hover: none) { .xt-caret { display:none; } }
 .xt-lday { display:flex; align-items:center; gap:8px; width:100%; border:0; background:#f0f2f5; border-radius:8px; padding:8px 10px;
   font:inherit; font-size:14px; font-weight:600; color:#111b21; cursor:pointer; text-align:left; margin-top:6px; }
 .xt-larrow { width:14px; color:#54656f; }
 .xt-lcount { margin-left:auto; font-weight:400; font-size:12px; color:#667781; }
 .xt-lrows { padding:4px 4px 2px 26px; }
 .xt-lrow { display:flex; gap:8px; padding:4px 0; font-size:13.5px; border-bottom:1px solid #f0f2f5; }
 .xt-lrow.seen { color:#2E90FA; }
 .xt-lmark { width:22px; letter-spacing:-2px; }
 .xt-lwhat { flex:1; }
 .xt-ltime { color:#667781; }
 .xt-lrow.seen .xt-ltime { color:#2E90FA; }
 .xt-lnot { margin-top:8px; font-size:12.5px; color:#667781; }
 .msg { position:relative; --xt-bg:#ffffff; }
 .msg.team { --xt-bg:#d9fdd3; }
</style></head><body><div class="wrap">
<div class="top"><b>💬 __REF__ — __TITLE__</b><small>__CLIENT__ · the client sees team messages as “Alphalize team”</small></div>
<div class="list" id="list"><div class="empty">Loading…</div></div>
<div class="info" id="info" hidden></div>
<div class="extra" id="extra"><div class="reply" id="reply" hidden></div><div class="chips" id="chips" hidden></div>
 <div class="prog" id="prog" hidden><div></div><span></span></div></div>
<div class="bar" id="bar">
 <div class="pinbox"><button class="pin" id="pin" title="Attach a photo, video or audio">📎</button>
  <div class="menu" id="menu" hidden><button data-pick="camera">📷 Camera</button><button data-pick="media">🖼 Photos &amp; videos</button><button data-pick="audio">🎵 Audio</button><button data-pick="doc">📄 Document</button></div>
  <input type="file" class="fin" id="in-camera" accept="image/*,video/*" capture="environment">
  <input type="file" class="fin" id="in-media" accept="image/*,video/*" multiple>
  <input type="file" class="fin" id="in-audio" accept="audio/*" multiple>
  <input type="file" class="fin" id="in-doc" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.zip,.rar,.7z" multiple></div>
 <textarea id="txt" rows="1" placeholder="Type a message or a caption"></textarea><button class="send" id="send" title="Send">➤</button></div>
</div>
<div class="scrim" id="scrim" hidden><div class="card" id="card"></div></div>
<script>
(function(){
 var ID=__ID__, list=document.getElementById('list'), txt=document.getElementById('txt'), btn=document.getElementById('send'),
     bar=document.getElementById('bar'), info=document.getElementById('info'), extra=document.getElementById('extra'),
     pin=document.getElementById('pin'), menu=document.getElementById('menu'), chips=document.getElementById('chips'),
     replyBar=document.getElementById('reply'), prog=document.getElementById('prog'), scrim=document.getElementById('scrim'),
     card=document.getElementById('card'), shown='';
 var MAX_FILES=10, MAX_BYTES=50*1024*1024, picked=[], replyTo=null, editing=null, sending=false, rowsNow=[], canAct=false, canSend=false;
 var ICON={image:'📷',video:'🎥',audio:'🎵',document:'📄'};
 var QUICK=['👍','❤️','😂','😮','😢','🙏'];
 var ALL=['👍','👎','❤️','🔥','🎉','👏','🙏','💯','😂','🤣','😅','😊','😍','😎','🤔','😐','😮','😢','😭','😡','🥳','🤝','💪','✅','❌','⚠️','👀','🚀','⭐','💡','⏰','📌'];
 function el(t,c,s){var e=document.createElement(t); if(c){e.className=c;} if(s!=null){e.textContent=s;} return e;}
 function when(a){return a?new Date(a.replace(' ','T')+'Z'):null;}
 function day(d){var k=d.toDateString(); if(k===new Date().toDateString())return 'Today';
   if(k===new Date(Date.now()-864e5).toDateString())return 'Yesterday';
   return d.toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});}
 function clock(d){return d?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';}
 function stamp(a){var d=when(a); return d?(day(d)==='Today'?'':day(d)+' ')+clock(d):'not yet';}
 function size(n){n=n||0; if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(0)+' KB'; return (n/1048576).toFixed(1)+' MB';}
 function kindOf(f){var t=(f.type||'').toLowerCase(), n=(f.name||'').toLowerCase();
   if(t.indexOf('audio/')===0)return 'audio'; if(t.indexOf('image/')===0)return 'image'; if(t.indexOf('video/')===0)return 'video';
   if(/\\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(n))return 'image'; if(/\\.(mp4|mov|mkv|avi|m4v)$/.test(n))return 'video';
   if(/\\.(webm|ogg|opus|mp3|wav|m4a|aac|amr|3gp)$/.test(n))return 'audio';
   if(/\\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|zip|rar|7z)$/.test(n))return 'document'; return '';}
 function filesLabel(files){var out=[];
   [['image','photo','photos'],['video','video','videos'],['audio','audio','audios'],['document','document','documents']].forEach(function(k){
     var n=(files||[]).filter(function(f){return f.kind===k[0];}).length; if(n){out.push(ICON[k[0]]+' '+n+' '+(n===1?k[1]:k[2]));}});
   return out.join(' · ');}
 function whoOf(x){return x.side==='team'?x.who:x.who+' · client';}
 function rpc(path,params){return fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',method:'call',params:params})}).then(function(r){return r.json();}).then(function(d){return (d&&d.result)||{};});}
 function media(f,r){var box=el('div','file'),m;
   if(f.kind==='document'){m=el('a');m.href=f.url;m.target='_blank';m.rel='noopener';m.style.cssText='display:flex;gap:8px;align-items:center;padding:10px 12px;background:rgba(0,0,0,.05);border-radius:6px;color:inherit;text-decoration:none;word-break:break-all;min-width:200px';
     m.appendChild(el('span','','📄'));m.appendChild(el('b','',f.name));box.appendChild(m);
     box.appendChild(el('div','fname',size(f.size)));return box;}
   if(f.kind==='image'){m=el('img');m.src=f.url;m.alt=f.name;m.loading='lazy';m.addEventListener('click',function(){viewPhoto(f,r);});box.appendChild(m);}
   else{m=el(f.kind==='video'?'video':'audio');m.src=f.url;m.controls=true;m.preload='metadata';box.appendChild(m);}
   box.appendChild(el('div','fname',f.name+' · '+size(f.size))); return box;}
 // Tap a photo: full screen over the chat, as in WhatsApp. ✕, a tap outside the photo or Esc closes it.
 // r: the message it came in -- who and when on top, its words under the photo.
 function pvHead(f,r){var h=el('span','pv-name'),t=r?when(r.at):null; h.appendChild(el('b','',(r?r.who:'')||f.name));
   if(t){h.appendChild(el('small','',(day(t)==='Today'?'Today':day(t))+' at '+clock(t)));} return h;}
 function viewPhoto(f,r){var v=el('div','pv-shade'),img=el('img'),bar=el('div','pv-bar'),x=el('button','pv-x','✕');
   var dl=el('a','pv-dl','⤓'); dl.href=f.url; dl.target='_blank'; dl.title='Open / download'; x.type='button'; x.title='Close';
   bar.appendChild(pvHead(f,r)); bar.appendChild(dl); bar.appendChild(x); img.src=f.url; img.alt=f.name;
   v.appendChild(bar); v.appendChild(img); if(r?r.body:''){v.appendChild(el('div','pv-cap',r.body));}
   function shut(){document.removeEventListener('keydown',key); if(v.parentNode)v.parentNode.removeChild(v);}
   function key(e){if(e.key==='Escape')shut();}
   x.addEventListener('click',shut); v.addEventListener('click',function(e){if(e.target===v)shut();});
   document.addEventListener('keydown',key); document.body.appendChild(v);}
 function jump(id){var t=document.getElementById('m'+id); if(!t)return;
   t.scrollIntoView({block:'center',behavior:'smooth'}); t.classList.add('flash'); setTimeout(function(){t.classList.remove('flash');},1400);}
 // Hold a bubble (or right-click) to open its actions, as in WhatsApp.
 function holdable(node,id){var t=null,sx=0,sy=0,fired=false,firedAt=0; function clear(){if(t){clearTimeout(t);t=null;}}
   function start(x,y){sx=x;sy=y;fired=false;clear(); t=setTimeout(function(){t=null;fired=true;firedAt=Date.now();openCard(id);},450);}
   function moved(x,y){if(t&&(Math.abs(x-sx)>8||Math.abs(y-sy)>8))clear();}
   // Touch first: a phone may cancel pointer events mid-press, touch events it keeps.
   node.addEventListener('touchstart',function(e){var p=e.touches[0]; if(p)start(p.clientX,p.clientY);},{passive:true});
   node.addEventListener('touchmove',function(e){var p=e.touches[0]; if(p)moved(p.clientX,p.clientY);},{passive:true});
   node.addEventListener('touchend',function(e){clear(); if(fired)e.preventDefault();});
   node.addEventListener('touchcancel',clear);
   node.addEventListener('mousedown',function(e){if(e.button===0&&!('ontouchstart' in window))start(e.clientX,e.clientY);});
   node.addEventListener('mousemove',function(e){moved(e.clientX,e.clientY);});
   ['mouseup','mouseleave'].forEach(function(n){node.addEventListener(n,clear);});
   // A phone's own long-press menu comes right after our hold: ignore that one.
   node.addEventListener('contextmenu',function(e){e.preventDefault();clear();if(Date.now()-firedAt>800)openCard(id);});}
 function reactionChips(x){if(!x.reactions||!x.reactions.length)return null; var row=el('div','react');
   x.reactions.forEach(function(r){var c=el('button','rchip'+(r.mine?' mine':''),r.emoji+(r.count>1?' '+r.count:'')); c.type='button';
     c.title=r.mine?'You reacted — tap to remove':'Tap to react'; c.addEventListener('click',function(){if(canAct)act(x.id,'react',{emoji:r.emoji});}); row.appendChild(c);});
   return row;}
 // 🔔 A message from the other side while this tab is in the background (or
 // the window is not focused): a soft pop and "(N) New message" in the tab
 // title, cleared when the person comes back. Looking at the chat: silent.
 var notify = (function () {
     var ctx = null, unread = 0, base = document.title;
     function unlock() {
         if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
         if (ctx && ctx.state === 'suspended') { ctx.resume(); }
     }
     ['pointerdown', 'keydown', 'touchstart'].forEach(function (n) { document.addEventListener(n, unlock, { passive: true }); });
     function pop() {
         if (!ctx) { return; }
         var t = ctx.currentTime;
         [[880, 0], [1320, 0.08]].forEach(function (p) {
             var o = ctx.createOscillator(), g = ctx.createGain();
             o.type = 'sine'; o.frequency.value = p[0];
             g.gain.setValueAtTime(0.0001, t + p[1]);
             g.gain.exponentialRampToValueAtTime(0.12, t + p[1] + 0.012);
             g.gain.exponentialRampToValueAtTime(0.0001, t + p[1] + 0.1);
             o.connect(g); g.connect(ctx.destination);
             o.start(t + p[1]); o.stop(t + p[1] + 0.12);
         });
     }
     function away() { return document.hidden || !document.hasFocus(); }
     function back() { if (!away() && unread) { unread = 0; document.title = base; } }
     document.addEventListener('visibilitychange', back);
     window.addEventListener('focus', back);
     return function (n) {
         if (!n || !away()) { return; }
         unread += n;
         document.title = '(' + unread + ') New message · ' + base;
         pop();
     };
 })();
 var lastOther = null;   // newest message id from the other side already shown
 function heard(rows, other) {
     var newest = 0, fresh = 0;
     rows.forEach(function (x) {
         if (x.side !== other || typeof x.id !== 'number') { return; }
         if (x.id > newest) { newest = x.id; }
         if (lastOther !== null && x.id > lastOther) { fresh++; }
     });
     if (lastOther !== null && fresh) { notify(fresh); }
     lastOther = Math.max(lastOther || 0, newest);
 }
 var ICONS = {
     reply: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
     smile: '<svg viewBox="0 0 24 24" width="SZ" height="SZ" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>',
     down: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>',
     clip: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" style="transform:rotate(45deg)"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>',
     send: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>'
 };
 var EMOJI = ['😀', '😂', '😊', '😍', '😘', '🤔', '😅', '😉', '🙂', '😎', '😢', '😭', '😡', '👍', '👎', '🙏',
              '👏', '💪', '🤝', '👌', '✌️', '🙌', '❤️', '🔥', '🎉', '✅', '❌', '⚠️', '⭐', '💯', '👀', '🚀',
              '💡', '📌', '⏰', '📷', '📎', '📝', '💬', '📞'];
 // WhatsApp Web: on hover, reply at once or react, beside the bubble.
 function quick(x, canReply) {
     var q = el('div', 'xt-quick');
     if (canReply) {
         var r = el('button'); r.type = 'button'; r.title = 'Reply'; r.innerHTML = ICONS.reply;
         r.addEventListener('click', function () { setReply(x); });
         q.appendChild(r);
     }
     var e = el('button'); e.type = 'button'; e.title = 'React'; e.innerHTML = ICONS.smile.replace(/SZ/g, '18');
     e.addEventListener('click', function () { openCard(x.id); });
     q.appendChild(e);
     return q;
 }
 // The type bar as in WhatsApp: 😊 emoji panel, 📎 paperclip, round send arrow.
 (function () {
     var row = pin.parentNode.parentNode, box = el('div', 'xt-emojibox');
     var b = el('button', 'xt-icon'); b.type = 'button'; b.title = 'Emoji'; b.innerHTML = ICONS.smile.replace(/SZ/g, '24');
     var panel = el('div', 'xt-emojis'); panel.style.display = 'none';
     EMOJI.forEach(function (e) {
         var x = el('button', '', e); x.type = 'button';
         x.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
         x.addEventListener('click', function () {
             var a = txt.selectionStart != null ? txt.selectionStart : txt.value.length, z = txt.selectionEnd != null ? txt.selectionEnd : a;
             txt.value = txt.value.slice(0, a) + e + txt.value.slice(z);
             txt.focus(); txt.selectionStart = txt.selectionEnd = a + e.length;
             txt.dispatchEvent(new Event('input'));
         });
         panel.appendChild(x);
     });
     b.addEventListener('click', function () { panel.style.display = panel.style.display === 'none' ? '' : 'none'; });
     document.addEventListener('click', function (ev) { if (panel.style.display !== 'none' && !box.contains(ev.target)) { panel.style.display = 'none'; } });
     box.appendChild(b); box.appendChild(panel);
     row.insertBefore(box, pin.parentNode);
     pin.innerHTML = ICONS.clip; pin.classList.add('xt-icon');
     btn.innerHTML = ICONS.send;
 })();
 function draw(r){
   if(r.status===false){info.textContent=r.message||'Not allowed.';info.hidden=false;bar.style.display='none';extra.style.display='none';return;}
   rowsNow=r.messages||[]; canAct=!!r.can_act; canSend=!!r.can_send; heard(rowsNow,'client');
   if(r.locked){info.textContent='🔒 '+r.locked;info.hidden=false;bar.style.display='none';extra.style.display='none';}
   else if(!r.can_send){info.textContent='This client has no WhatsApp group linked, so messages can’t be sent.';info.hidden=false;bar.style.display='none';extra.style.display='none';}
   var m=rowsNow, sig=m.map(function(x){return x.id+(x.status||'')+'|'+(x.v||'');}).join(',');
   // Redraw only when something changed (a message, a tick, an edit, a reaction), so a playing video is not cut.
   if(sig===shown)return; shown=sig; list.textContent='';
   if(!m.length){list.appendChild(el('div','empty','No messages yet.'));return;}
   var last='', prevSide='';
   m.forEach(function(x){var d=when(x.at),k=d?day(d):'';
     if(k!==last){list.appendChild(el('div','day',k));last=k;prevSide='';}
     var line=el('div','line'+(x.side==='team'?' team':'')); line.id='m'+x.id;
     var col=el('div','col'+(x.side==='team'?' team':''));
     var b=el('div','msg'+(x.side==='team'?' team':'')+(x.deleted?' gone':'')+(x.side!==prevSide?(x.side==='team'?' xt-tail-r':' xt-tail-l'):'')); prevSide=x.side;
     b.appendChild(el('div','who',whoOf(x)));
     if(x.reply){var q=el('div','quote'+(x.reply.side==='team'?' team':''));
       q.appendChild(el('b','',whoOf(x.reply))); q.appendChild(el('span','',x.reply.text));
       q.addEventListener('click',function(){jump(x.reply.id);}); b.appendChild(q);}
     if(x.deleted){b.appendChild(el('div','deleted','⊘ This message was deleted'));}
     else{(x.files||[]).forEach(function(f){b.appendChild(media(f,x));}); if(x.body){b.appendChild(el('div','body',x.body));}}
     var meta=el('div','time',(x.edited?'edited · ':'')+clock(d));
     if(x.side==='team'&&x.status&&!x.deleted){meta.appendChild(tick(x));}
     b.appendChild(meta);
     if(!x.deleted){holdable(b,x.id);caret(b,x.id);}
     var bl=el('div','xt-bl'+(x.side==='team'?' r':'')); bl.appendChild(b); if(!x.deleted&&canAct){bl.appendChild(quick(x,canSend));}
     col.appendChild(bl); var rc=reactionChips(x); if(rc){col.appendChild(rc);}
     line.appendChild(col); list.appendChild(line);});
   list.scrollTop=list.scrollHeight;}
 // ---- the action card (long-press): reactions, reply, edit, info, copy, delete
 function rowById(id){for(var i=0;i<rowsNow.length;i++){if(rowsNow[i].id===id)return rowsNow[i];} return null;}
 function closeCard(){scrim.hidden=true; card.textContent='';}
 function act(id,action,extra){var p={msg_id:id,action:action}; if(extra&&extra.emoji)p.emoji=extra.emoji; if(extra&&extra.text!=null)p.text=extra.text;
   return rpc('/kpi/team/chat/'+ID+'/act',p).then(function(r){if(r.status===false){alert(r.message||'That did not work.');return false;} shown='';draw(r);return true;})
     .catch(function(){alert('No connection — try again.');return false;});}
 function emojiButton(id,e){var b=el('button','remoji',e); b.type='button'; b.addEventListener('click',function(){closeCard();act(id,'react',{emoji:e});}); return b;}
 function actionRow(icon,label,fn,danger){var b=el('button','act'+(danger?' danger':'')); b.type='button';
   b.appendChild(el('span','aicon',icon)); b.appendChild(el('span','',label)); b.addEventListener('click',function(){closeCard();fn();}); return b;}
 function copyText(text){function fb(){var ta=el('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
     try{document.execCommand('copy');}catch(e){} document.body.removeChild(ta);}
   if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).catch(fb);}else{fb();}}
 // ⌄ on a bubble when the mouse is over it (as WhatsApp Web): opens the actions.
 function caret(b, id) {
     var c = el('button', 'xt-caret'); c.innerHTML = ICONS.down;
     c.type = 'button'; c.title = 'Message options';
     c.addEventListener('mousedown', function (e) { e.stopPropagation(); });
     c.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
     c.addEventListener('click', function (e) { e.stopPropagation(); openCard(id); });
     b.appendChild(c);
 }
 // Info: when it was sent, reached the other side and was seen. Plain times.
 function infoList(box, events) {
     events.forEach(function (ev) {
         var d = ev[2] ? new Date(ev[2].replace(' ', 'T') + 'Z') : null;
         var when = 'not yet';
         if (d && !isNaN(d)) {
             when = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
             if (d.toDateString() !== new Date().toDateString()) {
                 when = d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + when;
             }
         }
         var row = el('div', 'xt-irow' + (ev[3] ? ' ' + ev[3] : ''));
         row.appendChild(el('span', 'xt-imark', ev[0]));
         row.appendChild(el('span', 'xt-iwhat', ev[1]));
         row.appendChild(el('span', 'xt-itime', when));
         box.appendChild(row);
     });
 }
 function showInfo(x){card.textContent=''; var box=el('div','minfo'); box.appendChild(el('b','','Message info'));
   infoList(box,[['✓','Sent',x.at],['✓✓',"Delivered to the client's group",x.info&&x.info.delivered_at],['✓✓','Seen by the client',x.info&&x.info.seen_at,'seen']]);
   var c=el('button','act','Close'); c.type='button'; c.addEventListener('click',closeCard); box.appendChild(c);
   card.appendChild(box); scrim.hidden=false;}
 function openCard(id){var x=rowById(id); if(!x||x.deleted)return; card.textContent='';
   if(canAct){var strip=el('div','strip'); QUICK.forEach(function(e){strip.appendChild(emojiButton(id,e));});
     var more=el('button','remoji','+'); more.type='button'; more.title='More reactions';
     more.addEventListener('click',function(){card.textContent=''; var head=el('div','ghead');
       var back=el('button','act','← Back'); back.type='button'; back.addEventListener('click',function(){openCard(id);});
       head.appendChild(back); head.appendChild(el('span','','Pick a reaction')); card.appendChild(head);
       var grid=el('div','grid'); ALL.forEach(function(e){grid.appendChild(emojiButton(id,e));}); card.appendChild(grid);});
     strip.appendChild(more); card.appendChild(strip);}
   var acts=el('div','acts');
   if(canAct&&canSend){acts.appendChild(actionRow('↩','Reply',function(){setReply(x);}));}
   if(canAct&&x.can_edit){acts.appendChild(actionRow('✎','Edit',function(){setEdit(x);}));}
   if(x.info){acts.appendChild(actionRow('ⓘ','Info',function(){showInfo(x);}));}
   if(x.body){acts.appendChild(actionRow('⎘','Copy',function(){copyText(x.body);}));}
   if(canAct&&x.can_delete){acts.appendChild(actionRow('🗑','Delete',function(){if(window.confirm('Delete this message for everyone?'))act(id,'delete');},true));}
   if(!acts.childNodes.length&&!canAct)return;
   card.appendChild(acts); scrim.hidden=false;}
 scrim.addEventListener('click',function(e){if(e.target===scrim)closeCard();});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!scrim.hidden)closeCard();});
 // ---- ↩ reply / ✎ edit: the bar above the box
 function setReply(x){replyTo=x?x.id:null; editing=null; replyBar.textContent=''; replyBar.hidden=!x; if(!x)return;
   var t=el('div','rtext'); t.appendChild(el('b','','↩ Replying to '+whoOf(x)));
   t.appendChild(el('span','',(x.body||'').replace(/\\s+/g,' ').slice(0,120)||filesLabel(x.files)));
   var c=el('button','cx','✕'); c.title='Cancel reply'; c.addEventListener('click',function(){setReply(null);});
   replyBar.appendChild(t); replyBar.appendChild(c); txt.focus();}
 function setEdit(x){setReply(null); editing=x.id; replyBar.hidden=false;
   var t=el('div','rtext'); t.appendChild(el('b','','✎ Editing message')); t.appendChild(el('span','',(x.body||'').replace(/\\s+/g,' ').slice(0,120)));
   var c=el('button','cx','✕'); c.title='Cancel edit'; c.addEventListener('click',function(){txt.value='';setReply(null);});
   replyBar.appendChild(t); replyBar.appendChild(c); txt.value=x.body||''; txt.focus();}
 function drawChips(){chips.textContent=''; chips.hidden=!picked.length;
   picked.forEach(function(p,i){var c=el('span','chip',ICON[p.kind]+' '+p.file.name+' · '+size(p.file.size)+' ');
     if(!sending){var x=el('button','cx','✕'); x.title='Remove'; x.addEventListener('click',function(){picked.splice(i,1);drawChips();}); c.appendChild(x);}
     chips.appendChild(c);});}
 pin.addEventListener('click',function(){menu.hidden=!menu.hidden;});
 document.addEventListener('click',function(e){if(!menu.hidden&&e.target!==pin&&!menu.contains(e.target)){menu.hidden=true;}});
 Array.prototype.forEach.call(menu.querySelectorAll('[data-pick]'),function(a){a.addEventListener('click',function(){
   menu.hidden=true; var i=document.getElementById('in-'+a.getAttribute('data-pick')); i.value=''; i.click();});});
 Array.prototype.forEach.call(document.querySelectorAll('.fin'),function(inp){inp.addEventListener('change',function(){
   Array.prototype.forEach.call(inp.files||[],function(f){var k=kindOf(f);
     if(!k){alert('"'+f.name+'" can not be sent: photos, videos, audio and documents only.');}
     else if(f.size>MAX_BYTES){alert('"'+f.name+'" is '+size(f.size)+'. The limit is 50 MB.');}
     else if(picked.length>=MAX_FILES){alert('At most '+MAX_FILES+' files in one message.');}
     else{picked.push({file:f,kind:k});}});
   inp.value=''; drawChips();});});
 // ✓ saved · ✓✓ reached the client's group · blue ✓✓ the client opened the chat · ⚠ WhatsApp refused it (tap to retry).
 function tick(x){var t=el('span','tick'+(x.status==='failed'?' failed':''),x.status==='failed'?'⚠':(x.status==='pending'?'✓':'✓✓'));
   t.style.color=x.status==='seen'?'#53bdeb':(x.status==='failed'?'#d4572e':'#667781');
   t.title=x.status==='failed'?((x.error||'Not delivered.')+' Tap to retry.'):x.status==='seen'?'Seen by the client':x.status==='sent'?"Delivered to the client's WhatsApp group":'Sending…';
   if(x.status==='failed'){t.addEventListener('click',function(){rpc('/kpi/team/chat/'+ID+'/retry',{message_id:x.id}).then(function(r){if(r.status===false){alert(r.message||'Could not retry.');return;}shown='';draw(r);});});}
   return t;}
 // visible: the page is on screen, so the client's messages count as seen.
 // Online = on screen and touched in the last minute; the server tells
 // the other side's WhatsApp to stay quiet while we are online.
 var lastTouch = Date.now();
 ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel', 'mousemove'].forEach(function (n) {
     document.addEventListener(n, function () { lastTouch = Date.now(); }, { passive: true, capture: true });
 });
 function isActive() { return document.visibilityState === 'visible' && Date.now() - lastTouch < 60000; }
 function load(){if(sending)return; rpc('/kpi/team/chat/'+ID+'/rows',{visible:document.visibilityState==='visible',active:isActive()}).then(draw).catch(function(){});}
 // A text message shows at once with a single ✓ and the box clears; the server's rows replace it a moment later.
 function tempRow(text){var line=el('div','line team'),b=el('div','msg team'); b.appendChild(el('div','who','You')); b.appendChild(el('div','body',text));
   var meta=el('div','time',new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})); meta.appendChild(tick({status:'pending'})); b.appendChild(meta);
   line.appendChild(b); list.appendChild(line); list.scrollTop=list.scrollHeight; return line;}
 function unsend(line,text){if(line&&line.parentNode){line.parentNode.removeChild(line);} txt.value=text;}
 function finish(r){sending=false;btn.disabled=false;prog.hidden=true;
   if(r.status===false){alert(r.message||'Not sent.');drawChips();return;}
   txt.value='';picked=[];drawChips();setReply(null);shown='';draw(r);}
 function failed(){sending=false;btn.disabled=false;prog.hidden=true;drawChips();alert('No connection — try again.');}
 function send(){var t=txt.value.trim(); if(sending)return;
   if(editing){if(!t)return; var id=editing; sending=true; btn.disabled=true;
     act(id,'edit',{text:t}).then(function(ok){sending=false;btn.disabled=false; if(ok){txt.value='';setReply(null);}}); return;}
   if(!t&&!picked.length)return; sending=true; btn.disabled=true; drawChips();
   var fd=new FormData(); fd.append('text',t); fd.append('reply_to',replyTo||'');
   picked.forEach(function(p){fd.append('files',p.file,p.file.name);});
   var temp=null; if(!picked.length){temp=tempRow(t); txt.value=''; setReply(null);}
   // XHR, not fetch: it reports upload progress for big videos.
   var xhr=new XMLHttpRequest(); xhr.open('POST','/kpi/team/chat/'+ID+'/send_files',true);
   if(picked.length){prog.hidden=false;prog.firstElementChild.style.width='0%';prog.lastElementChild.textContent='';}
   xhr.upload.onprogress=function(e){if(!e.lengthComputable||!picked.length)return;
     var pc=Math.min(100,Math.round(e.loaded/e.total*100)); prog.firstElementChild.style.width=pc+'%';
     prog.lastElementChild.textContent=pc+'% · '+size(e.loaded)+' of '+size(e.total);};
   xhr.onload=function(){if(xhr.status===413){finish({status:false,message:'Too large for the server (max 50 MB).'});return;}
     var r=null; try{r=JSON.parse(xhr.responseText);}catch(e){r=null;} if(r){if(r.status===false){unsend(temp,t);} finish(r);}else{unsend(temp,t);failed();}};
   xhr.onerror=function(){unsend(temp,t);failed();}; xhr.send(fd);}
 // 🎤 Voice note, as in WhatsApp: with an empty box the send button is a
 // mic. Tap it: recording starts. ⏸ pauses (▶ plays what is recorded so far),
 // 🎙 carries on the same note, 🗑 throws it away, ➤ sends it. Nothing goes
 // out before ➤.
 var MIC_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
 function voiceRecorder(row, txt, sendBtn, hasFiles, sendVoice, say) {
     var can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
     var mode = 'send', sendHtml = sendBtn.innerHTML;
     var rec = null, chunks = [], stream = null, mime = '', started = 0, acc = 0, timer = null, bar = null;
     var tEl, dotEl, pauseBtn, audioEl;
     function wantMic() { return can && !bar && !sendBtn.disabled && !txt.value.trim() && !hasFiles(); }
     function refresh() {
         if (bar) { return; }
         var m = wantMic() ? 'mic' : 'send';
         // Which icon shows now: the browser rewrites SVG markup, so look for the
         // mic's own path rather than comparing the whole string.
         var isMic = sendBtn.innerHTML.indexOf('M12 14c1.66') > -1;
         if (m === 'mic' && !isMic) { sendHtml = sendBtn.innerHTML; sendBtn.innerHTML = MIC_SVG; sendBtn.title = 'Record a voice note'; }
         if (m === 'send' && isMic) { sendBtn.innerHTML = sendHtml; sendBtn.title = 'Send'; }
         mode = m;
     }
     txt.addEventListener('input', refresh);
     setInterval(refresh, 400);
     row.addEventListener('click', function (e) {
         if (mode === 'mic' && !bar && sendBtn.contains(e.target)) { e.preventDefault(); e.stopPropagation(); start(); }
     }, true);
     function pickMime() {
         var c = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
         for (var i = 0; i < c.length; i++) { if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c[i])) { return c[i]; } }
         return '';
     }
     function fmt(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
     function elapsed() { return acc + (rec && rec.state === 'recording' ? Date.now() - started : 0); }
     function btn(cls, title, html) { var b = el('button', cls); b.type = 'button'; b.title = title; b.innerHTML = html; return b; }
     function start() {
         navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
             stream = s; mime = pickMime(); chunks = []; acc = 0;
             try { rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); } catch (e) { rec = new MediaRecorder(s); }
             rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) { chunks.push(ev.data); } };
             rec.start(250); started = Date.now();
             build();
             timer = setInterval(function () {
                 if (!bar) { return; }
                 tEl.textContent = fmt(elapsed());
                 if (elapsed() >= 900000 && rec.state === 'recording') { pause(); }
             }, 250);
         }).catch(function () { say('Microphone not available — allow it in the browser to record.'); });
     }
     function build() {
         bar = el('div', 'xt-rec');
         var del = btn('xt-rbin', 'Delete', '🗑');
         dotEl = el('span', 'xt-rdot'); tEl = el('span', 'xt-rtime', '0:00');
         pauseBtn = btn('xt-rpause', 'Pause', '⏸');
         audioEl = el('audio'); audioEl.controls = true; audioEl.className = 'xt-raudio'; audioEl.style.display = 'none';
         var go = btn('xt-rsend', 'Send', ICONS.send);
         del.addEventListener('click', function () { finish(false); });
         pauseBtn.addEventListener('click', function () { if (rec.state === 'recording') { pause(); } else { resume(); } });
         go.addEventListener('click', function () { finish(true); });
         bar.appendChild(del); bar.appendChild(dotEl); bar.appendChild(tEl); bar.appendChild(audioEl);
         bar.appendChild(pauseBtn); bar.appendChild(go);
         row.classList.add('xt-recording'); row.appendChild(bar);
     }
     function pause() {
         if (!rec || rec.state !== 'recording') { return; }
         rec.pause(); acc += Date.now() - started;
         dotEl.classList.add('off'); pauseBtn.innerHTML = '🎙'; pauseBtn.title = 'Continue recording';
         try { rec.requestData(); } catch (e) { /* older browsers: the chunks so far are enough */ }
         setTimeout(function () {
             if (!bar) { return; }
             audioEl.src = URL.createObjectURL(new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] }));
             audioEl.style.display = ''; tEl.style.display = 'none';
         }, 200);
     }
     function resume() {
         if (!rec || rec.state !== 'paused') { return; }
         audioEl.pause(); audioEl.style.display = 'none'; tEl.style.display = '';
         rec.resume(); started = Date.now();
         dotEl.classList.remove('off'); pauseBtn.innerHTML = '⏸'; pauseBtn.title = 'Pause';
     }
     function finish(send) {
         if (!rec) { return; }
         var r = rec;
         r.onstop = function () {
             if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
             clearInterval(timer);
             var type = (r.mimeType || mime || 'audio/webm').split(';')[0];
             var ext = type.indexOf('ogg') > -1 ? 'ogg' : (type.indexOf('mp4') > -1 ? 'm4a' : 'webm');
             var blob = new Blob(chunks, { type: type });
             if (bar && bar.parentNode) { bar.parentNode.removeChild(bar); }
             bar = null; rec = null; row.classList.remove('xt-recording'); mode = 'send'; refresh();
             if (send && blob.size) {
                 var n = new Date(), p = function (x) { return ('0' + x).slice(-2); };
                 var name = 'voice-' + n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate()) + '-' + p(n.getHours()) + p(n.getMinutes()) + p(n.getSeconds()) + '.' + ext;
                 sendVoice(new File([blob], name, { type: type }));
             }
         };
         if (r.state === 'inactive') { r.onstop(); } else { r.stop(); }
     }
 }
 voiceRecorder(bar, txt, btn, function(){return picked.length>0;}, function(f){picked=[{file:f,kind:'audio'}];drawChips();send();}, function(m){alert(m);});
 btn.addEventListener('click',send);
 txt.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
 load(); setInterval(load,3000);
})();
</script></body></html>"""


def _team_user_ok(user):
    if user.has_group('kra_kpi_module.group_kra_client') and not user.has_group('kra_kpi_module.group_kra_admin'):
        return False
    return any(user.has_group(g) for g in (
        'kra_kpi_module.group_kra_developer', 'kra_kpi_module.group_kra_manager',
        'kra_kpi_module.group_kra_admin', 'kra_kpi_module.group_kra_owner', 'base.group_system'))


def _team_admin(user):
    return request.env['kra.kpi']._user_is_kpi_admin(user)


def _team_member_ok(kpi, user):
    """The shared team chat page is for the people on THIS task: its
    developer(s), its manager(s) and the KPI admins. Not every developer."""
    if _team_admin(user):
        return True
    people = kpi.user_id | kpi.contributor_ids | kpi._manager_users()
    doubts = request.env['kpi.doubt'].sudo().search([('kpi_id', '=', kpi.id), ('kind', '=', 'client_msg')])
    people |= doubts.mapped('manager_user_id')
    return user in people


def _team_payload(kpi, user):
    Report = request.env['kpi.wa.group.report'].sudo()
    locked = kpi._details_locked_for(user)
    return {'status': True, 'messages': kpi.chat_rows(viewer=user, admin=_team_admin(user)),
            'waiting': kpi.chat_waiting(),
            'can_send': bool(Report._group_for_kpi(kpi)), 'locked': locked, 'can_act': not locked}


class KpiTeamChat(http.Controller):

    def _kpi(self, kpi_id):
        kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(int(kpi_id)).exists()
        user = request.env.user
        if not kpi or not _team_user_ok(user) or not _team_member_ok(kpi, user):
            return None
        return kpi

    @http.route('/kpi/team/chat/<int:kpi_id>/rows', type='json', auth='user', methods=['POST'], csrf=False)
    def team_rows(self, kpi_id, visible=False, active=False, **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        if visible:
            kpi.chat_mark_seen('team', active=bool(active))
        return _team_payload(kpi, request.env.user)

    @http.route('/kpi/team/chat/<int:kpi_id>/retry', type='json', auth='user', methods=['POST'], csrf=False)
    def team_retry(self, kpi_id, message_id=None, **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        try:
            kpi.chat_retry(message_id)
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        return _team_payload(kpi, request.env.user)

    @http.route('/kpi/team/chat/<int:kpi_id>/act', type='json', auth='user', methods=['POST'], csrf=False)
    def team_act(self, kpi_id, msg_id=None, action='', emoji=None, text=None, **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        user = request.env.user
        locked = kpi._details_locked_for(user)
        if locked:
            return {'status': False, 'message': locked}
        try:
            kpi.chat_act(msg_id, action, 'u:%d' % user.id, emoji=emoji, text=text, admin=_team_admin(user))
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('team chat act failed for %s: %s', kpi.id, exc)
            return {'status': False, 'message': 'That did not work — please try again.'}
        return _team_payload(kpi, user)

    @http.route('/kpi/team/chat/<int:kpi_id>/send', type='json', auth='user', methods=['POST'], csrf=False)
    def team_send(self, kpi_id, text='', reply_to=None, **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        user = request.env.user
        locked = kpi._details_locked_for(user)
        if locked:
            return {'status': False, 'message': locked}
        try:
            kpi.chat_post_team(text, user, source='web', reply_to=reply_to)
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('team chat send failed for %s: %s', kpi.id, exc)
            return {'status': False, 'message': 'Could not send — please try again.'}
        return _team_payload(kpi, user)

    @http.route('/kpi/team/chat/<int:kpi_id>/send_files', type='http', auth='user', methods=['POST'], csrf=False)
    def team_send_files(self, kpi_id, text='', **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return request.make_json_response({'status': False, 'message': 'Not authorized.'})
        user = request.env.user
        locked = kpi._details_locked_for(user)
        if locked:
            return request.make_json_response({'status': False, 'message': locked})
        try:
            kpi.chat_post_team(text, user, source='web', files=chat_upload_files(),
                               reply_to=kw.get('reply_to'))
        except UserError as exc:
            return request.make_json_response({'status': False, 'message': str(exc)})
        except Exception as exc:
            _logger.exception('team chat files failed for %s: %s', kpi.id, exc)
            return request.make_json_response({'status': False, 'message': 'Could not send — please try again.'})
        return request.make_json_response(_team_payload(kpi, user))

    @http.route('/kpi/team/chat/<int:kpi_id>', type='http', auth='user', methods=['GET'],
                csrf=False, website=False)
    def team_chat(self, kpi_id, **kw):
        from html import escape
        kpi = self._kpi(kpi_id)
        if not kpi:
            task = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(int(kpi_id)).exists()
            if not task:
                return request.not_found()
            return request.make_response(
                '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
                '<div style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:18vh auto;'
                'padding:24px;text-align:center;color:#111b21">🔒<br><b>This chat is for the developer and manager on %s.</b>'
                '<br><span style="color:#667781">Ask the manager if you need to see it.</span></div>' % escape(task._chat_ref()),
                headers=[('Content-Type', 'text/html; charset=utf-8')], status=403)
        page = (_TEAM_PAGE.replace('__REF__', escape(kpi._chat_ref()))
                .replace('__TITLE__', escape(kpi.name or ''))
                .replace('__CLIENT__', escape(kpi.client_kra_id.name or kpi.kra_id.name or ''))
                .replace('__ID__', str(kpi.id)))
        return request.make_response(page, headers=[('Content-Type', 'text/html; charset=utf-8')])
