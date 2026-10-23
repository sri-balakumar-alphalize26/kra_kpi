const {
  DELIVERABLE_TYPES, isDeliverableType, deliverableLabel, hasDeliverable, toggleDeliverable,
  taskDeliverableLabel, needsOtherText, missingOtherText, DELIVERABLE_OTHER_REQUIRED_MSG,
} = require('../deliverableType');

describe('deliverableType', () => {
  it('offers Module, App, EXE and Other in that order', () => {
    expect(DELIVERABLE_TYPES.map((t) => t.code)).toEqual(['module', 'app', 'exe', 'other']);
    expect(DELIVERABLE_TYPES.map((t) => t.label)).toEqual(['Module', 'App', 'EXE', 'Other']);
  });

  it('knows only those four codes', () => {
    expect(isDeliverableType('exe')).toBe(true);
    expect(isDeliverableType('other')).toBe(true);
    expect(isDeliverableType('EXE')).toBe(false);   // the server lowercases; the app sends codes
    expect(isDeliverableType('')).toBe(false);
    expect(isDeliverableType(undefined)).toBe(false);
  });

  it('labels a code, and nothing for blank or unknown', () => {
    expect(deliverableLabel('app')).toBe('App');
    expect(deliverableLabel('')).toBe('');
    expect(deliverableLabel('dll')).toBe('');
  });

  it('labels several types stored together', () => {
    expect(deliverableLabel('module,app')).toBe('Module + App');
    expect(deliverableLabel('module,app,exe')).toBe('Module + App + EXE');
    expect(deliverableLabel(null)).toBe('');
  });

  it('labels Other with its typed text, or plain Other without', () => {
    expect(deliverableLabel('other', 'Plugin')).toBe('Plugin');
    expect(deliverableLabel('module,other', 'Plugin')).toBe('Module + Plugin');
    expect(deliverableLabel('module,other', '  ')).toBe('Module + Other');
    expect(deliverableLabel('other')).toBe('Other');
    // The text means nothing unless Other is picked.
    expect(deliverableLabel('app', 'Plugin')).toBe('App');
  });

  it('prefers the label the server made for a task', () => {
    expect(taskDeliverableLabel({ deliverable_type: 'module,other', deliverable_other: 'Plugin', deliverable_label: 'Module + Plugin' }))
      .toBe('Module + Plugin');
    expect(taskDeliverableLabel({ deliverable_type: 'app,other', deliverable_other: 'Website' })).toBe('App + Website');
    expect(taskDeliverableLabel({})).toBe('');
    expect(taskDeliverableLabel(null)).toBe('');
  });

  it("asks for Other's text only while Other is picked", () => {
    expect(needsOtherText('module,other')).toBe(true);
    expect(needsOtherText('module,app')).toBe(false);
    expect(missingOtherText('other', '')).toBe(true);
    expect(missingOtherText('other', '   ')).toBe(true);
    expect(missingOtherText('other', 'Plugin')).toBe(false);
    expect(missingOtherText('app', '')).toBe(false);
    expect(DELIVERABLE_OTHER_REQUIRED_MSG).toBe('Type what the Other type is (e.g. Plugin, Website).');
  });

  it('ticks and unticks types, keeping the server order', () => {
    expect(toggleDeliverable('', 'app')).toBe('app');
    expect(toggleDeliverable('app', 'module')).toBe('module,app');
    expect(toggleDeliverable('module,app', 'exe')).toBe('module,app,exe');
    expect(toggleDeliverable('module,app', 'module')).toBe('app');
    expect(toggleDeliverable('app', 'app')).toBe('');
    expect(toggleDeliverable(null, 'exe')).toBe('exe');
    expect(toggleDeliverable('other', 'module')).toBe('module,other');
    expect(toggleDeliverable('exe,other', 'app')).toBe('app,exe,other');
  });

  it('knows which types are ticked', () => {
    expect(hasDeliverable('module,app', 'app')).toBe(true);
    expect(hasDeliverable('module,app', 'exe')).toBe(false);
    expect(hasDeliverable('', 'app')).toBe(false);
  });
});
