const { DELIVERABLE_TYPES, isDeliverableType, deliverableLabel } = require('../deliverableType');

describe('deliverableType', () => {
  it('offers Module, App and EXE in that order', () => {
    expect(DELIVERABLE_TYPES.map((t) => t.code)).toEqual(['module', 'app', 'exe']);
    expect(DELIVERABLE_TYPES.map((t) => t.label)).toEqual(['Module', 'App', 'EXE']);
  });

  it('knows only those three codes', () => {
    expect(isDeliverableType('exe')).toBe(true);
    expect(isDeliverableType('EXE')).toBe(false);   // the server lowercases; the app sends codes
    expect(isDeliverableType('')).toBe(false);
    expect(isDeliverableType(undefined)).toBe(false);
  });

  it('labels a code, and nothing for blank or unknown', () => {
    expect(deliverableLabel('app')).toBe('App');
    expect(deliverableLabel('')).toBe('');
    expect(deliverableLabel('dll')).toBe('');
  });
});
