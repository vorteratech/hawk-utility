import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from 'ag-grid-community'
import { filesApi, type CsvPreview, type FileNode, type FilePreview } from '../lib/api'
import { Card, Err, StatusDot } from '../components/ui'

ModuleRegistry.registerModules([AllCommunityModule])

const darkTheme = themeQuartz.withParams({
  backgroundColor: 'transparent',
  foregroundColor: 'var(--color-text)',
  headerBackgroundColor: 'var(--color-surface-2)',
  rowHoverColor: 'var(--color-surface-2)',
  borderColor: 'var(--color-border)',
})

type Filter = 'all' | 'investigate' | 'tenant' | 'user'

export function FilesTab({ engagementId }: { engagementId: number }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['files', engagementId],
    queryFn: () => filesApi.tree(engagementId),
    refetchInterval: 5000, // tree picks up new HAWK output as runs complete
  })

  if (isLoading) return <Card title="Files">Loading…</Card>
  if (error)
    return (
      <Card title="Files">
        <Err msg={String(error)} />
      </Card>
    )

  const root = data!.root
  const filtered = applyFilter(root, filter)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <div className="lg:col-span-2">
        <Card
          title="Files"
          subtitle="Engagement output folder"
          right={
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            >
              Refresh
            </button>
          }
        >
          <FilterChips value={filter} onChange={setFilter} />
          <div className="mt-3 max-h-[640px] overflow-y-auto">
            {filtered ? (
              <Tree
                node={filtered}
                selected={selected}
                onSelect={setSelected}
                isRoot
              />
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                No files match this filter yet.
              </p>
            )}
          </div>
        </Card>
      </div>
      <div className="lg:col-span-3">
        <PreviewPane engagementId={engagementId} path={selected} />
      </div>
    </div>
  )
}

function FilterChips({
  value,
  onChange,
}: {
  value: Filter
  onChange: (f: Filter) => void
}) {
  const chips: { id: Filter; label: string; hint?: string }[] = [
    { id: 'all', label: 'All Files' },
    { id: 'investigate', label: '_Investigate only', hint: "HAWK's flagged findings" },
    { id: 'tenant', label: 'Tenant' },
    { id: 'user', label: 'Per-User' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          title={c.hint}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            value === c.id
              ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]'
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

function applyFilter(root: FileNode, filter: Filter): FileNode | null {
  if (filter === 'all') return root
  // Build a filtered copy: drop files that don't match; drop directories
  // whose subtree has no surviving files.
  const matchesFile = (n: FileNode): boolean => {
    if (filter === 'investigate') return !!n.is_investigate
    if (filter === 'tenant') return n.path.toLowerCase().includes('/tenant/')
    if (filter === 'user') {
      // 'Per-user' = anything inside Hawk\<upn>\, i.e. paths containing '@'.
      return /@[\w.-]+/.test(n.path)
    }
    return true
  }
  const walk = (n: FileNode): FileNode | null => {
    if (n.kind === 'file') {
      return matchesFile(n) ? n : null
    }
    const kept = (n.children ?? []).map(walk).filter(Boolean) as FileNode[]
    if (kept.length === 0 && n.path !== '') return null
    return { ...n, children: kept }
  }
  return walk(root)
}

function Tree({
  node,
  selected,
  onSelect,
  isRoot,
}: {
  node: FileNode
  selected: string | null
  onSelect: (path: string) => void
  isRoot?: boolean
}) {
  const [open, setOpen] = useState(true)
  if (node.kind === 'file') {
    const active = node.path === selected
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={`w-full flex items-baseline gap-2 px-2 py-1 rounded text-left text-xs ${
          active
            ? 'bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-text)]'
            : 'hover:bg-[var(--color-surface-2)] text-[var(--color-muted)]'
        }`}
      >
        {node.is_investigate && <StatusDot status="fail" className="self-center" />}
        <span
          className={`flex-1 truncate font-mono ${
            node.is_investigate ? 'font-semibold text-[var(--color-text)]' : ''
          }`}
        >
          {node.name}
        </span>
        {node.size != null && (
          <span className="text-[10px] tabular-nums shrink-0">{fmtBytes(node.size)}</span>
        )}
      </button>
    )
  }
  // dir
  return (
    <div className={isRoot ? '' : 'ml-3 border-l border-[var(--color-border)] pl-2'}>
      {!isRoot && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full text-left text-xs font-mono px-2 py-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-muted)]"
        >
          <span className="inline-block w-3 text-[var(--color-muted)]">{open ? '▾' : '▸'}</span>
          {node.name}/
        </button>
      )}
      {open && (
        <div className="space-y-0.5">
          {(node.children ?? []).length === 0 && (
            <p className="text-[11px] text-[var(--color-muted)] italic px-2 py-1">empty</p>
          )}
          {(node.children ?? []).map((c) => (
            <Tree key={c.path || c.name} node={c} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function PreviewPane({
  engagementId,
  path,
}: {
  engagementId: number
  path: string | null
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['file-preview', engagementId, path],
    queryFn: () => filesApi.preview(engagementId, path!),
    enabled: !!path,
  })

  if (!path) {
    return (
      <Card title="Preview" subtitle="Select a file from the tree on the left.">
        <div className="h-[540px] flex items-center justify-center text-sm text-[var(--color-muted)]">
          (nothing selected)
        </div>
      </Card>
    )
  }

  return (
    <Card
      title={path.split('/').pop() || 'Preview'}
      subtitle={path}
      right={
        <a
          href={filesApi.downloadUrl(engagementId, path)}
          download
          className="text-xs px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
        >
          Download
        </a>
      }
    >
      {isLoading && (
        <p className="text-sm text-[var(--color-muted)]">Loading preview…</p>
      )}
      {error && <Err msg={String(error)} />}
      {data && data.kind === 'csv' && <CsvViewer preview={data} />}
      {data && data.kind === 'text' && <TextViewer preview={data} />}
    </Card>
  )
}

function CsvViewer({ preview }: { preview: CsvPreview }) {
  const colDefs = useMemo(
    () =>
      preview.headers.map((h, i) => ({
        headerName: h || `col${i}`,
        field: String(i),
        sortable: true,
        filter: true,
        resizable: true,
      })),
    [preview.headers],
  )
  const rowData = useMemo(
    () => preview.rows.map((r) => Object.fromEntries(r.map((cell, i) => [String(i), cell]))),
    [preview.rows],
  )

  return (
    <div>
      <div className="mb-2 text-xs text-[var(--color-muted)]">
        {preview.truncated
          ? `Showing ${preview.preview_rows} of ${preview.total_rows} rows — download for full data.`
          : `${preview.total_rows} rows`}
      </div>
      <div style={{ height: 540 }}>
        <AgGridReact
          theme={darkTheme}
          rowData={rowData}
          columnDefs={colDefs}
          defaultColDef={{
            flex: 1,
            minWidth: 120,
            cellStyle: { fontFamily: 'var(--font-mono)', fontSize: '11px' },
          }}
        />
      </div>
    </div>
  )
}

function TextViewer({ preview }: { preview: FilePreview & { kind: 'text' } }) {
  return (
    <div>
      {preview.truncated && (
        <p className="mb-2 text-xs text-[var(--color-warn)]">
          Showing first {fmtBytes(preview.shown_bytes)} of {fmtBytes(preview.size)} —
          download for the full file.
        </p>
      )}
      <pre className="h-[540px] overflow-y-auto bg-black/30 border border-[var(--color-border)] rounded p-3 text-xs font-mono whitespace-pre-wrap">
        {preview.text}
      </pre>
    </div>
  )
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
