import { LockIcon } from '@primer/octicons-react'
import AvatarStack from './AvatarStack'
import StateIcon from './StateIcon'
import { DIRECT_REASONS, reasonLabel, stateKind, timeAgo } from '@/lib/display'
import type { Thread } from '@/lib/types'

interface Props {
  thread: Thread
  selected: boolean
  onToggle: (id: string, shiftKey: boolean) => void
}

export default function NotificationRow({ thread, selected, onToggle }: Props) {
  const actors = thread.subject?.recentActors ?? []
  return (
    <li className="row" data-unread={thread.unread} data-selected={selected}>
      {/* onClick, not onChange: React's checkbox onChange wraps the native `input`
          event, which carries no shiftKey. Click covers the keyboard path too,
          since space-activating a checkbox dispatches a click. */}
      <input
        type="checkbox"
        className="rowCheck"
        checked={selected}
        readOnly
        aria-label={`Select ${thread.title}`}
        onClick={e => onToggle(thread.id, e.shiftKey)}
      />

      <StateIcon kind={stateKind(thread)} />

      <span className="rowMain">
        <span className="rowRepo">
          {thread.private && <LockIcon size={12} />}
          {thread.repo}
          {thread.number != null && ` #${thread.number}`}
        </span>
        <a className="rowTitle" href={thread.htmlUrl} target="_blank" rel="noreferrer">
          {thread.title}
        </a>
      </span>

      <span className="rowReason" data-direct={DIRECT_REASONS.has(thread.reason)}>
        {reasonLabel(thread.reason)}
      </span>

      <AvatarStack actors={actors} />

      <time className="rowTime" dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString()}>
        {timeAgo(thread.updatedAt)}
      </time>
    </li>
  )
}
