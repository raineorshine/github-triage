import type { Thread } from './types'

const UNITS: [limit: number, seconds: number, name: string][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [2592000, 86400, 'day'],
  [31536000, 2592000, 'month'],
  [Infinity, 31536000, 'year'],
]

/** "7 minutes ago", matching GitHub's relative-time wording. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 45) return 'now'
  for (const [limit, size, name] of UNITS) {
    if (seconds < limit) {
      const value = Math.round(seconds / size)
      return `${value} ${name}${value === 1 ? '' : 's'} ago`
    }
  }
  return 'a while ago'
}

export type StateKind =
  | 'issue-open'
  | 'issue-closed'
  | 'issue-not-planned'
  | 'pr-open'
  | 'pr-draft'
  | 'pr-merged'
  | 'pr-closed'
  | 'discussion'
  | 'release'
  | 'commit'
  | 'check'
  | 'security'
  | 'other'

/** Which octicon and colour a row gets, mirroring GitHub's own state icons. */
export function stateKind(thread: Thread): StateKind {
  const s = thread.subject
  if (s?.typename === 'PullRequest') {
    if (s.merged) return 'pr-merged'
    if (s.state === 'CLOSED') return 'pr-closed'
    if (s.isDraft) return 'pr-draft'
    return 'pr-open'
  }
  if (s?.typename === 'Issue') {
    if (s.state === 'CLOSED') {
      return s.stateReason === 'NOT_PLANNED' ? 'issue-not-planned' : 'issue-closed'
    }
    return 'issue-open'
  }
  switch (thread.type) {
    case 'Discussion':
      return 'discussion'
    case 'Release':
      return 'release'
    case 'Commit':
      return 'commit'
    case 'CheckSuite':
      return 'check'
    case 'RepositoryVulnerabilityAlert':
    case 'SecurityAdvisory':
      return 'security'
    case 'PullRequest':
      return 'pr-open'
    case 'Issue':
      return 'issue-open'
    default:
      return 'other'
  }
}
