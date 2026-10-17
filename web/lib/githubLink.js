/* Fill in the GitHub repo/branch fields from whatever was pasted.

   A copy of utils/githubLink.js in the mobile app (which has the tests,
   utils/__tests__/githubLink.test.js). This web app is its own Next root and
   cannot import from there, so change both together.

   The URL GitHub hands you while looking at a branch already names it:
     https://github.com/user/repo/tree/feature-x
   so that is split into the repo root + the branch, instead of storing the
   branch view as the repository and asking for the branch again.

   Purely a convenience over the fields: the server still owns the rules
   (github.com only, branch required). */

/* A branch can contain slashes ("feature/x"), so everything after /tree/ is it. */
const TREE = /^(https?:\/\/[^/]*github\.com\/[^/]+\/[^/]+)\/tree\/(.+?)\/*$/i;

/** @returns {{ url: string, branch: string }} both trimmed and filled in */
export function resolveGithubLink(rawUrl, rawBranch) {
  const url = String(rawUrl || "").trim();
  const typed = String(rawBranch || "").trim();
  const m = TREE.exec(url);
  /* A branch the user typed themselves always wins over one in a pasted URL. */
  if (m) return { url: m[1], branch: typed || decodeURIComponent(m[2]) };
  /* No branch anywhere: `main`, GitHub's default. `master` is never guessed —
     a wrong guess records a branch that does not exist, silently. */
  return { url, branch: typed || "main" };
}
