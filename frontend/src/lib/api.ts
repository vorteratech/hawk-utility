export type SystemInfo = {
  platform_is_windows: boolean
  pwsh_executable: string
  engagements_root: string
  db_path: string
}

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'unknown'

export type SystemCheck = {
  id: string
  label: string
  status: CheckStatus
  detail?: string
  fix?: string
}

export type SystemStatus = {
  checks: SystemCheck[]
  ready: boolean
}

export type Engagement = {
  id: number
  client_name: string
  tenant_hint: string | null
  start_date: string
  end_date: string
  output_folder: string
  pwsh_pid: number | null
  status: 'starting' | 'active' | 'ended' | 'crashed'
  created_at: string
  ended_at: string | null
}

export type Run = {
  id: number
  engagement_id: number
  cmdlet: string
  params_json: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  exit_code: number | null
  log_path: string | null
  started_at: string
  ended_at: string | null
}

export type ConsoleLine = {
  seq: number
  stream: 'stdout' | 'stderr' | 'meta'
  text: string
  ts: string
  run_id: number | null
}

export type ConsoleEvent =
  | { type: 'line'; line: ConsoleLine }
  | { type: 'error'; msg: string }

export type StateEvent =
  | { type: 'engagement_started'; engagement_id: number; ts: string }
  | { type: 'engagement_ended'; engagement_id: number; ts: string }
  | { type: 'run_started'; run_id: number; cmdlet: string; clean_invocation: string; ts: string }
  | { type: 'run_finished'; run_id: number; status: Run['status']; detail: string; ts: string }
  | { type: 'error'; msg: string }

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return (await res.json()) as T
}

export const api = {
  systemInfo: () => jsonFetch<SystemInfo>('/api/system/info'),
  systemStatus: () => jsonFetch<SystemStatus>('/api/system/status'),
  listEngagements: () =>
    jsonFetch<{ engagements: Engagement[] }>('/api/engagements'),
  activeEngagement: () =>
    jsonFetch<{ engagement: Engagement | null }>('/api/engagements/active'),
  getEngagement: (id: number) =>
    jsonFetch<{ engagement: Engagement; runs: Run[] }>(`/api/engagements/${id}`),
  createEngagement: (body: {
    client_name: string
    start_date: string
    end_date: string
    tenant_hint?: string
    skip_preflight?: boolean
  }) =>
    jsonFetch<{ engagement: Engagement }>('/api/engagements', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  endEngagement: (id: number) =>
    jsonFetch<{ ok: true }>(`/api/engagements/${id}/end`, { method: 'POST' }),
  createRun: (engagementId: number, body: { cmdlet: string; params: Record<string, unknown> }) =>
    jsonFetch<{ run: Run }>(`/api/engagements/${engagementId}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendStdin: (engagementId: number, text: string) =>
    jsonFetch<{ ok: true }>(`/api/engagements/${engagementId}/stdin`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}
