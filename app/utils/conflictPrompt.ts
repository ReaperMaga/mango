import type { GitOperation, VcsKind } from '~/types/ipc'

/**
 * The message "Solve conflicts with agent" sends to a chat: written as a person would ask, with what
 * the agent needs (what is being merged, the files, what each side did) and the rules that keep the
 * merge in the user's hands. Plain Node: no Vue, no stores.
 */

export interface ConflictPromptInput {
  vcs: VcsKind
  operation: GitOperation | null
  /** Conflicted files, relative to the repository root. */
  files: string[]
  /** Only these (one file asked from the merge editor or its row); empty or absent: all of `files`. */
  only?: string[]
  /** Commit subjects on each side since they met, newest first (empty when not known). */
  ours?: string[]
  theirs?: string[]
}

/** At most this many subjects of each side, and files, are listed. */
export const PROMPT_SUBJECTS = 15
export const PROMPT_FILES = 40

const vcsName = (vcs: VcsKind) => (vcs === 'lore' ? 'Lore' : vcs === 'plastic' ? 'Unity Version Control' : 'git')

/** A sentence saying what is going on, e.g. "I'm merging feature/x into main". */
export function describeOperation(op: GitOperation | null, vcs: VcsKind): string {
  const into = op?.branch ? `\`${op.branch}\`` : 'the current branch'
  const from = op?.incoming ? `\`${op.incoming}\`` : null
  switch (op?.kind) {
    case 'rebase': {
      const step = op.step && op.steps ? ` (commit ${op.step} of ${op.steps}${op.subject ? `: "${op.subject}"` : ''})` : op.subject ? ` (applying "${op.subject}")` : ''
      return `I'm rebasing ${op.branch ? `\`${op.branch}\`` : 'a detached HEAD'} onto ${from ?? 'its new base'} with ${vcsName(vcs)} and it stopped on conflicts${step}`
    }
    case 'cherry-pick':
      return `I'm cherry-picking ${op.commit ? `commit \`${op.commit}\`` : 'a commit'}${op.subject ? ` ("${op.subject}")` : ''} onto ${into} and it stopped on conflicts`
    case 'revert':
      return `I'm reverting ${op.commit ? `commit \`${op.commit}\`` : 'a commit'}${op.subject ? ` (${op.subject})` : ''} on ${into} and it stopped on conflicts`
    case 'merge':
      return `I'm merging ${from ?? 'another branch'} into ${into} with ${vcsName(vcs)} and it stopped on conflicts`
    default:
      return `My ${vcsName(vcs)} merge stopped on conflicts`
  }
}

/** What "ours" and "theirs" mean in this operation, in the words of the markers. */
function sidesNote(op: GitOperation | null): string {
  if (op?.kind === 'rebase') {
    return `In the conflict markers, the first side (between \`<<<<<<<\` and \`=======\`) is ${op.incoming ? `\`${op.incoming}\`` : 'the new base'}, the branch I'm rebasing onto, and the second side (between \`=======\` and \`>>>>>>>\`) is my commit being applied.`
  }
  if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    return `In the conflict markers, the first side is what ${op.branch ? `\`${op.branch}\`` : 'the current branch'} has now and the second side is the ${op.kind === 'revert' ? 'revert' : 'picked commit'}.`
  }
  return `In the conflict markers, the first side (between \`<<<<<<<\` and \`=======\`) is ${op?.branch ? `\`${op.branch}\`` : 'the current branch'} and the second side (between \`=======\` and \`>>>>>>>\`) is ${op?.incoming ? `\`${op.incoming}\`` : 'what is merged in'}. A \`|||||||\` section, where there is one, is the common ancestor.`
}

function list(items: string[], cap: number, fmt: (s: string) => string): string {
  const shown = items.slice(0, cap).map(s => `- ${fmt(s)}`)
  if (items.length > cap) shown.push(`- …and ${items.length - cap} more`)
  return shown.join('\n')
}

/** Never let a subject close the quotes or the list it sits in. */
const subject = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160)

export function buildConflictPrompt(input: ConflictPromptInput): string {
  const { vcs, operation: op } = input
  const files = input.only?.length ? input.only : input.files
  const one = files.length === 1
  const what = one ? `the conflict in \`${files[0]}\`` : `the conflicts in these ${files.length} files`
  const parts: string[] = [`${describeOperation(op, vcs)}. Please resolve ${what}.`]
  if (!one) parts.push(list(files, PROMPT_FILES, f => `\`${f}\``))
  else if (input.files.length > 1) parts.push(`Other files are in conflict too; leave them for now.`)

  const ours = (input.ours ?? []).map(subject).filter(Boolean)
  const theirs = (input.theirs ?? []).map(subject).filter(Boolean)
  const oursName = op?.kind === 'rebase' ? (op.incoming ? `\`${op.incoming}\`` : 'the new base') : op?.branch ? `\`${op.branch}\`` : 'this branch'
  const theirsName = op?.kind === 'rebase' ? (op.branch ? `\`${op.branch}\`` : 'my branch') : op?.incoming ? `\`${op.incoming}\`` : 'the other side'
  if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    if (theirs.length) parts.push(`The commit: "${theirs[0]}".`)
  } else {
    if (ours.length) parts.push(`What ${oursName} did since the two sides split (newest first):\n${list(ours, PROMPT_SUBJECTS, s => `"${s}"`)}`)
    if (theirs.length) parts.push(`What ${theirsName} did${op?.kind === 'rebase' ? ' (the commits being replayed)' : ''}:\n${list(theirs, PROMPT_SUBJECTS, s => `"${s}"`)}`)
  }
  parts.push(sidesNote(op))

  const rules = [
    'Resolve every conflict so the result keeps what both sides meant to do; when they really disagree, pick the one that fits the rest of the code and say so.',
    'Remove all conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) and keep the file\'s existing formatting and line endings.',
    'If the project has a build, type check or tests that run quickly, run them to check the result.',
    `Do not stage files, mark conflicts resolved, commit, ${op?.kind === 'rebase' || op?.kind === 'cherry-pick' || op?.kind === 'revert' ? `continue or abort the ${op.kind}` : 'abort or finish the merge'}, reset, check out files or switch branches${vcs === 'lore' ? ' (no `lore branch merge resolve`, `lore stage` or `lore commit`)' : ''}. I'll review the result and do that myself.`,
    ...(vcs === 'lore'
      ? ['Leave the `~base`, `~mine` and `~theirs` copies Lore keeps next to each conflicted file (e.g. `a.txt~mine`): they are the merge\'s sides, and Lore removes them itself when the merge is committed.']
      : []),
    `Finish with a short summary per file of what you chose and why.`,
  ]
  parts.push(rules.map(r => `- ${r}`).join('\n'))
  return parts.join('\n\n')
}
