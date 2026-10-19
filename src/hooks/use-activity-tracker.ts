'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  ACTIVITY_EVENTS,
  HEARTBEAT_INTERVAL_MS,
  IDLE_THRESHOLD_MS,
  bucketForPath,
  type ActivityEndReason,
} from '@/lib/activity-tracker-config'

// Tracks the user's time on the current page, attributing it to the right
// bucket (ANNOTATION for scoring/reconciliation/adjudication/revision pages,
// OTHER for any other authenticated page — see bucketForPath).
//
// Active = page is visible AND there's been a real input event in the last
// IDLE_THRESHOLD_MS. While active, we POST a heartbeat every
// HEARTBEAT_INTERVAL_MS so the server keeps the session open. Visibility
// changes, idle timeouts, route transitions, and pagehide all close the
// session — multi-tab dedup is handled server-side at aggregate time.
//
// Session lifecycle invariants this hook maintains:
//   - At most one session is ever "owned" by this page at a time, and every
//     session the server creates for it gets an end request. A create whose
//     response has not arrived yet is tracked as `pendingCreate` so a hide /
//     navigate / idle in that window still closes the session it produces.
//   - A heartbeat for a session the server has closed (410) drops the id and
//     starts a fresh session; the server never substitutes one silently.
//   - An 'idle' end carries the time of the last input event so the server
//     books the session up to there, not up to idle detection.
export function useActivityTracker() {
  const pathname = usePathname()
  const { status } = useSession()

  const sessionIdRef = useRef<string | null>(null)
  // Initialized in the effect (Date.now() is impure — not safe during render).
  const lastActivityRef = useRef<number>(0)

  useEffect(() => {
    if (status !== 'authenticated') return
    const bucket = bucketForPath(pathname)
    if (!bucket) return

    let cancelled = false
    // The heartbeat currently creating a session (no id known yet), or null.
    let pendingCreate: Promise<string | null> | null = null
    // Set when a session was closed for idleness; the next input event
    // restarts tracking immediately instead of waiting for the next tick.
    let resumeOnActivity = false
    lastActivityRef.current = Date.now()

    const postEnd = (
      sessionId: string,
      reason: ActivityEndReason,
      lastActiveAt: number,
      useBeacon: boolean
    ) => {
      const data = JSON.stringify({ sessionId, reason, lastActiveAt })
      if (useBeacon && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([data], { type: 'application/json' })
        navigator.sendBeacon('/api/activity/end', blob)
        return
      }
      fetch('/api/activity/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
        keepalive: true,
      }).catch(() => {
        // Silent — the server sweeps orphaned sessions on the next heartbeat.
      })
    }

    const sendHeartbeat = (): void => {
      const sentId = sessionIdRef.current
      // A create is already in flight for this period — don't open a second
      // session (visibility flapping used to do exactly that).
      if (!sentId && pendingCreate) return

      const request: Promise<string | null> = fetch('/api/activity/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sentId ?? undefined, bucket }),
        keepalive: true,
      })
        .then(async (r) => {
          if (r.status === 410) {
            // The server closed this session (swept, or our own end request
            // won a race). Forget it and, if we're still active, start fresh.
            if (sentId && sessionIdRef.current === sentId) {
              sessionIdRef.current = null
              if (!cancelled && document.visibilityState === 'visible') sendHeartbeat()
            }
            return null
          }
          if (!r.ok) return null
          const data = (await r.json()) as { sessionId?: string }
          return data.sessionId ?? null
        })
        .catch(() => null)

      if (sentId) return
      pendingCreate = request
      request.then((id) => {
        // Adopt the id only if this create is still the live one. If the
        // period ended meanwhile, endCurrentSession took ownership of the
        // promise and will close whatever it produced.
        if (pendingCreate !== request) return
        pendingCreate = null
        if (!cancelled && id) sessionIdRef.current = id
      })
    }

    const endCurrentSession = (reason: ActivityEndReason, useBeacon = false) => {
      const lastActiveAt = lastActivityRef.current
      const id = sessionIdRef.current
      sessionIdRef.current = null
      const pending = pendingCreate
      pendingCreate = null
      if (reason === 'idle') resumeOnActivity = true

      if (id) {
        postEnd(id, reason, lastActiveAt, useBeacon)
        return
      }
      if (pending) {
        // The session is still being created. Wait for its id and close it;
        // otherwise it stays open until swept and the next page opens a
        // duplicate. (After pagehide this continuation may never run — the
        // server-side sweep then closes it at its only heartbeat, booking 0s.)
        pending.then((createdId) => {
          if (createdId) postEnd(createdId, reason, lastActiveAt, false)
        })
      }
    }

    const recordActivity = () => {
      lastActivityRef.current = Date.now()
      if (resumeOnActivity && !cancelled && document.visibilityState === 'visible') {
        resumeOnActivity = false
        sendHeartbeat()
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        endCurrentSession('hidden')
      } else if (document.visibilityState === 'visible') {
        lastActivityRef.current = Date.now()
        sendHeartbeat()
      }
    }

    const onPageHide = () => {
      endCurrentSession('beacon', true)
    }

    // Capture phase: `scroll` does not bubble, so a listener on window would
    // otherwise never see scrolling inside the evaluate page's inner panes.
    const listenerOptions: AddEventListenerOptions = { passive: true, capture: true }
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, recordActivity, listenerOptions)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    const interval = window.setInterval(() => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        endCurrentSession('hidden')
        return
      }
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs > IDLE_THRESHOLD_MS) {
        endCurrentSession('idle')
        return
      }
      sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    if (document.visibilityState === 'visible') {
      lastActivityRef.current = Date.now()
      sendHeartbeat()
    }

    return () => {
      cancelled = true
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, recordActivity, { capture: true })
      }
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.clearInterval(interval)
      // Route change or unmount — close any open (or still-opening) session.
      endCurrentSession('navigated')
    }
  }, [pathname, status])
}
