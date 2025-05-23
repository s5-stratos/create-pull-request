import * as core from '@actions/core'
import {GitCommandManager, Commit} from './git-command-manager'

const NOTHING_TO_COMMIT = 'nothing to commit, working tree clean'

export enum WorkingBaseType {
  Branch = 'branch',
  Commit = 'commit'
}

export async function getWorkingBaseAndType(
  git: GitCommandManager
): Promise<[string, WorkingBaseType]> {
  const symbolicRefResult = await git.exec(
    ['symbolic-ref', 'HEAD', '--short'],
    true
  )
  if (symbolicRefResult.exitCode == 0) {
    // A ref is checked out
    return [symbolicRefResult.stdout.trim(), WorkingBaseType.Branch]
  } else {
    // A commit is checked out (detached HEAD)
    const headSha = await git.revParse('HEAD')
    return [headSha, WorkingBaseType.Commit]
  }
}

export async function tryFetch(
  git: GitCommandManager,
  remote: string,
  branch: string,
  depth: number
): Promise<boolean> {
  try {
    await git.fetch([`${branch}:refs/remotes/${remote}/${branch}`], remote, [
      '--force',
      `--depth=${depth}`
    ])
    return true
  } catch {
    return false
  }
}

export async function buildBranchCommits(
  git: GitCommandManager,
  base: string,
  branch: string
): Promise<Commit[]> {
  const output = await git.exec(['log', '--format=%H', `${base}..${branch}`])
  const shas = output.stdout
    .split('\n')
    .filter(x => x !== '')
    .reverse()
  const commits: Commit[] = []
  for (const sha of shas) {
    const commit = await git.getCommit(sha)
    commits.push(commit)
    for (const unparsedChange of commit.unparsedChanges) {
      core.warning(`Skipping unexpected diff entry: ${unparsedChange}`)
    }
  }
  return commits
}

// Return the number of commits that branch2 is ahead of branch1
async function commitsAhead(
  git: GitCommandManager,
  branch1: string,
  branch2: string
): Promise<number> {
  const result = await git.revList(
    [`${branch1}...${branch2}`],
    ['--right-only', '--count']
  )
  return Number(result)
}

// Return true if branch2 is ahead of branch1
async function isAhead(
  git: GitCommandManager,
  branch1: string,
  branch2: string
): Promise<boolean> {
  return (await commitsAhead(git, branch1, branch2)) > 0
}

// Return the number of commits that branch2 is behind branch1
async function commitsBehind(
  git: GitCommandManager,
  branch1: string,
  branch2: string
): Promise<number> {
  const result = await git.revList(
    [`${branch1}...${branch2}`],
    ['--left-only', '--count']
  )
  return Number(result)
}

// Return true if branch2 is behind branch1
async function isBehind(
  git: GitCommandManager,
  branch1: string,
  branch2: string
): Promise<boolean> {
  return (await commitsBehind(git, branch1, branch2)) > 0
}

interface CreateOrUpdateBranchResult {
  action: string
  base: string
  hasDiffWithBase: boolean
  wasResetOrRebased: boolean
  baseCommit: Commit
  headSha: string
  branchCommits: Commit[]
}

