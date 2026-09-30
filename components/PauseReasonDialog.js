// The pause-reason dialog, as used on the Action Board — extracted so Home can
// ask the same question the same way.
//
// Home used to pause from a row of chips inside the card. That was fine for
// Break and Lunch, but it quietly could not offer Meeting at all: a meeting
// needs a note AND who it was with, and a chip has nowhere to put either. So
// Home sent people to the Action Board for exactly the reason they were most
// likely to be pausing for. This dialog closes that gap by asking the full
// question in both places.
//
// Self-contained on purpose: it owns its reason/note/attendee state and its own
// styles, copied from KpiActionBoard's modal so the two are visually identical.
// The attendee list is the shared components/MeetingPicker.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import * as H from '../utils/haptics';
import { PAUSE_REASONS, fetchPeople, IDLE_NOTE_MAX } from '../services/kpiActions';
import MeetingPicker from './MeetingPicker';
import { noteRequired, pauseReasonText, meetingIds } from '../utils/meetingPick';

const SH = Dimensions.get('window').height;
// The body scrolls and the footer sits outside it, so Confirm is reachable no
// matter how tall the body grows. Picking Meeting alone adds a 190px attendee
// list, a search box, a label, a note field and two hint lines.
const MODAL_BODY_MAX_H = Math.max(240, Math.round(SH * 0.78) - 230);

// Reasons that need words typed. Mirrors KpiActionBoard's noteRequiredFor and
// the web's needsNote: 'meeting' is included because "Meeting" alone says
// nothing about what it cost the day. A TEAM meeting does, so it is let off —
// see utils/meetingPick.noteRequired.
const noteRequiredFor = (code) => code === 'other' || code === 'urgent' || code === 'meeting';

/**
 * visible  — show/hide
 * title    — "Pause Task" / "Pause all 3 tasks"
 * subject  — line under the title (the task name, or "3 tasks running")
 * busy     — disables Confirm while the request is in flight
 * onCancel — dismiss
 * onConfirm({ reason, code, meetingWithIds }) — reason is the typed note, or the
 *            reason's own label when no note was needed.
 */
