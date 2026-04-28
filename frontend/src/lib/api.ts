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
  | { type: 'device_code'; url: string; code: string; target: 'graph' | 'exo' | null; ts: string }
  | { type: 'auth_step'; step: 'importing_modules' | 'graph_starting' | 'graph_done' | 'exo_done'; ts: string }
  | { type: 'auth_complete'; ts: string }
  | { type: 'exo_module_failure'; detail: string; run_id: number | null; ts: string }
  | { type: 'exo_module_recovered'; ts: string }
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
    jsonFetch<{ engagement: Engagement; runs: Run[]; auth_complete: boolean }>(`/api/engagements/${id}`),
  createEngagement: (body: {
    client_name: string
    start_date: string
    end_date: string
    tenant_hint?: string
    skip_preflight?: boolean
    skip_auth?: boolean
  }) =>
    jsonFetch<{ engagement: Engagement }>('/api/engagements', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  endEngagement: (id: number) =>
    jsonFetch<{ ok: true }>(`/api/engagements/${id}/end`, { method: 'POST' }),
  reconnectExo: (id: number) =>
    jsonFetch<{ ok: true }>(`/api/engagements/${id}/reconnect-exo`, {
      method: 'POST',
    }),
  deleteEngagement: (id: number, deleteFolder = false) =>
    jsonFetch<{ ok: true; folder_removed: boolean }>(
      `/api/engagements/${id}?delete_folder=${deleteFolder}`,
      { method: 'DELETE' },
    ),
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

// ---------- Files tab ----------
export type FileNode = {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number | null
  modified: string
  is_investigate?: boolean
  children?: FileNode[]
  truncated?: boolean
  error?: string
}

export type CsvPreview = {
  kind: 'csv'
  size: number
  headers: string[]
  rows: string[][]
  total_rows: number
  preview_rows: number
  truncated: boolean
}

export type TextPreview = {
  kind: 'text'
  size: number
  text: string
  truncated: boolean
  shown_bytes: number
}

export type FilePreview = CsvPreview | TextPreview

export const filesApi = {
  tree: (engagementId: number) =>
    jsonFetch<{ root: FileNode }>(`/api/engagements/${engagementId}/files`),
  preview: (engagementId: number, path: string) =>
    jsonFetch<FilePreview>(
      `/api/engagements/${engagementId}/files/preview?path=${encodeURIComponent(path)}`,
    ),
  downloadUrl: (engagementId: number, path: string) =>
    `/api/engagements/${engagementId}/files/download?path=${encodeURIComponent(path)}`,
  zipUrl: (engagementId: number) =>
    `/api/engagements/${engagementId}/zip`,
}
