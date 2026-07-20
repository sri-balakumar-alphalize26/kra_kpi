/** @odoo-module **/

// 369Chats â€” WhatsApp-Web-style chat client for the Odoo backend.
// Left: conversations (+ new chat / new group / â‹® menu). Right: the open chat.
// Per message: hover caret â†’ menu (Reply Â· Copy Â· React Â· Forward Â· Pin Â· Star Â·
// Edit Â· Delete for me / everyone) + quick-reactions bar. Header â‹® menu â†’
// New group Â· Starred messages Â· Mark all as read. ~3s polling.

import { Component, xml, useState, useRef, onWillStart, onMounted, onWillUnmount, onPatched, useExternalListener, markup } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { useService } from "@web/core/utils/hooks";

export class Chat369App extends Component {

    static template = xml/* xml */`
        <div class="o369">
            <!-- ================= LEFT PANE ================= -->
            <div class="o369-left">
                <t t-if="state.view === 'chats'">
                    <div class="o369-lhead">
                        <span class="o369-brandwrap">
                            <img src="/chats_369/static/description/icon.png" class="o369-brandlogo"/>
                            <span class="o369-brand">369Chats</span>
                        </span>
                        <span class="o369-headbtns">
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
                        <input type="text" placeholder="Search chats" t-model="state.search"/>
                    </div>
                    <div class="o369-chips">
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'all' }" t-on-click="() => this.setFilter('all')">All</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'unread' }" t-on-click="() => this.setFilter('unread')">Unread</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'favourites' }" t-on-click="() => this.setFilter('favourites')">Favourites</button>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'groups' }" t-on-click="() => this.setFilter('groups')">Groups</button>
                        <t t-foreach="state.lists" t-as="l" t-key="l.id">
                            <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === l.id }" t-on-click="() => this.setFilter(l.id)"><t t-esc="l.emoji"/> <t t-esc="l.name"/></button>
                        </t>
                        <button class="o369-chip" t-att-class="{ 'o369-chip-on': state.filter === 'archived' }" t-on-click="() => this.setFilter('archived')">Archived</button>
                        <button class="o369-chip o369-chipadd" t-on-click="openNewList" title="New list"><i class="fa fa-plus"/></button>
                    </div>
                    <div class="o369-list">
                        <t t-foreach="filteredConversations()" t-as="c" t-key="c.id">
                            <div class="o369-row" t-att-class="{ 'o369-active': c.id === state.selectedId }" t-on-click="() => this.select(c)">
                                <div class="o369-avatar">
                                    <img t-if="c.avatar_url" t-att-src="c.avatar_url"/>
                                    <span t-else="" t-esc="initials(c.title)"/>
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
                                        <span class="o369-prev" t-esc="c.last_preview"/>
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
                        <div class="o369-hint" t-if="filteredConversations().length === 0">No chats yet â€” tap the pencil to start one.</div>
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
            <div class="o369-right" t-att-class="{ 'o369-hasconv': state.selectedId }">
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
                        <button class="o369-hbtn" t-on-click.stop="toggleSearch" title="Search"><i class="fa fa-search"/></button>
                        <span class="o369-hmenuwrap">
                            <button class="o369-hbtn" t-on-click.stop="toggleConvMenu" title="Menu"><i class="fa fa-ellipsis-v"/></button>
                            <div class="o369-hdrmenu" t-if="state.convMenu">
                                <button class="o369-menuitem" t-on-click.stop="openContactInfo"><i class="fa fa-info-circle"/> <t t-esc="currentIsGroup() ? 'Group info' : 'Contact info'"/></button>
                                <button class="o369-menuitem" t-on-click.stop="toggleSearch"><i class="fa fa-search"/> Search</button>
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
                            <small class="o369-pinleft"> Â· <t t-esc="pinLabel(state.pinnedMsgs[0])"/></small>
                            <span class="o369-pinmore" t-if="state.pinnedMsgs.length > 1"> Â· +<t t-esc="state.pinnedMsgs.length - 1"/> more</span>
                        </div>
                        <button class="o369-pinunpin" t-on-click.stop="() => this.pinMessage(state.pinnedMsgs[0], false, 0)" title="Unpin"><i class="fa fa-times"/></button>
                    </div>

                    <div class="o369-msgs" t-ref="scroller">
                        <t t-foreach="groupedMessages()" t-as="it" t-key="it.id">
                            <div t-if="it.sep" class="o369-datesep"><span t-esc="it.label"/></div>
                            <t t-else="">
                                <t t-set="m" t-value="it.msg"/>
                                <div t-if="m.kind === 'system'" class="o369-sys"><span t-esc="m.body"/></div>
                                <div t-else="" class="o369-bubble" t-attf-id="o369m-{{m.id}}" t-att-class="(m.mine ? 'o369-out' : 'o369-in') + (state.flashId === m.id ? ' o369-flash' : '')">
                                    <button class="o369-caret" t-if="!m.deleted" t-on-click.stop="() => this.toggleMenu(m.id)" title="More"><i class="fa fa-chevron-down"/></button>
                                    <div class="o369-msgmenu" t-if="state.openMenuId === m.id">
                                        <div class="o369-reactbar">
                                            <t t-foreach="REACTIONS" t-as="e" t-key="e">
                                                <button class="o369-reactbtn" t-on-click.stop="() => this.react(m, e)"><t t-esc="e"/></button>
                                            </t>
                                            <button class="o369-reactbtn o369-reactplus" t-on-click.stop="() => this.openEmojiPicker(m)" title="More emojis">+</button>
                                        </div>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.startReply(m)"><i class="fa fa-reply"/> Reply</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.copyMsg(m)"><i class="fa fa-files-o"/> Copy</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.openForward(m)"><i class="fa fa-share"/> Forward</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.menuPin(m)"><i class="fa fa-thumb-tack"/> <t t-esc="m.pinned ? 'Unpin' : 'Pin'"/></button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.toggleStar(m)"><i class="fa fa-star"/> <t t-esc="m.starred ? 'Unstar' : 'Star'"/></button>
                                        <button class="o369-menuitem" t-if="m.mine" t-on-click.stop="() => this.startEdit(m)"><i class="fa fa-pencil"/> Edit</button>
                                        <button class="o369-menuitem" t-on-click.stop="() => this.deleteScope(m, 'me')"><i class="fa fa-trash-o"/> Delete for me</button>
                                        <button class="o369-menuitem o369-danger" t-if="m.mine" t-on-click.stop="() => this.deleteScope(m, 'everyone')"><i class="fa fa-trash"/> Delete for everyone</button>
                                    </div>

                                    <div class="o369-sender" t-if="!m.mine and currentIsGroup()" t-esc="m.author_name"/>
                                    <div class="o369-quote" t-if="m.reply_to_id">
                                        <span class="o369-qauthor" t-esc="m.reply_to_author"/>
                                        <span class="o369-qbody" t-esc="m.reply_to_body"/>
                                    </div>
                                    <t t-if="m.deleted">
                                        <span class="o369-deleted"><i class="fa fa-ban me-1"/>This message was deleted</span>
                                    </t>
                                    <t t-else="">
                                        <img t-if="m.kind === 'image' and m.media_url" class="o369-msgimg" t-att-src="m.media_url" t-on-click.stop="() => this.openLightbox(m.media_url)"/>
                                        <video t-if="m.kind === 'video' and m.media_url" class="o369-msgvid" controls="controls" t-att-src="m.media_url"/>
                                        <audio t-if="m.kind === 'audio' and m.media_url" class="o369-msgaudio" controls="controls" t-att-src="m.media_url"/>
                                        <a t-if="m.kind === 'document' and m.media_url" class="o369-msgdoc" t-att-href="m.media_url" target="_blank"><i class="fa fa-file-o me-2"/><t t-esc="m.file_name or 'Document'"/></a>
                                        <span t-if="m.body and state.searchOpen and state.searchQ" class="o369-btext" t-out="highlightBody(m.body)"/>
                                        <span t-elif="m.body" class="o369-btext" t-esc="m.body"/>
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
                                        <i t-if="m.mine and !m.deleted" class="fa ms-1" t-att-class="m._pending ? 'fa-clock-o o369-faint' : (m.status === 'read' ? 'fa-check o369-read' : (m.status === 'delivered' ? 'fa-check' : 'fa-check o369-faint'))"/>
                                    </span>
                                </div>
                            </t>
                        </t>
                        <div class="o369-hint" t-if="state.messages.length === 0">No messages yet â€” say hi ðŸ‘‹</div>
                    </div>

                    <div class="o369-replybar" t-if="state.editing">
                        <div class="o369-replyinfo"><b>Editing message</b><span>Change the text and press send</span></div>
                        <button class="o369-iconbtn o369-replyx" t-on-click="cancelEdit" title="Cancel"><i class="fa fa-times"/></button>
                    </div>
                    <div class="o369-replybar" t-elif="state.replyTo">
                        <div class="o369-replyinfo"><b t-esc="state.replyTo.author"/><span t-esc="state.replyTo.body"/></div>
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
                    <div class="o369-input" t-if="!state.recording">
                        <span class="o369-attachwrap">
                            <button class="o369-attachbtn" t-on-click.stop="toggleAttach" title="Attach"><i class="fa fa-plus"/></button>
                            <div class="o369-attachmenu" t-if="state.attachMenu">
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('document')"><i class="fa fa-file-o"/> Document</button>
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('image')"><i class="fa fa-picture-o"/> Photos &amp; videos</button>
                                <button class="o369-menuitem" t-on-click.stop="() => this.pickFile('audio')"><i class="fa fa-headphones"/> Audio</button>
                            </div>
                        </span>
                        <input type="text" placeholder="Type a message" t-att-value="state.draft" t-on-input="onDraftInput" t-on-keydown="onKeydown"/>
                        <button class="o369-send" t-on-click="micOrSend" t-att-title="state.draft ? 'Send' : 'Record voice'">
                            <i class="fa" t-att-class="state.draft ? 'fa-paper-plane' : 'fa-microphone'"/>
                        </button>
                        <input type="file" t-ref="fileinput" style="display:none" t-on-change="onFileChosen"/>
                    </div>
                </t>
            </div>

            <!-- Pin-duration picker -->
            <div class="o369-modal" t-if="state.pinPrompt" t-on-click.self="cancelPin">
                <div class="o369-modalcard">
                    <div class="o369-modaltitle"><i class="fa fa-thumb-tack me-2"/>Pin message forâ€¦</div>
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
                    <div class="o369-modaltitle"><i class="fa fa-share me-2"/>Forward toâ€¦</div>
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
                        <div class="o369-hint" t-if="state.lists.length === 0">No lists yet â€” create one below.</div>
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

            <!-- Image lightbox -->
            <div class="o369-lightbox" t-if="state.lightbox" t-on-click="closeLightbox">
                <img t-att-src="state.lightbox"/>
            </div>
        </div>
    `;

