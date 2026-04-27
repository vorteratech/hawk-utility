import { useEffect, useRef, useState } from 'react'
import { wsUrl, type ConsoleEvent, type StateEvent } from './api'

type Status = 'connecting' | 'open' | 'closed' | 'error'

export function useConsoleStream(
  engagementId: number | null,
  onLine: (line: ConsoleEvent) => void,
): { status: Status } {
  const [status, setStatus] = useState<Status>('connecting')
  const onLineRef = useRef(onLine)
  onLineRef.current = onLine

  useEffect(() => {
    if (engagementId == null) return
    const ws = new WebSocket(wsUrl(`/ws/engagements/${engagementId}/console`))
    setStatus('connecting')
    ws.onopen = () => setStatus('open')
    ws.onmessage = (e) => {
      try {
        onLineRef.current(JSON.parse(e.data) as ConsoleEvent)
      } catch (err) {
        console.error('console ws parse error', err)
      }
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = () => setStatus((s) => (s === 'error' ? 'error' : 'closed'))
    return () => ws.close()
  }, [engagementId])

  return { status }
}

export function useStateStream(
  engagementId: number | null,
  onEvent: (evt: StateEvent) => void,
): { status: Status } {
  const [status, setStatus] = useState<Status>('connecting')
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (engagementId == null) return
    const ws = new WebSocket(wsUrl(`/ws/engagements/${engagementId}/state`))
    setStatus('connecting')
    ws.onopen = () => setStatus('open')
    ws.onmessage = (e) => {
      try {
        onEventRef.current(JSON.parse(e.data) as StateEvent)
      } catch (err) {
        console.error('state ws parse error', err)
      }
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = () => setStatus((s) => (s === 'error' ? 'error' : 'closed'))
    return () => ws.close()
  }, [engagementId])

  return { status }
}
