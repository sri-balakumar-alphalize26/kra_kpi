// The app's own alert / confirm, as a hook.
//
// AppDialog existed but only KpiActionBoard used it, through a `say()` helper
// local to that file. Every other screen reached for Alert.alert instead — OS
// chrome on a screen that is otherwise rounded cards and gradients, with no way
// to show the danger red a delete deserves and, on Android, no busy state at all:
// the native alert dismisses the instant you tap it and leaves the row sitting
// there while the request is still in flight.
//
// This lifts the board's idiom (KpiActionBoard.js ~1341) out so the other seven
// screens get it without pasting the state, the render and the haptic mapping
// eight times.
//
// Usage:
//   const { dialog, say, showError, confirm } = useAppDialog();
//   ...
//   return (<View>…{dialog}</View>);
//
// Stacking over an open Modal is fine and is the established pattern here — RN
// presents by MOUNT order, not JSX order, so a dialog raised by a tap inside a
// sheet paints above it. See the comment at Reminders.js's <AppDialog>.
//
// What this is NOT for: "you left a box empty". Validation belongs next to the
// field, via components/FieldError. KpiActionBoard put it plainly — "the box it
// complains about is right there, so an OS alert thrown over the top put the
// complaint further away than the fix." A second modal is the same mistake in
// our own colours.
import React, { useState, useCallback } from 'react';
import AppDialog from './AppDialog';
import * as H from '../utils/haptics';

export default function useAppDialog() {
  // One at a time, which is all a screen should ever be asking.
  const [dlg, setDlg] = useState(null);
  const close = useCallback(() => setDlg(null), []);

  const say = useCallback((title, message, tone = 'info') => {
    // The haptic belongs to the tone, not the call site — a refusal should feel
    // different from a confirmation before either is read.
    if (tone === 'warn' || tone === 'danger') H.err();
    else if (tone === 'ok') H.ok();
    setDlg({ title, message, tone });
  }, []);

  // Named for what the ~26 failure sites are doing, so they don't read as
  // "say this, warmly".
  const showError = useCallback((title, message) => say(title, message, 'warn'), [say]);

  const confirm = useCallback((opts) => {
    const { onConfirm, ...rest } = opts || {};
    setDlg({
      ...rest,
      tone: rest.tone || 'warn',
      // Busy is driven HERE rather than by each caller. AppDialog never sets it
      // itself, and hand-driving it is the step most likely to be forgotten —
      // the board does it by hand and that is exactly one screen's worth of
      // discipline. An onConfirm that returns a promise gets "Working…", a
      // disabled button and a dead back-gesture until it settles.
      onConfirm: (text) => {
        let r;
        try {
          r = onConfirm && onConfirm(text);
        } catch (e) {
          setDlg(null);
          throw e;
        }
        if (r && typeof r.then === 'function') {
          setDlg((d) => (d ? { ...d, busy: true } : d));
          // Closed on settle either way. A handler that needs to report a
          // failure afterwards just calls showError(): it is a later setState on
          // the same single slot, so it replaces this rather than fighting it.
          r.then(
            () => setDlg(null),
            () => setDlg(null),
          );
          return;
        }
        setDlg(null);
      },
    });
  }, []);

  const dialog = (
    <AppDialog
      visible={!!dlg}
      tone={dlg?.tone}
      title={dlg?.title}
      message={dlg?.message}
      confirmLabel={dlg?.confirmLabel}
      destructive={dlg?.destructive}
      busy={dlg?.busy}
      input={dlg?.input}
      onConfirm={dlg?.onConfirm}
      onClose={close}
    />
  );

  return { dialog, say, showError, confirm, close };
}
