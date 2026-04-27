import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type ConsoleLine, type Run } from '../lib/api'
import { useConsoleStream, useStateStream } from '../lib/ws'
import { Button, Card, Err, StatusBadge } from '../components/ui'

export function EngagementPage() {
  const params = useParams<{ id: string }>()
  const id = params.id ? Number(params.id) : NaN
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['engagement', id],
    queryFn: () => api.getEngagement(id),
    enabled: Number.isFinite(id),
    refetchInterval: 3000,
  })

  const end = useMutation({
    mutationFn: () => api.endEngagement(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engagement', id] })
      qc.invalidateQueries({ queryKey: ['engagements'] })
      qc.invalidateQueries({ queryKey: ['active-engagement'] })
    },
  })

  const eng = data?.engagement
  const isActive = eng?.status === 'active' || eng?.status === 'starting'

  if (!Number.isFinite(id))
    return <Centered>Invalid engagement id</Centered>
  if (isLoading) return <Centered>Loading…</Centered>
  if (error) return <Centered><Err msg={String(error)} /></Centered>
  if (!eng) return <Centered>Engagement not found</Centered>

  return (
    <div className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link
            to="/"
            className="text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ← Engagements
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1 flex items-center gap-3">
            {eng.client_name}
            <StatusBadge status={eng.status} />
          </h1>
          <p className="text-xs text-[var(--color-muted)] mt-1 font-mono">
            #{eng.id} · {eng.start_date} → {eng.end_date} · {eng.output_folder}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() => end.mutate()}
            disabled={!isActive || end.isPending}
          >
            {end.isPending ? 'Ending…' : 'End Engagement'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ConsolePane engagementId={id} isActive={isActive} />
        </div>
        <div className="space-y-4">
          <CmdletPickerCard engagementId={id} disabled={!isActive} />
          <RunsCard runs={data?.runs ?? []} />
        </div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center">{children}</div>
  )
}

function ConsolePane({ engagementId, isActive }: { engagementId: number; isActive: boolean }) {
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [stdinValue, setStdinValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const seenSeqs = useRef<Set<number>>(new Set())

  const { status: consoleStatus } = useConsoleStream(engagementId, (evt) => {
    if (evt.type !== 'line') return
    const seq = evt.line.seq
    if (seenSeqs.current.has(seq)) return
    seenSeqs.current.add(seq)
    setLines((prev) => {
      const next = [...prev, evt.line].slice(-2000)
      return next
    })
  })

  const qc = useQueryClient()
  useStateStream(engagementId, (evt) => {
    if (evt.type === 'run_started' || evt.type === 'run_finished') {
      qc.invalidateQueries({ queryKey: ['engagement', engagementId] })
    }
  })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines.length])

  const sendStdin = useMutation({
    mutationFn: (text: string) => api.sendStdin(engagementId, text),
    onSuccess: () => setStdinValue(''),
  })

  return (
    <Card
      title="Console"
      subtitle={`/ws/engagements/${engagementId}/console · ${consoleStatus}`}
      right={
        <span className="text-xs text-[var(--color-muted)]">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      }
    >
      <div
        ref={scrollRef}
        className="h-[500px] overflow-y-auto bg-black/30 border border-[var(--color-border)] rounded p-3 text-xs font-mono whitespace-pre-wrap"
      >
        {lines.length === 0 && (
          <p className="text-[var(--color-muted)]">(awaiting output)</p>
        )}
        {lines.map((l) => (
          <div
            key={l.seq}
            className={
              l.stream === 'stderr'
                ? 'text-[var(--color-danger)]'
                : l.stream === 'meta'
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-text)]'
            }
          >
            {l.text || ' '}
          </div>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!stdinValue || !isActive) return
          sendStdin.mutate(stdinValue)
        }}
      >
        <input
          value={stdinValue}
          onChange={(e) => setStdinValue(e.target.value)}
          placeholder={isActive ? 'Type to send to subprocess stdin…' : 'Engagement ended'}
          disabled={!isActive}
          className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        <Button
          type="submit"
          variant="default"
          disabled={!stdinValue || !isActive || sendStdin.isPending}
        >
          Send
        </Button>
      </form>
    </Card>
  )
}

function CmdletPickerCard({ engagementId, disabled }: { engagementId: number; disabled: boolean }) {
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: (body: { cmdlet: string; params: Record<string, unknown> }) =>
      api.createRun(engagementId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement', engagementId] }),
  })

  return (
    <Card title="Run Cmdlet" subtitle="HAWK pickers land in M5/M6">
      <div className="space-y-2">
        <Button
          onClick={() => run.mutate({ cmdlet: 'Get-Date', params: {} })}
          disabled={disabled || run.isPending}
          className="w-full"
        >
          Get-Date (smoke test)
        </Button>
        <Button
          onClick={() =>
            run.mutate({
              cmdlet: '$PSVersionTable.PSVersion.ToString',
              params: {},
            })
          }
          disabled={disabled || run.isPending}
          className="w-full"
        >
          $PSVersionTable
        </Button>
        {run.error && <Err msg={String(run.error)} />}
      </div>
    </Card>
  )
}

function RunsCard({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <Card title="Runs">
        <p className="text-sm text-[var(--color-muted)]">No runs yet.</p>
      </Card>
    )
  }
  return (
    <Card title="Runs">
      <ul className="divide-y divide-[var(--color-border)]">
        {runs.map((r) => (
          <li key={r.id} className="py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono truncate">{r.cmdlet}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="text-[10px] text-[var(--color-muted)] mt-0.5">
                #{r.id} · {new Date(r.started_at).toLocaleTimeString()}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
