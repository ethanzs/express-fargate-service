/**
 * Commit messages follow Conventional Commits — semantic-release computes
 * versions from them (fix → patch, feat → minor, feat!/BREAKING CHANGE →
 * major; docs/chore/refactor → no release). Enforced locally by the husky
 * commit-msg hook and in CI on pull requests.
 *
 * Suggested scopes: api, hydrator, shared, infra, deps.
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