export async function createOrUpdateBranch(
  git: GitCommandManager,
  commitMessage: string,
  base: string,
  branch: string,
  branchRemoteName: string,
  signoff: boolean,
  addPaths: string[],
  isConfigSync: boolean
): Promise<CreateOrUpdateBranchResult> {
  // Get the working base.
  // When a ref, it may or may not be the actual base.
  // When a commit, we must rebase onto the actual base.
  const [workingBase, workingBaseType] = await getWorkingBaseAndType(git)
  core.info(`Working base is ${workingBaseType} '${workingBase}'`)
  if (workingBaseType == WorkingBaseType.Commit && !base) {
    throw new Error(`When in 'detached HEAD' state, 'base' must be supplied.`)
  }

  let action = 'none'
  let hasDiffWithBase = false
  const baseRemote = 'origin'

  if (workingBase != branch) {
    if (!(await tryFetch(git, branchRemoteName, branch, 0))) {
      // The pull request branch does not exist
      core.info(`Pull request branch '${branch}' does not exist yet.`)
      // Create the pull request branch
      await git.checkout(branch, base)
      action = 'created'
      core.info(`Created branch '${branch}'`)
      // Check if the pull request branch is ahead of the base
    } else {
      // The pull request branch exists
      core.info(
        `Pull request branch '${branch}' already exists as remote branch '${branchRemoteName}/${branch}'`
      )
      // Checkout the pull request branch
      await git.checkout(branch)
    }
  }

  // Check if the pull request branch is behind the base branch
  let wasResetOrRebased = false
  await git.exec(['fetch', baseRemote, base])
  /*
   * For configuration repos we can safely soft reset to base without losing history
   *
   * If this is indeed for a configuration repo, the current branch must match the base
   * branch before committing the current changes so that the commit patch is correct
   */
  if (isConfigSync && (await isBehind(git, base, branch))) {
    /*
     * New changes to the base branch are not present in the PR branch.
     *
     * Reset the state of the PR branch back to that of the base branch,
     * eliminating the commits currently in the PR branch.
     *
     * Normally dropping commits is undesirable, but in this specific case, it's
     * necessary to circumvent any attempt git would make to merge/rebase the
     * previous PR branch commits onto the newer base branch commits.
     *
     * Without doing so, this job would almost certainly fail due to conflicts.
     *
     * Ultimately, either the dropped commits were a subset of the changes in the
     * working tree, or their respective changes have since been undone.
     */
    core.info(
      `Pull request branch '${branch}' is behind base branch '${base}'.`
    )
    await git.exec(['reset', '--soft', `${baseRemote}/${base}`])
    core.info(`Reset '${branch}' to '${base}'.`)
    wasResetOrRebased = true
  }

  // Commit any changes
  if (await git.isDirty(true, addPaths)) {
    core.info('Uncommitted changes found. Adding a commit.')
    const aopts = ['add']
    if (addPaths.length > 0) {
      aopts.push(...['--', ...addPaths])
    } else {
      aopts.push('-A')
    }
    await git.exec(aopts, true)
    const popts = ['-m', commitMessage]
    if (signoff) {
      popts.push('--signoff')
    }
    const commitResult = await git.commit(popts, true)
    // 'nothing to commit' can occur when core.autocrlf is set to true
    if (
      commitResult.exitCode != 0 &&
      !commitResult.stdout.includes(NOTHING_TO_COMMIT)
    ) {
      throw new Error(`Unexpected error: ${commitResult.stderr}`)
    }
  }

  /*
   * For non-configuration repos, it is imperative that we preserve all history.
   *
   * To ensure that all changes from both branches are retained after the merge,
   * when this branch is behind the base, rebase all new commits onto base.
   *
   * This must be done after committing any new changes.
   */
  if (!isConfigSync && (await isBehind(git, base, branch))) {
    // Rebase the current branch onto the base branch
    core.info(
      `Pull request branch '${branch}' is behind base branch '${base}'.`
    )
    await git.exec(['pull', '--rebase', baseRemote, base])
    core.info(`Rebased '${branch}' commits ontop of '${base}'.`)
    wasResetOrRebased = true
  }

  hasDiffWithBase = await isAhead(git, base, branch)

  // If the base is not specified it is assumed to be the working base.
  base = base ? base : workingBase

  // Get the base and head SHAs
  const baseSha = await git.revParse(base)
  const baseCommit = await git.getCommit(baseSha)
  const headSha = await git.revParse(branch)

  let branchCommits: Commit[] = []
  if (hasDiffWithBase) {
    action = 'updated'
    // Build the branch commits
    branchCommits = await buildBranchCommits(git, base, branch)
  }

  return {
    action: action,
    base: base,
    hasDiffWithBase: hasDiffWithBase,
    wasResetOrRebased: wasResetOrRebased,
    baseCommit: baseCommit,
    headSha: headSha,
    branchCommits: branchCommits
  }
}
