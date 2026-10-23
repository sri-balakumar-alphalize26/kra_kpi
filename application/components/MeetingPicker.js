// Who a meeting is with. Multi-select, because a meeting rarely has exactly one
// other person, and the list includes CLIENTS — which is why it is fed by its own
// endpoint rather than the assignee list. Checkbox rows with an array toggle,
// matching AssignClientsModal in KraKpiDashboard rather than inventing a third
// control.
//
// Shared by every meeting dialog (the Action Board's four and Home's pause
// dialog). It used to be copied into two files, which is how copies drift.
//
// `team` / `setTeam` add the "Team meeting" choice above the list: a RADIO, not
// a checkbox, because it is instead of naming people rather than one more of
// them. Choosing it clears anyone ticked; ticking someone turns it off; tapping
// it again unselects it. Leave setTeam out and the picker is exactly as before.
import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import * as H from '../utils/haptics';
import { TEAM_MEETING_LABEL } from '../utils/meetingPick';

export default function MeetingPicker({ people, busy, query, setQuery, picked, setPicked, team = false, setTeam }) {
  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((u) => String(u.name || '').toLowerCase().includes(q)) : people;
  return (
    <>
      <Text style={s.fieldLabel}>Who is it with?</Text>
      {setTeam ? (
        <TouchableOpacity
          testID="meeting-team"
          accessibilityRole="radio"
          accessibilityState={{ checked: !!team }}
          style={[s.teamRow, team && s.teamRowOn]}
          activeOpacity={0.7}
          onPress={() => {
            H.select();
            const next = !team;
            setTeam(next);
            if (next) setPicked([]);
          }}
        >
          <Ionicons name={team ? 'radio-button-on' : 'radio-button-off'} size={20}
            color={team ? COLORS.primary : COLORS.faint} />
          <Text style={[s.personName, team && { color: COLORS.primary }]}>{TEAM_MEETING_LABEL}</Text>
          <Text style={s.personRole}>NO NOTE NEEDED</Text>
        </TouchableOpacity>
      ) : null}
      {busy && !people.length ? (
        <View style={{ paddingVertical: 14 }}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <>
          <View style={s.peopleSearch}>
            <Ionicons name="search" size={15} color={COLORS.muted} />
            <TextInput
              style={s.peopleSearchInput}
              placeholder="Search people…"
              placeholderTextColor={COLORS.faint}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
          </View>
          <ScrollView style={[s.peopleList, team && s.peopleListDim]} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {shown.map((u) => {
              const on = picked.includes(u.id);
              return (
                <TouchableOpacity
                  key={u.id} style={s.personRow} activeOpacity={0.7}
                  onPress={() => {
                    H.select();
                    if (team && setTeam) setTeam(false);
                    setPicked((prev) => (prev.includes(u.id)
                      ? prev.filter((x) => x !== u.id)
                      : [...prev, u.id]));
                  }}
                >
                  <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20}
                    color={on ? COLORS.primary : COLORS.faint} />
                  <Text style={s.personName} numberOfLines={1}>{u.name}</Text>
                  <Text style={s.personRole}>{String(u.role || '').toUpperCase()}</Text>
                </TouchableOpacity>
              );
            })}
            {!shown.length ? (
              <Text style={s.idleNoteHint}>
                {people.length ? 'No one matches.' : 'No one else to pick from.'}
              </Text>
            ) : null}
          </ScrollView>
          <Text style={s.idleNoteHint}>
            {team
              ? 'Team meeting — no need to pick people or add a note.'
              : picked.length ? `${picked.length} selected` : 'Optional — pick anyone who is in it.'}
          </Text>
        </>
      )}
    </>
  );
}

// The same values the Action Board and the pause dialog used for this picker,
// so moving it here changes nothing on screen.
const s = StyleSheet.create({
  fieldLabel: { fontSize: 13.5, fontWeight: '800', color: COLORS.navy, marginTop: 14, marginBottom: 7 },
  idleNoteHint: { fontSize: 11.5, color: COLORS.red, marginTop: 6, marginBottom: 4 },
  peopleSearch: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 7, marginBottom: 6, backgroundColor: '#fff',
  },
  peopleSearchInput: { flex: 1, fontSize: 13.5, color: COLORS.ink, padding: 0 },
  peopleList: {
    maxHeight: 190, borderWidth: 1, borderColor: COLORS.line,
    borderRadius: 10, paddingHorizontal: 8, backgroundColor: '#FBFCFE',
  },
  peopleListDim: { opacity: 0.55 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
  personName: { flex: 1, fontSize: 13.5, color: COLORS.ink, fontWeight: '600' },
  personRole: { fontSize: 9.5, fontWeight: '900', color: COLORS.muted, letterSpacing: 0.4 },
  teamRow: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingVertical: 10, paddingHorizontal: 10, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, backgroundColor: '#fff',
  },
  teamRowOn: { borderColor: COLORS.primary, backgroundColor: '#EAF1FE' },
});
