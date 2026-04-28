import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type ConsoleLine, type Run, type StateEvent } from '../lib/api'
import { useConsoleStream, useStateStream } from '../lib/ws'
import { Button, Card, Err, Modal, StatusBadge } from '../components/ui'

type DeviceCode = { url: string; code: string; target: 'graph' | 'exo' | null }

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

  // Auth + device-code state. The current device code is held in local state;
  // when auth_complete fires (or the engagement query reports it), we clear.
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null)
  const [authStep, setAuthStep] = useState<string | null>(null)
  const [authComplete, setAuthComplete] = useState(false)
  const [exoDirty, setExoDirty] = useState(false)

  // Sync from server on initial load (in case the WS stream missed the
  // earlier events, e.g. after a tab refresh).
  useEffect(() => {
    if (data?.auth_complete) {
      setAuthComplete(true)
      setDeviceCode(null)
    }
  }, [data?.auth_complete])

  const onState = (evt: StateEvent) => {
    if (evt.type === 'device_code') {
      setDeviceCode({ url: evt.url, code: evt.code, target: evt.target })
    } else if (evt.type === 'auth_step') {
      setAuthStep(evt.step)
      if (evt.step === 'graph_done') setDeviceCode(null) // EXO code arrives next
    } else if (evt.type === 'auth_complete') {
      setAuthComplete(true)
      setDeviceCode(null)
      qc.invalidateQueries({ queryKey: ['engagement', id] })
    } else if (evt.type === 'exo_module_failure') {
      setExoDirty(true)
    } else if (evt.type === 'exo_module_recovered') {
      setExoDirty(false)
      qc.invalidateQueries({ queryKey: ['engagement', id] })
    } else if (evt.type === 'run_started' || evt.type === 'run_finished') {
      qc.invalidateQueries({ queryKey: ['engagement', id] })
    }
  }

  const eng = data?.engagement
  const isActive = eng?.status === 'active' || eng?.status === 'starting'
  const cmdletsEnabled = isActive && authComplete

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
            {isActive && !authComplete && (
              <span className="text-xs px-2 py-0.5 rounded font-medium bg-[color-mix(in_srgb,var(--color-warn)_20%,transparent)] text-[var(--color-warn)]">
                AUTHENTICATING
              </span>
            )}
          </h1>
          <p className="text-xs text-[var(--color-muted)] mt-1 font-mono">
            #{eng.id} · {eng.start_date} → {eng.end_date} · {eng.output_folder}
          </p>
          {isActive && !authComplete && (
            <p className="text-xs text-[var(--color-muted)] mt-1">
              {!authStep && 'Spawning subprocess…'}
              {authStep === 'importing_modules' &&
                'Loading HAWK and Graph modules — first device code coming in a few seconds…'}
              {authStep === 'graph_starting' && 'Connecting to Microsoft Graph — device code coming…'}
              {authStep === 'graph_done' && 'Microsoft Graph connected — second device code coming for Exchange Online…'}
              {authStep === 'exo_done' && 'Both modules connected.'}
            </p>
          )}
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

      {exoDirty && <ExoFailureBanner engagementId={id} onCleared={() => setExoDirty(false)} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ConsolePane engagementId={id} isActive={isActive} onState={onState} />
        </div>
        <div className="space-y-4">
          <CmdletPickerCard
            engagementId={id}
            startDate={eng.start_date}
            endDate={eng.end_date}
            outputFolder={eng.output_folder}
            disabled={!cmdletsEnabled}
            disabledReason={
              !isActive ? 'Engagement ended' : !authComplete ? 'Waiting for device-code auth' : undefined
            }
          />
          <RunsCard runs={data?.runs ?? []} />
        </div>
      </div>

      <DeviceCodeModal
        deviceCode={deviceCode}
        onDismiss={() => setDeviceCode(null)}
      />
    </div>
  )
}

function ExoFailureBanner({
  engagementId,
  onCleared,
}: {
  engagementId: number
  onCleared: () => void
}) {
  const reconnect = useMutation({
    mutationFn: () => api.reconnectExo(engagementId),
    onSuccess: () => onCleared(),
  })
  return (
    <div className="mb-4 rounded-lg border border-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] p-4 flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-[var(--color-warn)]">
          Exchange Online module needs reconnect
        </p>
        <p className="text-xs text-[var(--color-muted)] mt-1 max-w-xl">
          HAWK reported "Module could not be correctly formed" (issue #292) —
          a known mid-investigation EXO state issue. Click below to run
          Disconnect-ExchangeOnline + Connect-ExchangeOnline in the same
          subprocess. You'll see a fresh device-code prompt for EXO. Then
          re-run the failed cmdlet.
        </p>
      </div>
      <Button
        variant="primary"
        onClick={() => reconnect.mutate()}
        disabled={reconnect.isPending}
      >
        {reconnect.isPending ? 'Reconnecting…' : 'Reconnect EXO'}
      </Button>
    </div>
  )
}

function DeviceCodeModal({
  deviceCode,
  onDismiss,
}: {
  deviceCode: DeviceCode | null
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!deviceCode) return null

  const targetLabel =
    deviceCode.target === 'graph'
      ? 'Microsoft Graph'
      : deviceCode.target === 'exo'
        ? 'Exchange Online'
        : 'Microsoft 365'

  const onCopy = async () => {
    await navigator.clipboard.writeText(deviceCode.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Modal open={true} onClose={onDismiss} title={`Sign in to ${targetLabel}`}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-muted)]">
          Open the login page and enter this code to authenticate the engagement
          subprocess against the client tenant. Paste it into the browser; this
          window will update automatically when the connect completes.
        </p>
        <div className="flex items-center justify-between gap-3 rounded border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-4 py-3">
          <code className="text-3xl font-mono font-semibold tracking-wider">
            {deviceCode.code}
          </code>
          <button
            type="button"
            onClick={onCopy}
            className="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
        <a
          href={deviceCode.url}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm px-3 py-2 rounded border border-[var(--color-accent)] bg-[var(--color-accent)] text-black hover:opacity-90"
        >
          Open {deviceCode.url} →
        </a>
        <p className="text-xs text-[var(--color-muted)] font-mono break-all">
          {deviceCode.url}
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          Two device codes are expected per engagement -- one for Microsoft
          Graph, one for Exchange Online. The next code will appear here
          automatically after this one completes.
        </p>
      </div>
    </Modal>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center">{children}</div>
  )
}

