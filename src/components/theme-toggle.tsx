'use client'

import { Sun, Moon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDarkMode } from '@/hooks/use-dark-mode'

export function ThemeToggle() {
  const [dark, setDark] = useDarkMode()

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setDark(!dark)}
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
