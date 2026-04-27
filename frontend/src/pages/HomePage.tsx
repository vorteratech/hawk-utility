import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Engagement, type SystemInfo } from '../lib/api'
import { Button, Card, Err, Kv, Modal, StatusBadge } from '../components/ui'
import { SystemStatusCard } from './SystemStatusCard'

function NewEngagementModal({
  open,
  onClose,
  preflightReady,
}: {
  open: boolean
  onClose: () => void
  preflightReady: boolean
}) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [clientName, setClientName] = useState('')
  const [tenantHint, setTenantHint] = useState('')
  // Default to a sensible 30-day window ending today.
  const today = new Date().toISOString().slice(0, 10)
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(thirtyAgo)
  const [endDate, setEndDate] = useState(today)
  const [skipPreflight, setSkipPreflight] = useState(false)

  const create = useMutation({
    mutationFn: api.createEngagement,
    onSuccess: ({ engagement }) => {
      qc.invalidateQueries({ queryKey: ['engagements'] })
      qc.invalidateQueries({ queryKey: ['active-engagement'] })
      onClose()
      nav(`/engagements/${engagement.id}`)
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    create.mutate({
      client_name: clientName.trim(),
      start_date: startDate,
      end_date: endDate,
      tenant_hint: tenantHint.trim() || undefined,
      skip_preflight: skipPreflight,
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="New Engagement">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Client name" required>
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            required
            className={inputClass}
            placeholder="Contoso"
          />
        </Field>
        <Field label="Tenant hint (optional)">
          <input
            value={tenantHint}
            onChange={(e) => setTenantHint(e.target.value)}
            className={inputClass}
            placeholder="contoso.onmicrosoft.com"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              className={inputClass}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              className={inputClass}
            />
          </Field>
        </div>
        {!preflightReady && (
          <label className="flex items-center gap-2 text-sm text-[var(--color-warn)]">
            <input
              type="checkbox"
              checked={skipPreflight}
              onChange={(e) => setSkipPreflight(e.target.checked)}
            />
            Skip pre-flight (dev only — pwsh subprocess will still spawn but HAWK cmdlets will fail)
          </label>
        )}
        {create.error && <Err msg={String(create.error)} />}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || (!preflightReady && !skipPreflight)}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

const inputClass =
  'w-full bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-[var(--color-muted)] mb-1">
        {label}
        {required && <span className="text-[var(--color-danger)]"> *</span>}
      </div>
      {children}
    </label>
  )
}

function EngagementListCard({ activeId }: { activeId: number | null }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['engagements'],
    queryFn: api.listEngagements,
  })
  if (isLoading) return <Card title="Engagements">Loading…</Card>
  if (error) return <Card title="Engagements"><Err msg={String(error)} /></Card>
  const list = data!.engagements
  if (list.length === 0) {
    return (
      <Card title="Engagements">
        <p className="text-sm text-[var(--color-muted)]">No engagements yet.</p>
      </Card>
    )
  }
  return (
    <Card title="Engagements">
      <ul className="divide-y divide-[var(--color-border)]">
        {list.map((e) => (
          <EngagementRow key={e.id} eng={e} isActive={e.id === activeId} />
        ))}
      </ul>
    </Card>
  )
}

function EngagementRow({ eng, isActive }: { eng: Engagement; isActive: boolean }) {
  return (
    <li className="py-3">
      <Link
        to={`/engagements/${eng.id}`}
        className="flex items-center justify-between gap-3 hover:bg-[var(--color-surface-2)] -mx-2 px-2 py-1 rounded"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{eng.client_name}</span>
            <StatusBadge status={eng.status} />
            {isActive && <StatusBadge status="active" />}
          </div>
          <div className="text-xs text-[var(--color-muted)] mt-0.5">
            {eng.start_date} → {eng.end_date} · created {new Date(eng.created_at).toLocaleString()}
          </div>
        </div>
        <span className="text-xs text-[var(--color-muted)] shrink-0">#{eng.id}</span>
      </Link>
    </li>
  )
}

function SystemInfoCard() {
  const { data, isLoading, error } = useQuery<SystemInfo>({
    queryKey: ['system-info'],
    queryFn: api.systemInfo,
  })
  if (isLoading) return <Card title="System Info">Loading…</Card>
  if (error)
    return (
      <Card title="System Info">
        <Err msg={String(error)} />
      </Card>
    )
  return (
    <Card title="System Info">
      <Kv k="Platform" v={data!.platform_is_windows ? 'Windows' : 'Non-Windows (dev)'} />
      <Kv k="pwsh executable" v={data!.pwsh_executable} mono />
      <Kv k="Engagements root" v={data!.engagements_root} mono />
      <Kv k="Database" v={data!.db_path} mono />
    </Card>
  )
}

export function HomePage() {
  const [modalOpen, setModalOpen] = useState(false)
  const { data: status } = useQuery({
    queryKey: ['system-status'],
    queryFn: api.systemStatus,
  })
  const { data: active } = useQuery({
    queryKey: ['active-engagement'],
    queryFn: api.activeEngagement,
    refetchInterval: 5000,
  })
  const ready = status?.ready ?? false
  const activeId = active?.engagement?.id ?? null
  const newDisabled = activeId !== null

  return (
    <div className="min-h-screen px-6 py-8 max-w-5xl mx-auto">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">HAWK Wrapper</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            M365 forensics orchestration · v0.1.0
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeId !== null && (
            <Link
              to={`/engagements/${activeId}`}
              className="text-sm px-3 py-1.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]"
            >
              Resume active engagement →
            </Link>
          )}
          <Button
            variant="primary"
            onClick={() => setModalOpen(true)}
            disabled={newDisabled}
            title={newDisabled ? 'End the active engagement first' : undefined}
          >
            New Engagement
          </Button>
        </div>
      </header>

      <div className="grid gap-4">
        <SystemStatusCard />
        <EngagementListCard activeId={activeId} />
        <SystemInfoCard />
      </div>

      <NewEngagementModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        preflightReady={ready}
      />
    </div>
  )
}
