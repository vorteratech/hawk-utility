import {
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, type SystemStatus } from '../lib/api'
import { Card, CopyableCode, Err, StatusDot } from '../components/ui'

function ReadyBadge({ ready }: { ready: boolean }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded font-medium ${
        ready
          ? 'bg-[color-mix(in_srgb,var(--color-ok)_20%,transparent)] text-[var(--color-ok)]'
          : 'bg-[color-mix(in_srgb,var(--color-danger)_20%,transparent)] text-[var(--color-danger)]'
      }`}
    >
      {ready ? 'READY' : 'NOT READY'}
    </span>
  )
}

export function SystemStatusCard() {
  const qc = useQueryClient()
  const { data, isLoading, isFetching, error } = useQuery<SystemStatus>({
    queryKey: ['system-status'],
    queryFn: api.systemStatus,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['system-status'] })

  if (isLoading) return <Card title="Pre-flight Checks">Running checks…</Card>
  if (error)
    return (
      <Card title="Pre-flight Checks">
        <Err msg={String(error)} />
      </Card>
    )

  const ready = data!.ready
  const failedCount = data!.checks.filter((c) => c.status === 'fail').length

  return (
    <Card
      title="Pre-flight Checks"
      subtitle={
        ready
          ? 'All required dependencies present.'
          : `${failedCount} check${failedCount === 1 ? '' : 's'} failing — engagement creation blocked.`
      }
      right={
        <div className="flex items-center gap-2">
          <ReadyBadge ready={ready} />
          <button
            type="button"
            onClick={refresh}
            disabled={isFetching}
            className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
          >
            {isFetching ? 'Re-running…' : 'Re-run'}
          </button>
        </div>
      }
    >
      <ul className="space-y-3">
        {data!.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-3">
            <StatusDot status={c.status} className="mt-1.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{c.label}</span>
                {c.detail && (
                  <span className="text-xs text-[var(--color-muted)] font-mono truncate">
                    {c.detail}
                  </span>
                )}
              </div>
              {c.status !== 'ok' && c.fix && <CopyableCode command={c.fix} />}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
