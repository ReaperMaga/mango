/**
 * Mango's own `/create-release [notes]`: the chat shows the command as typed, and the agent gets the
 * instructions below instead. Like `/create-pr` it names no project's rules: the agent reads the
 * project's own (AGENTS.md, a releasing guide, the release workflow, earlier releases).
 *
 * The release is published with `gh` (on GitLab `glab`), or by the project's workflow or pipeline on
 * the tag push, so it shows in the Releases tool window.
 */

const COMMAND = /^\/create-release(?:\s+([\s\S]*))?$/

/**
 * The instructions for a `/create-release` message; null when `text` is not one. `provider` is where
 * the project's repository lives (`gh_repo_link`): GitLab releases go through `glab`.
 */
export function createReleasePrompt(text: string, provider: 'github' | 'gitlab' = 'github'): string | null {
  const m = COMMAND.exec(text.trim())
  if (!m) return null
  const notes = m[1]?.trim()
  if (provider === 'gitlab') return gitlabPrompt(notes)
  return [
    'Cut a new release of this repository and publish it on GitHub. Do it end to end now. Stop to ask only where a step says so.',
    '',
    '1. **Conventions.** Read the project\'s own instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md or a releasing guide under docs/, whichever exist), the release workflows in .github/workflows (what a tag push builds and publishes), and the version scripts in the project\'s manifest (package.json, Cargo.toml, …). Follow them for how the version is set, the changelog, the release commit, the tag name and the checks to run. Look at the last few releases (`gh release list --limit 3`, then `gh release view <tag> --json tagName,name,body`) and the existing tags (`git tag --sort=-creatordate | head`) and match their style. If the project releases several things with their own tags (an app and a mobile app, say), release the main one unless my notes name another.',
    '2. **State.** Find the default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), the current branch, uncommitted changes, the latest release tag and the commits since it.',
    '   - If `gh` is missing or not signed in, stop and tell me to install it or run `gh auth login` in the terminal. Do not try to sign in yourself.',
    '   - Releases are cut from the default branch. If you are on another branch or have uncommitted changes, stop and tell me (`/create-pr` gets work onto it). Do not commit or stash my work.',
    '   - Run `git fetch` and make sure the branch is level with its remote. If it is behind, pull with fast-forward only; if it has diverged, stop and tell me.',
    '   - If there are no commits since the latest release, say so and stop.',
    '   - Check the latest CI run on this commit (`gh run list --branch <default> --limit 5`). If it failed, stop and tell me which jobs failed.',
    '3. **Version.** Use the version or bump my notes ask for. Otherwise choose it from the commits since the last release by semantic versioning: breaking changes bump the major (the minor while the major is 0), new features the minor, anything else the patch. Say which version you chose and why. If the project does not version this way and it is unclear, ask once.',
    '4. **Prepare.** Set the version with the project\'s own tool (a bump or release script) rather than editing files by hand, and update the changelog if the project keeps one and its tool does not. Run the checks the project documents before a release. If one fails, stop and tell me: do not release.',
    '5. **Commit and tag** the release in the project\'s style (its release commit message, its tag format, annotated unless the project does otherwise). Never move, replace or delete an existing tag.',
    '6. **Push** the branch, then the tag (`git push origin <tag>`). Never force-push. If the push is refused (a protected branch, say), stop and tell me; do not work around it.',
    '7. **Publish.** If a workflow builds and publishes the release on the tag push, do not create it yourself: find the run it started (`gh run list --limit 3`) and check that it began. Otherwise create the release with `gh release create <tag>`: write the notes to a temporary file and pass it with `--notes-file`, then delete the file. Take the notes from the changelog\'s new section, or write them from the commits since the last release in the style of earlier releases, for the people who use the project. Mark it a pre-release when the version is one. Do not @-mention anyone.',
    '8. **Report** the version, the tag, the release\'s link (or the run building it, with its link), and one line per check: passed, failed or not run.',
    ...(notes
      ? ['', 'My notes for this release (follow them; they can name the version or bump, ask for a draft or a pre-release, or say what to stress in the notes):', '', notes]
      : []),
  ].join('\n')
}

/** The same steps for a project on GitLab (gitlab.com or a self-managed server), through `glab`. */
function gitlabPrompt(notes: string | undefined): string {
  return [
    'Cut a new release of this repository and publish it on GitLab. Do it end to end now. Stop to ask only where a step says so.',
    '',
    '1. **Conventions.** Read the project\'s own instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md or a releasing guide under docs/, whichever exist), the pipeline in .gitlab-ci.yml (what a tag pipeline builds and publishes, a `release:` job for instance), and the version scripts in the project\'s manifest (package.json, Cargo.toml, …). Follow them for how the version is set, the changelog, the release commit, the tag name and the checks to run. Look at the last few releases (`glab release list --per-page 3`, then `glab release view <tag>`) and the existing tags (`git tag --sort=-creatordate | head`) and match their style. If the project releases several things with their own tags (an app and a mobile app, say), release the main one unless my notes name another.',
    '2. **State.** Find the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, or `glab repo view`), the current branch, uncommitted changes, the latest release tag and the commits since it.',
    '   - If `glab` is missing or not signed in to this server, stop and tell me to install it or sign in to GitLab in Mango (Settings > Git hosting), or run `glab auth login` in the terminal. Do not try to sign in yourself.',
    '   - Releases are cut from the default branch. If you are on another branch or have uncommitted changes, stop and tell me (`/create-pr` gets work onto it). Do not commit or stash my work.',
    '   - Run `git fetch` and make sure the branch is level with its remote. If it is behind, pull with fast-forward only; if it has diverged, stop and tell me.',
    '   - If there are no commits since the latest release, say so and stop.',
    '   - Check the latest pipeline on this commit (`glab ci list --ref <default> --per-page 5`). If it failed, stop and tell me which jobs failed.',
    '3. **Version.** Use the version or bump my notes ask for. Otherwise choose it from the commits since the last release by semantic versioning: breaking changes bump the major (the minor while the major is 0), new features the minor, anything else the patch. Say which version you chose and why. If the project does not version this way and it is unclear, ask once.',
    '4. **Prepare.** Set the version with the project\'s own tool (a bump or release script) rather than editing files by hand, and update the changelog if the project keeps one and its tool does not. Run the checks the project documents before a release. If one fails, stop and tell me: do not release.',
    '5. **Commit and tag** the release in the project\'s style (its release commit message, its tag format, annotated unless the project does otherwise). Never move, replace or delete an existing tag.',
    '6. **Push** the branch, then the tag (`git push origin <tag>`). Never force-push. If the push is refused (a protected branch, say), stop and tell me; do not work around it.',
    '7. **Publish.** If the tag pipeline builds and publishes the release, do not create it yourself: find the pipeline it started (`glab ci list --ref <tag> --per-page 3`) and check that it began. Otherwise create the release with `glab release create <tag> --notes-file <file>`: write the notes to a temporary file, then delete it. Take the notes from the changelog\'s new section, or write them from the commits since the last release in the style of earlier releases, for the people who use the project. Do not @-mention anyone.',
    '8. **Report** the version, the tag, the release\'s link (or the pipeline building it, with its link), and one line per check: passed, failed or not run.',
    ...(notes
      ? ['', 'My notes for this release (follow them; they can name the version or bump, or say what to stress in the notes):', '', notes]
      : []),
  ].join('\n')
}
