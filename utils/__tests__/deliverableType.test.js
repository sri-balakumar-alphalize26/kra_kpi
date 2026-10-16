const {
  DELIVERABLE_TYPES, isDeliverableType, deliverableLabel, hasDeliverable, toggleDeliverable,
} = require('../deliverableType');

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

  it('labels several types stored together', () => {
    expect(deliverableLabel('module,app')).toBe('Module + App');
    expect(deliverableLabel('module,app,exe')).toBe('Module + App + EXE');
    expect(deliverableLabel(null)).toBe('');
  });

  it('ticks and unticks types, keeping the server order', () => {
    expect(toggleDeliverable('', 'app')).toBe('app');
    expect(toggleDeliverable('app', 'module')).toBe('module,app');
    expect(toggleDeliverable('module,app', 'exe')).toBe('module,app,exe');
    expect(toggleDeliverable('module,app', 'module')).toBe('app');
    expect(toggleDeliverable('app', 'app')).toBe('');
    expect(toggleDeliverable(null, 'exe')).toBe('exe');
  });

  it('knows which types are ticked', () => {
    expect(hasDeliverable('module,app', 'app')).toBe(true);
    expect(hasDeliverable('module,app', 'exe')).toBe(false);
    expect(hasDeliverable('', 'app')).toBe(false);
  });
});
