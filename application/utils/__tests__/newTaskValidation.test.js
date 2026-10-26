// The New Task form's rules. Order and wording ARE the contract — these mirror
// submitNewTask() in the Odoo web report, and the point of pinning them is that
// a port which reorders the checks still "works" while complaining about the
// wrong field first.

const {
  validateNewTask, toSeconds, DOC_TYPES, prefixForDocType,
} = require('../newTaskValidation');

// Everything filled in. Each test below breaks exactly one thing.
const OK = {
  name: 'Login screen', kra_id: 12, user_id: 3, doc_type: 'requirement',
  estimate_hours: 2, estimate_minutes: 0, worked_hours: 1, worked_minutes: 30,
  priority: 'regular', deliverable_type: 'app',
};

describe('validateNewTask', () => {
  test('a complete form passes', () => {
    expect(validateNewTask(OK)).toBe('');
  });

  test('each rule fires with the web\'s exact wording', () => {
    expect(validateNewTask({ ...OK, name: '   ' })).toBe('Task name is required.');
    expect(validateNewTask({ ...OK, kra_id: '' })).toBe('Pick a project.');
    expect(validateNewTask({ ...OK, estimate_hours: 0, estimate_minutes: 0 }))
      .toBe('Estimate Time is required. Please enter hours and/or minutes.');
    expect(validateNewTask({ ...OK, worked_hours: 0, worked_minutes: 0 }))
      .toBe('Time worked is required. Enter the hours and/or minutes already spent.');
    expect(validateNewTask({ ...OK, user_id: '' }))
      .toBe('Pick an assignee — time worked is recorded against a person.');
  });

  test('first failure wins, in the web\'s order', () => {
    // Everything blank: the NAME is what it complains about, not the assignee.
    const empty = { name: '', kra_id: '', user_id: '', estimate_hours: 0, worked_hours: 0 };
    expect(validateNewTask(empty)).toBe('Task name is required.');
    // Name fixed → the project is next, still not the assignee.
    expect(validateNewTask({ ...empty, name: 'x' })).toBe('Pick a project.');
    expect(validateNewTask({ ...empty, name: 'x', kra_id: 4 }))
      .toBe('Estimate Time is required. Please enter hours and/or minutes.');
  });

  test('minutes alone satisfy a time pair — neither half is required on its own', () => {
    expect(validateNewTask({ ...OK, estimate_hours: 0, estimate_minutes: 30 })).toBe('');
    expect(validateNewTask({ ...OK, worked_hours: 0, worked_minutes: 15 })).toBe('');
  });

  test('Module / App / EXE / Other is required, and checked last', () => {
    expect(validateNewTask({ ...OK, deliverable_type: '' })).toBe('Pick a type — Module, App, EXE, Website, Database or Other.');
    // Everything blank still complains about the name first.
    expect(validateNewTask({})).toBe('Task name is required.');
    expect(validateNewTask({ ...OK, user_id: '', deliverable_type: '' }))
      .toBe('Pick an assignee — time worked is recorded against a person.');
  });

  test('Other needs its text', () => {
    expect(validateNewTask({ ...OK, deliverable_type: 'other' }))
      .toBe('Type what the Other type is (e.g. Plugin, Website).');
    expect(validateNewTask({ ...OK, deliverable_type: 'module,other', deliverable_other: '  ' }))
      .toBe('Type what the Other type is (e.g. Plugin, Website).');
    expect(validateNewTask({ ...OK, deliverable_type: 'other', deliverable_other: 'Plugin' })).toBe('');
  });

  test('Priority and Type are never validated', () => {
    // Starred on the web, checked nowhere. They always hold a value.
    expect(validateNewTask({ ...OK, priority: '', doc_type: '' })).toBe('');
  });

  test('empty strings from text inputs count as zero, not NaN', () => {
    expect(toSeconds('', '')).toBe(0);
    expect(toSeconds('2', '30')).toBe(9000);
    expect(toSeconds('abc', '')).toBe(0);
    expect(validateNewTask({ ...OK, estimate_hours: '', estimate_minutes: '' }))
      .toBe('Estimate Time is required. Please enter hours and/or minutes.');
  });
});

describe('doc types', () => {
  // The prefix is what create_kpi mints into external_ref, and what the report's
  // Type filter matches on. Getting it wrong makes the task invisible to the
  // filter meant to find it.
  test('map to the reference prefixes the server mints', () => {
    expect(DOC_TYPES.map((d) => d.code)).toEqual(['requirement', 'update', 'bug']);
    expect(prefixForDocType('requirement')).toBe('REQ');
    expect(prefixForDocType('update')).toBe('UPT');
    expect(prefixForDocType('bug')).toBe('BUG');
    expect(prefixForDocType('nonsense')).toBe('');
  });
});
