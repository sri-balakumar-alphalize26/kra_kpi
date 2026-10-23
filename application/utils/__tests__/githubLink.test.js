// Filling the GitHub repo/branch fields from a pasted URL.
//
// The whole point is to stop somebody retyping a branch the URL already names, so
// the cases that matter are the shapes GitHub actually hands out — and the one
// case where the app must NOT be clever, which is when a branch was typed by hand.
const { resolveGithubLink } = require('../githubLink');

describe('resolveGithubLink', () => {
  it('takes the branch out of a /tree/ URL and trims the repo back to its root', () => {
    expect(resolveGithubLink('https://github.com/acme/widgets/tree/feature-x', ''))
      .toEqual({ url: 'https://github.com/acme/widgets', branch: 'feature-x' });
  });

  it('keeps a branch that contains slashes whole', () => {
    // "feature/login" is one branch, not a branch inside a folder. Splitting on the
    // last slash would silently record "login".
    expect(resolveGithubLink('https://github.com/acme/widgets/tree/feature/login', ''))
      .toEqual({ url: 'https://github.com/acme/widgets', branch: 'feature/login' });
  });

  it('never overwrites a branch the user typed', () => {
    // They pasted one branch's URL but mean to record another. Second-guessing them
    // would leave no way to force the branch they actually want.
    expect(resolveGithubLink('https://github.com/acme/widgets/tree/main', 'release-2'))
      .toEqual({ url: 'https://github.com/acme/widgets', branch: 'release-2' });
  });

  it('defaults a plain repo URL to main rather than refusing', () => {
    expect(resolveGithubLink('https://github.com/acme/widgets', ''))
      .toEqual({ url: 'https://github.com/acme/widgets', branch: 'main' });
  });

  it('never guesses master — a wrong branch recorded silently is worse than typing one', () => {
    expect(resolveGithubLink('https://github.com/acme/widgets', '').branch).toBe('main');
  });

  it('leaves a URL it does not recognise alone, for the server to judge', () => {
    // github.com-only is the server's rule and stays in one place; this must not
    // start rejecting things itself.
    expect(resolveGithubLink('https://gitlab.com/acme/widgets', ''))
      .toEqual({ url: 'https://gitlab.com/acme/widgets', branch: 'main' });
  });

  it('trims whitespace and a trailing slash after the branch', () => {
    expect(resolveGithubLink('  https://github.com/acme/widgets/tree/dev/  ', ' '))
      .toEqual({ url: 'https://github.com/acme/widgets', branch: 'dev' });
  });

  it('survives empty input', () => {
    expect(resolveGithubLink('', '')).toEqual({ url: '', branch: 'main' });
    expect(resolveGithubLink(undefined, undefined)).toEqual({ url: '', branch: 'main' });
  });
});
