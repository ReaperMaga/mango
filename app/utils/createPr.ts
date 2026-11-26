/**
 * Mango's own `/create-pr [notes]`: the chat shows the command as typed, and the agent gets the
 * instructions below instead. It works the same for every agent and every project, so it names no
 * project's rules: the agent reads the project's own (AGENTS.md, CONTRIBUTING.md, earlier PRs).
 *
 * The agent opens the pull request with `gh pr create` (on GitLab the merge request with
 * `glab mr create`), which is what `utils/githubLinks.ts` trusts, so the new one is linked to the
 * chat and shows in the Pull requests tool window.
 */

const COMMAND = /^\/create-pr(?:\s+([\s\S]*))?$/

/**
 * The instructions for a `/create-pr` message; null when `text` is not one. `provider` is where the
 * project's repository lives (`gh_repo_link`): GitLab gets a merge request through `glab`.
 */
export function createPrPrompt(text: string, provider: 'github' | 'gitlab' = 'github'): string | null {
  const m = COMMAND.exec(text.trim())
  if (!m) return null
  const notes = m[1]?.trim()
  if (provider === 'gitlab') return gitlabPrompt(notes)
  return [
    'Open a GitHub pull request for the work in this repository. Do it end to end now. Stop to ask only where a step says so.',
    '',
    '1. **Conventions.** Read the project\'s own instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .github/pull_request_template.md, whichever exist) and follow them for branch names, commit messages, PR titles and the checks to run. Look at the last few merged pull requests (`gh pr list --state merged --limit 3 --json title,body`) and match their title and description style.',
    '2. **State.** Find the current branch, the default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), uncommitted changes and the commits ahead of the default branch.',
    '   - If `gh` is missing or not signed in, stop and tell me to install it or run `gh auth login` in the terminal. Do not try to sign in yourself.',
    '   - If this branch already has an open pull request (`gh pr view`), do not open another: push any new commits and give me its link.',
    '   - If there is nothing to propose (no commits ahead and a clean tree), say so and stop.',
    '3. **Branch.** If you are on the default branch, create a new branch named for the change, in the project\'s naming style.',
    '4. **Commit.** Commit the uncommitted work that belongs to this change, as logical commits in the project\'s message style. Leave out unrelated edits, scratch files, secrets and `.env` files, and tell me what you left out. If it is unclear what belongs, ask once.',
    '5. **Verify.** Run the checks the project documents (tests, typecheck, lint, build) that apply to what changed. Fix failures this change caused and commit the fix. Do not hide other failures: note them for the description.',
    '6. **Push** with `git push -u origin HEAD`. Never force-push.',
    '7. **Open** the pull request with `gh pr create` against the default branch. Write the description to a temporary file and pass it with `--body-file`, then delete the file. Use the project\'s template if it has one; otherwise: a short summary of what changed and why, the notable changes as a list, and an honest testing section that says what was run and what was not. Describe behaviour, not every line. Do not @-mention anyone.',
    '8. **Report** the pull request\'s link, its title, and one line per check: passed, failed or not run.',
    ...(notes
      ? ['', 'My notes for this pull request (follow them; they can ask for a draft, another base branch or what to stress in the description):', '', notes]
      : []),
  ].join('\n')
}

/** The same steps for a project on GitLab (gitlab.com or a self-managed server), through `glab`. */
function gitlabPrompt(notes: string | undefined): string {
  return [
    'Open a GitLab merge request for the work in this repository. Do it end to end now. Stop to ask only where a step says so.',
    '',
    '1. **Conventions.** Read the project\'s own instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, the templates in .gitlab/merge_request_templates/, whichever exist) and follow them for branch names, commit messages, merge request titles and the checks to run. Look at the last few merged merge requests (`glab mr list --merged --per-page 3`, then `glab mr view <number>`) and match their title and description style.',
    '2. **State.** Find the current branch, the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, or `glab repo view`), uncommitted changes and the commits ahead of the default branch.',
    '   - If `glab` is missing or not signed in to this server, stop and tell me to install it or sign in to GitLab in Mango (Settings > Git hosting), or run `glab auth login` in the terminal. Do not try to sign in yourself.',
    '   - If this branch already has an open merge request (`glab mr view`), do not open another: push any new commits and give me its link.',
    '   - If there is nothing to propose (no commits ahead and a clean tree), say so and stop.',
    '3. **Branch.** If you are on the default branch, create a new branch named for the change, in the project\'s naming style.',
    '4. **Commit.** Commit the uncommitted work that belongs to this change, as logical commits in the project\'s message style. Leave out unrelated edits, scratch files, secrets and `.env` files, and tell me what you left out. If it is unclear what belongs, ask once.',
    '5. **Verify.** Run the checks the project documents (tests, typecheck, lint, build) that apply to what changed. Fix failures this change caused and commit the fix. Do not hide other failures: note them for the description.',
    '6. **Push** with `git push -u origin HEAD`. Never force-push.',
    '7. **Open** the merge request with `glab mr create --target-branch <default> --title <title> --description <text> --yes` (non-interactive). Write the description to a temporary file first and pass its contents, then delete the file. Use the project\'s template if it has one; otherwise: a short summary of what changed and why, the notable changes as a list, and an honest testing section that says what was run and what was not. Describe behaviour, not every line. Do not @-mention anyone.',
    '8. **Report** the merge request\'s link, its title, and one line per pipeline job: passed, failed or not run.',
    ...(notes
      ? ['', 'My notes for this merge request (follow them; they can ask for a draft, another target branch or what to stress in the description):', '', notes]
      : []),
  ].join('\n')
}
