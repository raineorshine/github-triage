import {
  AlertIcon,
  CommentDiscussionIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  MailIcon,
  SkipIcon,
  SyncIcon,
  TagIcon,
} from '@primer/octicons-react'
import type { StateKind } from '@/lib/display'

const ICONS: Record<StateKind, { Icon: typeof IssueOpenedIcon; tone: string; label: string }> = {
  'issue-open': { Icon: IssueOpenedIcon, tone: 'open', label: 'Open issue' },
  'issue-closed': { Icon: IssueClosedIcon, tone: 'done', label: 'Closed issue' },
  'issue-not-planned': { Icon: SkipIcon, tone: 'muted', label: 'Closed as not planned' },
  'pr-open': { Icon: GitPullRequestIcon, tone: 'open', label: 'Open pull request' },
  'pr-draft': { Icon: GitPullRequestDraftIcon, tone: 'muted', label: 'Draft pull request' },
  'pr-merged': { Icon: GitMergeIcon, tone: 'done', label: 'Merged pull request' },
  'pr-closed': { Icon: GitPullRequestClosedIcon, tone: 'closed', label: 'Closed pull request' },
  discussion: { Icon: CommentDiscussionIcon, tone: 'muted', label: 'Discussion' },
  release: { Icon: TagIcon, tone: 'accent', label: 'Release' },
  commit: { Icon: GitCommitIcon, tone: 'muted', label: 'Commit' },
  check: { Icon: SyncIcon, tone: 'muted', label: 'Workflow run' },
  security: { Icon: AlertIcon, tone: 'closed', label: 'Security alert' },
  other: { Icon: MailIcon, tone: 'muted', label: 'Notification' },
}

export default function StateIcon({ kind }: { kind: StateKind }) {
  const { Icon, tone, label } = ICONS[kind]
  return (
    <span className="stateIcon" data-tone={tone} title={label} aria-label={label} role="img">
      <Icon size={16} />
    </span>
  )
}
