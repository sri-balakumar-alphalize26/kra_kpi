// The "From old DB" rule. Rule and wording ARE the contract — these mirror
// legacy_input_problem() in models/kpi_legacy.py, and an app that is looser than
// the server sends requests the server then refuses.

const {
  legacyProblem, legacyHint, legacyBadge, normalizeLegacyRef, voiceSeconds, voiceNoteName,
  isAudio, isImageOrVideo, isUsableVoice,
  LEGACY_MISSING_MSG, VOICE_SHORT_MSG, REF_BAD_MSG, LEGACY_OK_MSG, MIC_FAILED_MSG,
} = require('../legacyReq');

describe('legacyProblem', () => {
  test('nothing at all cannot be sent — photo or video is asked for first', () => {
    expect(legacyProblem({})).toBe(LEGACY_MISSING_MSG);
    expect(LEGACY_MISSING_MSG).toBe('Add a photo or video of the old screen if you can — if not possible, record a voice note or type a message (or add the Request ID).');
    expect(legacyProblem({ ref: '  ', name: ' ', note: '  ', files: [] })).toBe(LEGACY_MISSING_MSG);
  });

  test('a valid Request ID is enough; a bad one says what it looks like', () => {
    expect(legacyProblem({ ref: 'REQ-012' })).toBe('');
    expect(legacyProblem({ ref: 'req 12' })).toBe('');
    expect(legacyProblem({ ref: 'REQ12' })).toBe('');
    expect(legacyProblem({ ref: 'BUG-012' })).toBe(REF_BAD_MSG);
    // A bad ref wins even with a long message, as on the server.
    expect(legacyProblem({ ref: 'abc', note: 'x'.repeat(40) })).toBe(REF_BAD_MSG);
    expect(REF_BAD_MSG).toBe('The Request ID looks like REQ-012.');
  });

  test('task name: 15+ characters or 3+ words', () => {
    expect(legacyProblem({ name: 'Invoice printing' })).toBe('');
    expect(legacyProblem({ name: 'a b c' })).toBe('');
    expect(legacyProblem({ name: 'Invoice print' })).toBe(LEGACY_MISSING_MSG);
    expect(legacyProblem({ name: '  two   words ' })).toBe(LEGACY_MISSING_MSG);
  });

  test('typed message: 30+ characters, whitespace squashed', () => {
    expect(legacyProblem({ note: 'x'.repeat(30) })).toBe('');
    expect(legacyProblem({ note: 'x'.repeat(29) })).toBe(LEGACY_MISSING_MSG);
    expect(legacyProblem({ note: `${'x'.repeat(14)}      ${'x'.repeat(14)}` })).toBe(LEGACY_MISSING_MSG);
  });

  test('a photo or a video is enough on its own', () => {
    expect(legacyProblem({ files: [{ name: 'photo.jpg', size: 2000, mimetype: 'image/jpeg' }] })).toBe('');
    expect(legacyProblem({ files: [{ name: 'clip.mp4', size: 2000 }] })).toBe('');
    expect(legacyProblem({ files: [{ name: 'photo.jpg', size: 0 }] })).toBe(LEGACY_MISSING_MSG);
  });

  test('voice note: 5 s or more by its name, else 16000 bytes', () => {
    expect(legacyProblem({ files: [{ name: 'Voice note 1 (0m07s).m4a', size: 100 }] })).toBe('');
    expect(legacyProblem({ files: [{ name: 'Voice note 1 (0m05s).m4a', size: 100 }] })).toBe('');
    expect(legacyProblem({ files: [{ name: 'Voice note 1 (0m04s).m4a', size: 999999 }] })).toBe(VOICE_SHORT_MSG);
    expect(legacyProblem({ files: [{ name: 'memo.m4a', size: 16000 }] })).toBe('');
    expect(legacyProblem({ files: [{ name: 'memo.m4a', size: 15999 }] })).toBe(VOICE_SHORT_MSG);
    expect(VOICE_SHORT_MSG).toBe('The voice note is too short (5 seconds or more) — add a photo or video if you can, if not possible record again or type a message.');
  });

  test('a short voice note plus a long message is fine', () => {
    expect(legacyProblem({ note: 'x'.repeat(30), files: [{ name: 'Voice note 1 (0m02s).m4a', size: 10 }] })).toBe('');
  });
});

describe('helpers', () => {
  test('normalizeLegacyRef', () => {
    expect(normalizeLegacyRef('req 12')).toBe('REQ-012');
    expect(normalizeLegacyRef('REQ-0012')).toBe('REQ-012');
    expect(normalizeLegacyRef('REQ - 1234')).toBe('REQ-1234');
    expect(normalizeLegacyRef('')).toBe('');
    expect(normalizeLegacyRef('BUG-1')).toBeNull();
  });

  test('voice note names carry the length the server reads back', () => {
    expect(voiceNoteName(1, 7200)).toBe('Voice note 1 (0m07s).m4a');
    expect(voiceNoteName(2, 65000, '.m4a')).toBe('Voice note 2 (1m05s).m4a');
    expect(voiceSeconds(voiceNoteName(3, 125000))).toBe(125);
    expect(voiceSeconds('memo.m4a')).toBeNull();
  });

  test('file kinds', () => {
    expect(isAudio('a.m4a')).toBe(true);
    expect(isAudio('a.3gp', 'video/3gpp')).toBe(false);
    expect(isImageOrVideo('a.3gp')).toBe(true);
    expect(isImageOrVideo('a.pdf', 'application/pdf')).toBe(false);
    expect(isUsableVoice('a.pdf', 99999)).toBe(false);
  });

  test('legacyHint is red until enough, then green', () => {
    expect(legacyHint({})).toEqual({ text: LEGACY_MISSING_MSG, ok: false });
    expect(legacyHint({ ref: 'REQ-1' })).toEqual({ text: LEGACY_OK_MSG, ok: true });
    expect(LEGACY_OK_MSG).toBe('✓ Enough to trace this — the team adds anything missing later.');
    expect(MIC_FAILED_MSG).toBe("Can't use the mic — type it instead.");
  });

  test('legacyBadge', () => {
    expect(legacyBadge({})).toBeNull();
    expect(legacyBadge({ legacy_req_link: true, legacy_status: 'pending' })).toEqual({ label: '🗄️ Old DB', pending: true });
    expect(legacyBadge({ legacy_req_link: true, legacy_status: 'confirmed' })).toEqual({ label: '🗄️ Old DB', pending: false });
  });
});
