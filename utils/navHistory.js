// Where Android's back button goes. App.js keeps one screen name at a time
// (appScreen), so "back" used to mean "Home" from everywhere — a task opened
// from Notifications went back to Home, not to the list it came from. This is
// the trail behind the current screen, oldest first. Pure, so it is tested
// without rendering the app.

export const HISTORY_MAX = 20;
// Two back presses on Home this close together leave the app; one only warns.
export const EXIT_WINDOW_MS = 2000;

// `from` is the screen being left, `to` the one being opened. Home is the root:
// arriving there clears the trail, so back from Home can never walk into a
// screen visited an hour ago. Re-opening a screen already in the trail cuts the
// loop (A → B → A), otherwise back would bounce between the two forever.
export function pushHistory(stack, from, to) {
  if (!from || from === to) return stack;
  if (to === 'home') return [];
  const i = stack.indexOf(to);
  if (i >= 0) return stack.slice(0, i);
  return [...stack, from].slice(-HISTORY_MAX);
}

// The screen back should open, and the trail left behind it. An empty trail
// still has somewhere to go: Home.
export function popHistory(stack) {
  if (!stack.length) return { dest: 'home', stack: [] };
  return { dest: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

export function isSecondBackPress(lastAt, now, windowMs = EXIT_WINDOW_MS) {
  return !!lastAt && now - lastAt < windowMs;
}
