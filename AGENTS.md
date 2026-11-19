# atlassian-forks/berry

This fork of [yarnpkg/berry](https://github.com/yarnpkg/berry) builds the custom Yarn that atlassian-frontend-monorepo (AFM) runs. AFM pins it at `.yarn/releases/yarn-4.17.1-custom.cjs`, and AFM keeps its side of these instructions in `.yarn/AGENTS.md`.

These instructions are for people and coding agents. Read all of this before you change anything here or ship a build to AFM.

## Branch model

| Branch | Role | Rules |
|---|---|---|
| `master` | Mirror of upstream `yarnpkg/berry` master | Holds only upstream commits plus this file. Sync it from upstream; never put changes here |
| `pr/<topic>` | One change per branch | Cut from `master`, so it can go upstream as is. PRs from other forks count too, e.g. #2 |
| `base/4.17.1` | The upstream base we ship on, pinned at `20c78398f` | **Never move it.** See "The base" below |
| `custom/4.17.1-all-perf-fixes` | **The release branch.** It is what AFM runs | Only ports (`git cherry-pick -x`) of changes from `pr/*` branches or PRs |
| `custom/all-perf-fixes` | Superseded: the 4.18-based build from AFM round 3, which was reverted | Don't build from it |
| `speed-up-resolution`, `speed-package-maps`, `custom/build-concurrency` | Superseded or already upstreamed | Don't build from them |
| `tracking/change-tracking` | Empty branch that carries PR #1 | Don't merge |

Two draft PRs track the state. Neither is ever merged.

* **#1, all changes tracking:** every change made or proposed, and where it stands (upstreamed, proposed, released).
* **#3, released changes tracking:** `custom/4.17.1-all-perf-fixes` against `base/4.17.1`. Its diff is exactly what ships, and its description lists every released commit, the latest bundle, and the AFM rollouts.

## The base

`base/4.17.1` = upstream `0a230c14e` + "perf(nm): avoid redundant package map sorting" (upstreamed as yarnpkg/berry#7223). It is the same base as the AFM build before our patches (`4.17.1-git.20260715.hash-20c78398f`).

Moving to a newer upstream is a separate, deliberate project, not something to do in passing. AFM round 3 was reverted because its build quietly sat on 4.18:

* yarnpkg/berry#7216 changed how `node_modules/.bin` resolves bin-name collisions: it used to keep the last package and now keeps the first.
* AFM's `.bin/playwright` flipped to a transitive `@playwright/experimental-ct-react`, which broke CI.
* The 4.18 base also rewrote `yarn.ap.lock`.

Any base move needs the AFM verification below, and its PR description has to say plainly that the base moved.

## Making a change

1. **Own branch.** Cut `pr/<topic>` from `master`. Make the change with tests and a `.yarn/versions/*.yml` entry. Push it to this fork, and propose it upstream when it's ready.
2. **Verify on the branch:**
   * `yarn test:unit <paths>` for the tests you touched or added.
   * `yarn tsc --noEmit` for the whole repo. Jest runs through babel and doesn't type-check, so a test can pass and still fail `tsc`.
   * `yarn eslint <files>`.
3. **Port to the release branch:**
   ```bash
   git switch custom/4.17.1-all-perf-fixes
   git cherry-pick -x <commit>   # -x records "cherry picked from commit …"
   ```
   * If it conflicts, keep the fix minimal (usually import lines) and re-run the step 2 checks.
   * Never merge `master` or `pr/*` branches into the release branch; that drags in the newer upstream base.
   * A fix to something already released goes the same way: commit it on its `pr/*` branch, then port it.
4. **Push both branches**, then update #1 and #3.

## Building a bundle

```bash
git switch custom/4.17.1-all-perf-fixes
yarn build:cli          # writes packages/yarnpkg-cli/bundles/yarn.js
```

* The build log prints the version, `4.17.1-git.<commit date>.hash-<short sha>`. The hash is the release branch head, which is how you trace any AFM build back here.
* Check the version from outside this repo. Inside it, the repo's own `yarnPath` answers `4.17.1-dev`:
  ```bash
  cd "$TMPDIR" && YARN_IGNORE_PATH=1 node <berry>/packages/yarnpkg-cli/bundles/yarn.js --version
  ```
* Keep a named copy: `cp packages/yarnpkg-cli/bundles/yarn.js packages/yarnpkg-cli/bundles/yarn-4.17.1-custom-<sha>.cjs` (bundles are git-ignored).

## Shipping to AFM

Each rollout is one AFM PR, cut from a fresh `origin/master`.

1. **Replace the release file.** Copy the bundle over `.yarn/releases/yarn-4.17.1-custom.cjs` and **keep that filename**, so `.yarnrc.yml` doesn't change.
2. **Lockfiles.** `yarn.lock` and `yarn.ap.lock` must stay untouched. If either changes, stop: the build is doing something different from the current one.
3. **Bin composition.**
   * Record every `node_modules/.bin` entry and its target, once with the current AFM build and once with the new one.
   * Use the same single install for both, e.g. `afm install jira -y`, the smaller product.
   * Diff the two lists. Zero differences is the pass bar, `.bin/playwright -> ../playwright/cli.js` included.
   * Run installs one at a time. AFM installs into one place, so each install replaces the previous one.
4. **The two-install path.**
   * Run `yarn workspaces focus-recursive --verbose --mode skip-build @product/platform` and check that it completes.
   * Plain `afm install platform` doesn't cover this path: it usually runs with `--mode trust-lockfile`.
   * Round 2 ran out of memory here: AFM's focus plugin pushes about 1,400 resolutions in place between its two installs.
5. **PR description.** Link this fork's release branch and commit, list every change shipped against the current AFM build, and include the results of steps 2–4. Then add the rollout to #3.

AFM quirks:

* Run `afm` directly from an interactive shell, and pass `-y`. Invoked from a script, it has been seen running a lockfile update instead of the install, which AFM's `global-install-interceptor` plugin then rejects.
* Root dependencies can't go through `afm deps add`, which needs a product folder. Edit the root `package.json`, then run `afm install <product> --lockfile-only -y`.
* The first install with a zstd build can rebuild native packages once. That's expected.
