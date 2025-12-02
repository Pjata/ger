import { Effect } from 'effect'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { type ApiError, GerritApiService } from '@/api/gerrit'
import type { ChangeInfo } from '@/schemas/gerrit'
import { colors } from '@/utils/formatters'
import { getStatusIndicators } from '@/utils/status-indicators'

const execAsync = promisify(exec)

interface OpenChangesOptions {
  limit?: number
  json?: boolean
  xml?: boolean
}

interface ReviewerVote {
  name: string
  value: number
  pending: boolean
}

interface LabelVotes {
  'Code-Review': ReviewerVote[]
  Verified: ReviewerVote[]
}

/**
 * Detects the current project name from git remote origin URL
 */
const detectProject = (): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const { stdout } = await execAsync('git remote get-url origin')
      const url = stdout.trim()

      // Parse various URL formats:
      // ssh://gerrit.example.com/project-name
      // ssh://gerrit.example.com:29418/project-name
      // https://gerrit.example.com/a/project-name
      // git@gerrit.example.com:project-name
      // gerrit.example.com:project-name

      let project: string | undefined

      // SSH URL format: ssh://host/project or ssh://host:port/project
      if (url.startsWith('ssh://')) {
        const match = url.match(/ssh:\/\/[^/]+(?::\d+)?\/(.+?)(?:\.git)?$/)
        project = match?.[1]
      }
      // HTTPS URL format: https://host/a/project or https://host/project
      else if (url.startsWith('https://') || url.startsWith('http://')) {
        const match = url.match(/https?:\/\/[^/]+\/(?:a\/)?(.+?)(?:\.git)?$/)
        project = match?.[1]
      }
      // SCP-like format: user@host:project or host:project
      else if (url.includes(':')) {
        const match = url.match(/:(.+?)(?:\.git)?$/)
        project = match?.[1]
      }

      if (!project) {
        throw new Error(`Could not parse project name from remote URL: ${url}`)
      }

      return project
    },
    catch: (error) => {
      if (error instanceof Error) {
        if (error.message.includes('not a git repository')) {
          return new Error('Not in a git repository')
        }
        if (error.message.includes('No such remote')) {
          return new Error('No git remote "origin" configured')
        }
        return error
      }
      return new Error('Failed to detect project from git remote')
    },
  })

/**
 * Extracts reviewer votes from change labels.
 * Code-Review: includes all reviewers (voted + pending)
 * Verified: only includes reviewers who have voted (typically CI bots)
 */
const extractReviewerVotes = (change: ChangeInfo): LabelVotes => {
  const votes: LabelVotes = {
    'Code-Review': [],
    Verified: [],
  }

  const labels = change.labels
  if (!labels) return votes

  // Extract Code-Review votes from 'all' array (includes pending reviewers)
  const cr = labels['Code-Review']
  if (cr?.all) {
    for (const reviewer of cr.all) {
      const value = reviewer.value ?? 0
      votes['Code-Review'].push({
        name: reviewer.name || 'Unknown',
        value,
        pending: value === 0,
      })
    }
  } else if (cr) {
    // Fallback to individual fields if 'all' is not available
    if (cr.approved) {
      votes['Code-Review'].push({ name: cr.approved.name || 'Unknown', value: 2, pending: false })
    }
    if (cr.recommended) {
      votes['Code-Review'].push({
        name: cr.recommended.name || 'Unknown',
        value: 1,
        pending: false,
      })
    }
    if (cr.disliked) {
      votes['Code-Review'].push({ name: cr.disliked.name || 'Unknown', value: -1, pending: false })
    }
    if (cr.rejected) {
      votes['Code-Review'].push({ name: cr.rejected.name || 'Unknown', value: -2, pending: false })
    }
  }

  // Extract Verified votes from 'all' array
  // Only show reviewers who have actually voted (not pending) since Verified is typically for CI bots
  const v = labels['Verified']
  if (v?.all) {
    for (const reviewer of v.all) {
      const value = reviewer.value ?? 0
      // Skip pending reviewers for Verified - they're unlikely to vote here
      if (value === 0) continue
      votes['Verified'].push({
        name: reviewer.name || 'Unknown',
        value,
        pending: false,
      })
    }
  } else if (v) {
    // Fallback to individual fields if 'all' is not available
    if (v.approved) {
      votes['Verified'].push({ name: v.approved.name || 'Unknown', value: 1, pending: false })
    }
    if (v.rejected) {
      votes['Verified'].push({ name: v.rejected.name || 'Unknown', value: -1, pending: false })
    }
  }

  return votes
}

/**
 * Formats reviewer votes for display
 * e.g., "CR: +2 Alice, +1 Bob, ⏳ Carol  V: +1 Jenkins"
 */
