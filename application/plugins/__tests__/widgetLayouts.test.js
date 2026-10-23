// Every tag in a widget layout must be one RemoteViews can inflate.
//
// The launcher inflates a widget through a LayoutInflater filter that admits only
// classes annotated @RemoteViews.RemoteView. Anything else throws "Class not
// allowed to be inflated" and the home screen shows the launcher's error tile in
// place of the widget — with nothing in the app's own logs, because the failure
// happens in the launcher's process. Plain android.view.View is NOT on the list,
// and a bare <View> used as a divider is exactly how both widgets went dark once.
// This pins the allow-list so a restyle cannot reintroduce it.

const { widgetLayoutXml: taskLayout, providerKt: taskProvider } = require('../withTaskWidget');
const {
  widgetLayoutXml: liveTrackingLayout,
  itemLayoutXml: liveTrackingItem,
  providerKt: liveTrackingProvider,
} = require('../withLiveTrackingWidget');
const { LIGHT, DARK } = require('../widgetShared');

// The view classes RemoteViews supports (android.widget.RemoteViews docs, "the
// mechanism supports only the following"). Descendants are not supported either.
const ALLOWED = new Set([
  // layouts
  'FrameLayout', 'LinearLayout', 'RelativeLayout', 'GridLayout',
  // widgets
  'AnalogClock', 'Button', 'Chronometer', 'ImageButton', 'ImageView',
  'ProgressBar', 'TextClock', 'TextView', 'ViewFlipper', 'ViewStub',
  // collections
  'ListView', 'GridView', 'StackView', 'AdapterViewFlipper',
]);

/** Element names in an XML string, in document order. Skips <?xml ?> and comments. */
function tagsIn(xml) {
  const names = [];
  const re = /<([A-Za-z][\w.]*)/g;
  let m;
  while ((m = re.exec(xml)) !== null) names.push(m[1]);
  return names;
}

/** Every `@+id/<name>` a layout declares. */
function idsDeclared(xml) {
  return new Set([...xml.matchAll(/@\+id\/(\w+)/g)].map((m) => m[1]));
}

/** Every `R.<kind>.<name>` a Kotlin source touches. */
function resourcesUsed(kt, kind) {
  return new Set([...kt.matchAll(new RegExp(`R\\.${kind}\\.(\\w+)`, 'g'))].map((m) => m[1]));
}

describe.each([
  ['task widget', taskLayout, taskProvider('com.example.app')],
  // The card and its list item together: the provider fills both, so an id it
  // touches may live in either, and both must pass the allow-list.
  ['live tracking widget', liveTrackingLayout + liveTrackingItem, liveTrackingProvider('com.example.app')],
])('%s layout', (_name, xml, kotlin) => {
  it('declares every id the provider touches', () => {
    // A RemoteViews action aimed at an id the layout does not have is the same
    // launcher error tile as a disallowed view — it fails when applied, not when
    // compiled, so nothing but a test catches it before a phone does.
    const declared = idsDeclared(xml);
    const missing = [...resourcesUsed(kotlin, 'id')].filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it('only uses colours the palette defines, in both themes', () => {
    const known = new Set(Object.keys(LIGHT));
    expect(Object.keys(DARK).sort()).toEqual([...known].sort());
    const missing = [...resourcesUsed(kotlin, 'color')].filter((c) => !known.has(c));
    expect(missing).toEqual([]);
    const inLayout = [...xml.matchAll(/@color\/(\w+)/g)].map((m) => m[1]).filter((c) => !known.has(c));
    expect(inLayout).toEqual([]);
  });
  it('exports a real layout', () => {
    expect(typeof xml).toBe('string');
    expect(tagsIn(xml).length).toBeGreaterThan(0);
  });

  it('uses only views RemoteViews can inflate', () => {
    const offenders = tagsIn(xml).filter((t) => !ALLOWED.has(t));
    expect(offenders).toEqual([]);
  });

  it('never uses a bare <View>', () => {
    // Called out on its own because it is the one that actually bit: it looks
    // harmless, works in every ordinary layout, and fails only on the home screen.
    expect(xml).not.toMatch(/<View[\s>]/);
  });
});
