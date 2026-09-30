// The rules for a Meeting pause, shared by every dialog that asks for one (the
// board's Pause, Pause-all, idle popup and switch, and Home's pause dialog), so
// they cannot drift into disagreeing about what a valid meeting is.
//
// "Team meeting" is the everyday case: the whole team, no one to name and
// nothing to explain. Picking it means no note is required and nobody is sent as
// an attendee; with no note typed, "Team meeting" is what the Workday Map shows.

export const TEAM_MEETING_LABEL = 'Team meeting';

// Reasons that need words typed. Meeting is here because "Meeting" alone says
// nothing about what it cost the day — unless it is a team meeting, which does.
export const baseNoteRequired = (code) => code === 'other' || code === 'urgent' || code === 'meeting';
export const noteRequired = (code, team) => baseNoteRequired(code) && !(code === 'meeting' && team);

// The pause reason sent to the server: the typed note, else "Team meeting" for a
// team meeting, else the reason's own label.
export const pauseReasonText = (note, code, team, label, max) =>
  String(note || '').trim().slice(0, max) || (code === 'meeting' && team ? TEAM_MEETING_LABEL : label);

// Attendees travel only with a meeting, and a team meeting names nobody.
export const meetingIds = (code, team, picked) => (code === 'meeting' && !team ? (picked || []) : []);

// The idle popup and the switch dialog send a note rather than a reason; the
// note is optional there, so a team meeting simply fills an empty one.
export const idleMeetingNote = (note, team) => String(note || '').trim() || (team ? TEAM_MEETING_LABEL : '');
