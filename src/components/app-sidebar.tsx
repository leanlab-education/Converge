'use client'

import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutGrid,
  BookOpen,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  PenTool,
  BarChart3,
  UserCheck,
  UsersRound,
  Layers,
  List,
  Ruler,
  Download,
  ChevronRight,
  Scale,
  Sun,
  Moon,
} from 'lucide-react'

export interface ProjectContext {
  id: string
  name: string
  activeTab: string
  onTabChange: (tab: string) => void
}

interface AppSidebarProps {
  collapsed: boolean
  onToggle: () => void
  projectContext?: ProjectContext
}

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
}

const PROJECT_SUB_NAV = [
  { value: 'overview', label: 'Overview', icon: <BarChart3 className="size-3.5 shrink-0" /> },
  { value: 'evaluators', label: 'Annotators', icon: <UserCheck className="size-3.5 shrink-0" /> },
  { value: 'teams', label: 'Teams', icon: <UsersRound className="size-3.5 shrink-0" /> },
  { value: 'batches', label: 'Batches', icon: <Layers className="size-3.5 shrink-0" /> },
  { value: 'items', label: 'Items', icon: <List className="size-3.5 shrink-0" /> },
  { value: 'rubric', label: 'Rubric', icon: <Ruler className="size-3.5 shrink-0" /> },
  { value: 'export', label: 'Data', icon: <Download className="size-3.5 shrink-0" /> },
]

function SidebarThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <button
      onClick={toggle}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/70 transition-all duration-200 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground ${
        collapsed ? 'justify-center px-0' : ''
      }`}
      title={collapsed ? 'Toggle theme' : undefined}
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="size-4 shrink-0" /> : <Moon className="size-4 shrink-0" />}
      {!collapsed && <span>{dark ? 'Light Mode' : 'Dark Mode'}</span>}
    </button>
  )
}

export function AppSidebar({ collapsed, onToggle, projectContext }: AppSidebarProps) {
  const { data: session } = useSession()
  const pathname = usePathname()

  const isGlobalAdmin = session?.user?.role === 'ADMIN'
  // Non-global users only reach /admin/* if they're a project admin (the home
  // page redirects them there), so the admin pathname is a reliable signal.
  const onAdminPage = pathname.startsWith('/admin')

  const navItems: NavItem[] = isGlobalAdmin
    ? [
        {
          href: '/admin',
          label: 'Projects',
          icon: <LayoutGrid className="size-4 shrink-0" />,
        },
        {
          href: '/admin/accounts',
          label: 'Accounts',
          icon: <UsersRound className="size-4 shrink-0" />,
        },
      ]
    : onAdminPage
      ? [
          {
            href: '/admin',
            label: 'Projects',
            icon: <LayoutGrid className="size-4 shrink-0" />,
          },
        ]
      : [
          {
            href: '/',
            label: 'My Projects',
            icon: <BookOpen className="size-4 shrink-0" />,
          },
          {
            href: '/reconcile',
            label: 'Reconcile',
            icon: <Scale className="size-4 shrink-0" />,
          },
        ]

  function isActive(href: string) {
    if (href === '/admin/accounts') return pathname === '/admin/accounts'
    if (href === '/admin') return pathname === '/admin' || (pathname.startsWith('/admin/') && pathname !== '/admin/accounts')
    if (href === '/') return pathname === '/' || pathname.startsWith('/evaluate/')
    return pathname.startsWith(href)
  }

  return (
    <aside
      className={`flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200 ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      {/* Logo + collapse toggle */}
      <div className={`flex h-14 items-center border-b border-sidebar-border ${collapsed ? 'justify-center' : 'justify-between px-3'}`}>
        {collapsed ? (
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-sidebar-foreground transition-colors hover:text-sidebar-primary"
            title="Expand sidebar"
          >
            <PenTool className="size-5" />
          </button>
        ) : (
          <>
            <Link
              href={isGlobalAdmin ? '/admin' : '/'}
              className="flex items-center gap-2 text-sidebar-foreground transition-colors hover:text-sidebar-primary"
            >
              <PenTool className="size-5 shrink-0" />
              <span className="text-sm font-semibold tracking-tight whitespace-nowrap">
                Writing Evaluator
              </span>
            </Link>
            <button
              onClick={onToggle}
              className="rounded-md p-1 text-sidebar-foreground/40 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <div className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.href) && !projectContext
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                {item.icon}
                {!collapsed && <span>{item.label}</span>}
              </Link>
            )
          })}
        </div>

        {/* Project sub-nav */}
        {projectContext && !collapsed && (
          <div className="mt-4 border-t border-sidebar-border pt-4">
            <div className="mb-2 flex items-center gap-1.5 px-2.5">
              <ChevronRight className="size-3 text-sidebar-foreground/40" />
              <span className="truncate text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {projectContext.name}
              </span>
            </div>
            <div className="space-y-0.5">
              {PROJECT_SUB_NAV.map((item) => {
                const active = projectContext.activeTab === item.value
                return (
                  <button
                    key={item.value}
                    onClick={() => projectContext.onTabChange(item.value)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-all duration-200 ${
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Collapsed project indicator */}
        {projectContext && collapsed && (
          <div className="mt-4 border-t border-sidebar-border pt-4 space-y-1">
            {PROJECT_SUB_NAV.map((item) => {
              const active = projectContext.activeTab === item.value
              return (
                <button
                  key={item.value}
                  onClick={() => projectContext.onTabChange(item.value)}
                  className={`flex w-full items-center justify-center rounded-lg py-1.5 transition-all duration-200 ${
                    active
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  }`}
                  title={item.label}
                >
                  {item.icon}
                </button>
              )
            })}
          </div>
        )}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-sidebar-border px-2 py-3 space-y-0.5">
        {/* User email */}
        {session?.user?.email && !collapsed && (
          <div className="px-2.5 py-1.5">
            <p className="truncate text-xs text-sidebar-foreground/60">
              {session.user.email}
            </p>
          </div>
        )}

        {/* Theme toggle */}
        <SidebarThemeToggle collapsed={collapsed} />

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/70 transition-all duration-200 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground ${
            collapsed ? 'justify-center px-0' : ''
          }`}
          title={collapsed ? 'Sign out' : undefined}
        >
          <LogOut className="size-4 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </aside>
  )
}