const formatReviewerVotes = (votes: LabelVotes): string => {
  const parts: string[] = []

  // Format Code-Review votes
  if (votes['Code-Review'].length > 0) {
    const crVotes = votes['Code-Review']
      .sort((a, b) => {
        // Sort: positive votes first, then pending (0), then negative
        if (a.pending && !b.pending) return 1
        if (!a.pending && b.pending) return -1
        return b.value - a.value
      })
      .map((v) => {
        if (v.pending) {
          return `${colors.gray}⏳ ${v.name}${colors.reset}`
        }
        const sign = v.value > 0 ? '+' : ''
        const color = v.value > 0 ? colors.green : colors.red
        return `${color}${sign}${v.value}${colors.reset} ${v.name}`
      })
      .join(', ')
    parts.push(`CR: ${crVotes}`)
  } else {
    parts.push(`CR: ${colors.gray}no reviewers${colors.reset}`)
  }

  // Format Verified votes (only shows actual votes, typically from CI bots)
  if (votes['Verified'].length > 0) {
    const vVotes = votes['Verified']
      .sort((a, b) => b.value - a.value)
      .map((v) => {
        const sign = v.value > 0 ? '+' : ''
        const color = v.value > 0 ? colors.green : colors.red
        return `${color}${sign}${v.value}${colors.reset} ${v.name}`
      })
      .join(', ')
    parts.push(`V: ${vVotes}`)
  } else {
    parts.push(`V: ${colors.gray}--${colors.reset}`)
  }

  return parts.join('  ')
}

/**
 * Renders pretty output for the terminal
 */
const renderPretty = (changes: readonly ChangeInfo[], project: string): void => {
  if (changes.length === 0) {
    console.log(`${colors.green}✓ No open changes for ${project}${colors.reset}`)
    return
  }

  console.log(`${colors.blue}Open Changes for ${project} (${changes.length})${colors.reset}\n`)

  for (const change of changes) {
    const indicators = getStatusIndicators(change)
    const statusStr = indicators.length > 0 ? indicators.join(' ').padEnd(6) : '      '

    // Line 1: Status indicators + change number + subject
    console.log(`${statusStr}${colors.yellow}${change._number}${colors.reset}  ${change.subject}`)

    // Line 2: Reviewer votes
    const votes = extractReviewerVotes(change)
    const votesStr = formatReviewerVotes(votes)
    console.log(`      ${votesStr}`)

    // Line 3: Owner + status
    console.log(
      `      ${colors.gray}by ${change.owner?.name || 'Unknown'} • ${change.status}${colors.reset}`,
    )

    console.log() // Empty line between changes
  }
}

/**
 * Renders JSON output
 */
const renderJson = (changes: readonly ChangeInfo[], project: string): void => {
  const output = {
    project,
    count: changes.length,
    changes: changes.map((change) => {
      const votes = extractReviewerVotes(change)
      return {
        number: change._number,
        subject: change.subject,
        status: change.status,
        owner: change.owner?.name || 'Unknown',
        updated: change.updated,
        reviewers: {
          'Code-Review': votes['Code-Review'],
          Verified: votes['Verified'],
        },
      }
    }),
  }
  console.log(JSON.stringify(output, null, 2))
}

/**
 * Renders XML output
 */
const renderXml = (changes: readonly ChangeInfo[], project: string): void => {
  console.log('<?xml version="1.0" encoding="UTF-8"?>')
  console.log(`<open_changes project="${project}" count="${changes.length}">`)

  for (const change of changes) {
    const votes = extractReviewerVotes(change)
    console.log('  <change>')
    console.log(`    <number>${change._number}</number>`)
    console.log(`    <subject><![CDATA[${change.subject}]]></subject>`)
    console.log(`    <status>${change.status}</status>`)
    console.log(`    <owner>${change.owner?.name || 'Unknown'}</owner>`)
    if (change.updated) {
      console.log(`    <updated>${change.updated}</updated>`)
    }
    console.log('    <reviewers>')
    console.log('      <label name="Code-Review">')
    for (const vote of votes['Code-Review']) {
      const sign = vote.value > 0 ? '+' : ''
      const pending = vote.pending ? ' pending="true"' : ''
      console.log(`        <vote name="${vote.name}" value="${sign}${vote.value}"${pending}/>`)
    }
    console.log('      </label>')
    console.log('      <label name="Verified">')
    for (const vote of votes['Verified']) {
      const sign = vote.value > 0 ? '+' : ''
      console.log(`        <vote name="${vote.name}" value="${sign}${vote.value}"/>`)
    }
    console.log('      </label>')
    console.log('    </reviewers>')
    console.log('  </change>')
  }

  console.log('</open_changes>')
}

export const openChangesCommand = (
  options: OpenChangesOptions,
): Effect.Effect<void, ApiError | Error, GerritApiService> =>
  Effect.gen(function* () {
    const gerritApi = yield* GerritApiService
    const limit = options.limit ?? 20

    // Detect project from git remote
    const project = yield* detectProject()

    // Query for open changes in this project
    const query = `project:${project} status:open limit:${limit}`
    const changes = yield* gerritApi.listChanges(query)

    // Sort by updated date (most recent first)
    const sortedChanges = [...changes].sort((a, b) => {
      const dateA = a.updated ? new Date(a.updated).getTime() : 0
      const dateB = b.updated ? new Date(b.updated).getTime() : 0
      return dateB - dateA
    })

    // Render based on format
    if (options.json) {
      renderJson(sortedChanges, project)
    } else if (options.xml) {
      renderXml(sortedChanges, project)
    } else {
      renderPretty(sortedChanges, project)
    }
  })
