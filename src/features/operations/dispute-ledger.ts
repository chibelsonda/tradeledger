import type { DisputeStatus } from '@/lib/database.types'

export interface DisputeFilterableEntry {
  status: DisputeStatus
  searchText: string
}

export const disputeStatusLabels: Record<DisputeStatus, string> = {
  warning_needs_response: 'Warning needs response',
  warning_under_review: 'Warning under review',
  warning_closed: 'Warning closed',
  needs_response: 'Response required',
  under_review: 'Under review',
  won: 'Won',
  lost: 'Lost',
  prevented: 'Prevented',
  appealable: 'Appealable',
  appeal_under_review: 'Appeal under review',
  appeal_won: 'Appeal won',
  appeal_lost: 'Appeal lost',
}

export function disputeStatusLabel(status: string): string {
  return disputeStatusLabels[status as DisputeStatus] ?? 'Unknown'
}

export function disputeNeedsResponse(status: string): boolean {
  return status === 'needs_response' || status === 'warning_needs_response'
}

export function disputeIsLost(status: string): boolean {
  return status === 'lost' || status === 'appeal_lost'
}

export function disputeDeadlineState(
  dueAt: string | null,
  now = new Date(),
): 'none' | 'overdue' | 'urgent' | 'upcoming' {
  if (!dueAt) return 'none'
  const milliseconds = new Date(dueAt).getTime() - now.getTime()
  if (milliseconds < 0) return 'overdue'
  if (milliseconds <= 72 * 60 * 60 * 1000) return 'urgent'
  return 'upcoming'
}

export function filterDisputes<T extends DisputeFilterableEntry>(
  disputes: readonly T[],
  search: string,
  status: string,
): T[] {
  const query = search.trim().toLocaleLowerCase()
  return disputes.filter(
    (dispute) =>
      (!query || dispute.searchText.toLocaleLowerCase().includes(query)) &&
      (!status || dispute.status === status),
  )
}
