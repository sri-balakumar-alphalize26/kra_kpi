const {
  noteRequired, pauseReasonText, meetingIds, idleMeetingNote, TEAM_MEETING_LABEL,
} = require('../meetingPick');

describe('noteRequired', () => {
  it('asks a plain meeting what it is about', () => {
    expect(noteRequired('meeting', false)).toBe(true);
  });
  it('lets a team meeting off', () => {
    expect(noteRequired('meeting', true)).toBe(false);
  });
  it('never lets Other or Urgent off, whatever the team flag says', () => {
    expect(noteRequired('other', true)).toBe(true);
    expect(noteRequired('urgent', true)).toBe(true);
    expect(noteRequired('break', false)).toBe(false);
  });
});

describe('pauseReasonText', () => {
  it('files an empty team meeting as "Team meeting"', () => {
    expect(pauseReasonText('', 'meeting', true, 'Meeting', 60)).toBe(TEAM_MEETING_LABEL);
  });
  it('keeps a typed note, trimmed and capped', () => {
    expect(pauseReasonText('  sprint review  ', 'meeting', true, 'Meeting', 60)).toBe('sprint review');
    expect(pauseReasonText('x'.repeat(80), 'meeting', false, 'Meeting', 60)).toHaveLength(60);
  });
  it('ignores the team flag for other reasons', () => {
    expect(pauseReasonText('', 'break', true, 'Break', 60)).toBe('Break');
  });
});

describe('meetingIds', () => {
  it('sends nobody for a team meeting or a non-meeting', () => {
    expect(meetingIds('meeting', true, [3, 4])).toEqual([]);
    expect(meetingIds('break', false, [3, 4])).toEqual([]);
  });
  it('sends the picked people for a named meeting', () => {
    expect(meetingIds('meeting', false, [3, 4])).toEqual([3, 4]);
  });
});

describe('idleMeetingNote', () => {
  it('fills an empty note only for a team meeting', () => {
    expect(idleMeetingNote('', true)).toBe(TEAM_MEETING_LABEL);
    expect(idleMeetingNote('', false)).toBe('');
    expect(idleMeetingNote(' standup ', true)).toBe('standup');
  });
});