export default function PauseReasonDialog({
  visible, title, subject, busy, onCancel, onConfirm,
}) {
  // Defaults to "Moved to another task", NOT Break — the same choice the Board
  // makes. It is the commonest reason, and defaulting to Break is how real work
  // time ends up filed as a break on the Workday Map.
  const [code, setCode] = useState('priority_task');
  const [note, setNote] = useState('');
  const [dropdown, setDropdown] = useState(false);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState([]);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [meetingWith, setMeetingWith] = useState([]);
  const [teamMeeting, setTeamMeeting] = useState(false);

  // Fresh every time it opens: a dialog that reopened still holding the last
  // reason and note would silently attach them to a different pause.
  useEffect(() => {
    if (!visible) return;
    setCode('priority_task');
    setNote('');
    setDropdown(false);
    setErr('');
    setMeetingWith([]);
    setTeamMeeting(false);
    setPeopleQuery('');
  }, [visible]);

  const pick = useCallback((next) => {
    setCode(next);
    setErr('');
    // Clear the note when the new reason does not need one, so text typed for
    // "Other" cannot ride along into a Break.
    if (!noteRequiredFor(next)) setNote('');
    if (next !== 'meeting') {
      setMeetingWith([]);
      setTeamMeeting(false);
      setPeopleQuery('');
    } else if (!people.length && !peopleBusy) {
      setPeopleBusy(true);
      fetchPeople()
        .then((list) => setPeople(Array.isArray(list) ? list : []))
        .catch(() => setPeople([]))
        .finally(() => setPeopleBusy(false));
    }
  }, [people.length, peopleBusy]);

  const confirm = () => {
    const text = note.trim();
    if (noteRequired(code, teamMeeting) && !text) {
      setErr(code === 'meeting'
        ? 'Say what the meeting is about.'
        : 'Please say why — this shows on your Workday Map.');
      return;
    }
    const label = (PAUSE_REASONS.find((r) => r.code === code) || {}).label || code;
    onConfirm({
      reason: pauseReasonText(text, code, teamMeeting, label, IDLE_NOTE_MAX),
      code,
      meetingWithIds: meetingIds(code, teamMeeting, meetingWith),
    });
  };

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={s.modalWrap}>
        <View style={s.modalCard}>
          <View style={s.modalHead}>
            <Text style={s.modalHeadTitle}>{title || 'Pause Task'}</Text>
            <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={COLORS.muted} />
            </TouchableOpacity>
          </View>

          {/* Body scrolls, footer does not — picking Meeting adds enough content
              to outgrow a phone, and the Confirm button must never be the part
              that falls off the bottom. */}
          <ScrollView style={{ maxHeight: MODAL_BODY_MAX_H }} keyboardShouldPersistTaps="handled">
            <View style={s.modalPad}>
              {subject ? (
                <Text style={s.taskLabel}>Task: <Text style={s.taskName}>{subject}</Text></Text>
              ) : null}
              <Text style={s.whyTitle}>Why are you pausing?</Text>

              <View style={s.quickRow}>
                <View style={s.quickLeft}>
                  {PAUSE_REASONS.filter((r) => r.quick && r.code !== 'urgent').map((r) => {
                    const on = code === r.code;
                    return (
                      <TouchableOpacity
                        key={r.code}
                        style={[s.quick, on && s.quickOn]}
                        onPress={() => { H.select(); pick(r.code); }}
                      >
                        <Text style={s.quickEmoji}>{r.emoji}</Text>
                        <Text style={[s.quickTxt, on && { color: COLORS.primary }]}>{r.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity
                  style={[s.quickUrgent, code === 'urgent' && s.quickUrgentOn]}
                  onPress={() => { H.warn(); pick('urgent'); }}
                >
                  <Text style={s.quickEmoji}>🚨</Text>
                  <Text style={[s.quickTxt, { color: code === 'urgent' ? '#fff' : COLORS.red }]}>Urgent</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={s.dropdown} onPress={() => setDropdown((o) => !o)} activeOpacity={0.8}>
                <Text style={s.dropdownTxt}>{(PAUSE_REASONS.find((r) => r.code === code) || {}).label}</Text>
                <Ionicons name={dropdown ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.muted} />
              </TouchableOpacity>
              {dropdown && (
                <View style={s.dropdownList}>
                  <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {PAUSE_REASONS.map((r) => {
                      const on = code === r.code;
                      return (
                        <TouchableOpacity
                          key={r.code}
                          style={[s.dropdownItem, on && s.dropdownItemOn]}
                          onPress={() => { H.select(); pick(r.code); setDropdown(false); }}
                        >
                          <Text style={[s.dropdownItemTxt, on && { color: COLORS.primary, fontWeight: '800' }]}>{r.label}</Text>
                          {on && <Ionicons name="checkmark" size={17} color={COLORS.primary} />}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Inline, above the box it is about — an OS alert would sit
                  further from the fix than the mistake did. */}
              {err ? (
                <View style={s.inlineErr}>
                  <Ionicons name="alert-circle" size={15} color={COLORS.red} />
                  <Text style={s.inlineErrTxt}>{err}</Text>
                </View>
              ) : null}

              {code === 'meeting' ? (
                <>
                  <MeetingPicker
                    people={people} busy={peopleBusy}
                    query={peopleQuery} setQuery={setPeopleQuery}
                    picked={meetingWith} setPicked={setMeetingWith}
                    team={teamMeeting}
                    setTeam={(v) => { setTeamMeeting(v); if (v) setErr(''); }}
                  />
                  <Text style={s.fieldLabel}>What is it about?{teamMeeting ? ' (optional)' : ''}</Text>
                  <TextInput
                    style={s.pauseNote}
                    placeholder={teamMeeting ? 'Optional — saved as “Team meeting”' : 'Short — e.g. sprint planning'}
                    placeholderTextColor={COLORS.faint}
                    value={note}
                    onChangeText={(t) => { setNote(t); if (err) setErr(''); }}
                    maxLength={IDLE_NOTE_MAX}
                    multiline
                  />
                  <Text style={s.idleNoteHint}>
                    Keep it short — this shows on your Workday Map. {note.length}/{IDLE_NOTE_MAX}
                  </Text>
                </>
              ) : null}

              {/* Meeting excluded: it has its own note box above, under the
                  people list, so "who" then "what about" read in that order. */}
              {noteRequiredFor(code) && code !== 'meeting' ? (
                <>
                  <TextInput
                    style={s.pauseNote}
                    placeholder={code === 'urgent'
                      ? 'What is urgent? This is sent to the owner now…'
                      : 'Why? (required)'}
                    placeholderTextColor={COLORS.faint}
                    value={note}
                    onChangeText={(t) => { setNote(t); if (err) setErr(''); }}
                    maxLength={IDLE_NOTE_MAX}
                    multiline
                  />
                  <Text style={s.idleNoteHint}>
                    Keep it short — this shows on your Workday Map. {note.length}/{IDLE_NOTE_MAX}
                  </Text>
                </>
              ) : null}

              <Text style={s.pauseHelp}>
                Every pause reason is tracked as away-time in your day summary — never counted as productive.
              </Text>
            </View>
          </ScrollView>

          <View style={s.modalFoot}>
            <TouchableOpacity style={s.footCancel} onPress={onCancel}>
              <Text style={s.footCancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.footConfirm, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={confirm}
            >
              <Text style={s.footConfirmTxt}>{busy ? 'Pausing…' : 'Confirm Pause'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Copied verbatim from KpiActionBoard's stylesheet so the dialog is the same
// dialog wherever it is opened from.
const s = StyleSheet.create({
  modalWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', maxHeight: '92%' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  modalHeadTitle: { fontSize: 17, fontWeight: '900', color: COLORS.navy },
  modalPad: { paddingHorizontal: 18, paddingTop: 14 },
  taskLabel: { fontSize: 14, color: COLORS.ink, fontWeight: '800' },
  taskName: { fontWeight: '600', color: COLORS.muted },
  whyTitle: { fontSize: 14.5, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 10 },
  quickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  quickLeft: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flex: 1 },
  quick: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 36, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#fff' },
  quickOn: { borderColor: COLORS.primary, backgroundColor: '#EAF1FE' },
  quickEmoji: { fontSize: 14 },
  quickTxt: { fontSize: 13, fontWeight: '700', color: COLORS.ink },
  quickUrgent: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 36, borderRadius: 10, borderWidth: 1.5, borderColor: COLORS.red, backgroundColor: COLORS.redBg },
  quickUrgentOn: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 46, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 14, marginTop: 12 },
  dropdownTxt: { fontSize: 14.5, color: COLORS.ink, fontWeight: '600' },
  dropdownList: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, marginTop: 6, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F3F8' },
  dropdownItemOn: { backgroundColor: '#EEF3FF' },
  dropdownItemTxt: { fontSize: 14, color: COLORS.ink },
  inlineErr: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 12,
  },
  inlineErrTxt: { flex: 1, fontSize: 12.5, color: COLORS.red, fontWeight: '600', lineHeight: 17 },
  fieldLabel: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 7 },
  pauseNote: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, padding: 12, minHeight: 72, fontSize: 14.5, color: COLORS.ink, textAlignVertical: 'top', marginTop: 12 },
  idleNoteHint: { fontSize: 11.5, color: COLORS.red, marginTop: 6, marginBottom: 4 },
  pauseHelp: { fontSize: 12, color: COLORS.muted, marginTop: 12, marginBottom: 6, lineHeight: 17 },
  modalFoot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10, paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 6 },
  footCancel: { flexShrink: 1, paddingHorizontal: 18, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F8' },
  footCancelTxt: { color: COLORS.muted, fontWeight: '800', fontSize: 14.5 },
  footConfirm: { flexShrink: 1, paddingHorizontal: 20, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5A623' },
  footConfirmTxt: { color: '#fff', fontWeight: '900', fontSize: 14.5 },
});
