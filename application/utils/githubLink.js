// Fill in the GitHub repo/branch fields from whatever was pasted.
//
// The URL GitHub hands you while you are looking at a branch already names it:
//
//   https://github.com/user/repo/tree/feature-x
//
// Before this, that whole URL was stored as the repository AND the branch was still
// demanded separately — so you retyped what you had just pasted, and the saved link
// pointed at a branch view rather than the repo root.
//
// Purely a convenience over the fields: the server still owns the rules (github.com
// only, branch required), so nothing here decides whether a link is acceptable.
//
// The web app keeps a copy in web/lib/githubLink.js (it is its own Next root and
// cannot import from here). Change both together.

// A branch can contain slashes ("feature/x"), so everything after /tree/ is the
// branch — it is the LAST path segment that varies, not the depth.
const TREE = /^(https?:\/\/[^/]*github\.com\/[^/]+\/[^/]+)\/tree\/(.+?)\/*$/i;

/**
 * @param {string} rawUrl   what is in the Repository URL box
 * @param {string} rawBranch what is in the Branch box
 * @returns {{ url: string, branch: string }} both trimmed and filled in
 */
export function resolveGithubLink(rawUrl, rawBranch) {
  const url = String(rawUrl || '').trim();
  const typed = String(rawBranch || '').trim();

  const m = TREE.exec(url);
  if (m) {
    return {
      url: m[1],
      // A branch the user typed themselves always wins. Overwriting a deliberate
      // entry from a pasted URL would be the app second-guessing them, and they
      // would have no way to force the branch they meant.
      branch: typed || decodeURIComponent(m[2]),
    };
  }

  // No branch anywhere: assume `main`. GitHub's default for new repositories, and
  // the right answer in the large majority of cases.
  //
  // `master` is deliberately never guessed. Guessing wrong records a branch that
  // does not exist, silently — worse than making someone type it, because nothing
  // on screen would ever say it was wrong.
  return { url, branch: typed || 'main' };
}
