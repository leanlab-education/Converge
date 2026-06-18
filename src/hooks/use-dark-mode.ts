import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}

function getSnapshot() {
  return document.documentElement.classList.contains('dark')
}

/**
 * Reads dark mode from the <html> `dark` class (set pre-hydration by the inline
 * theme script) via useSyncExternalStore. Avoids setState-in-effect and is
 * SSR-safe — the server snapshot is `false`, matching the no-class default, so
 * there's no hydration mismatch.
 */
export function useDarkMode(): [boolean, (next: boolean) => void] {
  const dark = useSyncExternalStore(subscribe, getSnapshot, () => false)

  function setDark(next: boolean) {
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return [dark, setDark]
}
