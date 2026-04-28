import { useState } from 'react'

// Recreated from HAWK's terminal banner. Don't reformat -- the spacing
// and backticks are load-bearing for the ASCII art.
const HAWK_ASCII = String.raw`    __  __               __
   / / / /___ __      __/ /__
  / /_/ / __ ` + "`" + String.raw`/ | /| / / //_/
 / __  / /_/ /| |/ |/ / ,<
/_/ /_/\__,_/ |__/|__/_/|_|  `

export function Brand() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-6">
        <VorteraLogo />
        <HawkBanner />
      </div>
      <p className="text-xs tracking-[0.35em] uppercase text-[var(--color-muted)] font-medium">
        Investigation Utility
        <span className="ml-3 tracking-normal text-[var(--color-muted)] opacity-60 normal-case">
          v1.0
        </span>
      </p>
    </div>
  )
}

function VorteraLogo() {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <span className="text-xs text-[var(--color-muted)] italic">
        (drop logo at frontend/public/vortera-logo.png)
      </span>
    )
  }
  return (
    <img
      src="/vortera-logo.png"
      alt="Vortera Technologies"
      className="h-12 w-auto"
      onError={() => setErrored(true)}
    />
  )
}

function HawkBanner() {
  return (
    <pre
      aria-label="HAWK"
      className="font-mono text-[10px] leading-[1.05] text-[var(--color-accent)] whitespace-pre select-none"
    >
      {HAWK_ASCII}
    </pre>
  )
}
