// A render error must never be able to kill the whole app.
//
// WHY THIS EXISTS. In a DEV bundle React recovers from a render error and shows
// a red box, so a component that throws is an annoyance. In a PRODUCTION bundle
// there is no LogBox and no recovery: an uncaught render error unmounts the
// entire tree, the root view never draws a frame, and expo-splash-screen — which
// hides only once that first frame lands — keeps the native splash on screen
// forever. The app looks hung with nothing in logcat to say why.
//
// That is exactly what the 1.3.0 build did: `RangeError: Maximum call stack size
// exceeded` inside the animated intro, repeating, and a splash that never left.
// The same error had been firing in Expo Go for days and was written off as log
// noise precisely because dev mode kept the app alive.
//
// So two jobs, and the second matters as much as the first:
//   1. Contain the failure, so one bad subtree costs its own UI and nothing else.
//   2. REPORT it. log.error is the only level that survives a release build
//      (api/logger.js gates info on __DEV__), and the component stack is the only
//      thing that says *where* — a bare message is what made this take a day.
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { COLORS } from '../theme';
import { createLogger } from '../api/logger';

const log = createLogger('ErrorBoundary');

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Everything, on one line per field, because logcat truncation eats long
    // multi-line payloads and the stack is the whole point of being here.
    log.error(`caught in <${this.props.name || 'unnamed'}>`, error?.message || String(error));
    if (error?.stack) log.error('stack:', String(error.stack).slice(0, 4000));
    if (info?.componentStack) log.error('componentStack:', String(info.componentStack).slice(0, 4000));
    this.setState({ info });
    // Let the parent decide to carry on without this subtree (the splash does
    // exactly that — see App.js). Called AFTER logging so a throwing handler
    // cannot cost us the diagnosis.
    try { this.props.onError && this.props.onError(error, info); } catch (_) {}
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // `fallback` may be an element, a function of (error, reset), or null to
    // render nothing — null is what a non-essential subtree wants.
    const { fallback } = this.props;
    if (fallback === null) return null;
    if (typeof fallback === 'function') return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;

    return (
      <View style={s.root}>
        <Text style={s.title}>Something went wrong</Text>
        <Text style={s.sub}>
          The screen below failed to load. Your work is not lost — try again, and
          tell the team what you were doing.
        </Text>
        <ScrollView style={s.box} contentContainerStyle={{ padding: 12 }}>
          <Text style={s.mono}>{String(error?.message || error)}</Text>
        </ScrollView>
        <TouchableOpacity style={s.btn} onPress={this.reset} activeOpacity={0.85}>
          <Text style={s.btnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#EBF1FC', padding: 24, justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '900', color: COLORS.navy, textAlign: 'center' },
  sub: { fontSize: 13, color: COLORS.ink, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  box: { maxHeight: 180, backgroundColor: '#fff', borderRadius: 12, marginTop: 16 },
  mono: { fontSize: 11, color: '#B42318' },
  btn: {
    marginTop: 18, alignSelf: 'center', paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: 999, backgroundColor: COLORS.navy,
  },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