function ConsolePane({
  engagementId,
  isActive,
  onState,
}: {
  engagementId: number
  isActive: boolean
  onState: (evt: StateEvent) => void
}) {
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

  useStateStream(engagementId, onState)

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

function CmdletPickerCard({
  engagementId,
  startDate,
  endDate,
  outputFolder,
  disabled,
  disabledReason,
}: {
  engagementId: number
  startDate: string
  endDate: string
  outputFolder: string
  disabled: boolean
  disabledReason?: string
}) {
  const qc = useQueryClient()
  const [userModalOpen, setUserModalOpen] = useState(false)
  const run = useMutation({
    mutationFn: (body: { cmdlet: string; params: Record<string, unknown> }) =>
      api.createRun(engagementId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement', engagementId] }),
  })

  const runTenant = () =>
    run.mutate({
      cmdlet: 'Start-HawkTenantInvestigation',
      params: {
        StartDate: startDate,
        EndDate: endDate,
        FilePath: outputFolder,
      },
    })

  const runUsers = (upns: string[]) => {
    run.mutate({
      cmdlet: 'Start-HawkUserInvestigation',
      params: {
        UserPrincipalName: upns,
        StartDate: startDate,
        EndDate: endDate,
        FilePath: outputFolder,
      },
    })
    setUserModalOpen(false)
  }

  return (
    <Card
      title="Run Cmdlet"
      subtitle={
        disabled && disabledReason
          ? disabledReason
          : `${startDate} → ${endDate} · output in engagement folder`
      }
    >
      <div className="space-y-3">
        <Button
          onClick={runTenant}
          disabled={disabled || run.isPending}
          variant="primary"
          className="w-full"
          title="Runs Start-HawkTenantInvestigation across the engagement's date range"
        >
          {run.isPending ? 'Starting…' : 'Run Tenant Investigation'}
        </Button>
        <Button
          onClick={() => setUserModalOpen(true)}
          disabled={disabled || run.isPending}
          className="w-full"
          title="Runs Start-HawkUserInvestigation against one or more UPNs"
        >
          Run User Investigation…
        </Button>
        <details className="text-xs text-[var(--color-muted)]">
          <summary className="cursor-pointer select-none hover:text-[var(--color-text)]">
            Smoke tests
          </summary>
          <div className="mt-2 space-y-2">
            <Button
              onClick={() => run.mutate({ cmdlet: 'Get-Date', params: {} })}
              disabled={disabled || run.isPending}
              className="w-full"
            >
              Get-Date
            </Button>
            <Button
              onClick={() =>
                run.mutate({
                  cmdlet: '($PSVersionTable.PSVersion).ToString()',
                  params: {},
                })
              }
              disabled={disabled || run.isPending}
              className="w-full"
            >
              $PSVersionTable
            </Button>
          </div>
        </details>
        {run.error && <Err msg={String(run.error)} />}
      </div>
      <UserInvestigationModal
        open={userModalOpen}
        onClose={() => setUserModalOpen(false)}
        onSubmit={runUsers}
        startDate={startDate}
        endDate={endDate}
      />
    </Card>
  )
}

function UserInvestigationModal({
  open,
  onClose,
  onSubmit,
  startDate,
  endDate,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (upns: string[]) => void
  startDate: string
  endDate: string
}) {
  const [raw, setRaw] = useState('')
  const upns = parseUpns(raw)
  const valid = upns.length > 0 && upns.every(isProbablyUpn)

  return (
    <Modal open={open} onClose={onClose} title="Run User Investigation">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          onSubmit(upns)
          setRaw('')
        }}
        className="space-y-4"
      >
        <p className="text-sm text-[var(--color-muted)]">
          Runs <code className="font-mono text-xs">Start-HawkUserInvestigation</code>{' '}
          against the listed UPNs. Date range and output folder come from
          the engagement.
        </p>
        <label className="block">
          <div className="text-xs text-[var(--color-muted)] mb-1">
            User principal names — one per line, or comma-separated
          </div>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            className="w-full bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
            placeholder={'alice@contoso.com\nbob@contoso.com'}
          />
        </label>
        <div className="text-xs text-[var(--color-muted)]">
          {upns.length === 0 && 'Enter at least one UPN.'}
          {upns.length > 0 && (
            <>
              <span className="text-[var(--color-text)]">{upns.length} UPN{upns.length === 1 ? '' : 's'}:</span>{' '}
              {upns.slice(0, 5).map((u) => (
                <span
                  key={u}
                  className={`inline-block font-mono mr-2 ${
                    isProbablyUpn(u) ? '' : 'text-[var(--color-danger)]'
                  }`}
                >
                  {u}
                </span>
              ))}
              {upns.length > 5 && <span>and {upns.length - 5} more</span>}
            </>
          )}
        </div>
        <p className="text-[11px] text-[var(--color-muted)]">
          Date window: {startDate} → {endDate}.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            Run
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function parseUpns(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function isProbablyUpn(s: string): boolean {
  // Loose check -- HAWK validates the real format. We just need to catch
  // obvious typos before we POST to the backend.
  return /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(s)
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
