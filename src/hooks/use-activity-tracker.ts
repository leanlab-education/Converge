'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  ACTIVITY_EVENTS,
  HEARTBEAT_INTERVAL_MS,
  IDLE_THRESHOLD_MS,
  bucketForPath,
  type ActivityBucket,
} from '@/lib/activity-tracker-config'

// Tracks the user's time on the current page, attributing it to the right
// bucket (ANNOTATION for /evaluate/*, OTHER for any other authenticated page).
//
// Active = page is visible AND there's been a real input event in the last
// IDLE_THRESHOLD_MS. While active, we POST a heartbeat every
// HEARTBEAT_INTERVAL_MS so the server keeps the session open. Visibility
// changes, idle timeouts, route transitions, and pagehide all close the
// session — multi-tab dedup is handled server-side at aggregate time.
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
    lastActivityRef.current = Date.now()

    const sendHeartbeat = (forBucket: ActivityBucket) => {
      fetch('/api/activity/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current ?? undefined,
          bucket: forBucket,
        }),
        keepalive: true,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { sessionId?: string } | null) => {
          if (!cancelled && data?.sessionId) sessionIdRef.current = data.sessionId
        })
        .catch(() => {
          // Silent — sweep cron closes orphaned sessions.
        })
    }

    const endCurrentSession = (reason: string, useBeacon: boolean) => {
      const id = sessionIdRef.current
      if (!id) return
      sessionIdRef.current = null
      const data = JSON.stringify({ sessionId: id, reason })
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
      }).catch(() => {})
    }

    const recordActivity = () => {
      lastActivityRef.current = Date.now()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        endCurrentSession('hidden', false)
      } else if (document.visibilityState === 'visible') {
        lastActivityRef.current = Date.now()
        sendHeartbeat(bucket)
      }
    }

    const onPageHide = () => {
      endCurrentSession('beacon', true)
    }

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, recordActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)

    const interval = window.setInterval(() => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        endCurrentSession('hidden', false)
        return
      }
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs > IDLE_THRESHOLD_MS) {
        endCurrentSession('idle', false)
        return
      }
      sendHeartbeat(bucket)
    }, HEARTBEAT_INTERVAL_MS)

    if (document.visibilityState === 'visible') {
      lastActivityRef.current = Date.now()
      sendHeartbeat(bucket)
    }

    return () => {
      cancelled = true
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, recordActivity)
      }
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.clearInterval(interval)
      // Route change or unmount — close any open session.
      endCurrentSession('navigated', false)
    }
  }, [pathname, status])
}
