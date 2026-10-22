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

import hmac
import logging

from odoo import fields, http
from odoo.exceptions import UserError
from odoo.http import request

from .kpi_wa_approval import _render
from ..models.kpi_chat import CLIENT_CHAT_HOURS

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


def _rows(kpi):
    """The thread as the client may see it: no staff names."""
    return [{'id': r['id'], 'side': r['side'], 'body': r['body'], 'at': r['at'],
             'who': r['who'] if r['side'] == 'client' else 'Alphalize team'}
            for r in kpi.chat_rows(limit=200)]


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
    def rows(self, token, **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        return {'ok': True, 'rows': _rows(kpi)}

    @http.route('/kpi/wa/chat/<string:token>/send', type='json', auth='public',
                methods=['POST'], csrf=False)
    def send(self, token, text='', name='', **kw):
        kpi = _task_for(token)
        if not kpi:
            return {'ok': False, 'expired': True}
        # No name is asked for: the message is from the client's company.
        name = ' '.join((name or '').split())[:60] or kpi.client_kra_id.name or kpi.kra_id.name or 'Client'
        try:
            kpi.chat_post_client(text, name=name, source='client_page')
        except UserError as exc:
            return {'ok': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('client chat send failed for %s: %s', kpi.id, exc)
            return {'ok': False, 'message': 'Sorry — that could not be sent. Please try again.'}
        return {'ok': True, 'rows': _rows(kpi)}


# ---------------------------------------------------------------------------
# 💬 The TEAM's chat page for one task (/kpi/team/chat/<id>): the link in our
# WhatsApp group and in the manager's alert. A logged-in page (a group link
# is shared, so it cannot be a one-person token), WhatsApp style: the team in
# green on the right, the client in white on the left. Open to the team
# (developer / manager / admin roles), never to a client login: the developer
# a manager picks is often not on the task (and nobody is on a general one).
# ---------------------------------------------------------------------------
_TEAM_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat · __REF__</title>
<style>
 *{box-sizing:border-box} body{margin:0;font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#d1d7db;color:#111b21}
 .wrap{max-width:820px;margin:0 auto;height:100vh;display:flex;flex-direction:column;background:#efeae2}
 .top{background:#008069;color:#fff;padding:12px 16px}
 .top b{font-size:16px} .top small{display:block;opacity:.85;font-size:12.5px}
 .list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
 .day{align-self:center;background:#fff;color:#54656f;font-size:12px;padding:3px 12px;border-radius:8px;margin:6px 0;box-shadow:0 1px .5px rgba(11,20,26,.13)}
 .msg{align-self:flex-start;max-width:78%;background:#fff;border-radius:8px;padding:6px 9px 4px;box-shadow:0 1px .5px rgba(11,20,26,.13);white-space:pre-wrap;word-break:break-word}
 .msg.team{align-self:flex-end;background:#d9fdd3}
 .who{font-size:12.5px;font-weight:700;color:#d4572e} .msg.team .who{color:#027eb5}
 .time{font-size:11px;color:#667781;text-align:right;margin-top:2px}
 .empty{align-self:center;background:#fff3c4;color:#54656f;border-radius:8px;padding:8px 12px;margin-top:24px;font-size:13px}
 .bar{display:flex;gap:8px;align-items:flex-end;background:#f0f2f5;padding:10px 12px}
 .bar textarea{flex:1;border:0;border-radius:20px;padding:10px 14px;font:inherit;resize:none;outline:0;max-height:120px}
 .bar button{width:46px;height:46px;border-radius:50%;border:0;background:#00a884;color:#fff;font-size:20px;cursor:pointer}
 .bar button:disabled{opacity:.5} .info{background:#f0f2f5;color:#54656f;padding:10px 14px;font-size:13px}
</style></head><body><div class="wrap">
<div class="top"><b>💬 __REF__ — __TITLE__</b><small>__CLIENT__ · the client sees team messages as “Alphalize team”</small></div>
<div class="list" id="list"><div class="empty">Loading…</div></div>
<div class="info" id="info" hidden></div>
<div class="bar" id="bar"><textarea id="txt" rows="1" placeholder="Type a message"></textarea><button id="send" title="Send">➤</button></div>
</div><script>
(function(){
 var ID=__ID__, list=document.getElementById('list'), txt=document.getElementById('txt'), btn=document.getElementById('send'),
     bar=document.getElementById('bar'), info=document.getElementById('info'), shown=-1;
 function el(t,c,s){var e=document.createElement(t); if(c){e.className=c;} if(s!=null){e.textContent=s;} return e;}
 function when(a){return a?new Date(a.replace(' ','T')+'Z'):null;}
 function day(d){var k=d.toDateString(); if(k===new Date().toDateString())return 'Today';
   if(k===new Date(Date.now()-864e5).toDateString())return 'Yesterday';
   return d.toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});}
 function rpc(path,params){return fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',method:'call',params:params})}).then(function(r){return r.json();}).then(function(d){return (d&&d.result)||{};});}
 function draw(r){
   if(r.status===false){info.textContent=r.message||'Not allowed.';info.hidden=false;bar.style.display='none';return;}
   if(r.locked){info.textContent='🔒 '+r.locked;info.hidden=false;bar.style.display='none';}
   else if(!r.can_send){info.textContent='This client has no WhatsApp group linked, so messages can’t be sent.';info.hidden=false;bar.style.display='none';}
   var m=r.messages||[]; if(m.length===shown)return; shown=m.length; list.textContent='';
   if(!m.length){list.appendChild(el('div','empty','No messages yet.'));return;}
   var last='';
   m.forEach(function(x){var d=when(x.at),k=d?day(d):'';
     if(k!==last){list.appendChild(el('div','day',k));last=k;}
     var b=el('div','msg'+(x.side==='team'?' team':''));
     b.appendChild(el('div','who',x.side==='team'?x.who:x.who+' · client'));
     b.appendChild(el('div','',x.body));
     b.appendChild(el('div','time',d?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''));
     list.appendChild(b);});
   list.scrollTop=list.scrollHeight;}
 function load(){rpc('/kpi/team/chat/'+ID+'/rows',{}).then(draw).catch(function(){});}
 function send(){var t=txt.value.trim(); if(!t)return; btn.disabled=true;
   rpc('/kpi/team/chat/'+ID+'/send',{text:t}).then(function(r){
     if(r.status===false){alert(r.message||'Not sent.');return;} txt.value=''; shown=-1; draw(r);})
   .catch(function(){alert('No connection — try again.');}).then(function(){btn.disabled=false;});}
 btn.addEventListener('click',send);
 txt.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
 load(); setInterval(load,10000);
})();
</script></body></html>"""


def _team_user_ok(user):
    if user.has_group('kra_kpi_module.group_kra_client') and not user.has_group('kra_kpi_module.group_kra_admin'):
        return False
    return any(user.has_group(g) for g in (
        'kra_kpi_module.group_kra_developer', 'kra_kpi_module.group_kra_manager',
        'kra_kpi_module.group_kra_admin', 'kra_kpi_module.group_kra_owner', 'base.group_system'))


def _team_payload(kpi, user):
    Report = request.env['kpi.wa.group.report'].sudo()
    return {'status': True, 'messages': kpi.chat_rows(viewer=user), 'waiting': kpi.chat_waiting(),
            'can_send': bool(Report._group_for_kpi(kpi)), 'locked': kpi._details_locked_for(user)}


class KpiTeamChat(http.Controller):

    def _kpi(self, kpi_id):
        kpi = request.env['kra.kpi'].sudo().with_context(active_test=False).browse(int(kpi_id)).exists()
        if not kpi or not _team_user_ok(request.env.user):
            return None
        return kpi

    @http.route('/kpi/team/chat/<int:kpi_id>/rows', type='json', auth='user', methods=['POST'], csrf=False)
    def team_rows(self, kpi_id, **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        return _team_payload(kpi, request.env.user)

    @http.route('/kpi/team/chat/<int:kpi_id>/send', type='json', auth='user', methods=['POST'], csrf=False)
    def team_send(self, kpi_id, text='', **kw):
        kpi = self._kpi(kpi_id)
        if not kpi:
            return {'status': False, 'message': 'Not authorized.'}
        user = request.env.user
        locked = kpi._details_locked_for(user)
        if locked:
            return {'status': False, 'message': locked}
        try:
            kpi.chat_post_team(text, user, source='web')
        except UserError as exc:
            return {'status': False, 'message': str(exc)}
        except Exception as exc:
            _logger.exception('team chat send failed for %s: %s', kpi.id, exc)
            return {'status': False, 'message': 'Could not send — please try again.'}
        return _team_payload(kpi, user)

    @http.route('/kpi/team/chat/<int:kpi_id>', type='http', auth='user', methods=['GET'],
                csrf=False, website=False)
    def team_chat(self, kpi_id, **kw):
        from html import escape
        kpi = self._kpi(kpi_id)
        if not kpi:
            return request.not_found()
        page = (_TEAM_PAGE.replace('__REF__', escape(kpi._chat_ref()))
                .replace('__TITLE__', escape(kpi.name or ''))
                .replace('__CLIENT__', escape(kpi.client_kra_id.name or kpi.kra_id.name or ''))
                .replace('__ID__', str(kpi.id)))
        return request.make_response(page, headers=[('Content-Type', 'text/html; charset=utf-8')])
