import { useState, type ReactNode } from 'react'
import type { CheckStatus } from '../lib/api'

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {(title || right) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && (
              <h2 className="text-base font-medium text-[var(--color-text)]">{title}</h2>
            )}
            {subtitle && (
              <p className="text-xs text-[var(--color-muted)] mt-0.5">{subtitle}</p>
            )}
          </div>
          {right}
        </header>
      )}
      <div>{children}</div>
    </section>
  )
}

export function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-sm">
      <span className="text-[var(--color-muted)] w-40 shrink-0">{k}</span>
      <span className={mono ? 'font-mono text-xs break-all' : 'break-all'}>{v}</span>
    </div>
  )
}

export function StatusDot({
  status,
  className = '',
}: {
  status: CheckStatus
  className?: string
}) {
  const color =
    status === 'ok'
      ? 'bg-[var(--color-ok)]'
      : status === 'fail'
        ? 'bg-[var(--color-danger)]'
        : status === 'warn'
          ? 'bg-[var(--color-warn)]'
          : 'bg-[var(--color-muted)]'
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${color} ${className}`} />
  )
}

export function Err({ msg }: { msg: string }) {
  return <p className="text-sm text-[var(--color-danger)]">{msg}</p>
}

export function Button({
  children,
  variant = 'default',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
}) {
  const base =
    'text-sm px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const variants: Record<string, string> = {
    default:
      'border-[var(--color-border)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)]',
    primary:
      'border-[var(--color-accent)] bg-[var(--color-accent)] text-black hover:opacity-90',
    danger:
      'border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)]',
    ghost: 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]',
  }
  return (
    <button {...rest} className={`${base} ${variants[variant]} ${rest.className ?? ''}`}>
      {children}
    </button>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </header>
        {children}
      </div>
    </div>
  )
}

export function CopyableCode({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <code className="flex-1 text-xs font-mono bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded px-2 py-1 truncate">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] shrink-0"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    active: { bg: 'var(--color-accent)', fg: 'black' },
    starting: { bg: 'var(--color-warn)', fg: 'black' },
    ended: { bg: 'var(--color-muted)', fg: 'black' },
    crashed: { bg: 'var(--color-danger)', fg: 'white' },
    running: { bg: 'var(--color-warn)', fg: 'black' },
    succeeded: { bg: 'var(--color-ok)', fg: 'black' },
    failed: { bg: 'var(--color-danger)', fg: 'white' },
    interrupted: { bg: 'var(--color-muted)', fg: 'black' },
    queued: { bg: 'var(--color-border)', fg: 'var(--color-text)' },
  }
  const c = map[status] ?? { bg: 'var(--color-border)', fg: 'var(--color-text)' }
  return (
    <span
      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
      style={{ background: c.bg, color: c.fg }}
    >
      {status}
    </span>
  )
}
