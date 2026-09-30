import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

// Lets a screen take Android's back press before App.js does — to close its own
// detail view, dropdown or tab rather than leaving the screen. Return true to say
// "handled"; return false to let the press fall through to App.js.
//
// Registered ONCE per mount, with the handler read through a ref. React Native
// asks the newest listener first, so re-registering on every render would keep
// moving this one to the front and scramble the order. The screen mounted last
// (the deepest one showing) is always asked first. To switch it off, return
// false — never register conditionally.
//
// A parent and a child using this in the SAME commit register child-first, so
// the parent would be asked first. No screen does that today: every inner view
// (a task detail, an invoice form) mounts after the screen that holds it.
export default function useBackHandler(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress',
      () => !!(ref.current && ref.current()));
    return () => sub.remove();
  }, []);
}
