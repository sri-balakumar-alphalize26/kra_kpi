// The one place that decides whether an End Workday note is acceptable — shared by
// the web dialog and the app's end-workday sheet so the two can never disagree.
//
// Kept as a PURE function with zero React Native / Expo imports, and written as
// CommonJS, for the same reason as workdayState.js: it unit-tests under plain
// `jest` with no device, no emulator and no babel transform, while the app imports
// it through Metro's CJS interop.
//
// THE NOTE IS OPTIONAL. An empty note is valid and must always be allowed to end the
// day — End Workday is one-way, and nothing here may stand between a developer and
// closing their own day. This only rejects a note that was typed but says nothing.
//
// "Only words" does NOT mean letters-only. A real note from this team reads:
//
//   Module documents
//   ->Signage scan module doc
//   ...
//   Chats server connecting issue + Dark/light mode switch bug + Build taken for testing
//   KRA KPI checked for client side invoice generate + When checking found 4 error...
//
// — 396 characters across 15 lines, using - > ( ) + / and digits. A letters-only rule
// would reject the very thing people actually write. So punctuation and numbers pass
// freely; what gets rejected is a note with no actual words in it: ".", "123", "----",
// "...". The test is simply whether at least two real words are present.

// Longer than anyone writes in a day, short enough to stop a runaway paste. Deliberately
// a round common limit rather than one fitted to the sample above.
const NOTE_MAX = 2000;

// Two words, because one ("done", "ok") carries no more information than an empty box
// and is the obvious way to click past a prompt.
const MIN_WORDS = 2;

function wordCount(note) {
  // Strip everything that isn't a letter, then count the runs of 2+ letters that remain.
  // Digits are intentionally not words: "4" in "found 4 errors" is detail, not content,
  // and a note of "123" should not pass.
  const words = String(note || '').match(/[A-Za-z]{2,}/g);
  return words ? words.length : 0;
}

// Returns { ok, reason, value }.
//   ok     — safe to submit
//   reason — why not, for showing next to the field (empty when ok)
//   value  — the note to send, trimmed and clamped to NOTE_MAX
function validateWorkdayNote(note) {
  const raw = String(note == null ? '' : note);
  const trimmed = raw.trim();

  // Optional: nothing typed is fine, and ends the day.
  if (!trimmed) return { ok: true, reason: '', value: '' };

  if (wordCount(trimmed) < MIN_WORDS) {
    return {
      ok: false,
      reason: 'Please write a few words about what you did today, or leave it empty.',
      value: trimmed.slice(0, NOTE_MAX),
    };
  }

  return { ok: true, reason: '', value: trimmed.slice(0, NOTE_MAX) };
}

module.exports = { validateWorkdayNote, wordCount, NOTE_MAX, MIN_WORDS };
module.exports.default = validateWorkdayNote;