    setup() {
        this.REACTIONS = ['ðŸ‘', 'â¤ï¸', 'ðŸ˜‚', 'ðŸ˜®', 'ðŸ˜¢', 'ðŸ™'];
        this.EMOJIS = [...new Set(['ðŸ˜€','ðŸ˜ƒ','ðŸ˜„','ðŸ˜','ðŸ˜†','ðŸ˜…','ðŸ˜‚','ðŸ¤£','ðŸ˜Š','ðŸ˜‡','ðŸ™‚','ðŸ™ƒ','ðŸ˜‰','ðŸ˜Œ','ðŸ˜','ðŸ¥°','ðŸ˜˜','ðŸ˜‹','ðŸ˜›','ðŸ˜œ','ðŸ¤ª','ðŸ¤¨','ðŸ§','ðŸ¤“','ðŸ˜Ž','ðŸ¥³','ðŸ˜','ðŸ˜’','ðŸ˜”','ðŸ˜Ÿ','ðŸ™','ðŸ˜£','ðŸ˜–','ðŸ˜«','ðŸ˜©','ðŸ¥º','ðŸ˜¢','ðŸ˜­','ðŸ˜¤','ðŸ˜ ','ðŸ˜¡','ðŸ¤¬','ðŸ¤¯','ðŸ˜³','ðŸ¥µ','ðŸ¥¶','ðŸ˜±','ðŸ˜¨','ðŸ˜°','ðŸ˜¥','ðŸ¤—','ðŸ¤”','ðŸ¤­','ðŸ¤«','ðŸ¤¥','ðŸ˜¶','ðŸ˜','ðŸ˜‘','ðŸ˜¬','ðŸ™„','ðŸ˜®','ðŸ˜²','ðŸ¥±','ðŸ˜´','ðŸ¤¤','ðŸ¤¢','ðŸ¤®','ðŸ¤§','ðŸ˜·','ðŸ¤’','ðŸ¤•','ðŸ‘','ðŸ‘Ž','ðŸ‘Œ','âœŒï¸','ðŸ¤ž','ðŸ¤Ÿ','ðŸ¤˜','ðŸ‘','ðŸ™Œ','ðŸ™','ðŸ’ª','ðŸ‘€','ðŸ”¥','â­','ðŸŒŸ','âœ¨','ðŸ’¯','ðŸŽ‰','ðŸŽŠ','â¤ï¸','ðŸ§¡','ðŸ’›','ðŸ’š','ðŸ’™','ðŸ’œ','ðŸ–¤','ðŸ¤','ðŸ’”','ðŸ’•','ðŸ’ž','ðŸ’—','ðŸ’–'])];
        this.notification = useService("notification");
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
            searchOpen: false, searchQ: '', searchResults: [], searchIdx: 0, flashId: 0,
            calOpen: false, calYear: 0, calMonth: 0,
            attachMenu: false, lightbox: null, recording: false, recPaused: false, recSecs: 0, memberMenu: null, groupNameEdit: '',
            confirm: null,
            // Group info redesign / media viewer / permissions (Features 2-4)
            nameEditing: false, descEditing: false, descDraft: '',
            mediaOpen: false, mediaTab: 'media', mediaItems: [],
            permsOpen: false,
            addMembersOpen: false, addMemberSel: [], addMemberContacts: [],
        });
        this.scroller = useRef("scroller");
        this.fileinput = useRef("fileinput");
        this._scrollPending = false;
        this._timer = null;
        // Close any open menu when clicking elsewhere (caret/menu clicks use .stop).
        useExternalListener(window, "click", () => this.closeMenus());

        onWillStart(async () => { await this.loadConversations(true); this.loadLists(); });
        onMounted(() => { this._timer = setInterval(() => this.tick(), 3000); });
        onWillUnmount(() => { if (this._timer) { clearInterval(this._timer); this._timer = null; } });
        onPatched(() => {
            if (this._scrollPending && this.scroller.el) {
                this.scroller.el.scrollTop = this.scroller.el.scrollHeight;
                this._scrollPending = false;
            }
        });
    }

    closeMenus() { this.state.openMenuId = null; this.state.headerMenu = false; this.state.rowMenuId = null; this.state.convMenu = false; this.state.attachMenu = false; }
    toggleConvMenu() { this.closeMenus(); this.state.convMenu = !this.state.convMenu; }
    toggleMenu(id) { this.state.headerMenu = false; this.state.rowMenuId = null; this.state.openMenuId = this.state.openMenuId === id ? null : id; }
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
        this.state.selectedId = conv.id; this.state.activeConv = conv; this.state.messages = [];
        this.state.replyTo = null; this.state.editing = null; this.closeMenus();
        await this.reloadMessages(true); this.loadPinned();
    }
    async reloadMessages(scroll) {
        if (!this.state.selectedId) return;
        try { const res = await rpc('/chat/messages', { conversation_id: this.state.selectedId, limit: 60 }); if (res && res.status) { this.state.messages = res.messages || []; if (scroll) this._scrollPending = true; this.markRead(); } } catch (e) {}
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
        const replyTo = this.state.replyTo;
        const replyId = replyTo ? replyTo.id : 0;
        this.state.draft = ''; this.state.replyTo = null;
        // Optimistic: show the message instantly (a temp bubble with a clock), then
        // swap in the server copy â€” feels instant regardless of round-trip.
        const tempId = 'tmp-' + Date.now();
        this.state.messages.push({
            id: tempId, mine: true, body, kind: 'text', deleted: false, pinned: false, starred: false,
            edited: false, reactions: [], reply_to_id: replyId || false,
            reply_to_author: replyTo ? replyTo.author : '', reply_to_body: replyTo ? replyTo.body : '',
            author_name: 'You', created: new Date().toISOString(), status: 'sent', _pending: true,
        });
        this._scrollPending = true;
        try {
            const res = await rpc('/chat/send', { conversation_id: this.state.selectedId, body, reply_to_id: replyId });
            // Remove the temp bubble, then add the real one only if the poll didn't already.
            this.state.messages = this.state.messages.filter((m) => m.id !== tempId);
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this.loadConversations();
            }
        } catch (e) { this.state.messages = this.state.messages.filter((m) => m.id !== tempId); }
    }
    onKeydown(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.send(); } }
    onDraftInput(ev) { this.state.draft = this.sentenceCase(ev.target.value); }
    sentenceCase(s) {
        // Capitalize the first letter and the first letter after . ! ?
        return (s || '').replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase());
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
    closeForward() { this.state.forwardMsg = null; }
    async doForward(c) {
        const m = this.state.forwardMsg; this.state.forwardMsg = null;
        if (!m) return;
        try { const res = await rpc('/chat/forward', { message_id: m.id, to_conversation_id: c.id }); if (res && res.status === false) { this.notify(res.message); return; } this.notify('Forwarded', 'success'); this.loadConversations(); } catch (e) {}
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
        if (el) { el.accept = kind === 'image' ? 'image/*,video/*' : (kind === 'audio' ? 'audio/*' : '*/*'); el.value = ''; el.click(); }
    }
    onFileChosen(ev) {
        const file = ev.target.files && ev.target.files[0]; if (!file) return;
        if (this._pendingGroupPhoto) {
            this._pendingGroupPhoto = false;
            this._compressImage(file, 640, 0.7).then((b64) => this._setGroupPhoto(b64));
            return;
        }
        let kind = this._pendingKind || 'document';
        if (kind === 'image' && (file.type || '').startsWith('video')) kind = 'video';
        // Images are recompressed client-side so we store small files on Odoo.
        if (kind === 'image') {
            this._compressImage(file, 1280, 0.7).then((b64) => this.sendMedia(kind, b64, this._renameImg(file.name), 'image/jpeg'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => { const b64 = String(reader.result).split(',')[1] || ''; this.sendMedia(kind, b64, file.name, file.type); };
        reader.readAsDataURL(file);
    }
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
    async sendMedia(kind, b64, name, mime, duration) {
        if (!this.state.selectedId || !b64) return;
        try {
            const res = await rpc('/chat/send_media', { conversation_id: this.state.selectedId, kind, file_b64: b64, file_name: name || '', mimetype: mime || '', duration: duration || 0 });
            if (res && res.status === false) { this.notify(res.message); return; }
            if (res && res.status && res.message) {
                if (!this.state.messages.some((m) => m.id === res.message.id)) this.state.messages.push(res.message);
                this._scrollPending = true; this.loadConversations();
            }
        } catch (e) { this.notify('Could not send file'); }
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
    highlightBody(text) {
        const raw = String(text || '');
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    async tick() {
        await this.loadConversations();
        if (!this.state.selectedId) return;
        try {
            const res = await rpc('/chat/messages', { conversation_id: this.state.selectedId, after_id: this.lastMsgId() });
            if (res && res.status && (res.messages || []).length) {
                const have = new Set(this.state.messages.map((m) => m.id));
                const fresh = res.messages.filter((m) => !have.has(m.id));
                if (fresh.length) { this.state.messages.push(...fresh); this._scrollPending = true; this.markRead(); }
            }
        } catch (e) {}
    }

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
        if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });   // Monday, Tuesdayâ€¦
        return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
    }
    // Chat-row timestamp: todayâ†’time Â· yesterdayâ†’"Yesterday" Â· <7dâ†’weekday Â· olderâ†’date.
    fmtRowTime(iso) {
        if (!iso) return '';
        const d = new Date(iso); if (isNaN(d.getTime())) return '';
        const days = this._daysAgo(d);
        if (days <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (days === 1) return 'Yesterday';
        if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });   // Mon, Tueâ€¦
        return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    currentIsGroup() { return !!(this.state.activeConv && this.state.activeConv.is_group); }
    currentTitle() { return this.state.activeConv ? this.state.activeConv.title : ''; }
    currentSub() { const c = this.state.activeConv; if (!c) return ''; if (c.is_group) return (c.member_count || 0) + ' members'; if (c.online) return 'online'; return c.other_mobile || ''; }
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
