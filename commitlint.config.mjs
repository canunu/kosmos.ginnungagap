// Conventional commits, enforced by the commit-msg hook.
//
// The platform already standardises on this convention; see the Repo Tools list
// in kosmos.bootstrap's README, which links the specification.
//
// https://www.conventionalcommits.org/en/v1.0.0/
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Scopes are optional, but when present they should name a part of this
    // repository rather than being freeform, so that `git log --grep` is useful.
    //
    // `config` is separate from `compose` on purpose. A change to
    // config/deployment.json is a deployment, and a change to the compose template is a
    // change to how the service runs. Keeping the scopes apart is what makes
    // `git log --grep "(config)"` a readable deployment history, which is the
    // property the tracked configuration exists for.
    "scope-enum": [
      2,
      "always",
      [
        "compose",
        "config",
        "build", // the build and its supporting library
        "tests",
        "lint",
        "docs",
        "deps"
      ]
    ],
    // The default of 100 is generous enough that hitting it usually means the
    // subject is describing two changes.
    "header-max-length": [2, "always", 100],

    // Level 2 rather than the preset's 1. The commit-msg hook also passes
    // --strict, which promotes every warning to a failure, so this is belt and
    // braces: the level states the intent here, and the flag catches the rules
    // this file does not name.
    "body-max-line-length": [2, "always", 100]
  }
};
