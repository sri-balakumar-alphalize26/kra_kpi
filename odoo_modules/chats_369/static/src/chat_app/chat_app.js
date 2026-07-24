/** @odoo-module **/

// 369Chats — WhatsApp-Web-style chat client for the Odoo backend.
// Left: conversations (+ new chat / new group / ⋮ menu). Right: the open chat.
// Per message: hover caret → menu (Reply · Copy · React · Forward · Pin · Star ·
// Edit · Delete for me / everyone) + quick-reactions bar. Header ⋮ menu →
// New group · Starred messages · Mark all as read. ~3s polling.

import { Component, xml, useState, useRef, onWillStart, onMounted, onWillUnmount, onPatched, useExternalListener, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class Chat369App extends Component {

    static template = xml/* xml */`
        <div class="o369" t-att-class="'o369-theme-' + state.theme">
            <!-- ================= LEFT NAV RAIL ================= -->
            <div class="o369-rail">
                <div class="o369-raillogo">369</div>
                <button class="o369-railbtn" t-att-class="{ 'o369-railon': state.pane === 'chats' }" t-on-click="() => this.switchPane('chats')" title="Chats"><i class="fa fa-comments"/><span class="o369-railbadge" t-if="totalUnread() > 0" t-esc="totalUnread() > 99 ? '99+' : totalUnread()"/></button>
                <div class="o369-railgap"/>
                <div class="o369-raildiv"/>
                <button class="o369-railbtn" t-att-class="{ 'o369-railon': state.pane === 'calls' }" t-on-click="() => this.switchPane('calls')" title="Calls"><i class="fa fa-phone"/></button>
                <button class="o369-railbtn" t-att-class="{ 'o369-railon': state.pane === 'media' }" t-on-click="() => this.switchPane('media')" title="Media"><i class="fa fa-picture-o"/></button>
                <button class="o369-railav" t-att-class="{ 'o369-railon': state.pane === 'profile' }" t-on-click="() => this.switchPane('profile')" title="Profile">
                    <img t-if="state.me and state.me.avatar_url" t-att-src="state.me.avatar_url"/>
                    <span t-else="" t-esc="initials(state.me and state.me.name)"/>
                </button>
            </div>
            <!-- ================= LEFT PANE ================= -->
            <div class="o369-left" t-if="state.pane === 'chats'">
                <t t-if="state.view === 'chats'">
                    <div class="o369-lhead">
                        <span class="o369-brandwrap">
                            <span class="o369-brand">369Chats</span>
                        </span>
                        <span class="o369-headbtns">
                            <button class="o369-iconbtn" t-on-click="toggleDark" t-att-title="state.dark ? 'Switch to light' : 'Switch to dark'"><i class="fa" t-att-class="state.dark ? 'fa-sun-o' : 'fa-moon-o'"/></button>
                            <button class="o369-iconbtn" t-on-click="openContacts" title="New chat"><i class="fa fa-pencil-square-o"/></button>
                            <button class="o369-iconbtn" t-on-click.stop="toggleHeaderMenu" title="Menu"><i class="fa fa-ellipsis-v"/></button>
                            <div class="o369-hdrmenu" t-if="state.headerMenu">
                                <button class="o369-menuitem" t-on-click.stop="menuNewGroup"><i class="fa fa-users"/> New group</button>
                                <button class="o369-menuitem" t-on-click.stop="openStarred"><i class="fa fa-star"/> Starred messages</button>
                                <button class="o369-menuitem" t-on-click.stop="markAllRead"><i class="fa fa-check"/> Mark all as read</button>
                            </div>
                        </span>
                    </div>
                    <div class="o369-search">
                        <i class="fa fa-search"/>
                        <input type="text" placeholder="Search chats and messages" t-model="state.search" t-on-input="onListSearch"/>
                        <button class="o369-searchx" t-if="state.search" t-on-click="() => { state.search = ''; state.globalMsgs = []; }" title="Clear"><i class="fa fa-times"/></button>
                    </div>
                    <div class="o369-chips">
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'all' }" t-on-click="() => this.setFilter('all')">All</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'unread' }" t-on-click="() => this.setFilter('unread')">Unread</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'favourites' }" t-on-click="() => this.setFilter('favourites')">Favourites</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'groups' }" t-on-click="() => this.setFilter('groups')">Groups</button>
                        <div class="o369-chipmore-wrap">
                            <button class="o369-chip o369-chipmore" t-att-class="{ 'o369-chip-on': !['all','unread','favourites','groups'].includes(state.filter) }" t-on-click.stop="() => (state.chipMenuOpen = !state.chipMenuOpen)" title="More lists"><i class="fa fa-angle-down"/></button>
                            <div class="o369-chipmenu" t-if="state.chipMenuOpen">
                                <t t-foreach="state.lists" t-as="l" t-key="l.id">
                                    <button class="o369-chipmenu-item" t-att-class="{ 'o369-chipmenu-on': state.filter === l.id }" t-on-click.stop="() => { this.setFilter(l.id); state.chipMenuOpen = false; }"><span><t t-esc="l.emoji"/> <t t-esc="l.name"/></span></button>
                                </t>
                                <button class="o369-chipmenu-item" t-att-class="{ 'o369-chipmenu-on': state.filter === 'archived' }" t-on-click.stop="() => { this.setFilter('archived'); state.chipMenuOpen = false; }"><span><i class="fa fa-archive"/> Archived</span></button>
                                <button class="o369-chipmenu-item o369-chipmenu-admin" t-if="state.gmeet.is_admin" t-att-class="{ 'o369-chipmenu-on': state.filter === 'admin_all' }" t-on-click.stop="() => { this.setFilter('admin_all'); state.chipMenuOpen = false; }"><span><i class="fa fa-eye"/> All chats (monitor)</span></button>
                                <div class="o369-chipmenu-sep"/>
                                <button class="o369-chipmenu-item o369-chipmenu-add" t-on-click.stop="() => { this.openNewList(); state.chipMenuOpen = false; }"><span><i class="fa fa-plus"/> New list</span></button>
                            </div>
                        </div>
                    </div>
                    <div class="o369-notifbanner" t-if="notifsBlocked()">
                        <i class="fa fa-bell-slash-o o369-nb-ico"/>
                        <span class="o369-nb-txt">Notifications are off. <button class="o369-nb-on" t-on-click="enableNotifsFromBanner">Turn on</button></span>
                        <button class="o369-nb-x" t-on-click="() => (state.notifBannerHidden = true)" title="Dismiss"><i class="fa fa-times"/></button>
                    </div>
                    <div class="o369-list">
                        <t t-foreach="filteredConversations()" t-as="c" t-key="c.id">
                            <div class="o369-row" t-att-class="{ 'o369-active': c.id === state.selectedId }" t-on-click="() => this.select(c)">
                                <div class="o369-avatar">
                                    <img t-if="c.avatar_url" t-att-src="c.avatar_url"/>
                                    <span t-else="" t-esc="initials(c.title)"/>
                                    <span class="o369-onlinedot" t-if="c.online and !c.is_group" title="Online"/>
                                </div>
                                <div class="o369-rowmain">
                                    <div class="o369-rowtop">
                                        <span class="o369-title"><t t-esc="c.title"/></span>
                                        <span class="o369-time">
                                            <i t-if="c.muted" class="fa fa-bell-slash-o o369-mutedicon"/>
                                            <t t-esc="fmtRowTime(c.last_at)"/>
                                        </span>
                                    </div>
                                    <div class="o369-rowbot">
                                        <span class="o369-prev" t-if="draftFor(c.id)"><span class="o369-draft">Draft:</span> <t t-esc="draftFor(c.id)"/></span>
                                        <span class="o369-prev" t-else="" t-esc="c.last_preview"/>
                                        <span class="o369-rowicons">
                                            <i t-if="c.favourite" class="fa fa-heart o369-favicon"/>
                                            <i t-if="c.pinned" class="fa fa-thumb-tack o369-pinicon"/>
                                            <span class="o369-unread" t-if="c.unread_count" t-esc="c.unread_count"/>
                                            <span class="o369-unreaddot" t-elif="c.manual_unread"/>
                                        </span>
                                    </div>
                                </div>
                                <button class="o369-rowcaret" t-on-click.stop="() => this.toggleRowMenu(c.id)" title="Menu"><i class="fa fa-chevron-down"/></button>
                                <div class="o369-rowmenu" t-if="state.rowMenuId === c.id">
                                    <button class="o369-menuitem" t-on-click.stop="() => this.archiveChat(c)"><i class="fa fa-archive"/> <t t-esc="c.archived ? 'Unarchive chat' : 'Archive chat'"/></button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.pinConversation(c)"><i class="fa fa-thumb-tack"/> <t t-esc="c.pinned ? 'Unpin chat' : 'Pin chat'"/></button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.markUnread(c)"><i class="fa fa-envelope-o"/> Mark as unread</button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.toggleFavourite(c)"><i class="fa fa-heart-o"/> <t t-esc="c.favourite ? 'Remove from favourites' : 'Add to favourites'"/></button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.muteChat(c)"><i class="fa fa-bell-slash-o"/> <t t-esc="c.muted ? 'Unmute' : 'Mute'"/></button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.openAddToList(c)"><i class="fa fa-folder-o"/> Add to list</button>
                                    <button class="o369-menuitem" t-on-click.stop="() => this.clearChatRow(c)"><i class="fa fa-eraser"/> Clear chat</button>
                                    <button class="o369-menuitem o369-danger" t-on-click.stop="() => this.leaveChatRow(c)"><i class="fa fa-trash"/> <t t-esc="c.is_group ? 'Leave group' : 'Delete chat'"/></button>
                                </div>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="filteredConversations().length === 0">No chats yet — tap the pencil to start one.</div>
                        <div class="o369-gsearch" t-if="state.search and state.globalMsgs.length">
                            <div class="o369-glabel">Messages</div>
                            <t t-foreach="state.globalMsgs" t-as="gm" t-key="gm.msg_id">
                                <button class="o369-grow" t-on-click="() => this.openGlobalHit(gm)">
                                    <div class="o369-gtop"><span class="o369-gtitle" t-esc="gm.conv_title"/><span class="o369-gtime" t-esc="fmtRowTime(gm.created)"/></div>
                                    <div class="o369-gsnip"><b t-esc="gm.author + ': '"/><t t-esc="gm.snippet"/></div>
                                </button>
                            </t>
                        </div>
                    </div>
                </t>

                <t t-else="">
                    <div class="o369-lhead">
                        <button class="o369-iconbtn" t-on-click="closeContacts" title="Back"><i class="fa fa-arrow-left"/></button>
                        <span class="o369-brand" t-esc="state.groupMode ? 'New group' : 'New chat'"/>
                        <button class="o369-iconbtn" t-if="!state.groupMode" t-on-click="() => (state.groupMode = true)" title="New group"><i class="fa fa-users"/></button>
                    </div>
                    <div class="o369-search" t-if="state.groupMode">
                        <i class="fa fa-tag"/>
                        <input type="text" placeholder="Group name" t-model="state.groupName"/>
                    </div>
                    <div class="o369-search">
                        <i class="fa fa-search"/>
                        <input type="text" placeholder="Search name or number" t-model="state.contactSearch"/>
                    </div>
                    <div class="o369-list">
                        <t t-if="!state.groupMode and !state.contactSearch">
                            <div class="o369-row" t-on-click="() => (state.groupMode = true)">
                                <div class="o369-avatar o369-actionavatar"><i class="fa fa-users"/></div>
                                <div class="o369-rowmain"><div class="o369-rowtop"><span class="o369-title">New group</span></div></div>
                            </div>
                            <div class="o369-row" t-on-click="openSelf">
                                <div class="o369-avatar o369-actionavatar o369-selfavatar"><i class="fa fa-bookmark-o"/></div>
                                <div class="o369-rowmain"><div class="o369-rowtop"><span class="o369-title">Message yourself</span></div><div class="o369-rowbot"><span class="o369-prev">Note to self</span></div></div>
                            </div>
                        </t>
                        <t t-foreach="filteredContacts()" t-as="u" t-key="u.id">
                            <div class="o369-row" t-on-click="() => this.onContactClick(u)">
                                <div class="o369-avatar">
                                    <img t-if="u.avatar_url" t-att-src="u.avatar_url"/>
                                    <span t-else="" t-esc="initials(u.name)"/>
                                </div>
                                <div class="o369-rowmain">
                                    <div class="o369-rowtop"><span class="o369-title" t-esc="u.name"/></div>
                                    <div class="o369-rowbot"><span class="o369-prev" t-esc="u.mobile"/></div>
                                </div>
                                <i t-if="state.groupMode" class="fa" t-att-class="state.groupSel.includes(u.id) ? 'fa-check-circle o369-checked' : 'fa-circle-o'"/>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="filteredContacts().length === 0">No people found.</div>
                    </div>
                    <div class="o369-groupbar" t-if="state.groupMode">
                        <button class="o369-createbtn" t-on-click="createGroup" t-att-disabled="!state.groupName || state.groupSel.length === 0">Create group (<t t-esc="state.groupSel.length"/>)</button>
                    </div>
                </t>
            </div>

            <!-- ================= RIGHT PANE ================= -->
            <div class="o369-right" t-if="state.pane === 'chats'" t-att-class="{ 'o369-hasconv': state.selectedId }">
                <t t-if="!state.selectedId">
                    <div class="o369-empty">
                        <img src="/chats_369/static/description/icon.png" class="o369-emptylogo"/>
                        <p>Select a chat to start messaging</p>
                    </div>
                </t>
                <t t-else="">
                    <div class="o369-rhead">
                        <div class="o369-avatar" style="cursor:pointer;" t-on-click="openContactInfo">
                            <img t-if="state.activeConv and state.activeConv.avatar_url" t-att-src="state.activeConv.avatar_url"/>
                            <span t-else="" t-esc="initials(currentTitle())"/>
                        </div>
                        <div class="o369-rheadtxt" style="cursor:pointer;" t-on-click="openContactInfo">
                            <div class="o369-rtitle" t-esc="currentTitle()"/>
                            <div class="o369-rsub" t-esc="currentSub()"/>
                        </div>
                        <span class="o369-rheadspace"/>
                        <button class="o369-hbtn" t-if="canCall()" t-on-click.stop="() => this.startCall(false)" title="Voice call"><i class="fa fa-phone"/></button>
                        <button class="o369-hbtn" t-if="canCall()" t-on-click.stop="() => this.startCall(true)" title="Video call"><i class="fa fa-video-camera"/></button>
                        <button class="o369-hbtn" t-on-click.stop="toggleSearch" title="Search"><i class="fa fa-search"/></button>
                        <span class="o369-hmenuwrap">
                            <button class="o369-hbtn" t-on-click.stop="toggleConvMenu" title="Menu"><i class="fa fa-ellipsis-v"/></button>
                            <div class="o369-hdrmenu" t-if="state.convMenu">
                                <button class="o369-menuitem" t-on-click.stop="openContactInfo"><i class="fa fa-info-circle"/> <t t-esc="currentIsGroup() ? 'Group info' : 'Contact info'"/></button>
                                <button class="o369-menuitem" t-on-click.stop="toggleSearch"><i class="fa fa-search"/> Search</button>
                                <button class="o369-menuitem" t-on-click.stop="exportChat"><i class="fa fa-download"/> Export chat</button>
                                <button class="o369-menuitem" t-on-click.stop="headerClear"><i class="fa fa-eraser"/> Clear chat</button>
                                <button class="o369-menuitem o369-danger" t-on-click.stop="headerLeave"><i class="fa fa-trash"/> <t t-esc="currentIsGroup() ? 'Exit group' : 'Delete chat'"/></button>
                            </div>
                        </span>
                    </div>

                    <div class="o369-searchbar" t-if="state.searchOpen">
                        <button class="o369-hbtn o369-hbtn-d" t-on-click.stop="toggleCalendar" title="Jump to date"><i class="fa fa-calendar"/></button>
                        <div class="o369-searchfield"><i class="fa fa-search"/><input type="text" placeholder="Search messages" t-model="state.searchQ" t-on-keyup="onSearchKey"/></div>
                        <span class="o369-searchcount" t-if="state.searchResults.length"><t t-esc="state.searchIdx + 1"/> / <t t-esc="state.searchResults.length"/></span>
                        <span class="o369-searchcount" t-elif="state.searchQ">0 found</span>
                        <button class="o369-hbtn o369-hbtn-d" t-on-click.stop="() => this.searchStep(-1)"><i class="fa fa-chevron-up"/></button>
                        <button class="o369-hbtn o369-hbtn-d" t-on-click.stop="() => this.searchStep(1)"><i class="fa fa-chevron-down"/></button>
                        <button class="o369-hbtn o369-hbtn-d" t-on-click.stop="closeSearch"><i class="fa fa-times"/></button>
                        <div class="o369-calpop" t-if="state.calOpen" t-on-click.stop="">
                            <div class="o369-calhead">
                                <button t-on-click.stop="() => this.calShift(-1)"><i class="fa fa-chevron-left"/></button>
                                <span t-esc="calTitle()"/>
                                <button t-att-disabled="calAtCurrentMonth()" t-att-class="{ 'o369-caldis': calAtCurrentMonth() }" t-on-click.stop="() => this.calShift(1)"><i class="fa fa-chevron-right"/></button>
                            </div>
                            <div class="o369-calgrid">
                                <span class="o369-caldow">Su</span><span class="o369-caldow">Mo</span><span class="o369-caldow">Tu</span><span class="o369-caldow">We</span><span class="o369-caldow">Th</span><span class="o369-caldow">Fr</span><span class="o369-caldow">Sa</span>
                                <t t-foreach="calDays()" t-as="d" t-key="d.key">
                                    <button class="o369-calday" t-att-class="{ 'o369-calempty': !d.day, 'o369-calfuture': d.future }" t-att-disabled="!d.day or d.future" t-on-click.stop="() => this.pickDate(d.iso)"><t t-esc="d.day"/></button>
                                </t>
                            </div>
                        </div>
                    </div>

                    <div class="o369-pinbar" t-if="state.pinnedMsgs.length">
                        <i class="fa fa-thumb-tack me-2"/>
                        <div class="o369-pinbartxt" t-on-click="openPins" title="View pinned messages">
                            <b t-esc="state.pinnedMsgs[0].author_name"/>: <t t-esc="state.pinnedMsgs[0].body"/>
                            <small class="o369-pinleft"> · <t t-esc="pinLabel(state.pinnedMsgs[0])"/></small>
                            <span class="o369-pinmore" t-if="state.pinnedMsgs.length > 1"> · +<t t-esc="state.pinnedMsgs.length - 1"/> more</span>
                        </div>
                        <button class="o369-pinunpin" t-on-click.stop="() => this.pinMessage(state.pinnedMsgs[0], false, 0)" title="Unpin"><i class="fa fa-times"/></button>
                    </div>

                    <div class="o369-msgs" t-ref="scroller" t-on-scroll="onMsgScroll">
                        <t t-foreach="groupedMessages()" t-as="it" t-key="it.id">
                            <div t-if="it.sep" class="o369-datesep"><span t-esc="it.label"/></div>
                            <t t-else="">
                                <t t-set="m" t-value="it.msg"/>
                                <div t-if="m.kind === 'system'" class="o369-sys"><span t-esc="m.body"/></div>
                                <div t-else="" class="o369-bubble" t-attf-id="o369m-{{m.id}}" t-att-class="(m.mine ? 'o369-out' : 'o369-in') + (state.flashId === m.id ? ' o369-flash' : '') + (state.selectMode and state.selectedIds.includes(m.id) ? ' o369-selected' : '')">
                                    <div t-if="state.selectMode and !m._pending" class="o369-seloverlay" t-on-click.stop="() => this.toggleSelect(m)">
                                        <span class="o369-selcheck" t-att-class="{ 'o369-selcheck-on': state.selectedIds.includes(m.id) }"><i class="fa fa-check"/></span>
                                    </div>
                                    <button class="o369-caret" t-if="!m.deleted" t-on-click.stop="(ev) => this.toggleMenu(m.id, ev)" title="More"><i class="fa fa-chevron-down"/></button>
                                    <div class="o369-msgmenu" t-if="state.openMenuId === m.id" t-attf-style="top:{{state.menuPos.top}}px; left:{{state.menuPos.left}}px;">
                                        <div class="o369-reactbar">
                                            <t t-foreach="REACTIONS" t-as="e" t-key="e">
                                                <button class="o369-reactbtn" t-on-click.stop="() => this.react(m, e)"><t t-esc="e"/></button>
                                            </t>
                                            <button class="o369-reactbtn o369-reactplus" t-on-click.stop="() => this.openEmojiPicker(m)" title="More emojis">+</button>
                                        </div>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.startReply(m)"><i class="fa fa-reply"/> Reply</button>
                                        <button class="o369-menuitem" t-if="!m.mine and currentIsGroup()" t-on-click.stop="() => this.replyPrivately(m)"><i class="fa fa-user-circle-o"/> Reply privately</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.copyMsg(m)"><i class="fa fa-files-o"/> Copy</button>
                                        <button class="o369-menuitem" t-if="!m._pending" t-on-click.stop="() => this.enterSelect(m)"><i class="fa fa-check-square-o"/> Select</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.openForward(m)"><i class="fa fa-share"/> Forward</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.menuPin(m)"><i class="fa fa-thumb-tack"/> <t t-esc="m.pinned ? 'Unpin' : 'Pin'"/></button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.toggleStar(m)"><i class="fa fa-star"/> <t t-esc="m.starred ? 'Unstar' : 'Star'"/></button>
                                        <button class="o369-menuitem" t-if="m.mine and !m.deleted and !m._pending" t-on-click.stop="() => this.openMessageInfo(m)"><i class="fa fa-info-circle"/> Info</button>
                                        <button class="o369-menuitem" t-if="canEditMsg(m)" t-on-click.stop="() => this.startEdit(m)"><i class="fa fa-pencil"/> Edit</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.deleteScope(m, 'me')"><i class="fa fa-trash-o"/> Delete for me</button>
                                        <button class="o369-menuitem o369-danger" t-if="m.mine" t-on-click.stop="() => this.deleteScope(m, 'everyone')"><i class="fa fa-trash"/> Delete for everyone</button>
                                    </div>

                                    <div class="o369-sender" t-if="!m.mine and currentIsGroup()" t-esc="m.author_name"/>
                                    <div class="o369-quote" t-if="m.quoted or m.reply_to_id">
                                        <span class="o369-qauthor" t-esc="m.reply_to_author"/>
                                        <span class="o369-qbody" t-esc="m.reply_to_body"/>
                                    </div>
                                    <div class="o369-fwdtag" t-if="m.forwarded and !m.deleted"><i class="fa fa-share o369-fwdicon"/> Forwarded</div>
                                    <t t-if="m.deleted">
                                        <span class="o369-deleted"><i class="fa fa-ban me-1"/>This message was deleted</span>
                                    </t>
                                    <t t-else="">
                                        <div t-if="m._uploading" class="o369-uploading">
                                            <img t-if="m._preview" class="o369-msgimg o369-upimg" t-att-src="m._preview"/>
                                            <div t-else="" class="o369-upvid"><i class="fa fa-film"/></div>
                                            <div class="o369-upoverlay">
                                                <div class="o369-upring" t-attf-style="background: conic-gradient(#fff {{m._progress}}%, rgba(255,255,255,.35) 0);"><span class="o369-uppct"><t t-esc="m._progress"/>%</span></div>
                                                <div class="o369-upmb"><t t-esc="m._upmb"/> / <t t-esc="m._totmb"/> MB</div>
                                            </div>
                                        </div>
                                        <img t-if="m.kind === 'image' and m.media_url and !m.view_once" class="o369-msgimg" t-att-src="m.media_url" t-on-click.stop="() => this.openMsgViewer(m)"/>
                                        <div t-if="m.kind === 'video' and m.media_url and !m.view_once" class="o369-msgvidwrap" t-on-click.stop="() => this.openMsgViewer(m)">
                                            <video class="o369-msgvid" t-att-src="m.media_url" preload="metadata"/>
                                            <span class="o369-vidplaybtn"><i class="fa fa-play"/></span>
                                        </div>
                                        <button t-if="m.view_once and (m.kind === 'image' or m.kind === 'video')" class="o369-viewonce" t-att-class="{ 'o369-viewonce-done': m.mine or m.viewed or !m.media_url }" t-on-click.stop="() => this.openViewOnce(m)">
                                            <span class="o369-vo-ico"><i class="fa fa-circle-o"/><span class="o369-vo-one">1</span></span>
                                            <span class="o369-vo-txt">
                                                <t t-if="m.mine"><t t-esc="m.kind === 'video' ? 'Video' : 'Photo'"/> · view once</t>
                                                <t t-elif="m.viewed or !m.media_url">Opened</t>
                                                <t t-else=""><t t-esc="m.kind === 'video' ? 'Video' : 'Photo'"/> · tap to view</t>
                                            </span>
                                        </button>
                                        <div t-if="m.kind === 'audio' and m.media_url" class="o369-voice">
                                            <button class="o369-voiceplay" t-on-click.stop="() => this.toggleAudio(m)"><i class="fa" t-att-class="state.playingId === m.id and !state.audioPaused ? 'fa-pause' : 'fa-play'"/></button>
                                            <div class="o369-voicebar" t-on-pointerdown.stop="(ev) => this.startSeek(m, ev)">
                                                <div class="o369-voicefill" t-attf-style="width:{{audioPct(m.id)}}%"/>
                                            </div>
                                            <button class="o369-voicespeed" t-if="state.playingId === m.id" t-on-click.stop="() => this.cycleSpeed()" t-esc="audioSpeedLabel()"/>
                                            <span class="o369-voicetime" t-esc="audioTimeLabel(m)"/>
                                        </div>
                                        <a t-if="m.kind === 'document' and m.media_url" class="o369-msgdoc" t-att-href="m.media_url" target="_blank"><i class="fa fa-file-o me-2"/><t t-esc="m.file_name or 'Document'"/></a>
                                        <t t-set="lc" t-value="linkCard(m)"/>
                                        <a t-if="lc" class="o369-linkcard" t-att-href="lc.url" target="_blank" rel="noopener noreferrer">
                                            <img t-if="lc.image" class="o369-linkimg" t-att-src="lc.image" loading="lazy"/>
                                            <span t-else="" class="o369-linkfav"><i class="fa fa-globe"/></span>
                                            <span class="o369-linkmeta">
                                                <span class="o369-linktitle" t-esc="lc.title or lc.url"/>
                                                <span class="o369-linkdesc" t-if="lc.desc" t-esc="lc.desc"/>
                                                <span class="o369-linkdomain" t-esc="linkDomain(lc.url)"/>
                                            </span>
                                        </a>
                                        <span t-if="m.body and state.searchOpen and state.searchQ" class="o369-btext" t-out="highlightBody(m.body)"/>
                                        <a t-elif="m.is_meet and m.body" class="o369-meetcard" t-att-href="m.body" target="_blank"><span class="o369-meetico"><i class="fa fa-video-camera"/></span><span class="o369-meetinfo"><span class="o369-meettitle">Google Meet</span><span class="o369-meetsub">Tap to join the meeting</span></span><span class="o369-meetjoin">Join</span></a>
                                        <div t-elif="m.kind === 'poll' and m.poll" class="o369-poll">
                                            <div class="o369-pollq"><i class="fa fa-bar-chart me-1"/><t t-esc="m.poll.question"/></div>
                                            <t t-foreach="m.poll.options" t-as="opt" t-key="opt.id">
                                                <button class="o369-pollopt" t-att-class="{ 'o369-pollopt-mine': opt.mine }" t-on-click.stop="() => this.votePoll(m, opt)">
                                                    <span class="o369-pollbar" t-attf-style="width:{{pollPct(m.poll, opt)}}%"/>
                                                    <span class="o369-polltext"><i class="fa" t-att-class="opt.mine ? 'fa-check-circle' : 'fa-circle-o'"/> <t t-esc="opt.text"/></span>
                                                    <span class="o369-pollcount" t-esc="opt.votes"/>
                                                </button>
                                            </t>
                                            <div class="o369-polltotal"><t t-esc="m.poll.total"/> <t t-esc="m.poll.total === 1 ? 'vote' : 'votes'"/><t t-if="m.poll.multi"> · Multiple answers</t></div>
                                        </div>
                                        <span t-elif="m.body" class="o369-btext" t-out="linkifyBody(m.body)"/>
                                    </t>
                                    <div class="o369-reacts" t-if="m.reactions.length">
                                        <t t-foreach="m.reactions" t-as="rx" t-key="rx.emoji">
                                            <span class="o369-react" t-att-class="{ 'o369-react-mine': rx.mine }" t-on-click.stop="() => this.react(m, rx.emoji)"><t t-esc="rx.emoji"/> <t t-esc="rx.count"/></span>
                                        </t>
                                    </div>
                                    <span class="o369-btime">
                                        <i t-if="m.starred" class="fa fa-star o369-starmark me-1"/>
                                        <i t-if="m.pinned" class="fa fa-thumb-tack o369-pinmark me-1"/>
                                        <small t-if="m.edited" class="o369-edited">edited</small>
                                        <t t-esc="fmtTime(m.created)"/>
                                        <span t-if="m.mine and !m.deleted" class="o369-ticks ms-1" t-att-class="m._pending ? 'o369-tick-pending' : ('o369-tick-' + (m.status or 'sent'))">
                                            <i t-if="m._pending" class="fa fa-clock-o"/>
                                            <t t-else=""><i class="fa fa-check o369-tick1"/><i class="fa fa-check o369-tick2"/></t>
                                        </span>
                                    </span>
                                </div>
                            </t>
                        </t>
                        <div class="o369-hint" t-if="state.messages.length === 0">No messages yet — say hi 👋</div>
                    </div>

                    <button class="o369-jumpbtm" t-if="state.showJumpBottom" t-on-click="jumpToBottom" title="Jump to latest"><i class="fa fa-chevron-down"/></button>
                    <div class="o369-replybar" t-if="state.editing">
                        <div class="o369-replyinfo"><b>Editing message</b><span>Change the text and press send</span></div>
                        <button class="o369-iconbtn o369-replyx" t-on-click="cancelEdit" title="Cancel"><i class="fa fa-times"/></button>
                    </div>
                    <div class="o369-replybar" t-elif="state.replyTo">
                        <div class="o369-replyinfo"><b t-esc="state.replyTo.author"/><small t-if="state.replyTo.external" class="o369-replyext"> · private reply</small><span t-esc="state.replyTo.body"/></div>
                        <button class="o369-iconbtn o369-replyx" t-on-click="cancelReply" title="Cancel"><i class="fa fa-times"/></button>
                    </div>
                    <!-- WhatsApp-style recording bar: delete . red dot . timer . waveform . pause . send -->
                    <div class="o369-recbar" t-if="state.recording">
                        <button class="o369-recdel" t-on-click="cancelRecording" title="Delete"><i class="fa fa-trash"/></button>
                        <span class="o369-recdot"/>
                        <span class="o369-rectime" t-esc="recTimeLabel()"/>
                        <div class="o369-recwave" t-att-class="{ 'o369-recpaused': state.recPaused }">
                            <t t-foreach="[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]" t-as="b" t-key="b"><span/></t>
                        </div>
                        <button class="o369-recpause" t-on-click="toggleRecPause" t-att-title="state.recPaused ? 'Resume' : 'Pause'"><i class="fa" t-att-class="state.recPaused ? 'fa-play' : 'fa-pause'"/></button>
                        <button class="o369-recsend" t-on-click="stopRecording" title="Send"><i class="fa fa-paper-plane"/></button>
                        <input type="file" t-ref="fileinput" style="display:none" t-on-change="onFileChosen"/>
                    </div>
                    <div class="o369-mentionbox" t-if="state.mentionOpen">
                        <t t-foreach="state.mentionMatches" t-as="mm" t-key="mm.id">
                            <button class="o369-mentionitem" t-att-class="{ 'o369-mentionitem-on': mm_index === state.mentionIdx }" t-on-click.stop="() => this.mentionPick(mm)">
                                <span class="o369-mentionav" t-att-class="{ 'o369-mentionav-all': mm.id === 'all' }" t-esc="mm.id === 'all' ? '@' : initials(mm.name)"/>
                                <span class="o369-mentionname" t-esc="mm.label || mm.name"/>
                            </button>
                        </t>
                    </div>
                    <div class="o369-complink" t-if="state.composerLink and !state.composerLinkHidden">
                        <img t-if="state.composerLink.image" class="o369-complinkimg" t-att-src="state.composerLink.image"/>
                        <div class="o369-complinkmeta">
                            <div class="o369-complinktitle" t-esc="state.composerLink.title or state.composerLink.url"/>
                            <div class="o369-complinkurl" t-if="state.composerLink.desc" t-esc="state.composerLink.desc"/>
                            <div class="o369-complinkdomain" t-esc="linkDomain(state.composerLink.url)"/>
                        </div>
                        <button class="o369-complinkx" t-on-click="() => (state.composerLinkHidden = true)" title="Remove preview"><i class="fa fa-times"/></button>
                    </div>
                    <div class="o369-monitorbar" t-if="state.activeConv and state.activeConv.oversight">
                        <i class="fa fa-eye"/> Monitoring (read-only) — you are not a member of this chat
                    </div>
                    <div class="o369-blockbar" t-if="state.activeConv and state.activeConv.blocked_by_me and !(state.activeConv and state.activeConv.oversight)">
                        <span><i class="fa fa-ban me-1"/> You blocked this contact.</span>
                        <button class="o369-blockunbtn" t-on-click="unblockFromBar">Unblock</button>
                    </div>
                    <div class="o369-selbar" t-if="state.selectMode">
                        <button class="o369-selx" t-on-click="exitSelect" title="Cancel"><i class="fa fa-times"/></button>
                        <span class="o369-selcount"><t t-esc="state.selectedIds.length"/> selected</span>
                        <span class="o369-selactions">
                            <button t-att-disabled="!state.selectedIds.length" t-on-click="bulkStar" title="Star"><i class="fa fa-star"/></button>
                            <button t-att-disabled="!state.selectedIds.length" t-on-click="bulkForward" title="Forward"><i class="fa fa-share"/></button>
                            <button t-att-disabled="!state.selectedIds.length" t-on-click="bulkDelete" title="Delete for me"><i class="fa fa-trash"/></button>
                        </span>
                    </div>
                    <div class="o369-input" t-if="!state.selectMode and !state.recording and !(state.activeConv and state.activeConv.oversight) and !(state.activeConv and state.activeConv.blocked_by_me)">
                        <span class="o369-emojiwrap">
                            <button class="o369-emojiopen" t-on-click.stop="toggleComposerEmoji" title="Emoji"><i class="fa fa-smile-o"/></button>
                            <div class="o369-emojipop" t-if="state.composerEmojiOpen" t-on-click.stop="">
                                <div class="o369-emojipopgrid">
                                    <t t-foreach="EMOJIS" t-as="e" t-key="e"><button class="o369-emojibtn" t-on-click.stop="() => this.insertEmoji(e)"><t t-esc="e"/></button></t>
                                </div>
                            </div>
                        </span>
                        <span class="o369-attachwrap">
                            <button class="o369-attachbtn" t-on-click.stop="toggleAttach" title="Attach"><i class="fa fa-plus"/></button>
                            <div class="o369-attachmenu" t-if="state.attachMenu">
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('document')"><i class="fa fa-file-o"/> Document</button>
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('image')"><i class="fa fa-picture-o"/> Photos &amp; videos</button>
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('audio')"><i class="fa fa-headphones"/> Audio</button>
                                <button class="o369-menuitem" t-if="currentIsGroup()" t-on-click.stop="openPollCreate"><i class="fa fa-bar-chart"/> Poll</button>
                                <button class="o369-menuitem" t-if="state.gmeet.connected" t-on-click.stop="startMeet"><i class="fa fa-video-camera"/> Video meeting</button>
                            </div>
                        </span>
                        <input type="text" t-ref="msgbox" placeholder="Type a message" t-att-value="state.draft" t-on-input="onDraftInput" t-on-keydown="onKeydown"/>
                        <button class="o369-send" t-on-click="micOrSend" t-att-title="state.draft ? 'Send' : 'Record voice'">
                            <i class="fa" t-att-class="state.draft ? 'fa-paper-plane' : 'fa-microphone'"/>
                        </button>
                        <input type="file" t-ref="fileinput" style="display:none" t-on-change="onFileChosen"/>
                    </div>
                </t>
            </div>

            <!-- ================= MEDIA (all chats) ================= -->
            <div class="o369-pane o369-mediapane" t-if="state.pane === 'media'">
                <div class="o369-panehead"><div class="o369-panehc"><span class="o369-panetitle">Media</span><span class="o369-panesub">Media from all chats</span></div></div>
                <div class="o369-mediatabs">
                    <button t-att-class="{ 'o369-mtab-on': state.mediaAllTab === 'media' }" t-on-click="() => this.setAllMediaTab('media')">Media</button>
                    <button t-att-class="{ 'o369-mtab-on': state.mediaAllTab === 'docs' }" t-on-click="() => this.setAllMediaTab('docs')">Docs</button>
                    <button t-att-class="{ 'o369-mtab-on': state.mediaAllTab === 'links' }" t-on-click="() => this.setAllMediaTab('links')">Links</button>
                </div>
                <div class="o369-mediabody">
                    <div t-if="state.mediaAllBusy" class="o369-hint">Loading…</div>
                    <div t-elif="!state.mediaAllItems.length" class="o369-hint">Nothing here yet</div>
                    <t t-else="">
                        <t t-foreach="groupedAllMedia()" t-as="g" t-key="g.label">
                            <div class="o369-mediamonth" t-esc="g.label"/>
                            <div class="o369-mediagrid" t-if="state.mediaAllTab === 'media'">
                                <div class="o369-mediacell" t-foreach="g.items" t-as="it" t-key="it.id" t-on-click="() => this.openMediaViewer(it)">
                                    <img t-if="it.kind === 'image'" t-att-src="it.url" loading="lazy"/>
                                    <t t-else=""><video class="o369-mediavidthumb" t-att-src="it.url" preload="metadata" muted="muted"/><span class="o369-vidplay"><i class="fa fa-play"/></span></t>
                                    <span t-if="it.duration" class="o369-viddur" t-esc="fmtDur(it.duration)"/>
                                    <span class="o369-mediachat" t-esc="it.chat"/>
                                </div>
                            </div>
                            <div class="o369-doclist" t-elif="state.mediaAllTab === 'docs'">
                                <a class="o369-docrow" t-foreach="g.items" t-as="it" t-key="it.id" t-att-href="it.url + '?dl=1'" t-att-download="it.name">
                                    <i class="fa o369-docic" t-att-class="it.kind === 'audio' ? 'fa-music' : 'fa-file-o'"/>
                                    <span class="o369-docmeta"><span class="o369-docname" t-esc="it.name"/><span class="o369-docchat"><t t-esc="it.chat"/> &#183; <t t-esc="fmtInfoTime(it.created)"/></span></span>
                                    <i class="fa fa-download o369-docdl"/>
                                </a>
                            </div>
                            <div class="o369-doclist" t-else="">
                                <a class="o369-docrow" t-foreach="g.items" t-as="it" t-key="it.id" t-att-href="it.url" target="_blank">
                                    <div class="o369-linkico"><i class="fa fa-link"/></div>
                                    <span class="o369-docmeta"><span class="o369-docname o369-linkurl" t-esc="it.url"/><span class="o369-docchat"><t t-esc="it.chat"/> &#183; <t t-esc="fmtInfoTime(it.created)"/></span></span>
                                </a>
                            </div>
                        </t>
                    </t>
                </div>
            </div>

            <!-- ================= CALLS ================= -->
            <div class="o369-pane o369-callspane" t-if="state.pane === 'calls'">
                <div class="o369-panehead">
                    <div class="o369-panehc"><span class="o369-panetitle">Calls</span><span class="o369-panesub">Favourites, upcoming &amp; recent</span></div>
                    <button class="o369-iconbtn o369-schedbtn" t-on-click="openSchedule" title="Schedule a call"><i class="fa fa-calendar-plus-o"/></button>
                </div>
                <div class="o369-list">
                    <t t-if="state.calls.favorites.length">
                        <div class="o369-callsect">Favourites</div>
                        <t t-foreach="state.calls.favorites" t-as="fv" t-key="fv.conversation_id">
                            <div class="o369-row" t-on-click="() => this.openCallChatId(fv.conversation_id, fv.name, fv.avatar)">
                                <div class="o369-avatar"><img t-if="fv.avatar" t-att-src="fv.avatar"/><span t-else="" t-esc="initials(fv.name)"/></div>
                                <div class="o369-rowmain"><div class="o369-rowtop"><span class="o369-title" t-esc="fv.name"/></div></div>
                                <button class="o369-callbackbtn" t-on-click.stop="() => this.quickCall(fv, false)" title="Voice call"><i class="fa fa-phone"/></button>
                                <button class="o369-callbackbtn" t-on-click.stop="() => this.quickCall(fv, true)" title="Video call"><i class="fa fa-video-camera"/></button>
                            </div>
                        </t>
                    </t>
                    <t t-if="state.calls.upcoming.length">
                        <div class="o369-callsect">Upcoming</div>
                        <t t-foreach="state.calls.upcoming" t-as="up" t-key="up.id">
                            <div class="o369-row">
                                <div class="o369-avatar o369-actionavatar"><i class="fa fa-calendar"/></div>
                                <div class="o369-rowmain">
                                    <div class="o369-rowtop"><span class="o369-title" t-esc="up.title"/><span class="o369-time" t-esc="fmtWhen(up.when)"/></div>
                                    <div class="o369-rowbot"><span class="o369-prev"><i class="fa" t-att-class="up.video ? 'fa-video-camera' : 'fa-phone'"/> <t t-esc="up.mine ? 'You scheduled' : up.organizer"/></span></div>
                                </div>
                                <button class="o369-callbackbtn" t-if="up.conversation_id" t-on-click.stop="() => this.startScheduled(up)" title="Start now"><i class="fa fa-phone"/></button>
                                <button class="o369-callbackbtn o369-schedcancel" t-if="up.mine" t-on-click.stop="() => this.cancelSchedule(up)" title="Cancel"><i class="fa fa-times"/></button>
                            </div>
                        </t>
                    </t>
                    <div class="o369-callsect">Recent</div>
                    <t t-foreach="state.calls.recent" t-as="cl" t-key="cl.id">
                        <div class="o369-row" t-on-click="() => this.openCallChatId(cl.conversation_id, cl.name, cl.avatar)">
                            <div class="o369-avatar"><img t-if="cl.avatar" t-att-src="cl.avatar"/><span t-else="" t-esc="initials(cl.name)"/></div>
                            <div class="o369-rowmain">
                                <div class="o369-rowtop"><span class="o369-title" t-att-class="{ 'o369-callmissed': cl.missed }" t-esc="cl.name"/><span class="o369-time" t-esc="fmtRowTime(cl.created)"/></div>
                                <div class="o369-rowbot"><span class="o369-prev o369-callmeta2">
                                    <i class="fa" t-att-class="cl.missed ? 'fa-arrow-down o369-callic-missed' : (cl.outgoing ? 'fa-arrow-up o369-callic-out' : 'fa-arrow-down o369-callic-in')"/>
                                    <t t-esc="cl.missed ? 'Missed' : (cl.outgoing ? 'Outgoing' : 'Incoming')"/><t t-if="!cl.missed and cl.duration"> · <t t-esc="fmtCallDur(cl.duration)"/></t>
                                </span></div>
                            </div>
                            <button class="o369-callbackbtn" t-on-click.stop="() => this.callBack(cl)" title="Call back"><i class="fa" t-att-class="cl.video ? 'fa-video-camera' : 'fa-phone'"/></button>
                        </div>
                    </t>
                    <div class="o369-hint" t-if="!state.calls.recent.length and !state.calls.favorites.length and !state.calls.upcoming.length">No calls yet — start one from any chat.</div>
                </div>
            </div>

            <!-- ================= PROFILE / SETTINGS ================= -->
            <div class="o369-pane o369-settingspane" t-if="state.pane === 'profile'">
                <t t-if="state.settingsView === 'menu'">
                    <div class="o369-panehead"><span class="o369-panetitle">Settings</span></div>
                    <div class="o369-setbody">
                        <div class="o369-setprofile" t-on-click="() => this.settingsGo('profile')">
                            <div class="o369-avatar o369-avatarbig"><img t-if="state.me and state.me.avatar_url" t-att-src="state.me.avatar_url"/><span t-else="" t-esc="initials(state.me and state.me.name)"/></div>
                            <div class="o369-setpinfo"><div class="o369-setpname" t-esc="state.me and state.me.name"/><div class="o369-setpabout" t-esc="(state.me and state.me.about) or 'Available'"/></div>
                            <i class="fa fa-angle-right o369-setchev"/>
                        </div>
                        <button class="o369-setrow" t-on-click="() => this.settingsGo('profile')"><i class="fa fa-user-o"/><span>Profile</span><i class="fa fa-angle-right o369-setchev"/></button>
                        <button class="o369-setrow" t-on-click="() => this.settingsGo('privacy')"><i class="fa fa-lock"/><span>Privacy</span><i class="fa fa-angle-right o369-setchev"/></button>
                        <button class="o369-setrow" t-on-click="() => this.settingsGo('notif')"><i class="fa fa-bell-o"/><span>Notifications</span><i class="fa fa-angle-right o369-setchev"/></button>
                        <button class="o369-setrow" t-on-click="() => this.settingsGo('theme')"><i class="fa fa-paint-brush"/><span>Theme</span><i class="fa fa-angle-right o369-setchev"/></button>
                        <button class="o369-setrow" t-if="state.gmeet.is_admin" t-on-click="openGmeetSettings"><i class="fa fa-video-camera"/><span>Google Meet</span><i class="fa fa-angle-right o369-setchev"/></button>
                        <button class="o369-setrow o369-setlogout" t-on-click="logout"><i class="fa fa-sign-out"/><span>Log out</span></button>
                    </div>
                </t>
                <t t-elif="state.settingsView === 'profile'">
                    <div class="o369-panehead"><button class="o369-backbtn" t-on-click="() => this.settingsGo('menu')"><i class="fa fa-arrow-left"/></button><span class="o369-panetitle">Profile</span></div>
                    <div class="o369-setbody" t-if="state.me">
                        <div class="o369-profilehero">
                            <button class="o369-avataredit" t-on-click="pickAvatar" title="Change photo">
                                <span class="o369-avatar o369-avatarxl"><img t-if="state.me.avatar_url" t-att-src="state.me.avatar_url"/><span t-else="" t-esc="initials(state.me.name)"/></span>
                                <span class="o369-avatarcam"><i class="fa fa-camera"/></span>
                            </button>
                            <input type="file" accept="image/*" t-ref="avatarinput" style="display:none" t-on-change="onAvatarChosen"/>
                        </div>
                        <div class="o369-setfield">
                            <div class="o369-setflabel">Name</div>
                            <div class="o369-setfedit" t-if="state.profileEdit.field === 'name'"><input t-model="state.profileEdit.val"/><button t-on-click="() => this.saveProfileField('name', state.profileEdit.val)"><i class="fa fa-check"/></button></div>
                            <div class="o369-setfval" t-else=""><span t-esc="state.me.name"/><i class="fa fa-pencil" t-on-click="() => this.startProfileEdit('name')"/></div>
                        </div>
                        <div class="o369-setfield">
                            <div class="o369-setflabel">About</div>
                            <div class="o369-setfedit" t-if="state.profileEdit.field === 'about'"><input t-model="state.profileEdit.val"/><button t-on-click="() => this.saveProfileField('about', state.profileEdit.val)"><i class="fa fa-check"/></button></div>
                            <div class="o369-setfval" t-else=""><span t-esc="state.me.about or 'Available'"/><i class="fa fa-pencil" t-on-click="() => this.startProfileEdit('about')"/></div>
                            <div class="o369-aboutpresets" t-if="state.profileEdit.field === 'about'">
                                <t t-foreach="ABOUT_PRESETS" t-as="ap" t-key="ap">
                                    <button class="o369-aboutopt" t-on-click="() => this.saveProfileField('about', ap)"><span t-esc="ap"/><i class="fa fa-check o369-optck" t-if="state.me.about === ap"/></button>
                                </t>
                            </div>
                        </div>
                        <div class="o369-setfield">
                            <div class="o369-setflabel">Phone</div>
                            <div class="o369-setfval"><span t-esc="state.me.mobile or '—'"/><button class="o369-copybtn" t-if="state.me.mobile" t-on-click="copyMyMobile" title="Copy number"><i class="fa fa-copy"/></button></div>
                        </div>
                    </div>
                </t>
                <t t-elif="state.settingsView === 'privacy'">
                    <div class="o369-panehead"><button class="o369-backbtn" t-on-click="() => this.settingsGo('menu')"><i class="fa fa-arrow-left"/></button><span class="o369-panetitle">Privacy</span></div>
                    <div class="o369-setbody" t-if="state.me">
                        <div class="o369-setsecttitle">Last seen</div>
                        <button class="o369-optrow" t-on-click="() => this.setPrivacyField('last_seen_privacy','everyone')"><span>Everyone</span><i class="fa fa-check o369-optck" t-if="state.me.last_seen_privacy === 'everyone'"/></button>
                        <button class="o369-optrow" t-on-click="() => this.setPrivacyField('last_seen_privacy','contacts')"><span>My contacts</span><i class="fa fa-check o369-optck" t-if="state.me.last_seen_privacy === 'contacts'"/></button>
                        <button class="o369-optrow" t-on-click="() => this.setPrivacyField('last_seen_privacy','nobody')"><span>Nobody</span><i class="fa fa-check o369-optck" t-if="state.me.last_seen_privacy === 'nobody'"/></button>
                        <div class="o369-setsecttitle">Online</div>
                        <button class="o369-optrow" t-on-click="() => this.setPrivacyField('online_privacy','everyone')"><span>Everyone</span><i class="fa fa-check o369-optck" t-if="state.me.online_privacy === 'everyone'"/></button>
                        <button class="o369-optrow" t-on-click="() => this.setPrivacyField('online_privacy','same')"><span>Same as last seen</span><i class="fa fa-check o369-optck" t-if="state.me.online_privacy === 'same'"/></button>
                        <div class="o369-toggrow"><div class="o369-toginfo"><div class="o369-toglabel">Read receipts</div><div class="o369-toghint">If off, you won't send or see blue read ticks. Groups always show them.</div></div><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.me.read_receipts }" t-on-click="() => this.toggleSetting('read_receipts')"><span/></button></div>
                        <div class="o369-privhint">If you don't share your last seen, you won't be able to see anyone else's.</div>
                    </div>
                </t>
                <t t-elif="state.settingsView === 'gmeet'">
                    <div class="o369-panehead"><button class="o369-backbtn" t-on-click="() => this.settingsGo('menu')"><i class="fa fa-arrow-left"/></button><span class="o369-panetitle">Google Meet</span></div>
                    <div class="o369-setbody o369-gmbody">
                        <div class="o369-gmstatus">
                            <div class="o369-gmstatus-l">
                                <div class="o369-gmicon"><i class="fa fa-video-camera"/></div>
                                <div><div class="o369-gmstatus-t">Google Meet</div><div class="o369-gmstatus-s">Auto-create meeting links in chat</div></div>
                            </div>
                            <span class="o369-gmpill" t-att-class="{ 'o369-gmpill-on': state.gmeet.connected }" t-esc="state.gmeet.connected ? 'Connected ✓' : 'Not connected'"/>
                        </div>

                        <div class="o369-gmsectitle">Google credentials</div>
                        <div class="o369-gmfield"><label>Client ID</label><input t-model="state.gmeetForm.client_id" placeholder="xxxxx.apps.googleusercontent.com"/></div>
                        <div class="o369-gmfield"><label>Client Secret</label><input type="password" t-model="state.gmeetForm.client_secret" placeholder="(hidden — leave blank to keep)"/></div>
                        <div class="o369-gmfield"><label>Redirect URI <span class="o369-gmhint">— paste this into Google</span></label><div class="o369-gmuri"><span t-esc="gmeetRedirect()"/><i class="fa fa-copy" t-on-click="copyRedirect" title="Copy"/></div></div>
                        <div class="o369-gmfield"><label>Server / base URL <span class="o369-gmhint">(leave blank = auto)</span></label><input t-model="state.gmeetForm.base_url" placeholder="https://chat.yourcompany.com"/></div>

                        <div class="o369-gmsectitle">Behaviour</div>
                        <div class="o369-gmfield"><label>Trigger words <span class="o369-gmhint">(comma-separated)</span></label><input t-model="state.gmeetForm.triggers" placeholder="meet, send link, gmeet"/></div>
                        <div class="o369-gmrow"><label>Where it works</label><select t-model="state.gmeetForm.scope"><option value="both">Groups &amp; 1:1</option><option value="groups">Groups only</option><option value="direct">1:1 only</option></select></div>
                        <div class="o369-gmrow"><label>Admins only</label><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.gmeetForm.admin_only }" t-on-click="() => (state.gmeetForm.admin_only = !state.gmeetForm.admin_only)"><span/></button></div>

                        <div class="o369-gmbtns">
                            <button class="o369-gmsave" t-att-disabled="!gmeetDirty()" t-att-class="{ 'o369-gmsave-off': !gmeetDirty() }" t-on-click="saveGmeet">Save settings</button>
                            <button class="o369-gmconnect" t-on-click="connectGmeet"><i class="fa fa-google"/> <span t-esc="state.gmeet.connected ? 'Reconnect Google account' : 'Connect Google account'"/></button>
                        </div>

                        <div class="o369-gmhelp">
                            <button class="o369-gmhelp-head" t-on-click="() => (state.gmeetHelpOpen = !state.gmeetHelpOpen)">
                                <span><i class="fa fa-lightbulb-o"/> How to set this up (first time)</span>
                                <i class="fa" t-att-class="state.gmeetHelpOpen ? 'fa-angle-up' : 'fa-angle-down'"/>
                            </button>
                            <div class="o369-gmhelp-body" t-if="state.gmeetHelpOpen">
                                <ol>
                                    <li>Go to <b>console.cloud.google.com</b> → create a project (any name).</li>
                                    <li>Search <b>Google Calendar API</b> → click <b>Enable</b>.</li>
                                    <li>Open <b>OAuth consent screen</b> → <b>External</b> → add your host Gmail as a test user (or publish the app).</li>
                                    <li>Open <b>Credentials → Create OAuth client ID → Web application</b>.</li>
                                    <li>In <b>Authorized redirect URIs</b>, paste the <b>Redirect URI</b> shown above.</li>
                                    <li>Copy the <b>Client ID</b> + <b>Client Secret</b> into the boxes here → <b>Save settings</b>.</li>
                                    <li>Click <b>Connect Google account</b> → sign in with your host Gmail → Allow.</li>
                                </ol>
                                <div class="o369-gmhelp-tip"><i class="fa fa-info-circle"/> Use <b>localhost</b> in the Redirect URI — Google does not allow plain IP addresses.</div>
                            </div>
                        </div>
                    </div>
                </t>
                <t t-elif="state.settingsView === 'theme'">
                    <div class="o369-panehead"><button class="o369-backbtn" t-on-click="() => this.settingsGo('menu')"><i class="fa fa-arrow-left"/></button><span class="o369-panetitle">Theme</span></div>
                    <div class="o369-setbody">
                        <div class="o369-setsecttitle">Display</div>
                        <button class="o369-optrow" t-on-click="() => this.setThemeMode('system')"><span>System default</span><i class="fa fa-check o369-optck" t-if="state.themeMode === 'system'"/></button>
                        <button class="o369-optrow" t-on-click="() => this.setThemeMode('light')"><span>Light</span><i class="fa fa-check o369-optck" t-if="state.themeMode === 'light'"/></button>
                        <button class="o369-optrow" t-on-click="() => this.setThemeMode('dark')"><span>Dark</span><i class="fa fa-check o369-optck" t-if="state.themeMode === 'dark'"/></button>
                        <div class="o369-setsecttitle" style="margin-top:16px">Accent colour</div>
                        <div class="o369-themegrid">
                            <t t-foreach="THEMES" t-as="th" t-key="th.id">
                                <button class="o369-themecard" t-att-class="{ 'o369-themecard-on': state.theme === th.id }" t-on-click="() => this.setTheme(th.id)">
                                    <span class="o369-themeswatch" t-attf-style="background: linear-gradient(135deg, {{th.a}}, {{th.b}});"><i class="fa fa-check o369-themeck" t-if="state.theme === th.id"/></span>
                                    <span class="o369-themename" t-esc="th.name"/>
                                </button>
                            </t>
                        </div>
                        <div class="o369-privhint">Your theme is saved on this device.</div>
                        <button class="o369-resetbtn" t-on-click="resetAppearance"><i class="fa fa-refresh me-1"/> Reset to default</button>
                    </div>
                </t>
                <t t-else="">
                    <div class="o369-panehead"><button class="o369-backbtn" t-on-click="() => this.settingsGo('menu')"><i class="fa fa-arrow-left"/></button><span class="o369-panetitle">Notifications</span></div>
                    <div class="o369-setbody" t-if="state.me">
                        <div class="o369-toggrow"><div class="o369-toglabel">Direct messages</div><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.me.notif_messages }" t-on-click="() => this.toggleSetting('notif_messages')"><span/></button></div>
                        <div class="o369-toggrow"><div class="o369-toglabel">Group messages</div><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.me.notif_groups }" t-on-click="() => this.toggleSetting('notif_groups')"><span/></button></div>
                        <div class="o369-toggrow"><div class="o369-toglabel">Sound</div><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.me.notif_sound }" t-on-click="() => this.toggleSetting('notif_sound')"><span/></button></div>
                        <div class="o369-toggrow"><div class="o369-toglabel">Show preview</div><button class="o369-switch" t-att-class="{ 'o369-switch-on': state.me.notif_preview }" t-on-click="() => this.toggleSetting('notif_preview')"><span/></button></div>
                        <button class="o369-bignbtn" t-on-click="enableBrowserNotifs"><i class="fa fa-bell me-1"/> Enable browser notifications</button>
                        <div class="o369-privhint">Shows desktop alerts like WhatsApp Web when a chat isn't open. Click above and allow it in the browser prompt.</div>
                    </div>
                </t>
            </div>

            <!-- Pin-duration picker -->
            <div class="o369-modal" t-if="state.pinPrompt" t-on-click.self="cancelPin">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-thumb-tack me-2"/>Pin message for…</div>
                    <button class="o369-modalopt" t-on-click="() => this.confirmPin(1)">1 day</button>
                    <button class="o369-modalopt" t-on-click="() => this.confirmPin(7)">7 days</button>
                    <button class="o369-modalopt" t-on-click="() => this.confirmPin(14)">14 days</button>
                    <button class="o369-modalopt" t-on-click="() => this.confirmPin(30)">30 days</button>
                    <button class="o369-modalcancel" t-on-click="cancelPin">Cancel</button>
                </div>
            </div>

            <!-- Pinned-messages list -->
            <div class="o369-modal" t-if="state.showPins" t-on-click.self="closePins">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-thumb-tack me-2"/>Pinned messages (<t t-esc="state.pinnedMsgs.length"/>)</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.pinnedMsgs" t-as="pm" t-key="pm.id">
                            <div class="o369-pinitem">
                                <div class="o369-pinitemtxt"><b t-esc="pm.author_name"/><span t-esc="pm.body"/><small class="o369-pinleft" t-esc="pinLabel(pm)"/></div>
                                <button class="o369-pinitemx" t-on-click="() => this.pinMessage(pm, false, 0)" title="Unpin"><i class="fa fa-times"/></button>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="state.pinnedMsgs.length === 0">No pinned messages.</div>
                    </div>
                    <button class="o369-modalcancel" t-on-click="closePins">Close</button>
                </div>
            </div>

            <!-- Forward picker -->
            <div class="o369-modal" t-if="state.forwardMsg" t-on-click.self="closeForward">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-share me-2"/>Forward to…</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.conversations" t-as="c" t-key="c.id">
                            <div class="o369-pinitem o369-fwdrow" t-on-click="() => this.doForward(c)">
                                <div class="o369-avatar o369-avatar-sm">
                                    <img t-if="c.avatar_url" t-att-src="c.avatar_url"/>
                                    <span t-else="" t-esc="initials(c.title)"/>
                                </div>
                                <div class="o369-pinitemtxt"><b t-esc="c.title"/></div>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="state.conversations.length === 0">No chats to forward to.</div>
                    </div>
                    <button class="o369-modalcancel" t-on-click="closeForward">Cancel</button>
                </div>
            </div>

            <!-- Mute duration -->
            <div class="o369-modal" t-if="state.muteConv" t-on-click.self="closeMute">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-bell-slash me-2"/>Mute notifications</div>
                    <button class="o369-modalopt" t-on-click="() => this.confirmMute(8)">8 hours</button>
                    <button class="o369-modalopt" t-on-click="() => this.confirmMute(168)">1 week</button>
                    <button class="o369-modalopt" t-on-click="() => this.confirmMute(0)">Always</button>
                    <button class="o369-modalcancel" t-on-click="closeMute">Cancel</button>
                </div>
            </div>

            <!-- Create new list -->
            <div class="o369-modal" t-if="state.showNewList" t-on-click.self="closeNewList">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-list-ul me-2"/>Create new list</div>
                    <input class="o369-listinput" placeholder="List name" t-model="state.newListName"/>
                    <div class="o369-listhint">Add chats to this list</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.conversations" t-as="c" t-key="c.id">
                            <div class="o369-pinitem o369-fwdrow" t-on-click="() => this.toggleNewListConv(c.id)">
                                <div class="o369-avatar o369-avatar-sm"><img t-if="c.avatar_url" t-att-src="c.avatar_url"/><span t-else="" t-esc="initials(c.title)"/></div>
                                <div class="o369-pinitemtxt"><b t-esc="c.title"/></div>
                                <i class="fa" t-att-class="state.newListSel.includes(c.id) ? 'fa-check-circle o369-checked' : 'fa-circle-o'"/>
                            </div>
                        </t>
                    </div>
                    <button class="o369-createbtn" t-on-click="createList" t-att-disabled="!state.newListName">Create list</button>
                    <button class="o369-modalcancel" t-on-click="closeNewList">Cancel</button>
                </div>
            </div>

            <!-- Add this chat to a list -->
            <div class="o369-modal" t-if="state.addToListConv" t-on-click.self="closeAddToList">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-folder-o me-2"/>Add to list</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.lists" t-as="l" t-key="l.id">
                            <div class="o369-pinitem o369-fwdrow" t-on-click="() => this.toggleListMembership(l)">
                                <div class="o369-pinitemtxt"><b><t t-esc="l.emoji"/> <t t-esc="l.name"/></b><small><t t-esc="l.count"/> chats</small></div>
                                <i class="fa" t-att-class="l.has ? 'fa-check-circle o369-checked' : 'fa-circle-o'"/>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="state.lists.length === 0">No lists yet — create one below.</div>
                    </div>
                    <button class="o369-createbtn" t-on-click="newListFromPicker">+ New list</button>
                    <button class="o369-modalcancel" t-on-click="closeAddToList">Done</button>
                </div>
            </div>

            <!-- Full emoji picker (reaction +) -->
            <div class="o369-modal" t-if="state.emojiPickerMsg" t-on-click.self="closeEmojiPicker">
                <div class="o369-modalcard o369-emojicard">
                    <div class="o369-modaltitle"><i class="fa fa-smile-o me-2"/>Pick a reaction</div>
                    <div class="o369-emojigrid">
                        <t t-foreach="EMOJIS" t-as="e" t-key="e"><button class="o369-emojibtn" t-on-click.stop="() => this.pickEmoji(e)"><t t-esc="e"/></button></t>
                    </div>
                    <button class="o369-modalcancel" t-on-click="closeEmojiPicker">Close</button>
                </div>
            </div>

            <!-- Disappearing messages timer -->
            <div class="o369-modal" t-if="state.disappearOpen" t-on-click.self="() => (state.disappearOpen = false)">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-clock-o me-2"/>Disappearing messages</div>
                    <div class="o369-disaphint">New messages in this chat will vanish after the time you pick. Everyone sees a note in the chat.</div>
                    <button class="o369-modalopt" t-on-click="() => this.setDisappear(0)">Off</button>
                    <button class="o369-modalopt" t-on-click="() => this.setDisappear(86400)">24 hours</button>
                    <button class="o369-modalopt" t-on-click="() => this.setDisappear(604800)">7 days</button>
                    <button class="o369-modalopt" t-on-click="() => this.setDisappear(7776000)">90 days</button>
                    <button class="o369-modalcancel" t-on-click="() => (state.disappearOpen = false)">Cancel</button>
                </div>
            </div>

            <!-- Create poll -->
            <div class="o369-modal" t-if="state.pollCreate" t-on-click.self="closePollCreate">
                <div class="o369-modalcard o369-pollcard">
                    <div class="o369-modaltitle"><i class="fa fa-bar-chart me-2"/>Create poll</div>
                    <input class="o369-listinput" placeholder="Ask a question" t-att-value="state.pollCreate.question" t-on-input="(ev) => (state.pollCreate.question = ev.target.value)"/>
                    <div class="o369-pollopts">
                        <t t-foreach="state.pollCreate.options" t-as="o" t-key="o_index">
                            <div class="o369-polloptrow">
                                <input class="o369-listinput" placeholder="Option" t-att-value="o" t-on-input="(ev) => this.setPollOption(o_index, ev.target.value)"/>
                                <button class="o369-polloptdel" t-if="state.pollCreate.options.length > 2" t-on-click.stop="() => this.removePollOption(o_index)"><i class="fa fa-times"/></button>
                            </div>
                        </t>
                    </div>
                    <button class="o369-polladd" t-if="state.pollCreate.options.length &lt; 12" t-on-click.stop="addPollOption"><i class="fa fa-plus"/> Add option</button>
                    <div class="o369-pollmulti" t-on-click="() => (state.pollCreate.multi = !state.pollCreate.multi)">
                        <span class="o369-switch" t-att-class="{ 'o369-switch-on': state.pollCreate.multi }"><span/></span>
                        <span>Allow multiple answers</span>
                    </div>
                    <button class="o369-createbtn" t-on-click="submitPoll" t-att-disabled="!state.pollCreate.question">Send poll</button>
                    <button class="o369-modalcancel" t-on-click="closePollCreate">Cancel</button>
                </div>
            </div>

            <!-- Starred messages -->
            <div class="o369-modal" t-if="state.showStarred" t-on-click.self="closeStarred">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-star me-2"/>Starred messages (<t t-esc="state.starredMsgs.length"/>)</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.starredMsgs" t-as="sm" t-key="sm.id">
                            <div class="o369-pinitem">
                                <div class="o369-pinitemtxt">
                                    <b t-esc="sm.conversation_title"/>
                                    <span><t t-esc="sm.author_name"/>: <t t-esc="sm.body"/></span>
                                    <small class="o369-pinleft" t-esc="fmtTime(sm.created)"/>
                                </div>
                                <button class="o369-pinitemx" t-on-click="() => this.unstarFromPanel(sm)" title="Unstar"><i class="fa fa-star"/></button>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="state.starredMsgs.length === 0">No starred messages.</div>
                    </div>
                    <button class="o369-modalcancel" t-on-click="closeStarred">Close</button>
                </div>
            </div>

            <!-- Contact / Group info drawer -->
            <div class="o369-drawer" t-if="state.infoOpen and state.contactInfo">
                <!-- ===== Feature 3: media / docs / links sub-view ===== -->
                <t t-if="state.mediaOpen">
                    <div class="o369-drawerhead">
                        <button class="o369-hbtn o369-hbtn-d" t-on-click="closeMedia"><i class="fa fa-arrow-left"/></button>
                        <span>Media, links &amp; docs</span>
                    </div>
                    <div class="o369-mediatabs">
                        <button t-att-class="{ 'o369-mtab-on': state.mediaTab === 'media' }" t-on-click="() => this.setMediaTab('media')">Media</button>
                        <button t-att-class="{ 'o369-mtab-on': state.mediaTab === 'docs' }" t-on-click="() => this.setMediaTab('docs')">Docs</button>
                        <button t-att-class="{ 'o369-mtab-on': state.mediaTab === 'links' }" t-on-click="() => this.setMediaTab('links')">Links</button>
                    </div>
                    <div class="o369-drawerbody">
                        <t t-foreach="groupedMedia()" t-as="grp" t-key="grp.label">
                            <div class="o369-monthhdr" t-esc="grp.label"/>
                            <div t-if="state.mediaTab === 'media'" class="o369-mediagrid">
                                <t t-foreach="grp.items" t-as="it" t-key="it.id">
                                    <div class="o369-mediacell">
                                        <img t-if="it.kind === 'image'" t-att-src="it.url" t-on-click="() => this.openLightbox(it.url)"/>
                                        <a t-else="" class="o369-mediacellicon" t-att-href="it.url" target="_blank"><i class="fa" t-att-class="it.kind === 'video' ? 'fa-play-circle' : 'fa-file-o'"/></a>
                                    </div>
                                </t>
                            </div>
                            <t t-else="">
                                <t t-foreach="grp.items" t-as="it" t-key="it.id">
                                    <a class="o369-doclink" t-att-href="it.url" target="_blank">
                                        <i class="fa" t-att-class="state.mediaTab === 'links' ? 'fa-link' : (it.kind === 'audio' ? 'fa-headphones' : 'fa-file-o')"/>
                                        <span class="o369-docname" t-esc="it.name"/>
                                        <i class="fa fa-download o369-docdl"/>
                                    </a>
                                </t>
                            </t>
                        </t>
                        <div class="o369-hint" t-if="state.mediaItems.length === 0">Nothing here yet.</div>
                    </div>
                </t>
                <!-- ===== Feature 4: group permissions sub-view ===== -->
                <t t-elif="state.permsOpen">
                    <div class="o369-drawerhead">
                        <button class="o369-hbtn o369-hbtn-d" t-on-click="closePerms"><i class="fa fa-arrow-left"/></button>
                        <span>Group permissions</span>
                    </div>
                    <div class="o369-drawerbody">
                        <div class="o369-drawersection">
                            <div class="o369-secttitle">Members can</div>
                            <t t-foreach="MEMBER_PERMS" t-as="p" t-key="p.field">
                                <div class="o369-permrow">
                                    <span t-esc="p.label"/>
                                    <span class="o369-toggle" t-att-class="{ 'o369-toggle-on': permOn(p.field) }" t-on-click="() => this.togglePerm(p.field)"><span class="o369-toggleknob"/></span>
                                </div>
                            </t>
                        </div>
                        <div class="o369-drawersection">
                            <div class="o369-secttitle">Admins can</div>
                            <div class="o369-permrow">
                                <span>Approve new members</span>
                                <span class="o369-toggle" t-att-class="{ 'o369-toggle-on': permOn('admin_approve') }" t-on-click="() => this.togglePerm('admin_approve')"><span class="o369-toggleknob"/></span>
                            </div>
                        </div>
                        <div class="o369-drawersection">
                            <button class="o369-drawaction" t-on-click="closePerms"><i class="fa fa-user-secret"/> Edit group admins <i class="fa fa-chevron-right o369-rowchev"/></button>
                        </div>
                    </div>
                </t>
                <!-- ===== main info view ===== -->
                <t t-else="">
                <div class="o369-drawerhead">
                    <button class="o369-hbtn o369-hbtn-d" t-on-click="closeContactInfo"><i class="fa fa-times"/></button>
                    <span t-esc="state.contactInfo.is_group ? 'Group info' : 'Contact info'"/>
                </div>
                <div class="o369-drawerbody">
                    <div class="o369-drawerprofile">
                        <div class="o369-avatarwrap">
                            <div class="o369-avatar o369-avatarbig"><img t-if="state.contactInfo.avatar_url" t-att-src="state.contactInfo.avatar_url"/><span t-else="" t-esc="initials(state.contactInfo.title)"/></div>
                            <button class="o369-cambadge" t-if="state.contactInfo.is_group and canEditInfo()" t-on-click="changeGroupPhoto" title="Change group photo"><i class="fa fa-camera"/></button>
                        </div>
                        <div class="o369-namerow">
                            <t t-if="state.contactInfo.is_group and state.nameEditing">
                                <input class="o369-nickinput" placeholder="Group name" t-model="state.groupNameEdit"/>
                                <button class="o369-savebtn" t-on-click="saveGroupName">Save</button>
                                <button class="o369-hbtn o369-hbtn-d" t-on-click="cancelNameEdit"><i class="fa fa-times"/></button>
                            </t>
                            <t t-else="">
                                <div class="o369-drawername" t-esc="state.contactInfo.title"/>
                                <button class="o369-editpencil" t-if="state.contactInfo.is_group and canEditInfo()" t-on-click="startNameEdit" title="Edit name"><i class="fa fa-pencil"/></button>
                            </t>
                        </div>
                        <div class="o369-drawersub" t-if="!state.contactInfo.is_group" t-esc="state.contactInfo.mobile"/>
                        <div class="o369-drawersub" t-if="state.contactInfo.is_group"><t t-esc="state.contactInfo.member_count"/> members</div>
                        <div class="o369-circlebtns" t-if="state.contactInfo.is_group">
                            <button class="o369-circlebtn" t-if="canAddMembers()" t-on-click="openAddMembers"><span class="o369-circleico"><i class="fa fa-user-plus"/></span><span class="o369-circlelbl">Add</span></button>
                            <button class="o369-circlebtn" t-if="canInvite()" t-on-click="openInvite"><span class="o369-circleico"><i class="fa fa-link"/></span><span class="o369-circlelbl">Invite</span></button>
                            <button class="o369-circlebtn" t-on-click="searchFromInfo"><span class="o369-circleico"><i class="fa fa-search"/></span><span class="o369-circlelbl">Search</span></button>
                        </div>
                    </div>
                    <div class="o369-drawersection" t-if="state.contactInfo.is_group">
                        <t t-if="state.descEditing">
                            <textarea class="o369-desctextarea" placeholder="Add group description" t-model="state.descDraft"/>
                            <div class="o369-descbtns">
                                <button class="o369-savebtn" t-on-click="saveDesc">Save</button>
                                <button class="o369-drawcancel" t-on-click="cancelDescEdit">Cancel</button>
                            </div>
                        </t>
                        <t t-else="">
                            <div class="o369-descrow" t-if="state.contactInfo.description" t-att-class="{ 'o369-descrow-edit': canEditInfo() }" t-on-click="startDescEdit">
                                <span class="o369-desctext" t-esc="state.contactInfo.description"/>
                                <i class="fa fa-pencil o369-descpencil" t-if="canEditInfo()"/>
                            </div>
                            <button class="o369-adddesc" t-elif="canEditInfo()" t-on-click="startDescEdit"><i class="fa fa-pencil"/> Add group description</button>
                            <div class="o369-drawersub" t-else="">No description</div>
                        </t>
                    </div>
                    <div class="o369-drawersection" t-if="!state.contactInfo.is_group and state.contactInfo.user_id">
                        <div class="o369-secttitle">Nickname (only you see this)</div>
                        <div class="o369-nickrow">
                            <input class="o369-nickinput" placeholder="Add a nickname" t-model="state.nickDraft"/>
                            <button class="o369-savebtn" t-on-click="saveNick">Save</button>
                        </div>
                    </div>
                    <div class="o369-drawersection">
                        <div class="o369-mediarow o369-mediarow-btn" t-on-click="openMedia"><i class="fa fa-picture-o me-2"/>Media, links &amp; docs <span class="o369-mediacount" t-esc="mediaTotal()"/><i class="fa fa-chevron-right o369-rowchev"/></div>
                        <div class="o369-mediastats"><span><t t-esc="state.contactInfo.media.photos"/> photos</span><span><t t-esc="state.contactInfo.media.videos"/> videos</span><span><t t-esc="state.contactInfo.media.docs"/> docs</span></div>
                    </div>
                    <div class="o369-drawersection">
                        <div class="o369-mediarow o369-mediarow-btn" t-on-click="openDisappear"><i class="fa fa-clock-o me-2"/>Disappearing messages <span class="o369-mediacount" t-esc="disappearLabel()"/><i class="fa fa-chevron-right o369-rowchev"/></div>
                        <div class="o369-mediastats" t-if="state.contactInfo.is_group and !state.contactInfo.is_admin">Only admins can change this.</div>
                    </div>
                    <div class="o369-drawersection">
                        <button class="o369-drawaction" t-on-click="openStarred"><i class="fa fa-star"/> Starred messages</button>
                        <button class="o369-drawaction" t-on-click="favFromInfo"><i class="fa fa-heart-o"/> <t t-esc="state.contactInfo.favourite ? 'Remove from favourites' : 'Add to favourites'"/></button>
                        <button class="o369-drawaction" t-on-click="addToListFromInfo"><i class="fa fa-folder-o"/> Add to list</button>
                    </div>
                    <div class="o369-drawersection" t-if="state.contactInfo.is_group and state.contactInfo.is_admin">
                        <button class="o369-drawaction" t-on-click="togglePerms"><i class="fa fa-lock"/> Group permissions <i class="fa fa-chevron-right o369-rowchev"/></button>
                    </div>
                    <div class="o369-drawersection" t-if="state.contactInfo.is_group">
                        <div class="o369-secttitle"><t t-esc="state.contactInfo.member_count"/> members</div>
                        <t t-foreach="state.contactInfo.members" t-as="mm" t-key="mm.id">
                            <div class="o369-memrow" style="cursor:pointer;" t-on-click="() => this.openMemberMenu(mm)">
                                <div class="o369-avatar o369-avatar-sm"><img t-if="mm.avatar_url" t-att-src="mm.avatar_url"/><span t-else="" t-esc="initials(mm.name)"/></div>
                                <div class="o369-memtxt"><b t-esc="mm.name"/><small t-esc="mm.mobile"/></div>
                                <span class="o369-adminbadge" t-if="mm.is_admin">Admin</span>
                            </div>
                        </t>
                    </div>
                    <div class="o369-drawersection">
                        <button class="o369-drawaction o369-danger" t-if="!state.contactInfo.is_group and state.contactInfo.user_id" t-on-click="toggleBlock"><i class="fa fa-ban"/> <t t-esc="state.contactInfo.blocked_by_me ? 'Unblock' : 'Block'"/> <t t-esc="state.contactInfo.name"/></button>
                        <button class="o369-drawaction o369-danger" t-on-click="headerClear"><i class="fa fa-eraser"/> Clear chat</button>
                        <button class="o369-drawaction o369-danger" t-on-click="headerLeave"><i class="fa fa-trash"/> <t t-esc="state.contactInfo.is_group ? 'Exit group' : 'Delete chat'"/></button>
                    </div>
                </div>
                </t>
            </div>

            <!-- Add members picker (Feature 2) -->
            <div class="o369-modal" t-if="state.addMembersOpen" t-on-click.self="closeAddMembers">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-user-plus me-2"/>Add members</div>
                    <div class="o369-pinlist">
                        <t t-foreach="state.addMemberContacts" t-as="u" t-key="u.id">
                            <div class="o369-pinitem o369-fwdrow" t-on-click="() => this.toggleAddMemberSel(u.id)">
                                <div class="o369-avatar o369-avatar-sm"><img t-if="u.avatar_url" t-att-src="u.avatar_url"/><span t-else="" t-esc="initials(u.name)"/></div>
                                <div class="o369-pinitemtxt"><b t-esc="u.name"/><small t-esc="u.mobile"/></div>
                                <i class="fa" t-att-class="state.addMemberSel.includes(u.id) ? 'fa-check-circle o369-checked' : 'fa-circle-o'"/>
                            </div>
                        </t>
                        <div class="o369-hint" t-if="state.addMemberContacts.length === 0">No contacts to add.</div>
                    </div>
                    <button class="o369-createbtn" t-on-click="confirmAddMembers" t-att-disabled="state.addMemberSel.length === 0">Add (<t t-esc="state.addMemberSel.length"/>)</button>
                    <button class="o369-modalcancel" t-on-click="closeAddMembers">Cancel</button>
                </div>
            </div>

            <!-- Member action menu -->
            <div class="o369-modal" t-if="state.memberMenu" t-on-click.self="() => (state.memberMenu = null)">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle" t-esc="state.memberMenu.name"/>
                    <button class="o369-modalopt" t-on-click="() => this.messageMember(state.memberMenu)">Message</button>
                    <t t-if="state.contactInfo and state.contactInfo.is_admin and state.memberMenu.id !== state.contactInfo.me_id">
                        <button class="o369-modalopt" t-on-click="() => this.promoteMember(state.memberMenu)"><t t-esc="state.memberMenu.is_admin ? 'Dismiss as admin' : 'Make group admin'"/></button>
                        <button class="o369-modalopt" t-on-click="() => this.removeMember(state.memberMenu)">Remove from group</button>
                    </t>
                    <button class="o369-modalcancel" t-on-click="() => (state.memberMenu = null)">Cancel</button>
                </div>
            </div>

            <!-- Styled confirm dialog (replaces window.confirm) -->
            <div class="o369-modal" t-if="state.confirm" t-on-click.self="() => this._confirmResolve(false)">
                <div class="o369-modalcard o369-confirmcard">
                    <div class="o369-modaltitle" t-esc="state.confirm.title"/>
                    <div class="o369-confirmbody" t-esc="state.confirm.body"/>
                    <div class="o369-confirmbtns">
                        <button class="o369-confirmcancel" t-on-click="() => this._confirmResolve(false)">Cancel</button>
                        <button t-att-class="'o369-confirmok' + (state.confirm.danger ? ' o369-danger' : '')" t-on-click="() => this._confirmResolve(true)" t-esc="state.confirm.okLabel"/>
                    </div>
                </div>
            </div>

            <!-- Message info (delivered / read + times), WhatsApp-style -->
            <div class="o369-modal" t-if="state.msgInfo" t-on-click.self="closeMessageInfo">
                <div class="o369-modalcard o369-infocard">
                    <div class="o369-modaltitle"><i class="fa fa-info-circle me-2"/>Message info</div>
                    <div class="o369-infoprev" t-esc="state.msgInfo.body or infoKindLabel(state.msgInfo.kind)"/>
                    <div t-if="state.msgInfo.loading" class="o369-infoempty">Loading…</div>
                    <t t-else="">
                        <div class="o369-inforow">
                            <div class="o369-infohead">
                                <span class="o369-ticks o369-tick-read"><i class="fa fa-check o369-tick1"/><i class="fa fa-check o369-tick2"/></span>
                                Read <t t-if="state.msgInfo.is_group">(<t t-esc="state.msgInfo.read.length"/>)</t>
                            </div>
                            <div class="o369-infoperson" t-foreach="state.msgInfo.read" t-as="r" t-key="r.user_id">
                                <span t-esc="r.name"/><span class="o369-infotime" t-esc="fmtInfoTime(r.at)"/>
                            </div>
                            <div t-if="!state.msgInfo.read.length" class="o369-infoempty">Not read yet</div>
                        </div>
                        <div class="o369-inforow">
                            <div class="o369-infohead">
                                <span class="o369-ticks o369-tick-delivered"><i class="fa fa-check o369-tick1"/><i class="fa fa-check o369-tick2"/></span>
                                Delivered <t t-if="state.msgInfo.is_group">(<t t-esc="state.msgInfo.delivered.length"/>)</t>
                            </div>
                            <div class="o369-infoperson" t-foreach="state.msgInfo.delivered" t-as="d" t-key="d.user_id">
                                <span t-esc="d.name"/><span class="o369-infotime" t-esc="fmtInfoTime(d.at)"/>
                            </div>
                            <div t-if="!state.msgInfo.delivered.length" class="o369-infoempty">Not delivered yet</div>
                        </div>
                    </t>
                    <button class="o369-modalcancel" t-on-click="closeMessageInfo">Close</button>
                </div>
            </div>

            <!-- Privacy: last seen / online (WhatsApp-style) -->
            <div class="o369-modal" t-if="state.privacyOpen" t-on-click.self="closePrivacy">
                <div class="o369-modalcard o369-privacycard">
                    <div class="o369-modaltitle"><i class="fa fa-lock me-2"/>Privacy</div>
                    <div class="o369-privrow">
                        <label>Last seen</label>
                        <select t-on-change="(ev) => this.setPrivacy('last_seen_privacy', ev.target.value)">
                            <option value="everyone" t-att-selected="state.privacy.last_seen_privacy === 'everyone'">Everyone</option>
                            <option value="contacts" t-att-selected="state.privacy.last_seen_privacy === 'contacts'">My contacts</option>
                            <option value="nobody" t-att-selected="state.privacy.last_seen_privacy === 'nobody'">Nobody</option>
                        </select>
                    </div>
                    <div class="o369-privrow">
                        <label>Online</label>
                        <select t-on-change="(ev) => this.setPrivacy('online_privacy', ev.target.value)">
                            <option value="everyone" t-att-selected="state.privacy.online_privacy === 'everyone'">Everyone</option>
                            <option value="same" t-att-selected="state.privacy.online_privacy === 'same'">Same as last seen</option>
                        </select>
                    </div>
                    <div class="o369-privhint">If you don't share your last seen, you won't be able to see anyone else's.</div>
                    <button class="o369-modalcancel" t-on-click="closePrivacy">Done</button>
                </div>
            </div>

            <!-- Group invite link (employee-only join) -->
            <div class="o369-modal" t-if="state.inviteOpen" t-on-click.self="closeInvite">
                <div class="o369-modalcard o369-invitecard">
                    <div class="o369-modaltitle"><i class="fa fa-link me-2"/>Invite to group via link</div>
                    <div class="o369-invitehint">Anyone from your company with this link can join the group.</div>
                    <div class="o369-invitelinkrow" t-if="state.inviteLink">
                        <input class="o369-invitelink" readonly="readonly" t-att-value="state.inviteLink"/>
                        <button class="o369-invitecopy" t-on-click="copyInviteLink" title="Copy link"><i class="fa fa-copy"/></button>
                    </div>
                    <div t-if="state.inviteBusy and !state.inviteLink" class="o369-infoempty">Loading…</div>
                    <button class="o369-inviteredo" t-on-click="resetInviteLink"><i class="fa fa-refresh me-1"/> Reset link</button>
                    <button class="o369-modalcancel" t-on-click="closeInvite">Close</button>
                </div>
            </div>

            <!-- Image lightbox -->
            <div class="o369-lightbox" t-if="state.lightbox" t-on-click="closeLightbox">
                <img t-att-src="state.lightbox"/>
            </div>

            <!-- Multi-photo review (captions + view-once) -->
            <div class="o369-viewer o369-mediareview" t-if="state.mediaReview">
                <div class="o369-vhead">
                    <button class="o369-vtool" t-on-click="closeMediaReview" title="Cancel"><i class="fa fa-times"/></button>
                    <span class="o369-mrtitle"><t t-esc="state.mediaReview.idx + 1"/> / <t t-esc="state.mediaReview.items.length"/></span>
                    <button class="o369-vtool o369-mrvo" t-att-class="{ 'o369-mrvo-on': state.mediaReview.viewOnce }" t-on-click="() => (state.mediaReview.viewOnce = !state.mediaReview.viewOnce)" title="View once"><i class="fa fa-eye"/> View once</button>
                </div>
                <div class="o369-vstage">
                    <img t-if="mrCur() and mrCur().kind === 'image'" t-att-src="mrCur().previewUrl"/>
                    <video t-elif="mrCur()" t-att-src="mrCur().previewUrl" controls="controls"/>
                </div>
                <div class="o369-mrcapwrap">
                    <input class="o369-mrcap" placeholder="Add a caption…" t-att-value="mrCur() and mrCur().caption" t-on-input="(ev) => this.setReviewCaption(ev.target.value)"/>
                    <button class="o369-mrsend" t-on-click="sendMediaReview" title="Send"><i class="fa fa-paper-plane"/></button>
                </div>
                <div class="o369-vstrip" t-if="state.mediaReview.items.length > 1">
                    <div class="o369-vthumb" t-foreach="state.mediaReview.items" t-as="it" t-key="it_index" t-att-class="{ 'o369-vthumb-on': it_index === state.mediaReview.idx }" t-on-click="() => (state.mediaReview.idx = it_index)">
                        <img t-if="it.kind === 'image'" t-att-src="it.previewUrl"/>
                        <div t-else="" class="o369-vthumbvid"><i class="fa fa-play"/></div>
                    </div>
                </div>
            </div>

            <!-- Schedule a call -->
            <div class="o369-modal" t-if="state.scheduleForm" t-on-click.self="closeSchedule">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-calendar me-2"/>Schedule a call</div>
                    <input class="o369-listinput" placeholder="Call title" t-att-value="state.scheduleForm.title" t-on-input="(ev) => (state.scheduleForm.title = ev.target.value)"/>
                    <select class="o369-listinput" t-on-change="(ev) => (state.scheduleForm.conversation_id = ev.target.value)">
                        <option value="">Contact to call (optional)</option>
                        <t t-foreach="oneToOneConvs()" t-as="c" t-key="c.id"><option t-att-value="c.id" t-esc="c.title"/></t>
                    </select>
                    <input class="o369-listinput" type="datetime-local" t-att-value="state.scheduleForm.when" t-on-input="(ev) => (state.scheduleForm.when = ev.target.value)"/>
                    <div class="o369-pollmulti" t-on-click="() => (state.scheduleForm.video = !state.scheduleForm.video)">
                        <span class="o369-switch" t-att-class="{ 'o369-switch-on': state.scheduleForm.video }"><span/></span>
                        <span>Video call</span>
                    </div>
                    <button class="o369-createbtn" t-on-click="submitSchedule" t-att-disabled="!state.scheduleForm.title or !state.scheduleForm.when">Schedule</button>
                    <button class="o369-modalcancel" t-on-click="closeSchedule">Cancel</button>
                </div>
            </div>

            <!-- Incoming call -->
            <div class="o369-incoming" t-if="state.call and state.call.status === 'incoming'">
                <div class="o369-incomingcard">
                    <div class="o369-avatar o369-avatarxl o369-incomingav"><img t-if="state.call.avatar" t-att-src="state.call.avatar"/><span t-else="" t-esc="initials(state.call.name)"/></div>
                    <div class="o369-incomingname" t-esc="state.call.name"/>
                    <div class="o369-incomingsub" t-esc="state.call.video ? 'Incoming video call' : 'Incoming voice call'"/>
                    <div class="o369-incomingbtns">
                        <button class="o369-callbtn o369-callend" t-on-click="rejectCall" title="Decline"><i class="fa fa-phone"/></button>
                        <button class="o369-callbtn o369-callaccept" t-on-click="acceptCall" title="Accept"><i class="fa" t-att-class="state.call.video ? 'fa-video-camera' : 'fa-phone'"/></button>
                    </div>
                </div>
            </div>

            <!-- In-call overlay -->
            <div class="o369-calloverlay" t-if="state.call and state.call.status !== 'incoming'">
                <video class="o369-callremote" t-ref="remoteVideo" autoplay="autoplay" playsinline="playsinline"/>
                <div class="o369-callremoteph" t-if="!(state.call.status === 'connected' and state.call.video)">
                    <div class="o369-avatar o369-avatarxl"><img t-if="state.call.avatar" t-att-src="state.call.avatar"/><span t-else="" t-esc="initials(state.call.name)"/></div>
                    <div class="o369-callname" t-esc="state.call.name"/>
                    <div class="o369-callstatus" t-esc="callStatusLabel()"/>
                </div>
                <div class="o369-calltop" t-if="state.call.status === 'connected'"><b t-esc="state.call.name"/> · <t t-esc="callTimeLabel()"/></div>
                <video class="o369-calllocal" t-if="state.call.video" t-ref="localVideo" autoplay="autoplay" playsinline="playsinline" muted="muted" t-att-class="{ 'o369-calllocal-off': state.call.camOff }"/>
                <div class="o369-callctrls">
                    <button class="o369-callbtn" t-att-class="{ 'o369-callbtn-off': state.call.muted }" t-on-click="toggleMute" title="Mute"><i class="fa" t-att-class="state.call.muted ? 'fa-microphone-slash' : 'fa-microphone'"/></button>
                    <button class="o369-callbtn" t-if="state.call.video" t-att-class="{ 'o369-callbtn-off': state.call.camOff }" t-on-click="toggleCam" title="Camera"><i class="fa fa-video-camera"/></button>
                    <button class="o369-callbtn o369-callend" t-on-click="endCall" title="End call"><i class="fa fa-phone"/></button>
                </div>
            </div>

            <!-- View-once fullscreen (consumed on close) -->
            <div class="o369-lightbox o369-volightbox" t-if="state.viewOnceView" t-on-click.self="closeViewOnce">
                <div class="o369-vo-banner"><i class="fa fa-eye me-1"/> View once — this disappears when you close it</div>
                <img t-if="state.viewOnceView.kind === 'image'" t-att-src="state.viewOnceView.url"/>
                <video t-else="" t-att-src="state.viewOnceView.url" controls="controls" autoplay="autoplay"/>
                <button class="o369-vo-close" t-on-click.stop="closeViewOnce"><i class="fa fa-times"/></button>
            </div>

            <!-- Rich media viewer (sender/date, download, prev/next, filmstrip) -->
            <div class="o369-viewer" t-if="state.viewer">
                <div class="o369-vhead">
                    <div class="o369-vwho">
                        <div class="o369-vname" t-esc="(viewerCur() and viewerCur().author) or 'Media'"/>
                        <div class="o369-vdate" t-esc="viewerCur() ? fmtInfoTime(viewerCur().date) : ''"/>
                    </div>
                    <div class="o369-vtools">
                        <button class="o369-vtool" t-on-click="() => this.viewerZoom(0.5)" title="Zoom in"><i class="fa fa-search-plus"/></button>
                        <button class="o369-vtool" t-on-click="() => this.viewerZoom(-0.5)" title="Zoom out"><i class="fa fa-search-minus"/></button>
                        <button class="o369-vtool" t-if="viewerMsg()" t-on-click="viewerReply" title="Reply"><i class="fa fa-reply"/></button>
                        <button class="o369-vtool" t-if="viewerMsg()" t-on-click="viewerStar" title="Star"><i class="fa fa-star-o"/></button>
                        <button class="o369-vtool" t-if="viewerMsg()" t-on-click="viewerReact" title="React"><i class="fa fa-smile-o"/></button>
                        <button class="o369-vtool" t-if="viewerMsg()" t-on-click="viewerForward" title="Forward"><i class="fa fa-share"/></button>
                        <a class="o369-vtool" t-att-href="viewerCur() and (viewerCur().url + '?dl=1')" t-att-download="viewerCur() and viewerCur().name" title="Download"><i class="fa fa-download"/></a>
                        <button class="o369-vtool" t-on-click="closeViewer" title="Close"><i class="fa fa-times"/></button>
                    </div>
                </div>
                <button class="o369-vnav o369-vprev" t-if="viewerHasPrev()" t-on-click.stop="viewerPrev"><i class="fa fa-chevron-left"/></button>
                <div class="o369-vstage" t-on-click.self="closeViewer">
                    <img t-if="viewerCur() and viewerCur().kind === 'image'" t-att-src="viewerCur().url" t-attf-style="transform: scale({{state.viewer.zoom or 1}}); transition: transform .12s;"/>
                    <video t-elif="viewerCur()" t-att-src="viewerCur().url" controls="controls" autoplay="autoplay"/>
                </div>
                <button class="o369-vnav o369-vnext" t-if="viewerHasNext()" t-on-click.stop="viewerNext"><i class="fa fa-chevron-right"/></button>
                <div class="o369-vstrip" t-if="state.viewer.list.length > 1">
                    <div class="o369-vthumb" t-foreach="state.viewer.list" t-as="v" t-key="v_index" t-att-class="{ 'o369-vthumb-on': v_index === state.viewer.idx }" t-on-click.stop="() => this.viewerGo(v_index)">
                        <img t-if="v.kind === 'image'" t-att-src="v.url" loading="lazy"/>
                        <div t-else="" class="o369-vthumbvid"><i class="fa fa-play"/></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    setup() {
        this.REACTIONS = ['\u{1F44D}','\u{2764}\u{FE0F}','\u{1F602}','\u{1F62E}','\u{1F622}','\u{1F64F}'];
        this.EMOJIS = [...new Set(['\u{1F600}','\u{1F603}','\u{1F604}','\u{1F601}','\u{1F606}','\u{1F605}','\u{1F602}','\u{1F923}','\u{1F60A}','\u{1F607}','\u{1F642}','\u{1F643}','\u{1F609}','\u{1F60C}','\u{1F60D}','\u{1F970}','\u{1F618}','\u{1F617}','\u{1F61A}','\u{1F60B}','\u{1F61B}','\u{1F61C}','\u{1F61D}','\u{1F92A}','\u{1F928}','\u{1F9D0}','\u{1F913}','\u{1F60E}','\u{1F929}','\u{1F60F}','\u{1F612}','\u{1F614}','\u{1F61E}','\u{1F61F}','\u{1F615}','\u{1F641}','\u{1F623}','\u{1F616}','\u{1F62B}','\u{1F629}','\u{1F97A}','\u{1F622}','\u{1F62D}','\u{1F624}','\u{1F620}','\u{1F621}','\u{1F92C}','\u{1F92F}','\u{1F633}','\u{1F975}','\u{1F976}','\u{1F631}','\u{1F628}','\u{1F630}','\u{1F625}','\u{1F613}','\u{1F917}','\u{1F92D}','\u{1F92B}','\u{1F914}','\u{1F610}','\u{1F611}','\u{1F636}','\u{1F644}','\u{1F62E}','\u{1F62F}','\u{1F632}','\u{1F971}','\u{1F634}','\u{1F924}','\u{1F62A}','\u{1F635}','\u{1F910}','\u{1F974}','\u{1F922}','\u{1F92E}','\u{1F927}','\u{1F637}','\u{1F912}','\u{1F915}','\u{1F925}','\u{1F44D}','\u{1F44E}','\u{1F44C}','\u{1F90F}','\u{1F91E}','\u{1F91F}','\u{1F918}','\u{1F919}','\u{1F448}','\u{1F449}','\u{1F446}','\u{1F447}','\u{1F44A}','\u{270A}','\u{1F91B}','\u{1F91C}','\u{1F44F}','\u{1F64C}','\u{1F450}','\u{1F932}','\u{1F91D}','\u{1F64F}','\u{1F4AA}','\u{1F933}','\u{1F440}','\u{1F44B}','\u{1F9E1}','\u{1F49B}','\u{1F49A}','\u{1F499}','\u{1F49C}','\u{1F5A4}','\u{1F90D}','\u{1F90E}','\u{1F494}','\u{1F495}','\u{1F49E}','\u{1F493}','\u{1F497}','\u{1F496}','\u{1F498}','\u{1F49D}','\u{1F49F}','\u{1F48B}','\u{1F525}','\u{2B50}','\u{1F31F}','\u{2728}','\u{1F4AF}','\u{1F389}','\u{1F38A}','\u{1F64B}','\u{1F3B6}','\u{1F480}','\u{1F47B}','\u{1F916}','\u{1F31E}','\u{1F319}','\u{2764}\u{FE0F}','\u{270C}\u{FE0F}','\u{261D}\u{FE0F}','\u{2705}','\u{274C}','\u{2757}','\u{2753}'])];
        this.THEMES = [
            { id: 'clean', name: 'Light', a: '#F4F6FA', b: '#DCE6F3' },
            { id: 'ocean', name: 'Ocean', a: '#1F5F9E', b: '#F47A20' },
            { id: 'emerald', name: 'Emerald', a: '#0E8F53', b: '#F2A93B' },
            { id: 'sunset', name: 'Sunset', a: '#C2410C', b: '#F59E0B' },
            { id: 'violet', name: 'Violet', a: '#6D28D9', b: '#F472B6' },
            { id: 'graphite', name: 'Graphite', a: '#334155', b: '#F59E0B' },
            { id: 'rose', name: 'Rose', a: '#BE185D', b: '#FB7185' },
        ];
        this.ABOUT_PRESETS = ['Available', 'Busy', 'At work', 'In a meeting', 'Urgent calls only',
            'At the gym', 'Sleeping', 'Battery about to die', "Can't talk now", 'On holiday'];
        this.notification = useService("notification");
        this.bus = useService("bus_service");
        this.MEMBER_PERMS = [
            { field: 'perm_edit_info', label: 'Edit group settings' },
            { field: 'perm_send', label: 'Send new messages' },
            { field: 'perm_add_members', label: 'Add other members' },
            { field: 'perm_send_history', label: 'Send message history' },
            { field: 'perm_invite', label: 'Invite via link' },
        ];
        this.state = useState({
            view: 'chats', conversations: [], contacts: [], messages: [], pinnedMsgs: [],
            activeConv: null, selectedId: null, draft: '', replyTo: null, editing: null,
            search: '', contactSearch: '', groupMode: false, groupName: '', groupSel: [],
            pinPrompt: null, showPins: false, openMenuId: null, headerMenu: false,
            forwardMsg: null, showStarred: false, starredMsgs: [], emojiPickerMsg: null,
            rowMenuId: null, muteConv: null,
            filter: 'all', lists: [], showNewList: false, newListName: '', newListSel: [], addToListConv: null,
            convMenu: false, infoOpen: false, contactInfo: null, nickDraft: '',
            searchOpen: false, searchQ: '', searchResults: [], searchIdx: 0, flashId: 0, globalMsgs: [],
            selectMode: false, selectedIds: [], forwardSel: [],
            calOpen: false, calYear: 0, calMonth: 0,
            attachMenu: false, lightbox: null, recording: false, recPaused: false, recSecs: 0, memberMenu: null, groupNameEdit: '',
            confirm: null, typing: null, msgInfo: null,
            privacyOpen: false, privacy: { last_seen_privacy: 'everyone', online_privacy: 'everyone' },
            playingId: null, audioPaused: false, audioCur: 0, audioDur: 0, showJumpBottom: false,
            inviteOpen: false, inviteLink: '', inviteBusy: false, audioSpeed: 1,
            pane: 'chats', me: null,
            mediaAllTab: 'media', mediaAllItems: [], mediaAllBusy: false, viewer: null, menuPos: { top: 0, left: 0 },
            gmeet: { connected: false, has_creds: false, is_admin: false, triggers: [], scope: 'both', admin_only: true, client_id: '' },
            gmeetForm: { client_id: '', client_secret: '', triggers: '', scope: 'both', admin_only: true, base_url: '' },
            gmeetSaved: '', gmeetHelpOpen: false, chipMenuOpen: false, notifBannerHidden: false,
            drafts: {}, composerEmojiOpen: false, disappearOpen: false, pollCreate: null,
            mediaReview: null, viewOnceView: null,
            composerLink: null, composerLinkHidden: false, previews: {}, theme: 'ocean', themeMode: 'system', dark: false, call: null,
            calls: { recent: [], favorites: [], upcoming: [] }, scheduleForm: null,
            mentionOpen: false, mentionMatches: [], mentionIdx: 0, mentionMembers: [], mentionMembersConv: 0, mentionStart: 0, mentionEnd: 0,
            settingsView: 'menu', profileEdit: { field: null, val: '' },
            // Group info redesign / media viewer / permissions (Features 2-4)
            nameEditing: false, descEditing: false, descDraft: '',
            mediaOpen: false, mediaTab: 'media', mediaItems: [],
            permsOpen: false,
            addMembersOpen: false, addMemberSel: [], addMemberContacts: [],
        });
        this.scroller = useRef("scroller");
        this.fileinput = useRef("fileinput");
        this.avatarinput = useRef("avatarinput");
        this.msgbox = useRef("msgbox");
        this.localVideo = useRef("localVideo");
        this.remoteVideo = useRef("remoteVideo");
        try { this.state.drafts = JSON.parse(localStorage.getItem('o369_drafts') || '{}') || {}; } catch (e) { this.state.drafts = {}; }
        try { this.state.theme = localStorage.getItem('o369_theme') || 'clean'; } catch (e) {}
        try { this.state.themeMode = localStorage.getItem('o369_thememode') || 'system'; } catch (e) {}
        this._applyThemeMode();
        try {
            this._mqDark = window.matchMedia('(prefers-color-scheme: dark)');
            this._mqDark.addEventListener('change', () => { if (this.state.themeMode === 'system') this._applyThemeMode(); });
        } catch (e) {}
        this._scrollPending = false;
        this._timer = null;
        // Close any open menu when clicking elsewhere (caret/menu clicks use .stop).
        useExternalListener(window, "click", () => this.closeMenus());

        this.bus.subscribe("chat369.event", (payload) => this._onBus(payload));
        onWillStart(async () => {
            try { const r = await rpc('/chat/bus_channel', {}); if (r && r.channel) this.bus.addChannel(r.channel); } catch (e) {}
            await this.loadConversations(true); this.loadLists(); this.loadMe(); this.loadGmeet(); this.loadCalls();
        });
        onMounted(() => { this._timer = setInterval(() => this.tick(), 6000); });
        onWillUnmount(() => { if (this._timer) { clearInterval(this._timer); this._timer = null; } this._teardownCall(); });
        onPatched(() => {
            // Attach live call streams to their <video> elements once rendered.
            if (this.state.call) {
                if (this.localVideo.el && this._localStream && this.localVideo.el.srcObject !== this._localStream) this.localVideo.el.srcObject = this._localStream;
                if (this.remoteVideo.el && this._remoteStream && this.remoteVideo.el.srcObject !== this._remoteStream) this.remoteVideo.el.srcObject = this._remoteStream;
            }
            if (this._prependAdjust && this.scroller.el) {
                // Keep the viewport steady after prepending older history.
                this.scroller.el.scrollTop += this.scroller.el.scrollHeight - (this._prependOldHeight || 0);
                this._prependAdjust = false;
            } else if (this._scrollPending && this.scroller.el) {
                this.scroller.el.scrollTop = this.scroller.el.scrollHeight;
                this._scrollPending = false;
            }
        });
    }

    closeMenus() { this.state.openMenuId = null; this.state.headerMenu = false; this.state.rowMenuId = null; this.state.convMenu = false; this.state.attachMenu = false; this.state.chipMenuOpen = false; this.state.composerEmojiOpen = false; }
    toggleConvMenu() { this.closeMenus(); this.state.convMenu = !this.state.convMenu; }
    toggleMenu(id, ev) {
        this.state.headerMenu = false; this.state.rowMenuId = null;
        if (this.state.openMenuId === id) { this.state.openMenuId = null; return; }
        this.state.openMenuId = id;
        const btn = ev && ev.currentTarget;
        if (btn && btn.getBoundingClientRect) {
            const r = btn.getBoundingClientRect();
            const w = 205, h = 350, pad = 8;
            let left = Math.min(r.right - w, window.innerWidth - w - pad);
            if (left < pad) left = pad;
            let top = r.bottom + 4;
            if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h);  // flip up near bottom
            this.state.menuPos = { top, left };
        }
    }
    canEditMsg(m) {
        // WhatsApp-style: edit only your own text, within 15 minutes of sending.
        if (!m.mine || m.deleted || m.kind !== 'text') return false;
        if (!m.created) return true;
        return (Date.now() - new Date(m.created).getTime()) < 15 * 60 * 1000;
    }
    toggleHeaderMenu() { this.state.openMenuId = null; this.state.rowMenuId = null; this.state.headerMenu = !this.state.headerMenu; }
    toggleRowMenu(id) { this.state.openMenuId = null; this.state.headerMenu = false; this.state.rowMenuId = this.state.rowMenuId === id ? null : id; }
    notify(msg, type) { this.notification.add(msg || 'Action failed.', { type: type || 'warning' }); }

    // ---------------- data ----------------
    async loadConversations() {
        try { const res = await rpc('/chat/conversations', { filter: this.state.filter }); if (res && res.status) this.state.conversations = res.conversations || []; } catch (e) {}
    }
    async loadLists(convId) {
        try { const res = await rpc('/chat/lists', convId ? { conversation_id: convId } : {}); if (res && res.status) this.state.lists = res.lists || []; } catch (e) {}
    }
    setFilter(f) { this.state.filter = f; this.loadConversations(); }
    // Total unread across all chats — for the WhatsApp-style badge on the rail icon.
    totalUnread() { return (this.state.conversations || []).reduce((s, c) => s + (c.unread_count || 0), 0); }
    // Browser notifications are OFF → show the "turn on" banner atop the chat list.
    notifsBlocked() {
        try { return typeof Notification !== 'undefined' && Notification.permission !== 'granted' && !this.state.notifBannerHidden; }
        catch (e) { return false; }
    }
    async enableNotifsFromBanner() {
        try {
            if (typeof Notification === 'undefined') { this.notify('This browser has no notifications.'); return; }
            const p = await Notification.requestPermission();
            if (p === 'granted') { this.state.notifBannerHidden = true; this.notify('Notifications turned on', 'success'); }
            else { this.notify('Still blocked — allow notifications for this site in your browser.'); }
        } catch (e) {}
    }
    // ---- lists ----
    openNewList() { this.state.newListName = ''; this.state.newListSel = []; this.state.showNewList = true; }
    closeNewList() { this.state.showNewList = false; }
    toggleNewListConv(id) { const i = this.state.newListSel.indexOf(id); if (i >= 0) this.state.newListSel.splice(i, 1); else this.state.newListSel.push(id); }
    async createList() {
        const name = (this.state.newListName || '').trim(); if (!name) return;
        const convIds = [...this.state.newListSel];
        this.state.showNewList = false;                 // close instantly
        try { await rpc('/chat/create_list', { name, conversation_ids: convIds }); await this.loadLists(); } catch (e) {}
    }
    openAddToList(c) { this.closeMenus(); this.state.addToListConv = c; this.loadLists(c.id); }
    closeAddToList() { this.state.addToListConv = null; this.loadLists(); }
    async toggleListMembership(l) {
        const c = this.state.addToListConv; if (!c) return;
        try { const res = await rpc('/chat/list_toggle', { list_id: l.id, conversation_id: c.id }); if (res && res.status) { l.has = res.has; l.count = res.count; } } catch (e) {}
    }
    newListFromPicker() { const c = this.state.addToListConv; this.state.addToListConv = null; this.state.newListSel = c ? [c.id] : []; this.state.newListName = ''; this.state.showNewList = true; }
    async openSelf() {
        try { const res = await rpc('/chat/open_self', {}); if (res && res.status && res.conversation) { this.closeContacts(); await this.select(res.conversation); await this.loadConversations(); } } catch (e) {}
    }
    async openContacts() {
        this.state.view = 'contacts'; this.state.groupMode = false; this.state.groupName = ''; this.state.groupSel = []; this.state.contactSearch = '';
        try { const res = await rpc('/chat/contacts', {}); if (res && res.status) this.state.contacts = res.contacts || []; } catch (e) {}
    }
    closeContacts() { this.state.view = 'chats'; this.state.groupMode = false; }
    onContactClick(u) {
        if (this.state.groupMode) { const i = this.state.groupSel.indexOf(u.id); if (i >= 0) this.state.groupSel.splice(i, 1); else this.state.groupSel.push(u.id); }
        else this.openDirect(u.id);
    }
    async openDirect(userId) {
        try { const res = await rpc('/chat/open_direct', { user_id: userId }); if (res && res.status && res.conversation) { this.closeContacts(); await this.select(res.conversation); await this.loadConversations(); } } catch (e) {}
    }
    async createGroup() {
        const name = (this.state.groupName || '').trim();
        if (!name || this.state.groupSel.length === 0) return;
        try { const res = await rpc('/chat/create_group', { name, member_ids: this.state.groupSel }); if (res && res.status && res.conversation) { this.closeContacts(); await this.select(res.conversation); await this.loadConversations(); } } catch (e) {}
    }
    async select(conv) {
        this._saveDraft();   // keep the unsent text of the chat we're leaving
        this._clearComposerLink();
        this.state.selectedId = conv.id; this.state.activeConv = conv; this.state.messages = [];
        this.state.draft = this.state.drafts[conv.id] || '';   // restore this chat's draft
        this.state.replyTo = null; this.state.editing = null; this.state.typing = null; this.state.msgInfo = null;
        this._stopAudio(); this._noMoreOlder = false; this.state.showJumpBottom = false;
        this.closeContactInfo();   // don't leave the previous chat's info panel open on switch
        this.closeMenus();
        await this.reloadMessages(true); this.loadPinned();
    }
    // ---- drafts (WhatsApp-style: unsent text kept per chat) ----
    draftFor(id) { return (this.state.drafts[id] || '').trim(); }
    _saveDraft() {
        const id = this.state.selectedId; if (!id) return;
        const d = this.state.draft || '';
        if (d.trim()) this.state.drafts[id] = d; else delete this.state.drafts[id];
        this._persistDrafts();
    }
    _persistDrafts() { try { localStorage.setItem('o369_drafts', JSON.stringify(this.state.drafts)); } catch (e) {} }
    async reloadMessages(scroll) {
        if (!this.state.selectedId) return;
        try { const res = await rpc('/chat/messages', { conversation_id: this.state.selectedId, limit: 60 }); if (res && res.status) { this.state.messages = res.messages || []; if (scroll) this._scrollPending = true; this.markRead(); this._scanPreviews(); } } catch (e) {}
    }
    async loadPinned() {
        if (!this.state.selectedId) return;
        try { const res = await rpc('/chat/pinned_messages', { conversation_id: this.state.selectedId }); if (res && res.status) this.state.pinnedMsgs = res.messages || []; } catch (e) {}
    }
    lastMsgId() { let mx = 0; for (const m of this.state.messages) { if (typeof m.id === 'number' && m.id > mx) mx = m.id; } return mx; }
    _applyMsg(res) {
        if (res && res.status && res.message) {
            const nm = res.message;
            const i = this.state.messages.findIndex((x) => x.id === nm.id);
            if (i >= 0) this.state.messages.splice(i, 1, nm);
        }
    }
    async markRead() {
        if (!this.state.selectedId) return;
        try { await rpc('/chat/mark_read', { conversation_id: this.state.selectedId, up_to_message_id: this.lastMsgId() }); } catch (e) {}
    }
    async send() {
        const body = (this.state.draft || '').trim();
        if (!body || !this.state.selectedId) return;
        // Edit mode?
        if (this.state.editing) {
            const id = this.state.editing.id;
            this.state.draft = ''; this.state.editing = null;
            try { const res = await rpc('/chat/edit_message', { message_id: id, body }); if (res && res.status === false) { this.notify(res.message); return; } this._applyMsg(res); this.loadConversations(); } catch (e) {}
            return;
        }
        // Configured meeting trigger word -> post the typed word as a normal message,
        // then generate a Google Meet link right after (so the chat shows the word first,
        // then the Meet card). createMeet() is fired once the text send resolves below.
        const isMeetTrigger = this._meetTriggered(body);
        const replyTo = this.state.replyTo;
        const replyId = replyTo ? replyTo.id : 0;
        this.state.draft = ''; this._saveDraft(); this._clearComposerLink(); this.state.replyTo = null; this._stopTyping();
        // Optimistic: show the message instantly (a temp bubble with a clock), then
        // swap in the server copy — feels instant regardless of round-trip.
        const tempId = 'tmp-' + Date.now();
        this.state.messages.push({
            id: tempId, mine: true, body, kind: 'text', deleted: false, pinned: false, starred: false,
            edited: false, reactions: [], reply_to_id: replyId || false,
            reply_to_author: replyTo ? replyTo.author : '', reply_to_body: replyTo ? replyTo.body : '', quoted: !!replyTo,
            author_name: 'You', created: new Date().toISOString(), status: 'sent', _pending: true,
        });
        this._scrollPending = true;
        try {
            const payload = { conversation_id: this.state.selectedId, body, reply_to_id: replyId };
            if (replyTo && replyTo.external) { payload.quote_author = replyTo.quote_author || replyTo.author || ''; payload.quote_body = replyTo.quote_body || replyTo.body || ''; }
            const res = await rpc('/chat/send', payload);
            // Remove the temp bubble, then add the real one only if the poll didn't already.
            this.state.messages = this.state.messages.filter((m) => m.id !== tempId);
            if (res && res.status === false) {
                // Server rejected (e.g. only-admins-can-send / empty) — tell the user and
                // put their text back so nothing is silently lost.
                this.notify(res.message || 'Message not sent');
                this.state.draft = body; this.state.replyTo = replyTo || null;
                return;
            }
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this.loadConversations();
                this._scanPreviews();
            }
            // Trigger word was just posted as text — now drop the Meet card right below it.
            if (isMeetTrigger) this.createMeet();
        } catch (e) {
            this.state.messages = this.state.messages.filter((m) => m.id !== tempId);
            this.notify('Message not sent'); this.state.draft = body; this.state.replyTo = replyTo || null;
        }
    }
    onKeydown(ev) {
        if (this.state.mentionOpen && this.state.mentionMatches.length) {
            if (ev.key === 'ArrowDown') { ev.preventDefault(); this.state.mentionIdx = (this.state.mentionIdx + 1) % this.state.mentionMatches.length; return; }
            if (ev.key === 'ArrowUp') { ev.preventDefault(); this.state.mentionIdx = (this.state.mentionIdx - 1 + this.state.mentionMatches.length) % this.state.mentionMatches.length; return; }
            if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); this.mentionPick(this.state.mentionMatches[this.state.mentionIdx]); return; }
            if (ev.key === 'Escape') { ev.preventDefault(); this.state.mentionOpen = false; return; }
        }
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.send(); }
    }
    onDraftInput(ev) { this.state.draft = this.sentenceCase(ev.target.value); this._saveDraft(); this._emitTyping(); this._mentionDetect(ev.target); this._detectComposerLink(); }
    // ---- composer emoji picker (insert into the message box, not react) ----
    toggleComposerEmoji() { const open = this.state.composerEmojiOpen; this.closeMenus(); this.state.composerEmojiOpen = !open; }
    insertEmoji(e) {
        const el = this.msgbox.el;
        const d = this.state.draft || '';
        if (el && typeof el.selectionStart === 'number') {
            const s = el.selectionStart, en = el.selectionEnd;
            this.state.draft = d.slice(0, s) + e + d.slice(en);
            const np = s + e.length;
            setTimeout(() => { try { el.focus(); el.selectionStart = el.selectionEnd = np; } catch (x) {} }, 0);
        } else {
            this.state.draft = d + e;
        }
        this._saveDraft();
    }
    // ---- @mention picker (groups only) ----
    async _loadMentionMembers() {
        const c = this.state.activeConv;
        if (!c || !c.is_group) { this.state.mentionMembers = []; return; }
        try {
            const res = await rpc('/chat/contact_info', { conversation_id: c.id });
            const info = (res && (res.info || res)) || {};
            const meId = this.state.me && this.state.me.id;
            this.state.mentionMembers = (info.members || []).filter((m) => m.id !== meId).map((m) => ({ id: m.id, name: m.name }));
            this.state.mentionMembersConv = c.id;
        } catch (e) { this.state.mentionMembers = []; }
    }
    _mentionDetect(inputEl) {
        const c = this.state.activeConv;
        if (!c || !c.is_group) { this.state.mentionOpen = false; return; }
        this._lastInput = inputEl || this._lastInput;
        const pos = inputEl ? (inputEl.selectionStart || 0) : (this.state.draft || '').length;
        const upto = (this.state.draft || '').slice(0, pos);
        const mm = upto.match(/(^|\s)@([\w]*)$/);   // '@' at a word boundary + the query typed so far
        if (!mm) { this.state.mentionOpen = false; return; }
        const q = (mm[2] || '').toLowerCase();
        this.state.mentionStart = pos - mm[2].length - 1;   // index of the '@'
        this.state.mentionEnd = pos;
        const all = { id: 'all', name: 'all', label: 'Everyone  ·  @all' };
        let matches = this.state.mentionMembers.filter((m) => m.name.toLowerCase().includes(q));
        matches = (('all'.startsWith(q) || q === '') ? [all] : []).concat(matches).slice(0, 6);
        this.state.mentionMatches = matches;
        this.state.mentionIdx = 0;
        this.state.mentionOpen = matches.length > 0;
        if (this.state.mentionMembersConv !== c.id && !this._mentionLoading) {
            this._mentionLoading = true;
            this._loadMentionMembers().then(() => { this._mentionLoading = false; this._mentionDetect(this._lastInput); });
        }
    }
    mentionPick(item) {
        if (!item) return;
        const d = this.state.draft || '';
        const s = this.state.mentionStart != null ? this.state.mentionStart : d.length;
        const e = this.state.mentionEnd != null ? this.state.mentionEnd : d.length;
        const ins = '@' + item.name + ' ';
        this.state.draft = d.slice(0, s) + ins + d.slice(e);
        this.state.mentionOpen = false;
        const el = this._lastInput, np = s + ins.length;
        if (el) setTimeout(() => { try { el.focus(); el.selectionStart = el.selectionEnd = np; } catch (x) {} }, 0);
    }
    sentenceCase(s) {
        s = s || '';
        // Capitalize the first letter — UNLESS the text starts with a link (a
        // capitalized "Https://" is an invalid/broken URL).
        const f = /^(\s*)([a-z])([\s\S]*)$/.exec(s);
        if (f && !/^(https?:\/\/|www\.)/i.test(f[2] + f[3])) {
            s = f[1] + f[2].toUpperCase() + f[3];
        }
        // Capitalize after sentence enders (URLs have no space after their dots, so untouched).
        return s.replace(/([.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    }

    // ---------------- message menu actions ----------------
    startReply(m) { this.closeMenus(); this.state.editing = null; this.state.replyTo = { id: m.id, author: m.mine ? 'You' : m.author_name, body: (m.body || '').slice(0, 120) }; }
    cancelReply() { this.state.replyTo = null; }
    startEdit(m) { this.closeMenus(); this.state.replyTo = null; this.state.editing = { id: m.id }; this.state.draft = m.body || ''; }
    cancelEdit() { this.state.editing = null; this.state.draft = ''; }
    async copyMsg(m) { this.closeMenus(); try { await navigator.clipboard.writeText(m.body || ''); this.notify('Copied', 'info'); } catch (e) { this.notify('Could not copy'); } }
    menuPin(m) { this.closeMenus(); this.requestPinMessage(m); }
    async toggleStar(m) { this.closeMenus(); try { const res = await rpc('/chat/star', { message_id: m.id, starred: !m.starred }); this._applyMsg(res); } catch (e) {} }
    async react(m, emoji) { this.closeMenus(); try { const res = await rpc('/chat/react', { message_id: m.id, emoji }); this._applyMsg(res); } catch (e) {} }
    openEmojiPicker(m) { this.closeMenus(); this.state.emojiPickerMsg = m; }
    closeEmojiPicker() { this.state.emojiPickerMsg = null; }
    pickEmoji(e) { const m = this.state.emojiPickerMsg; this.state.emojiPickerMsg = null; if (m) this.react(m, e); }
    async deleteScope(m, scope) {
        this.closeMenus();
        if (!await this.askConfirm({ title: 'Delete message', body: scope === 'everyone' ? 'Delete this message for everyone?' : 'Delete this message for you?', okLabel: 'Delete', danger: true })) return;
        try {
            const res = await rpc('/chat/delete_message', { message_id: m.id, scope });
            if (res && res.status === false) { this.notify(res.message); return; }
            if (res && res.removed) this.state.messages = this.state.messages.filter((x) => x.id !== res.message_id);
            else this._applyMsg(res);
            this.loadPinned(); this.loadConversations();
        } catch (e) {}
    }
    openForward(m) { this.closeMenus(); this.state.forwardMsg = m; }
    closeForward() { this.state.forwardMsg = null; this.state.forwardSel = []; }
    async doForward(c) {
        const fm = this.state.forwardMsg; this.state.forwardMsg = null;
        if (!fm) return;
        const ids = fm._bulk ? [...(this.state.forwardSel || [])] : [fm.id];
        this.state.forwardSel = [];
        let ok = 0;
        for (const id of ids) {
            try { const res = await rpc('/chat/forward', { message_id: id, to_conversation_id: c.id }); if (!res || res.status !== false) ok++; else if (ids.length === 1) { this.notify(res.message); return; } } catch (e) {}
        }
        if (ok) this.notify(ok > 1 ? (ok + ' forwarded') : 'Forwarded', 'success');
        this.loadConversations();
        if (fm._bulk) this.exitSelect();
    }
    // ---------------- reply privately (group message -> a 1:1 with that person) ----------------
    async replyPrivately(m) {
        this.closeMenus();
        const author = m.author_name || '';
        const body = (m.body && m.body.trim())
            ? m.body.slice(0, 120)
            : ({ image: 'Photo', video: 'Video', audio: 'Voice message', document: 'Document', poll: 'Poll' }[m.kind] || '');
        if (!m.author_id) { this.notify('Cannot reply privately to this message.'); return; }
        await this.openDirect(m.author_id);   // switch to the 1:1 (this clears replyTo)
        this.state.replyTo = { external: true, author, body, quote_author: author, quote_body: body };
    }
    // ---------------- multi-select (bulk forward / delete / star) ----------------
    enterSelect(m) { this.closeMenus(); this.state.selectMode = true; this.state.selectedIds = (m && typeof m.id === 'number') ? [m.id] : []; }
    exitSelect() { this.state.selectMode = false; this.state.selectedIds = []; this.state.forwardSel = []; }
    toggleSelect(m) {
        if (!m || typeof m.id !== 'number') return;
        const i = this.state.selectedIds.indexOf(m.id);
        if (i >= 0) this.state.selectedIds.splice(i, 1); else this.state.selectedIds.push(m.id);
    }
    async bulkStar() {
        const ids = [...this.state.selectedIds]; if (!ids.length) return;
        for (const id of ids) { try { await rpc('/chat/star', { message_id: id, starred: true }); } catch (e) {} }
        this.notify(ids.length + ' starred', 'success'); this.exitSelect(); this.reloadMessages(false);
    }
    async bulkDelete() {
        const ids = [...this.state.selectedIds]; if (!ids.length) return;
        for (const id of ids) { try { await rpc('/chat/delete_message', { message_id: id, scope: 'me' }); } catch (e) {} }
        this.notify(ids.length + ' deleted', 'success'); this.exitSelect(); this.reloadMessages(false); this.loadConversations();
    }
    bulkForward() {
        if (!this.state.selectedIds.length) return;
        this.state.forwardSel = [...this.state.selectedIds];
        this.state.forwardMsg = { _bulk: true };   // opens the forward picker in bulk mode
    }

    // ---------------- header menu ----------------
    async menuNewGroup() { this.closeMenus(); await this.openContacts(); this.state.groupMode = true; }
    async openStarred() {
        this.closeMenus(); this.state.showStarred = true;
        try { const res = await rpc('/chat/starred_messages', {}); if (res && res.status) this.state.starredMsgs = res.messages || []; } catch (e) {}
    }
    closeStarred() { this.state.showStarred = false; }
    async unstarFromPanel(sm) {
        try { await rpc('/chat/star', { message_id: sm.id, starred: false }); this.state.starredMsgs = this.state.starredMsgs.filter((x) => x.id !== sm.id); if (this.state.selectedId) this.reloadMessages(false); } catch (e) {}
    }
    async markAllRead() {
        this.closeMenus();
        try { await rpc('/chat/mark_all_read', {}); await this.loadConversations(); if (this.state.selectedId) this.reloadMessages(false); this.notify('All chats marked read', 'success'); } catch (e) {}
    }

    // ---------------- pin ----------------
    async pinConversation(c) {
        this.closeMenus();
        try { const res = await rpc('/chat/pin_conversation', { conversation_id: c.id, pinned: !c.pinned }); if (res && res.status === false) { this.notify(res.message); return; } await this.loadConversations(); } catch (e) {}
    }
    // ---- chat-row menu ----
    async archiveChat(c) { this.closeMenus(); try { await rpc('/chat/archive', { conversation_id: c.id, archived: !c.archived }); await this.loadConversations(); } catch (e) {} }
    async markUnread(c) { this.closeMenus(); try { await rpc('/chat/mark_unread', { conversation_id: c.id }); await this.loadConversations(); } catch (e) {} }
    async toggleFavourite(c) { this.closeMenus(); try { await rpc('/chat/favourite', { conversation_id: c.id, favourite: !c.favourite }); await this.loadConversations(); } catch (e) {} }
    muteChat(c) { this.closeMenus(); if (c.muted) this._doMute(c.id, false, 0); else this.state.muteConv = c; }
    closeMute() { this.state.muteConv = null; }
    confirmMute(hours) { const c = this.state.muteConv; this.state.muteConv = null; if (c) this._doMute(c.id, true, hours); }
    async _doMute(id, muted, hours) { try { await rpc('/chat/mute', { conversation_id: id, muted, hours }); await this.loadConversations(); } catch (e) {} }
    // Styled confirm dialog — returns a Promise<boolean>. Replaces window.confirm so
    // Clear/Delete/etc. use the app's own modal look (o369-modal) instead of the browser's.
    askConfirm({ title, body, okLabel = 'Confirm', danger = false }) {
        return new Promise((resolve) => { this.state.confirm = { title, body, okLabel, danger, resolve }; });
    }
    _confirmResolve(val) {
        const c = this.state.confirm;
        this.state.confirm = null;
        if (c && c.resolve) c.resolve(val);
    }
    async clearChatRow(c) {
        this.closeMenus();
        if (!await this.askConfirm({ title: 'Clear chat', body: 'Clear all messages in this chat? This can\'t be undone.', okLabel: 'Clear', danger: true })) return;
        try { await rpc('/chat/clear_chat', { conversation_id: c.id }); if (this.state.selectedId === c.id) this.reloadMessages(false); this.loadConversations(); } catch (e) {}
    }
    async leaveChatRow(c) {
        this.closeMenus();
        const grp = c.is_group;
        if (!await this.askConfirm({ title: grp ? 'Exit group' : 'Delete chat', body: grp ? 'Are you sure you want to exit this group?' : 'Delete this chat? This can\'t be undone.', okLabel: grp ? 'Exit' : 'Delete', danger: true })) return;
        try { await rpc('/chat/leave_chat', { conversation_id: c.id }); if (this.state.selectedId === c.id) { this.state.selectedId = null; this.state.activeConv = null; } this.loadConversations(); } catch (e) {}
    }

    // ---- contact / group info ----
    async openContactInfo() {
        if (!this.state.selectedId) return;
        this.closeMenus();
        this.state.mediaOpen = false; this.state.permsOpen = false; this.state.nameEditing = false; this.state.descEditing = false;
        try { const res = await rpc('/chat/contact_info', { conversation_id: this.state.selectedId }); if (res && res.status) { this.state.contactInfo = res.info; this.state.nickDraft = res.info.nickname || ''; this.state.groupNameEdit = res.info.name || ''; this.state.infoOpen = true; } } catch (e) {}
    }
    closeContactInfo() { this.state.infoOpen = false; this.state.mediaOpen = false; this.state.permsOpen = false; this.state.nameEditing = false; this.state.descEditing = false; }

    // ---- group info redesign (Feature 2): permission helpers ----
    canEditInfo() { const i = this.state.contactInfo; return !!(i && (i.is_admin || (i.permissions && i.permissions.perm_edit_info))); }
    canAddMembers() { const i = this.state.contactInfo; return !!(i && (i.is_admin || (i.permissions && i.permissions.perm_add_members))); }
    canInvite() { const i = this.state.contactInfo; return !!(i && (i.is_admin || (i.permissions && i.permissions.perm_invite))); }
    async openInvite() {
        const i = this.state.contactInfo; if (!i) return;
        this.state.inviteOpen = true; this.state.inviteLink = ''; this.state.inviteBusy = true;
        try { const r = await rpc('/chat/group/invite', { conversation_id: i.conversation_id, action: 'get' }); if (r && r.status) this.state.inviteLink = r.link || ''; else this.notify((r && r.message) || 'Cannot get link'); } catch (e) {}
        this.state.inviteBusy = false;
    }
    async resetInviteLink() {
        const i = this.state.contactInfo; if (!i) return;
        this.state.inviteBusy = true;
        try { const r = await rpc('/chat/group/invite', { conversation_id: i.conversation_id, action: 'reset' }); if (r && r.status) { this.state.inviteLink = r.link || ''; this.notify('New link created', 'success'); } } catch (e) {}
        this.state.inviteBusy = false;
    }
    async copyInviteLink() {
        try { await navigator.clipboard.writeText(this.state.inviteLink); this.notify('Link copied', 'success'); } catch (e) { this.notify('Could not copy'); }
    }
    closeInvite() { this.state.inviteOpen = false; }

    // ---- disappearing messages ----
    disappearLabel() {
        const s = (this.state.contactInfo && this.state.contactInfo.disappear_seconds) || 0;
        return ({ 0: 'Off', 86400: '24 hours', 604800: '7 days', 7776000: '90 days' })[s] || 'Off';
    }
    openDisappear() {
        const i = this.state.contactInfo; if (!i) return;
        if (i.is_group && !i.is_admin) { this.notify('Only admins can change disappearing messages.'); return; }
        this.state.disappearOpen = true;
    }
    async setDisappear(secs) {
        const i = this.state.contactInfo; this.state.disappearOpen = false; if (!i) return;
        try {
            const res = await rpc('/chat/set_disappear', { conversation_id: i.conversation_id, seconds: secs });
            if (res && res.status === false) { this.notify(res.message); return; }
            i.disappear_seconds = res.disappear_seconds;
            if (this.state.selectedId === i.conversation_id) this.reloadMessages(false);
            this.notify('Disappearing messages updated', 'success');
        } catch (e) {}
    }

    // ---- polls ----
    openPollCreate() { this.state.attachMenu = false; this.state.pollCreate = { question: '', options: ['', ''], multi: false }; }
    closePollCreate() { this.state.pollCreate = null; }
    setPollOption(i, val) { if (this.state.pollCreate) this.state.pollCreate.options[i] = val; }
    addPollOption() { const p = this.state.pollCreate; if (p && p.options.length < 12) p.options.push(''); }
    removePollOption(i) { const p = this.state.pollCreate; if (p && p.options.length > 2) p.options.splice(i, 1); }
    async submitPoll() {
        const p = this.state.pollCreate; if (!p) return;
        const question = (p.question || '').trim();
        const options = p.options.map((o) => (o || '').trim()).filter(Boolean);
        if (!question || options.length < 2) { this.notify('Add a question and at least 2 options.'); return; }
        this.state.pollCreate = null;
        try {
            const res = await rpc('/chat/poll/create', { conversation_id: this.state.selectedId, question, options, multi: p.multi });
            if (res && res.status === false) { this.notify(res.message); return; }
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this._scrollPending = true; this.loadConversations();
            }
        } catch (e) { this.notify('Could not create poll'); }
    }
    pollPct(poll, opt) {
        const mx = Math.max(1, ...(poll.options || []).map((o) => o.votes || 0));
        return Math.round(((opt.votes || 0) / mx) * 100);
    }
    async votePoll(m, opt) {
        try {
            const res = await rpc('/chat/poll/vote', { option_id: opt.id });
            if (res && res.status === false) { this.notify(res.message); return; }
            this._applyMsg(res);
        } catch (e) {}
    }

    // ---------------- nav rail: chats / media / profile ----------------
    async switchPane(p) {
        this.state.pane = p;
        this.closeMenus();
        if (p === 'profile') { this.state.settingsView = 'menu'; await this.loadMe(); }
        else if (p === 'media') { await this.loadAllMedia(); }
        else if (p === 'calls') { await this.loadCalls(); }
    }
    async loadMe() {
        try { const r = await rpc('/chat/me', {}); if (r && r.status) this.state.me = r.me; } catch (e) {}
    }
    // ---- change my profile picture ----
    pickAvatar() { const el = this.avatarinput.el; if (el) { el.value = ''; el.click(); } }
    async onAvatarChosen(ev) {
        const file = (ev.target.files || [])[0]; if (!file) return;
        try {
            const b64 = await this._compressImage(file, 512, 0.85);
            const res = await rpc('/chat/profile', { avatar: b64 });
            if (res && res.status && this.state.me) {
                const url = res.avatar_url || this.state.me.avatar_url || '';
                this.state.me.avatar_url = url ? (url.split('?')[0] + '?t=' + Date.now()) : url;
                this.notify('Profile photo updated', 'success');
                this.loadConversations();
            } else { this.notify('Could not update photo'); }
        } catch (e) { this.notify('Could not update photo'); }
    }
    // ---------------- Google Meet ----------------
    async loadGmeet() {
        try { const r = await rpc('/chat/gmeet/status', {}); if (r && r.status) this.state.gmeet = r; } catch (e) {}
    }
    _meetTriggered(body) {
        const g = this.state.gmeet;
        if (!g || !g.connected || !(g.triggers || []).length) return false;
        return g.triggers.includes((body || '').trim().toLowerCase());
    }
    startMeet() { this.closeMenus(); this.createMeet(); }
    async createMeet() {
        if (!this.state.selectedId) return;
        this.notify('Creating meeting…', 'info');
        try {
            const res = await rpc('/chat/create_meet', { conversation_id: this.state.selectedId });
            if (res && res.status === false) { this.notify(res.message || 'Could not create the meeting'); return; }
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this._scrollPending = true; this.loadConversations();
                // In a group the server also posts "@all Please join the meeting" — pull it in.
                if (this.currentIsGroup()) this.syncMessages();
            }
        } catch (e) { this.notify('Could not create the meeting'); }
    }
    openGmeetSettings() {
        const g = this.state.gmeet;
        this.state.gmeetForm = { client_id: g.client_id || '', client_secret: '',
            triggers: (g.triggers || []).join(', '), scope: g.scope || 'both', admin_only: g.admin_only !== false,
            base_url: g.base_url || '' };
        this.state.gmeetSaved = JSON.stringify(this.state.gmeetForm);  // baseline for the "changed?" check
        this.settingsGo('gmeet');
    }
    // Save button is active only when the form differs from what was last saved.
    gmeetDirty() {
        return JSON.stringify(this.state.gmeetForm) !== (this.state.gmeetSaved || '');
    }
    gmeetRedirect() {
        const b = (this.state.gmeetForm.base_url || '').trim().replace(/\/+$/, '');
        if (b) return b + '/chat/gmeet/oauth/callback';
        return this.state.gmeet.redirect_uri || '';
    }
    async copyRedirect() {
        try { await navigator.clipboard.writeText(this.gmeetRedirect()); this.notify('Copied', 'success'); } catch (e) { this.notify('Could not copy'); }
    }
    async saveGmeet() {
        const f = this.state.gmeetForm;
        try {
            const r = await rpc('/chat/gmeet/config', { client_id: f.client_id, client_secret: f.client_secret,
                triggers: f.triggers, scope: f.scope, admin_only: f.admin_only, base_url: f.base_url });
            if (r && r.status) { this.notify('Saved', 'success'); this.state.gmeetSaved = JSON.stringify(this.state.gmeetForm); this.loadGmeet(); }
            else this.notify((r && r.message) || 'Save failed');
        } catch (e) {}
    }
    connectGmeet() { window.location.href = '/chat/gmeet/oauth/start'; }
    async loadAllMedia() {
        this.state.mediaAllBusy = true; this.state.mediaAllItems = [];
        try { const r = await rpc('/chat/all_media', { tab: this.state.mediaAllTab }); if (r && r.status) this.state.mediaAllItems = r.items || []; } catch (e) {}
        this.state.mediaAllBusy = false;
    }
    setAllMediaTab(t) { if (this.state.mediaAllTab !== t) { this.state.mediaAllTab = t; this.loadAllMedia(); } }
    groupedAllMedia() {
        const out = []; let cur = null;
        for (const it of this.state.mediaAllItems) {
            const label = it.month_label || '';
            if (!cur || cur.label !== label) { cur = { label, items: [] }; out.push(cur); }
            cur.items.push(it);
        }
        return out;
    }
    fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); const ss = s % 60; return m + ':' + (ss < 10 ? '0' + ss : ss); }
    // ---------------- rich media viewer (sender/date + download + prev/next + filmstrip) ----------------
    openMediaViewer(it) {
        const src = this.state.mediaAllItems.filter((x) => x.kind === 'image' || x.kind === 'video');
        const list = src.map((x) => ({ id: x.id, url: x.url, kind: x.kind, name: x.name, author: x.chat, date: x.created }));
        let idx = src.findIndex((x) => x.id === it.id); if (idx < 0) idx = 0;
        this.state.viewer = { list, idx, zoom: 1 };
    }
    openMsgViewer(m) {
        const src = this.state.messages.filter((x) => (x.kind === 'image' || x.kind === 'video') && x.media_url && !x.deleted);
        const list = src.map((x) => ({ id: x.id, url: x.media_url, kind: x.kind, name: x.file_name, author: x.mine ? 'You' : x.author_name, date: x.created }));
        let idx = src.findIndex((x) => x.id === m.id); if (idx < 0) idx = 0;
        this.state.viewer = { list, idx, zoom: 1 };
    }
    viewerCur() { const v = this.state.viewer; return (v && v.list[v.idx]) ? v.list[v.idx] : null; }
    viewerMsg() { const c = this.viewerCur(); return (c && c.id) ? (this.state.messages.find((m) => m.id === c.id) || null) : null; }
    viewerHasPrev() { const v = this.state.viewer; return !!(v && v.idx > 0); }
    viewerHasNext() { const v = this.state.viewer; return !!(v && v.idx < v.list.length - 1); }
    viewerPrev() { if (this.viewerHasPrev()) { this.state.viewer.idx--; this.state.viewer.zoom = 1; } }
    viewerNext() { if (this.viewerHasNext()) { this.state.viewer.idx++; this.state.viewer.zoom = 1; } }
    viewerGo(i) { if (this.state.viewer) { this.state.viewer.idx = i; this.state.viewer.zoom = 1; } }
    viewerZoom(d) { const v = this.state.viewer; if (v) v.zoom = Math.min(4, Math.max(1, (v.zoom || 1) + d)); }
    viewerReply() { const m = this.viewerMsg(); if (m) { this.closeViewer(); this.startReply(m); } }
    viewerStar() { const m = this.viewerMsg(); if (m) this.toggleStar(m); }
    viewerForward() { const m = this.viewerMsg(); if (m) { this.closeViewer(); this.openForward(m); } }
    viewerReact() { const m = this.viewerMsg(); if (m) { this.closeViewer(); this.openEmojiPicker(m); } }
    closeViewer() { this.state.viewer = null; }
    // ---------------- settings / profile ----------------
    settingsGo(v) { this.state.settingsView = v; this.state.profileEdit = { field: null, val: '' }; }
    startProfileEdit(field) { this.state.profileEdit = { field, val: (this.state.me && this.state.me[field]) || '' }; }
    async saveProfileField(field, value) {
        const params = {}; params[field] = value;
        try { const r = await rpc('/chat/profile', params); if (r && r.status && this.state.me) { this.state.me.name = r.name; this.state.me.about = r.about; this.state.me.avatar_url = r.avatar_url; this.notify('Saved', 'success'); this.loadConversations(); } } catch (e) {}
        this.state.profileEdit = { field: null, val: '' };
    }
    async setPrivacyField(field, value) {
        if (this.state.me) this.state.me[field] = value;
        const params = {}; params[field] = value;
        try { const r = await rpc('/chat/privacy', params); if (r && r.status && this.state.me) { this.state.me.last_seen_privacy = r.last_seen_privacy; this.state.me.online_privacy = r.online_privacy; } } catch (e) {}
    }
    async toggleSetting(field) {
        if (!this.state.me) return;
        const val = !this.state.me[field]; this.state.me[field] = val;
        const params = {}; params[field] = val;
        try { await rpc('/chat/settings', params); } catch (e) {}
        if (field === 'read_receipts' && this.state.selectedId) this.syncMessages();
    }
    copyMyMobile() { try { navigator.clipboard.writeText((this.state.me && this.state.me.mobile) || ''); this.notify('Copied', 'success'); } catch (e) { this.notify('Could not copy'); } }
    logout() { window.location.href = '/web/session/logout?redirect=/web/login'; }
    // ---------------- browser notifications (WhatsApp-Web-style) ----------------
    async enableBrowserNotifs() {
        if (!('Notification' in window)) { this.notify('Notifications are not supported here'); return; }
        try { const p = await Notification.requestPermission(); this.notify(p === 'granted' ? 'Browser notifications enabled' : 'Notifications blocked in the browser', p === 'granted' ? 'success' : 'warning'); } catch (e) {}
    }
    _msgPreview(m) {
        if (!m) return 'New message';
        if (m.kind === 'text') return m.body || '';
        return ({ image: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice message', document: '📄 Document' })[m.kind] || 'New message';
    }
    _maybeNotify(p) {
        // bus 'message' events are only sent to me for OTHER people's messages.
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const me = this.state.me;
        const conv = this.state.conversations.find((c) => c.id === p.conversation_id);
        const isGroup = conv ? conv.is_group : false;
        if (me) { if (isGroup && !me.notif_groups) return; if (!isGroup && !me.notif_messages) return; }
        if (p.conversation_id === this.state.selectedId && this.state.pane === 'chats' && document.hasFocus()) return;
        const m = p.message;
        const title = (conv && conv.title) || (m && m.author_name) || 'New message';
        const body = (me && !me.notif_preview) ? 'New message' : this._msgPreview(m);
        try {
            const n = new Notification(title, { body, tag: 'chat369-' + p.conversation_id });
            n.onclick = () => { window.focus(); this.state.pane = 'chats'; if (conv) this.select(conv); n.close(); };
        } catch (e) {}
        if (!me || me.notif_sound) this._beep();
    }
    _beep() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
            this._actx = this._actx || new Ctx();
            const o = this._actx.createOscillator(); const g = this._actx.createGain();
            o.frequency.value = 660; g.gain.value = 0.05; o.connect(g); g.connect(this._actx.destination);
            o.start(); o.stop(this._actx.currentTime + 0.12);
        } catch (e) {}
    }
    // Inline group-name edit (reuses renameGroup + state.groupNameEdit).
    startNameEdit() { if (!this.canEditInfo()) return; this.state.groupNameEdit = this.state.contactInfo.name || this.state.contactInfo.title || ''; this.state.nameEditing = true; }
    cancelNameEdit() { this.state.nameEditing = false; }
    async saveGroupName() { await this.renameGroup(); this.state.nameEditing = false; }
    // Inline group description edit (Feature 2).
    startDescEdit() { if (!this.canEditInfo()) return; this.state.descDraft = (this.state.contactInfo && this.state.contactInfo.description) || ''; this.state.descEditing = true; }
    cancelDescEdit() { this.state.descEditing = false; }
    async saveDesc() {
        const i = this.state.contactInfo; if (!i) return;
        const desc = (this.state.descDraft || '').trim();
        try { const res = await rpc('/chat/group/update', { conversation_id: i.conversation_id, action: 'description', description: desc }); if (res && res.status === false) { this.notify(res.message); return; } i.description = desc; this.state.descEditing = false; this.notify('Description updated', 'success'); } catch (e) {}
    }
    searchFromInfo() { this.state.infoOpen = false; this.state.searchOpen = true; this.state.searchQ = ''; this.state.searchResults = []; }

    // ---- add-members picker (Feature 2) ----
    async openAddMembers() {
        const i = this.state.contactInfo; if (!i) return;
        this.state.addMemberSel = []; this.state.addMemberContacts = []; this.state.addMembersOpen = true;
        try { const res = await rpc('/chat/contacts', {}); if (res && res.status) { const have = new Set((i.members || []).map((m) => m.id)); this.state.addMemberContacts = (res.contacts || []).filter((u) => !have.has(u.id)); } } catch (e) {}
    }
    closeAddMembers() { this.state.addMembersOpen = false; }
    toggleAddMemberSel(id) { const a = this.state.addMemberSel; const idx = a.indexOf(id); if (idx >= 0) a.splice(idx, 1); else a.push(id); }
    async confirmAddMembers() {
        const i = this.state.contactInfo; const ids = [...this.state.addMemberSel];
        this.state.addMembersOpen = false; if (!i || !ids.length) return;
        try { const res = await rpc('/chat/group/update', { conversation_id: i.conversation_id, action: 'add', member_ids: ids }); if (res && res.status === false) { this.notify(res.message); return; } this._refreshInfo(i.conversation_id); this.loadConversations(); this.notify('Members added', 'success'); } catch (e) {}
    }

    // ---- media viewer (Feature 3) ----
    openMedia() { this.state.mediaOpen = true; this.state.mediaTab = 'media'; this.loadMediaList(); }
    closeMedia() { this.state.mediaOpen = false; }
    setMediaTab(t) { this.state.mediaTab = t; this.loadMediaList(); }
    async loadMediaList() {
        const i = this.state.contactInfo; if (!i) return; this.state.mediaItems = [];
        try { const res = await rpc('/chat/media_list', { conversation_id: i.conversation_id, tab: this.state.mediaTab }); if (res && res.status) this.state.mediaItems = res.items || []; } catch (e) {}
    }
    groupedMedia() {
        const groups = []; let cur = null;
        for (const it of this.state.mediaItems) {
            if (!cur || cur.label !== it.month_label) { cur = { label: it.month_label, items: [] }; groups.push(cur); }
            cur.items.push(it);
        }
        return groups;
    }

    // ---- group permissions (Feature 4) ----
    togglePerms() { this.state.permsOpen = true; }
    closePerms() { this.state.permsOpen = false; }
    permOn(field) { const i = this.state.contactInfo; return !!(i && i.permissions && i.permissions[field]); }
    async togglePerm(field) {
        const i = this.state.contactInfo; if (!i || !i.permissions) return;
        const val = !i.permissions[field];
        i.permissions[field] = val;   // optimistic
        try { const res = await rpc('/chat/group/permissions', { conversation_id: i.conversation_id, field, value: val }); if (res && res.status === false) { this.notify(res.message); i.permissions[field] = !val; return; } if (res && res.permissions) i.permissions = res.permissions; } catch (e) { i.permissions[field] = !val; }
    }
    mediaTotal() { const m = this.state.contactInfo && this.state.contactInfo.media; return m ? (m.photos + m.videos + m.docs) : 0; }
    async saveNick() {
        const info = this.state.contactInfo; if (!info || !info.user_id) return;
        try { await rpc('/chat/set_nickname', { user_id: info.user_id, nick: this.state.nickDraft }); if (this.state.activeConv) this.state.activeConv.title = this.state.nickDraft || info.name; info.title = this.state.nickDraft || info.name; this.loadConversations(); this.notify('Nickname saved', 'success'); } catch (e) {}
    }
    async favFromInfo() {
        const info = this.state.contactInfo; if (!info) return;
        try { await rpc('/chat/favourite', { conversation_id: info.conversation_id, favourite: !info.favourite }); info.favourite = !info.favourite; this.loadConversations(); } catch (e) {}
    }
    addToListFromInfo() { const c = this.state.conversations.find((x) => x.id === this.state.selectedId) || { id: this.state.selectedId }; this.state.infoOpen = false; this.openAddToList(c); }
    async headerClear() {
        this.closeMenus(); if (!this.state.selectedId) return;
        if (!await this.askConfirm({ title: 'Clear chat', body: 'Clear all messages in this chat? This can\'t be undone.', okLabel: 'Clear', danger: true })) return;
        try { await rpc('/chat/clear_chat', { conversation_id: this.state.selectedId }); this.reloadMessages(false); this.loadConversations(); } catch (e) {}
    }
    async headerLeave() {
        this.closeMenus(); const id = this.state.selectedId; if (!id) return;
        const grp = this.currentIsGroup();
        if (!await this.askConfirm({ title: grp ? 'Exit group' : 'Delete chat', body: grp ? 'Are you sure you want to exit this group?' : 'Delete this chat? This can\'t be undone.', okLabel: grp ? 'Exit' : 'Delete', danger: true })) return;
        try { await rpc('/chat/leave_chat', { conversation_id: id }); this.state.infoOpen = false; this.state.selectedId = null; this.state.activeConv = null; this.loadConversations(); } catch (e) {}
    }

    // ---------------- media / attachments (Phase 2) ----------------
    toggleAttach() { const open = this.state.attachMenu; this.closeMenus(); this.state.attachMenu = !open; }
    pickFile(kind) {
        this.state.attachMenu = false; this._pendingGroupPhoto = false; this._pendingKind = kind;
        const el = this.fileinput.el;
        if (el) { el.accept = kind === 'image' ? 'image/*,video/*' : (kind === 'audio' ? 'audio/*' : '*/*'); el.multiple = (kind === 'image'); el.value = ''; el.click(); }
    }
    onFileChosen(ev) {
        const files = Array.from(ev.target.files || []); if (!files.length) return;
        if (this._pendingGroupPhoto) {
            this._pendingGroupPhoto = false;
            this._compressImage(files[0], 640, 0.7).then((b64) => this._setGroupPhoto(b64));
            return;
        }
        const kind = this._pendingKind || 'document';
        // Photos & videos → a review tray (multiple, per-item caption, view-once toggle).
        if (kind === 'image') { this._buildMediaReview(files); return; }
        // Audio / document → send the single file as before.
        const file = files[0];
        const reader = new FileReader();
        reader.onload = () => { const b64 = String(reader.result).split(',')[1] || ''; this.sendMedia(kind, b64, file.name, file.type); };
        reader.readAsDataURL(file);
    }
    _readB64(file) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(file); }); }
    async _buildMediaReview(files) {
        const items = [];
        for (const file of files.slice(0, 10)) {
            const isVideo = (file.type || '').startsWith('video');
            if (isVideo) {
                const b64 = await this._readB64(file);
                items.push({ kind: 'video', b64, name: file.name, mime: file.type || 'video/mp4', caption: '', previewUrl: URL.createObjectURL(file) });
            } else {
                const b64 = await this._compressImage(file, 1280, 0.7);
                items.push({ kind: 'image', b64, name: this._renameImg(file.name), mime: 'image/jpeg', caption: '', previewUrl: 'data:image/jpeg;base64,' + b64 });
            }
        }
        if (items.length) this.state.mediaReview = { items, idx: 0, viewOnce: false };
    }
    mrCur() { const r = this.state.mediaReview; return r ? r.items[r.idx] : null; }
    setReviewCaption(v) { const c = this.mrCur(); if (c) c.caption = v; }
    closeMediaReview() {
        const r = this.state.mediaReview; this.state.mediaReview = null;
        if (r) r.items.forEach((it) => { if (it.kind === 'video' && it.previewUrl) { try { URL.revokeObjectURL(it.previewUrl); } catch (e) {} } });
    }
    async sendMediaReview() {
        const r = this.state.mediaReview; if (!r) return;
        const items = r.items, viewOnce = r.viewOnce; this.state.mediaReview = null;
        for (const it of items) {
            await this.sendMedia(it.kind, it.b64, it.name, it.mime, 0, it.caption, viewOnce);
            if (it.kind === 'video' && it.previewUrl) { try { URL.revokeObjectURL(it.previewUrl); } catch (e) {} }
        }
    }
    // ---- view once (open a single time, then it's gone) ----
    openViewOnce(m) {
        if (m.mine || m.viewed || !m.media_url) { this.notify('This can only be opened once.'); return; }
        this.state.viewOnceView = { id: m.id, url: m.media_url, kind: m.kind };
    }
    async closeViewOnce() {
        const v = this.state.viewOnceView; this.state.viewOnceView = null;
        if (v) { try { const res = await rpc('/chat/view_once_seen', { message_id: v.id }); this._applyMsg(res); } catch (e) {} this.reloadMessages(false); }
    }
    // ---- block / unblock ----
    async toggleBlock() {
        const i = this.state.contactInfo; if (!i || !i.user_id) return;
        const willBlock = !i.blocked_by_me;
        if (willBlock && !await this.askConfirm({ title: 'Block ' + i.name, body: "Blocked contacts can't message you, and you can't message them.", okLabel: 'Block', danger: true })) return;
        try {
            const res = await rpc('/chat/block', { user_id: i.user_id, blocked: willBlock });
            if (res && res.status === false) { this.notify(res.message); return; }
            i.blocked_by_me = willBlock;
            if (this.state.activeConv) this.state.activeConv.blocked_by_me = willBlock;
            this.loadConversations();
            this.notify(willBlock ? 'Contact blocked' : 'Contact unblocked', 'success');
        } catch (e) {}
    }
    async unblockFromBar() {
        const c = this.state.activeConv; if (!c) return;
        let uid = this.state.contactInfo && this.state.contactInfo.user_id;
        if (!uid) { try { const r = await rpc('/chat/contact_info', { conversation_id: c.id }); if (r && r.status) uid = r.info.user_id; } catch (e) {} }
        if (!uid) return;
        try {
            const res = await rpc('/chat/block', { user_id: uid, blocked: false });
            if (res && res.status === false) { this.notify(res.message); return; }
            c.blocked_by_me = false;
            if (this.state.contactInfo) this.state.contactInfo.blocked_by_me = false;
            this.loadConversations(); this.notify('Contact unblocked', 'success');
        } catch (e) {}
    }
    linkDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
    // First http(s) URL in a message body (drops trailing punctuation).
    firstUrlIn(body) {
        if (!body) return '';
        const m = String(body).match(/https?:\/\/[^\s]+/i);
        return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : '';
    }
    // The link-preview card to render under a message: the server-fetched one if
    // present, else a client-fetched one (kept in state.previews, keyed by URL).
    linkCard(m) {
        if (!m || m.deleted || m.is_meet) return null;
        if (m.link) return m.link;
        const u = this.firstUrlIn(m.body);
        if (!u) return null;
        const p = this.state.previews[u];
        return (p && typeof p === 'object') ? p : null;
    }
    // For every loaded message with a URL but no card yet, fetch one (once per URL).
    _scanPreviews() {
        const todo = [];
        for (const m of this.state.messages) {
            if (!m || m.deleted || m.is_meet || m.link) continue;
            const u = this.firstUrlIn(m.body);
            if (u && !(u in this.state.previews)) todo.push(u);
        }
        for (const u of todo) {
            this.state.previews[u] = false;   // mark in-flight so we only fetch once
            rpc('/chat/link_preview', { url: u }).then((res) => {
                if (res && res.status && (res.title || res.image)) {
                    this.state.previews[u] = { url: u, title: res.title, desc: res.desc, image: res.image };
                }
            }).catch(() => {});
        }
    }
    // ---- compose-time link preview (WhatsApp-style card above the input) ----
    _detectComposerLink() {
        const d = this.state.draft || '';
        const m = d.match(/https?:\/\/[^\s]+/i);
        const url = m ? m[0].replace(/[.,;:!?)\]]+$/, '') : '';
        if (!url) { this._clearComposerLink(); return; }
        if (url === this._composerLinkUrl) return;
        this._composerLinkUrl = url;
        this.state.composerLink = null; this.state.composerLinkHidden = false;
        clearTimeout(this._complinkTimer);
        this._complinkTimer = setTimeout(async () => {
            try {
                const res = await rpc('/chat/link_preview', { url });
                if (res && res.status && (res.title || res.image) && this._composerLinkUrl === url) {
                    this.state.composerLink = { url, title: res.title, desc: res.desc, image: res.image };
                }
            } catch (e) {}
        }, 600);
    }
    _clearComposerLink() { this.state.composerLink = null; this.state.composerLinkHidden = false; this._composerLinkUrl = ''; clearTimeout(this._complinkTimer); }
    // ---- theme ----
    setTheme(t) { this.state.theme = t; try { localStorage.setItem('o369_theme', t); } catch (e) {} }
    // Light / dark mode (WhatsApp-style: System default / Light / Dark).
    _applyThemeMode() {
        const m = this.state.themeMode;
        let dark = (m === 'dark');
        if (m === 'system') { try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { dark = false; } }
        this.state.dark = dark;
    }
    setThemeMode(mode) {
        this.state.themeMode = mode;
        try { localStorage.setItem('o369_thememode', mode); } catch (e) {}
        this._applyThemeMode();
    }
    toggleDark() { this.setThemeMode(this.state.dark ? 'light' : 'dark'); }
    // Reset all appearance choices back to the default 369Chats look.
    resetAppearance() {
        this.setThemeMode('system');
        this.setTheme('clean');
        try { localStorage.removeItem('o369_wallpaper'); } catch (e) {}
        this.notify('Appearance reset to default', 'success');
    }

    // ================= In-app calls (WebRTC, 1:1) =================
    canCall() { const c = this.state.activeConv; return !!(c && !c.is_group && !c.oversight && !c.blocked_by_me); }
    async _iceConfig() {
        if (this._iceCache) return this._iceCache;
        try { const r = await rpc('/chat/call/ice', {}); this._iceCache = (r && r.ice) || [{ urls: 'stun:stun.l.google.com:19302' }]; }
        catch (e) { this._iceCache = [{ urls: 'stun:stun.l.google.com:19302' }]; }
        return this._iceCache;
    }
    _getMedia(video) { return navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 1280, height: 720 } : false }); }
    _createPc(ice) {
        const pc = new RTCPeerConnection({ iceServers: ice });
        if (this._localStream) this._localStream.getTracks().forEach((t) => pc.addTrack(t, this._localStream));
        this._remoteStream = new MediaStream();
        pc.ontrack = (ev) => { (ev.streams[0] || new MediaStream([ev.track])).getTracks().forEach((t) => this._remoteStream.addTrack(t)); };
        pc.onicecandidate = (ev) => { if (ev.candidate) this._signal('ice', ev.candidate); };
        pc.onconnectionstatechange = () => {
            const c = this.state.call; if (!c) return;
            if (pc.connectionState === 'connected' && c.status !== 'connected') { c.status = 'connected'; this._stopRing(); this._startCallTimer(); }
            if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && c.status === 'connected') this.endCall();
        };
        this._pendingIce = [];
        return pc;
    }
    async _signal(kind, data) {
        const c = this.state.call; if (!c) return;
        try { await rpc('/chat/call/signal', { conversation_id: c.convId, call_id: c.id, kind, data: JSON.stringify(data) }); } catch (e) {}
    }
    async startCall(video) {
        if (this.state.call) return;
        const conv = this.state.activeConv; if (!conv || conv.is_group) { this.notify('Calls are 1:1 only.'); return; }
        if (!navigator.mediaDevices || !window.RTCPeerConnection) { this.notify('Calls are not supported in this browser.'); return; }
        this.closeMenus();
        try { this._localStream = await this._getMedia(video); }
        catch (e) { this.notify('Camera/mic blocked — calls need HTTPS or localhost.'); return; }
        const ice = await this._iceConfig();
        this.state.call = { id: null, convId: conv.id, video, status: 'outgoing', caller: true,
            name: conv.title, avatar: conv.avatar_url, muted: false, camOff: false, secs: 0 };
        this._pc = this._createPc(ice);
        this._startRing(true);
        try {
            const r = await rpc('/chat/call/start', { conversation_id: conv.id, video });
            if (r && r.status === false) { this.notify(r.message); this._teardownCall(); return; }
            this.state.call.id = r.call_id; if (r.ice) this._iceCache = r.ice;
        } catch (e) { this.notify('Could not start the call'); this._teardownCall(); }
    }
    _onCallRing(p) {
        if (this.state.call) { rpc('/chat/call/reject', { conversation_id: p.conversation_id, call_id: p.call_id }).catch(() => {}); return; }
        this.state.call = { id: p.call_id, convId: p.conversation_id, video: p.video, status: 'incoming', caller: false,
            name: p.name, avatar: p.avatar, from_id: p.from_id, muted: false, camOff: false, secs: 0 };
        this._startRing(false);
    }
    async acceptCall() {
        const c = this.state.call; if (!c || c.status !== 'incoming') return;
        if (!navigator.mediaDevices) { this.rejectCall(); return; }
        try { this._localStream = await this._getMedia(c.video); }
        catch (e) { this.notify('Camera/mic blocked — calls need HTTPS or localhost.'); this.rejectCall(); return; }
        const ice = await this._iceConfig();
        this._pc = this._createPc(ice);
        this._stopRing(); c.status = 'connecting';
        try { await rpc('/chat/call/accept', { conversation_id: c.convId, call_id: c.id }); } catch (e) {}
    }
    async _onCallAccept(p) {
        const c = this.state.call; if (!c || !c.caller || !this._pc) return;
        try { const offer = await this._pc.createOffer(); await this._pc.setLocalDescription(offer); this._signal('offer', offer); } catch (e) {}
    }
    async _onCallSignal(p) {
        const c = this.state.call; if (!c || !this._pc) return;
        let data; try { data = JSON.parse(p.data); } catch (e) { return; }
        try {
            if (p.kind === 'offer') {
                await this._pc.setRemoteDescription(new RTCSessionDescription(data));
                await this._flushIce();
                const answer = await this._pc.createAnswer(); await this._pc.setLocalDescription(answer); this._signal('answer', answer);
            } else if (p.kind === 'answer') {
                await this._pc.setRemoteDescription(new RTCSessionDescription(data)); await this._flushIce();
            } else if (p.kind === 'ice') {
                if (this._pc.remoteDescription && this._pc.remoteDescription.type) await this._pc.addIceCandidate(new RTCIceCandidate(data));
                else (this._pendingIce = this._pendingIce || []).push(data);
            }
        } catch (e) {}
    }
    async _flushIce() {
        if (!this._pendingIce || !this._pendingIce.length) return;
        for (const cand of this._pendingIce) { try { await this._pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {} }
        this._pendingIce = [];
    }
    async rejectCall() {
        const c = this.state.call; if (!c) return;
        try { await rpc('/chat/call/reject', { conversation_id: c.convId, call_id: c.id }); } catch (e) {}
        this._teardownCall();
    }
    _onCallReject(p) { if (this.state.call && this.state.call.caller) { this.notify('Call declined'); this.endCall(); } }
    _onCallEnd(p) { if (this.state.call) this._teardownCall(); }
    async endCall() {
        const c = this.state.call; if (!c) return;
        const convId = c.convId, wasConnected = (c.status === 'connected'), dur = c.secs || 0, caller = c.caller, video = c.video;
        this._teardownCall();
        try { await rpc('/chat/call/end', { conversation_id: convId, call_id: c.id, duration: dur, missed: wasConnected ? 0 : 1, video: video ? 1 : 0, log: caller ? 1 : 0 }); } catch (e) {}
        if (this.state.selectedId === convId) this.reloadMessages(false);
        if (caller) this.loadCalls();
    }
    toggleMute() { const c = this.state.call; if (!c || !this._localStream) return; c.muted = !c.muted; this._localStream.getAudioTracks().forEach((t) => (t.enabled = !c.muted)); }
    toggleCam() { const c = this.state.call; if (!c || !this._localStream) return; c.camOff = !c.camOff; this._localStream.getVideoTracks().forEach((t) => (t.enabled = !c.camOff)); }
    _startCallTimer() { clearInterval(this._callTimer); this._callTimer = setInterval(() => { if (this.state.call) this.state.call.secs++; }, 1000); }
    callTimeLabel() { const s = (this.state.call && this.state.call.secs) || 0; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    callStatusLabel() {
        const c = this.state.call; if (!c) return '';
        if (c.status === 'connected') return this.callTimeLabel();
        if (c.status === 'outgoing') return 'Ringing…';
        if (c.status === 'connecting') return 'Connecting…';
        return c.video ? 'Incoming video call' : 'Incoming voice call';
    }
    _teardownCall() {
        clearInterval(this._callTimer); this._callTimer = null; this._stopRing();
        try { if (this._pc) { this._pc.onicecandidate = null; this._pc.ontrack = null; this._pc.onconnectionstatechange = null; this._pc.close(); } } catch (e) {}
        this._pc = null;
        try { if (this._localStream) this._localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        this._localStream = null; this._remoteStream = null; this._pendingIce = null; this.state.call = null;
    }
    _startRing(outgoing) {
        this._stopRing();
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
            this._ringCtx = this._ringCtx || new Ctx(); const ctx = this._ringCtx;
            const beep = () => {
                if (!this._ringOn) return;
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.frequency.value = outgoing ? 440 : 523; g.gain.value = 0.07;
                o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
            };
            this._ringOn = true; beep(); this._ringTimer = setInterval(beep, outgoing ? 1600 : 1100);
        } catch (e) {}
    }
    _stopRing() { this._ringOn = false; if (this._ringTimer) { clearInterval(this._ringTimer); this._ringTimer = null; } }

    // ---- Calls tab (history / favourites / scheduled) ----
    async loadCalls() {
        try { const r = await rpc('/chat/calls', {}); if (r && r.status) this.state.calls = { recent: r.recent || [], favorites: r.favorites || [], upcoming: r.upcoming || [] }; } catch (e) {}
    }
    oneToOneConvs() { return (this.state.conversations || []).filter((c) => !c.is_group); }
    async openCallChatId(convId, name, avatar) {
        if (!convId) return;
        this.state.pane = 'chats';
        let conv = this.state.conversations.find((c) => c.id === convId);
        if (!conv) conv = { id: convId, is_group: false, title: name, avatar_url: avatar };
        await this.select(conv);
    }
    async callBack(cl) { await this.openCallChatId(cl.conversation_id, cl.name, cl.avatar); if (cl.conversation_id) this.startCall(cl.video); }
    async quickCall(fv, video) { await this.openCallChatId(fv.conversation_id, fv.name, fv.avatar); this.startCall(video); }
    async startScheduled(up) { if (!up.conversation_id) return; await this.openCallChatId(up.conversation_id, up.title, false); this.startCall(up.video); }
    openSchedule() { this.state.scheduleForm = { title: '', conversation_id: '', when: '', video: false }; }
    closeSchedule() { this.state.scheduleForm = null; }
    async submitSchedule() {
        const f = this.state.scheduleForm; if (!f || !f.title || !f.when) return;
        let whenIso; try { whenIso = new Date(f.when).toISOString(); } catch (e) { whenIso = f.when; }
        this.state.scheduleForm = null;
        try {
            const r = await rpc('/chat/call/schedule', { title: f.title, when: whenIso, video: f.video, conversation_id: f.conversation_id ? parseInt(f.conversation_id) : 0 });
            if (r && r.status === false) { this.notify(r.message); return; }
            this.loadCalls(); this.notify('Call scheduled', 'success');
        } catch (e) {}
    }
    async cancelSchedule(up) {
        try { await rpc('/chat/call/schedule/cancel', { id: up.id }); this.loadCalls(); } catch (e) {}
    }
    _checkScheduledCalls() {
        const up = (this.state.calls && this.state.calls.upcoming) || []; if (!up.length) return;
        const now = Date.now(); this._remindedScheds = this._remindedScheds || {};
        for (const s of up) {
            const t = new Date(s.when).getTime();
            if (!isNaN(t) && t <= now + 30000 && t >= now - 60000 && !this._remindedScheds[s.id]) {
                this._remindedScheds[s.id] = true;
                try { if (('Notification' in window) && Notification.permission === 'granted') new Notification('📞 Scheduled call', { body: s.title, tag: 'sched-' + s.id }); } catch (e) {}
                this._beep(); this.notify('📞 Scheduled call now: ' + s.title, 'info');
            }
        }
    }
    fmtCallDur(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    fmtWhen(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return ''; return d.toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    _renameImg(name) { return (name || 'image').replace(/\.[^.]+$/, '') + '.jpg'; }
    // Downscale + JPEG-recompress an image in the browser to keep Odoo storage small.
    _compressImage(file, maxSide, quality) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    let w = img.width, h = img.height;
                    if (w > maxSide || h > maxSide) { if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; } else { w = Math.round(w * maxSide / h); h = maxSide; } }
                    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve((canvas.toDataURL('image/jpeg', quality || 0.7).split(',')[1]) || '');
                };
                img.onerror = () => resolve(String(reader.result).split(',')[1] || '');
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }
    // POST media over XHR so we get upload progress (the rpc helper can't report it).
    _postMediaWithProgress(params, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/chat/send_media', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText).result); } catch (err) { reject(err); }
                } else { reject(new Error('HTTP ' + xhr.status)); }
            };
            xhr.onerror = () => reject(new Error('network'));
            xhr.send(JSON.stringify({ jsonrpc: '2.0', method: 'call', params }));
        });
    }
    async sendMedia(kind, b64, name, mime, duration, caption, viewOnce) {
        if (!this.state.selectedId || !b64) return;
        const replyId = this.state.replyTo ? this.state.replyTo.id : 0;
        this.state.replyTo = null;   // clear the reply bar so it can't imply a phantom reply
        // Optimistic "uploading" bubble with a live % + MB ring.
        const fileMB = (b64.length * 0.75) / (1024 * 1024);
        const tempId = 'tmp-' + Date.now() + '-' + Math.round(fileMB * 1000);
        const preview = (kind === 'image') ? ('data:' + (mime || 'image/jpeg') + ';base64,' + b64) : '';
        this.state.messages.push({
            id: tempId, mine: true, kind, deleted: false, pinned: false, starred: false, edited: false,
            reactions: [], body: caption || '', author_name: 'You', created: new Date().toISOString(),
            status: 'sent', _pending: true, _uploading: true, _progress: 0, _upmb: '0.0',
            _totmb: fileMB.toFixed(1), _preview: preview, view_once: !!viewOnce, media_url: false, reply_to_id: false,
        });
        this._scrollPending = true;
        const temp = this.state.messages[this.state.messages.length - 1];
        const params = { conversation_id: this.state.selectedId, kind, file_b64: b64, file_name: name || '',
            mimetype: mime || '', duration: duration || 0, reply_to_id: replyId, caption: caption || '', view_once: viewOnce ? 1 : 0 };
        try {
            const res = await this._postMediaWithProgress(params, (loaded, total) => {
                const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
                temp._progress = pct; temp._upmb = ((pct / 100) * fileMB).toFixed(1);
            });
            this.state.messages = this.state.messages.filter((m) => m.id !== tempId);
            if (res && res.status === false) { this.notify(res.message); return; }
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this._scrollPending = true; this.loadConversations();
            }
        } catch (e) {
            this.state.messages = this.state.messages.filter((m) => m.id !== tempId);
            this.notify('Could not send file');
        }
    }
    micOrSend() { if ((this.state.draft || '').trim()) this.send(); else if (this.state.recording) this.stopRecording(); else this.startRecording(); }
    async startRecording() {
        if (!navigator.mediaDevices || !window.MediaRecorder) { this.notify('Recording not supported here'); return; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._chunks = []; this._recStart = new Date().getTime();
            this._recorder = new MediaRecorder(stream);
            this._recorder.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
            this._recorder.onstop = () => {
                const blob = new Blob(this._chunks, { type: 'audio/webm' });
                const dur = Math.round((new Date().getTime() - this._recStart) / 1000);
                const reader = new FileReader();
                reader.onload = () => { const b64 = String(reader.result).split(',')[1] || ''; if (b64) this.sendMedia('audio', b64, 'voice-message.webm', 'audio/webm', dur); };
                reader.readAsDataURL(blob);
                stream.getTracks().forEach((t) => t.stop());
            };
            this._recorder.start(); this.state.recording = true; this.state.recPaused = false; this.state.recSecs = 0;
            this._recTimer = setInterval(() => { if (!this.state.recPaused) this.state.recSecs++; }, 1000);
        } catch (e) { this.notify('Microphone access denied'); }
    }
    _clearRecTimer() { if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null; } }
    recTimeLabel() { const s = this.state.recSecs || 0; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    toggleRecPause() {
        if (!this._recorder) return;
        try {
            if (this.state.recPaused) { this._recorder.resume(); this.state.recPaused = false; }
            else { this._recorder.pause(); this.state.recPaused = true; }
        } catch (e) {}
    }
    stopRecording() { this._clearRecTimer(); try { if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop(); } catch (e) {} this.state.recording = false; this.state.recPaused = false; }
    cancelRecording() { this._clearRecTimer(); this._chunks = []; try { if (this._recorder) { this._recorder.onstop = null; this._recorder.stop(); this._recorder.stream && this._recorder.stream.getTracks().forEach((t) => t.stop()); } } catch (e) {} this.state.recording = false; this.state.recPaused = false; }
    openLightbox(url) { this.state.lightbox = url; }
    closeLightbox() { this.state.lightbox = null; }

    // ---------------- group members / admin ----------------
    openMemberMenu(mm) { this.state.memberMenu = mm; }
    messageMember(mm) { this.state.memberMenu = null; this.state.infoOpen = false; this.openDirect(mm.id); }
    async _refreshInfo(cid) { try { const res = await rpc('/chat/contact_info', { conversation_id: cid }); if (res && res.status) { this.state.contactInfo = res.info; this.state.groupNameEdit = res.info.name || ''; } } catch (e) {} }
    async promoteMember(mm) {
        const cid = this.state.contactInfo.conversation_id; this.state.memberMenu = null;
        try { const res = await rpc('/chat/group/update', { conversation_id: cid, action: 'promote', user_id: mm.id }); if (res && res.status === false) { this.notify(res.message); return; } this._refreshInfo(cid); } catch (e) {}
    }
    async removeMember(mm) {
        if (!await this.askConfirm({ title: 'Remove member', body: 'Remove ' + mm.name + ' from the group?', okLabel: 'Remove', danger: true })) return;
        const cid = this.state.contactInfo.conversation_id; this.state.memberMenu = null;
        try { const res = await rpc('/chat/group/update', { conversation_id: cid, action: 'remove', user_id: mm.id }); if (res && res.status === false) { this.notify(res.message); return; } this._refreshInfo(cid); this.loadConversations(); } catch (e) {}
    }
    async renameGroup() {
        const cid = this.state.contactInfo.conversation_id; const name = (this.state.groupNameEdit || '').trim(); if (!name) return;
        try { const res = await rpc('/chat/group/update', { conversation_id: cid, action: 'rename', name }); if (res && res.status === false) { this.notify(res.message); return; } this._refreshInfo(cid); if (this.state.activeConv) this.state.activeConv.title = name; this.loadConversations(); this.notify('Group renamed', 'success'); } catch (e) {}
    }
    changeGroupPhoto() {
        this._pendingGroupPhoto = true;
        const el = this.fileinput.el;
        if (el) { el.accept = 'image/*'; el.value = ''; el.click(); }
    }
    async _setGroupPhoto(b64) {
        const cid = this.state.contactInfo.conversation_id;
        try { const res = await rpc('/chat/group/update', { conversation_id: cid, action: 'photo', image_b64: b64 }); if (res && res.status === false) { this.notify(res.message); return; } this._refreshInfo(cid); this.loadConversations(); this.notify('Group photo updated', 'success'); } catch (e) {}
    }

    // ---- in-chat search + calendar ----
    toggleSearch() { this.closeMenus(); this.state.searchOpen = !this.state.searchOpen; if (!this.state.searchOpen) this.closeSearch(); }
    closeSearch() { this.state.searchOpen = false; this.state.searchQ = ''; this.state.searchResults = []; this.state.calOpen = false; this.state.flashId = 0; }
    // ---- global search: the left "Search chats" box also finds messages everywhere ----
    onListSearch() {
        const q = (this.state.search || '').trim();
        clearTimeout(this._gsTimer);
        if (q.length < 2) { this.state.globalMsgs = []; return; }
        this._gsTimer = setTimeout(async () => {
            try { const r = await rpc('/chat/search_all', { query: q }); if (r && r.status) this.state.globalMsgs = r.results || []; }
            catch (e) {}
        }, 300);
    }
    async openGlobalHit(gm) {
        const conv = this.state.conversations.find((c) => c.id === gm.conv_id)
            || { id: gm.conv_id, title: gm.conv_title, is_group: false };
        this.state.search = ''; this.state.globalMsgs = [];
        await this.select(conv);
        this.jumpToMessage(gm.msg_id);
    }
    exportChat() {
        this.closeMenus();
        if (this.state.selectedId) window.open('/chat/export/' + this.state.selectedId, '_blank');
    }
    onSearchKey(ev) { if (ev.key === 'Escape') { this.closeSearch(); return; } this.doSearch(); }
    async doSearch(date) {
        if (!this.state.selectedId) return;
        const q = (this.state.searchQ || '').trim();
        if (!q && !date) { this.state.searchResults = []; return; }
        try {
            const res = await rpc('/chat/search_messages', { conversation_id: this.state.selectedId, query: q, date: date || false });
            if (res && res.status) {
                this.state.searchResults = (res.messages || []).map((m) => m.id);
                const n = this.state.searchResults.length;
                if (n) { this.state.searchIdx = date ? n - 1 : 0; this.jumpToMessage(this.state.searchResults[this.state.searchIdx]); }
            }
        } catch (e) {}
    }
    searchStep(dir) {
        const n = this.state.searchResults.length; if (!n) return;
        this.state.searchIdx = (this.state.searchIdx + dir + n) % n;
        this.jumpToMessage(this.state.searchResults[this.state.searchIdx]);
    }
    // Escape text, then wrap every occurrence of the query in <mark> (raw HTML via markup).
    // Auto-detect URLs (http/https/www.) in a message and render them as clickable
    // links that open in a new tab — like WhatsApp. XSS-safe: ALL text is HTML-escaped;
    // only the <a> wrappers are injected (href + label are escaped too).
    linkifyBody(text) {
        const raw = String(text || '');
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        // escape, highlight @mentions (@all or @Capitalized name), then apply
        // WhatsApp text formatting: *bold* _italic_ ~strike~ `mono`. All done on
        // already-escaped text; the only HTML injected is our own safe tags.
        const mark = (s) => {
            let t = esc(s).replace(/@(all\b|[A-Z][\w]*(?:\s[A-Z][\w]*)*)/g, (mm) => '<span class="o369-mention">' + mm + '</span>');
            t = t.replace(/(^|\s)\*(\S(?:[^*\n]*\S)?)\*(?=\s|[.,!?)]|$)/g, '$1<b>$2</b>')
                 .replace(/(^|\s)_(\S(?:[^_\n]*\S)?)_(?=\s|[.,!?)]|$)/g, '$1<i>$2</i>')
                 .replace(/(^|\s)~(\S(?:[^~\n]*\S)?)~(?=\s|[.,!?)]|$)/g, '$1<s>$2</s>')
                 .replace(/`([^`\n]+?)`/g, '<code class="o369-mono">$1</code>');
            return t;
        };
        const re = /(https?:\/\/[^\s<"']+|www\.[^\s<"']+)/gi;
        let out = '', last = 0, m;
        while ((m = re.exec(raw)) !== null) {
            out += mark(raw.slice(last, m.index));
            let url = m[0], tail = '';
            const tm = url.match(/[)\].,;:!?'"]+$/);   // trailing punctuation isn't part of the link
            if (tm) { tail = tm[0]; url = url.slice(0, url.length - tail.length); }
            const href = /^https?:\/\//i.test(url) ? url : 'http://' + url;
            out += '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" class="o369-link">' + esc(url) + '</a>' + mark(tail);
            last = m.index + m[0].length;
        }
        out += mark(raw.slice(last));
        return markup(out);
    }
    highlightBody(text) {
        const raw = String(text || '');
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const q = (this.state.searchQ || '').trim();
        if (!q) return markup(esc(raw));
        const rx = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        // Split keeping the matches (odd indices are the matched terms).
        const parts = raw.split(rx);
        const html = parts.map((p, i) => (i % 2 === 1) ? ('<mark class="o369-hl">' + esc(p) + '</mark>') : esc(p)).join('');
        return markup(html);
    }
    async jumpToMessage(id) {
        if (!this.state.messages.some((m) => m.id === id)) {
            try { const res = await rpc('/chat/messages_around', { conversation_id: this.state.selectedId, message_id: id }); if (res && res.status) this.state.messages = res.messages || []; } catch (e) {}
        }
        this.state.flashId = id;
        setTimeout(() => { const el = document.getElementById('o369m-' + id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
        setTimeout(() => { if (this.state.flashId === id) this.state.flashId = 0; }, 1600);
    }
    toggleCalendar() { this.state.calOpen = !this.state.calOpen; if (this.state.calOpen) { const n = new Date(); this.state.calYear = n.getFullYear(); this.state.calMonth = n.getMonth(); } }
    calShift(d) {
        let m = this.state.calMonth + d, y = this.state.calYear; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
        // Never navigate into a month later than the current one (no future).
        const n = new Date(); if (y > n.getFullYear() || (y === n.getFullYear() && m > n.getMonth())) return;
        this.state.calMonth = m; this.state.calYear = y;
    }
    calAtCurrentMonth() { const n = new Date(); return this.state.calYear === n.getFullYear() && this.state.calMonth === n.getMonth(); }
    calTitle() { return new Date(this.state.calYear, this.state.calMonth, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }); }
    calDays() {
        const y = this.state.calYear, m = this.state.calMonth;
        const now = new Date(); const todayIso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const first = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate(); const out = [];
        for (let i = 0; i < first; i++) out.push({ key: 'e' + i, day: '', iso: '', future: false });
        for (let d = 1; d <= days; d++) { const iso = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); out.push({ key: iso, day: d, iso, future: iso > todayIso }); }
        return out;
    }
    pickDate(iso) { if (!iso) return; this.state.calOpen = false; this.doSearch(iso); }
    requestPinMessage(m) { if (m.pinned) { this.pinMessage(m, false, 0); } else { this.state.pinPrompt = m; } }
    confirmPin(days) { const m = this.state.pinPrompt; this.state.pinPrompt = null; if (m) this.pinMessage(m, true, days); }
    cancelPin() { this.state.pinPrompt = null; }
    openPins() { this.state.showPins = true; }
    closePins() { this.state.showPins = false; }
    async pinMessage(m, pinned, days) {
        try { const res = await rpc('/chat/pin_message', { message_id: m.id, pinned: pinned, days: days || 0 }); if (res && res.status === false) { this.notify(res.message); return; } this._applyMsg(res); await this.loadPinned(); } catch (e) {}
    }

    // poll
    // Safety-net poll (the bus does the instant work). Refreshes the list + presence
    // and reconciles the open thread's ticks/reactions/edits every few seconds.
    async tick() {
        await this.loadConversations();
        if (this.state.selectedId) await this.syncMessages();
        this._callTick = (this._callTick || 0) + 1;
        if (this._callTick % 5 === 0) await this.loadCalls();   // refresh calls + upcoming ~every 30s
        this._checkScheduledCalls();
    }
    async syncMessages() {
        if (!this.state.selectedId) return;
        try {
            const res = await rpc('/chat/messages', { conversation_id: this.state.selectedId, limit: 60 });
            if (res && res.status) this._reconcile(res.messages || []);
        } catch (e) {}
    }
    _atBottom() {
        const el = this.scroller.el; if (!el) return true;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
    }
    onMsgScroll(ev) {
        const el = ev.currentTarget;
        if (this.state.openMenuId) this.state.openMenuId = null;   // fixed menu shouldn't detach on scroll
        if (el.scrollTop < 60) this.loadOlder();
        const show = (el.scrollHeight - el.scrollTop - el.clientHeight) > 200;
        if (show !== this.state.showJumpBottom) this.state.showJumpBottom = show;   // avoid re-render spam
    }
    async loadOlder() {
        if (this._loadingOlder || this._noMoreOlder || !this.state.selectedId) return;
        const ids = this.state.messages.map((m) => m.id).filter((i) => typeof i === 'number');
        if (!ids.length) return;
        const beforeId = Math.min(...ids);
        this._loadingOlder = true;
        try {
            const res = await rpc('/chat/messages', { conversation_id: this.state.selectedId, before_id: beforeId, limit: 40 });
            if (res && res.status) {
                const have = new Set(this.state.messages.map((m) => m.id));
                const older = (res.messages || []).filter((m) => !have.has(m.id));
                if (older.length) {
                    this._prependOldHeight = this.scroller.el ? this.scroller.el.scrollHeight : 0;
                    this.state.messages.unshift(...older);
                    this._prependAdjust = true;
                } else { this._noMoreOlder = true; }
            }
        } catch (e) {}
        this._loadingOlder = false;
    }
    jumpToBottom() {
        const el = this.scroller.el;
        if (el) { el.scrollTop = el.scrollHeight; this.state.showJumpBottom = false; }
    }
    // Merge a fresh serialized list into state.messages by id: update existing in
    // place (status/reactions/edited/deleted/pinned) and append new ones.
    _reconcile(list) {
        if (!list.length) return;
        const byId = {};
        for (const m of this.state.messages) { if (typeof m.id === 'number') byId[m.id] = m; }
        const atB = this._atBottom();
        let appended = false;
        for (const nm of list) {
            const cur = byId[nm.id];
            if (cur) { Object.assign(cur, nm); }
            else { this.state.messages.push(nm); appended = true; }
        }
        if (appended) {
            this.state.messages.sort((a, b) => {
                const ai = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
                const bi = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
                return ai - bi;
            });
            if (atB) this._scrollPending = true;
            this.markRead();
        }
        this._scanPreviews();
    }
    // Live events pushed from the server over the Odoo bus.
    _onBus(p) {
        if (!p || !p.event) return;
        if (p.event === 'call_ring') { this._onCallRing(p); return; }
        if (p.event === 'call_accept') { this._onCallAccept(p); return; }
        if (p.event === 'call_signal') { this._onCallSignal(p); return; }
        if (p.event === 'call_reject') { this._onCallReject(p); return; }
        if (p.event === 'call_end') { this._onCallEnd(p); return; }
        const open = (p.conversation_id === this.state.selectedId);
        if (p.event === 'message') {
            if (open && p.message && !this.state.messages.some((m) => m.id === p.message.id)) {
                const atB = this._atBottom();
                this.state.messages.push(p.message);
                if (atB) this._scrollPending = true;
                this.markRead();
                this._clearTypingUser(p.message.author_id);
            }
            this._maybeNotify(p);
            this.loadConversations();
        } else if (p.event === 'update') {
            if (open && p.message) {
                const i = this.state.messages.findIndex((m) => m.id === p.message.id);
                if (i >= 0) this.state.messages.splice(i, 1, p.message);
            }
        } else if (p.event === 'read' || p.event === 'delivered') {
            if (open) this.syncMessages(); else this.loadConversations();
        } else if (p.event === 'typing') {
            if (open) this._setTyping(p);
        }
    }
    _setTyping(p) {
        if (!p.typing) { this._clearTypingUser(p.user_id); return; }
        this.state.typing = { user_id: p.user_id, name: p.name };
        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => { this.state.typing = null; }, 4000);
    }
    _clearTypingUser(uid) {
        if (this.state.typing && this.state.typing.user_id === uid) {
            this.state.typing = null; clearTimeout(this._typingTimer);
        }
    }
    _emitTyping() {
        if (!this.state.selectedId) return;
        const now = Date.now();
        if (!this._lastTypingSent || now - this._lastTypingSent > 2500) {
            this._lastTypingSent = now;
            rpc('/chat/typing', { conversation_id: this.state.selectedId, typing: true }).catch(() => {});
        }
        clearTimeout(this._typingStop);
        this._typingStop = setTimeout(() => this._stopTyping(), 3000);
    }
    _stopTyping() {
        clearTimeout(this._typingStop); this._lastTypingSent = 0;
        if (this.state.selectedId) rpc('/chat/typing', { conversation_id: this.state.selectedId, typing: false }).catch(() => {});
    }
    async openMessageInfo(m) {
        this.closeMenus();
        this.state.msgInfo = { id: m.id, loading: true, is_group: false, read: [], delivered: [], created: m.created, body: m.body, kind: m.kind, mine: true };
        try {
            const res = await rpc('/chat/message_info', { message_id: m.id });
            if (res && res.status) { this.state.msgInfo = Object.assign({}, this.state.msgInfo, res, { loading: false }); }
            else { this.state.msgInfo = null; this.notify((res && res.message) || 'No info available'); }
        } catch (e) { this.state.msgInfo = null; }
    }
    closeMessageInfo() { this.state.msgInfo = null; }
    async openPrivacy() {
        this.closeMenus();
        this.state.privacyOpen = true;
        try { const r = await rpc('/chat/privacy', {}); if (r && r.status) this.state.privacy = { last_seen_privacy: r.last_seen_privacy, online_privacy: r.online_privacy }; } catch (e) {}
    }
    closePrivacy() { this.state.privacyOpen = false; }
    async setPrivacy(field, value) {
        this.state.privacy[field] = value;
        const params = {}; params[field] = value;
        try { const r = await rpc('/chat/privacy', params); if (r && r.status) { this.state.privacy = { last_seen_privacy: r.last_seen_privacy, online_privacy: r.online_privacy }; this.notify('Privacy updated', 'success'); } } catch (e) {}
    }
    // ---------------- voice-note player (play / seek / duration) ----------------
    toggleAudio(m) {
        if (this.state.playingId === m.id && this._audio) {
            if (this._audio.paused) { this._audio.play().catch(() => {}); this.state.audioPaused = false; }
            else { this._audio.pause(); this.state.audioPaused = true; }
            return;
        }
        if (this._audio) { this._audio.pause(); }
        this._audio = new Audio(m.media_url);
        this.state.playingId = m.id; this.state.audioPaused = false;
        this.state.audioCur = 0; this.state.audioDur = m.duration || 0;
        this._audio.playbackRate = this.state.audioSpeed;
        this._audio.addEventListener('loadedmetadata', () => { if (this._audio && isFinite(this._audio.duration)) this.state.audioDur = this._audio.duration; });
        this._audio.addEventListener('timeupdate', () => { if (this._audio) this.state.audioCur = this._audio.currentTime; });
        this._audio.addEventListener('ended', () => { this.state.audioCur = 0; this.state.audioPaused = true; });
        this._audio.play().catch(() => { this.state.playingId = null; });
    }
    startSeek(m, ev) {
        // Tap on a not-yet-playing clip just starts it; on the loaded clip, tap+drag scrubs.
        if (this.state.playingId !== m.id || !this._audio) { this.toggleAudio(m); return; }
        this._seekBar = ev.currentTarget;
        this._seekTo(ev);
        this._segMove = (e) => this._seekTo(e);
        this._segUp = () => { window.removeEventListener('pointermove', this._segMove); window.removeEventListener('pointerup', this._segUp); this._seekBar = null; };
        window.addEventListener('pointermove', this._segMove);
        window.addEventListener('pointerup', this._segUp);
    }
    _seekTo(ev) {
        if (!this._seekBar || !this._audio) return;
        const rect = this._seekBar.getBoundingClientRect();
        const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const dur = isFinite(this._audio.duration) ? this._audio.duration : (this.state.audioDur || 0);
        if (dur) { this._audio.currentTime = pct * dur; this.state.audioCur = pct * dur; }
    }
    cycleSpeed() {
        const seq = [1, 1.5, 2]; const i = seq.indexOf(this.state.audioSpeed);
        this.state.audioSpeed = seq[(i + 1) % seq.length];
        if (this._audio) this._audio.playbackRate = this.state.audioSpeed;
    }
    audioSpeedLabel() { return this.state.audioSpeed + '×'; }
    audioPct(id) {
        if (this.state.playingId !== id) return 0;
        const d = this.state.audioDur || 0; if (!d) return 0;
        return Math.min(100, (this.state.audioCur / d) * 100);
    }
    audioTimeLabel(m) {
        const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const mm = Math.floor(s / 60); const ss = s % 60; return mm + ':' + (ss < 10 ? '0' + ss : ss); };
        if (this.state.playingId === m.id) return fmt(this.state.audioCur) + ' / ' + fmt(this.state.audioDur || m.duration || 0);
        return fmt(m.duration || 0);
    }
    _stopAudio() { if (this._audio) { this._audio.pause(); } this.state.playingId = null; this.state.audioPaused = true; this.state.audioCur = 0; }

    // ---------------- helpers ----------------
    filteredConversations() { const q = (this.state.search || '').trim().toLowerCase(); const l = this.state.conversations; return q ? l.filter((c) => (c.title || '').toLowerCase().includes(q)) : l; }
    filteredContacts() { const q = (this.state.contactSearch || '').trim().toLowerCase(); const l = this.state.contacts; return q ? l.filter((u) => (u.name || '').toLowerCase().includes(q) || (u.mobile || '').includes(q)) : l; }
    groupedMessages() {
        const out = []; let lastDay = null; const seen = new Set();
        for (const m of this.state.messages) {
            if (seen.has(m.id)) continue;   // guard against a duplicate ever reaching render
            seen.add(m.id);
            const d = m.created ? new Date(m.created) : null;
            const key = d && !isNaN(d.getTime()) ? d.toDateString() : '';
            if (key && key !== lastDay) { out.push({ sep: true, id: 'sep-' + m.id, label: this.dateLabel(d) }); lastDay = key; }
            out.push({ sep: false, id: 'm-' + m.id, msg: m });
        }
        return out;
    }
    _daysAgo(d) {
        const s = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
        return Math.round((s(new Date()) - s(d)) / 86400000);
    }
    dateLabel(d) {
        const days = this._daysAgo(d);
        if (days <= 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });   // Monday, Tuesday…
        return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
    }
    // Chat-row timestamp: today→time · yesterday→"Yesterday" · <7d→weekday · older→date.
    fmtRowTime(iso) {
        if (!iso) return '';
        const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const days = this._daysAgo(d);
        if (days <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (days === 1) return 'Yesterday';
        if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });   // Mon, Tue…
        return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    currentIsGroup() { return !!(this.state.activeConv && this.state.activeConv.is_group); }
    currentTitle() { return this.state.activeConv ? this.state.activeConv.title : ''; }
    currentSub() {
        const c = this.state.activeConv; if (!c) return '';
        const fresh = this.state.conversations.find((x) => x.id === this.state.selectedId) || c;
        if (this.state.typing) return c.is_group ? (this.state.typing.name + ' is typing…') : 'typing…';
        if (c.is_group) return (fresh.member_count || c.member_count || 0) + ' members';
        if (fresh.online) return 'online';
        if (fresh.last_seen) return 'last seen ' + this.lastSeenLabel(fresh.last_seen);
        return c.other_mobile || '';
    }
    lastSeenLabel(iso) {
        const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const now = new Date();
        const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (d.toDateString() === now.toDateString()) return 'today at ' + t;
        const y = new Date(now); y.setDate(now.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'yesterday at ' + t;
        return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' at ' + t;
    }
    infoKindLabel(kind) { return ({ image: 'Photo', video: 'Video', audio: 'Voice message', document: 'Document' })[kind] || ''; }
    fmtInfoTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return 'Today at ' + t;
        return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ', ' + t;
    }
    avatarSrc(b64) { return 'data:image/png;base64,' + b64; }
    initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
    fmtTime(iso) {
        if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const same = d.toDateString() === new Date().toDateString();
        return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    }
    pinLeft(iso) {
        if (!iso) return ''; const exp = new Date(iso); if (isNaN(exp.getTime())) return '';
        const ms = exp.getTime() - Date.now(); if (ms <= 0) return 'expired';
        const days = Math.floor(ms / 86400000); const hours = Math.floor((ms % 86400000) / 3600000);
        if (days >= 1) return days + (days === 1 ? ' day left' : ' days left');
        if (hours >= 1) return hours + (hours === 1 ? ' hour left' : ' hours left');
        return Math.max(1, Math.floor(ms / 60000)) + ' min left';
    }
    pinLabel(m) { return this.pinLeft(m.pin_expiry) || 'Pinned'; }
}

registry.category("actions").add("chats_369_app", Chat369App);
