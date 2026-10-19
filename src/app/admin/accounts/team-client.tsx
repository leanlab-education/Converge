'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Loader2, Plus, Check, ShieldCheck, UserCheck, Send, Trash2, ArrowUpDown } from 'lucide-react'

interface User {
  id: string
  name: string | null
  email: string
  role: string
  hasAccount: boolean
  createdAt: string
}

interface Props {
  users: User[]
  currentUserId: string
}

export function TeamClient({ users, currentUserId }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'ADMIN' | 'EVALUATOR'>('EVALUATOR')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const admins = users.filter((u) => u.role === 'ADMIN')
  const evaluators = users.filter((u) => u.role === 'EVALUATOR')

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSending(true)

    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || null,
          role,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setEmail('')
        setName('')
        setRole('EVALUATOR')
        if (data.invited) {
          setSuccess('Invitation email sent!')
        } else if (data.alreadyHasPassword) {
          setSuccess('User already has an account.')
        }
        router.refresh()
        setTimeout(() => {
          setOpen(false)
          setSuccess('')
        }, 1500)
      } else {
        const err = await res.json()
        setError(err.error || 'Failed to send invite')
      }
    } catch {
      setError('Something went wrong')
    } finally {
      setSending(false)
    }
  }

  async function handleResendInvite(user: User) {
    setActionLoading(user.id)
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, name: user.name, role: user.role }),
      })
      if (res.ok) {
        router.refresh()
      }
    } catch (err) {
      console.error('Failed to resend invite:', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleChangeRole(user: User) {
    const newRole = user.role === 'ADMIN' ? 'EVALUATOR' : 'ADMIN'
    const label = newRole === 'ADMIN' ? 'admin' : 'evaluator'
    if (!confirm(`Change ${user.name || user.email} to ${label}?`)) return

    setActionLoading(user.id)
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (res.ok) {
        router.refresh()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to change role')
      }
    } catch (err) {
      console.error('Failed to change role:', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleDelete(user: User) {
    if (
      !confirm(
        `Delete ${user.name || user.email}? This removes their account and their project and team memberships. Accounts with recorded scores or escalations cannot be deleted — remove them from their projects instead. This cannot be undone.`
      )
    )
      return

    setActionLoading(user.id)
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' })
      if (res.ok) {
        router.refresh()
      } else {
        // The server explains why (e.g. the account still holds scores).
        const err = await res.json().catch(() => null)
        alert(err?.error || 'Failed to delete user')
      }
    } catch (err) {
      console.error('Failed to delete user:', err)
      alert('Something went wrong while deleting the account.')
    } finally {
      setActionLoading(null)
    }
  }

  function UserRow({ user, idx }: { user: User; idx: number }) {
    const isSelf = user.id === currentUserId
    const isAdmin = user.role === 'ADMIN'
    const loading = actionLoading === user.id

    return (
      <div
        className={`flex items-center gap-3 px-3 py-2.5 ${idx > 0 ? 'border-t border-border' : ''}`}
      >
        {isAdmin ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
        ) : (
          <UserCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">
            {user.name || user.email}
          </span>
          {user.name && (
            <span className="ml-2 text-xs text-muted-foreground">{user.email}</span>
          )}
          {isSelf && (
            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {user.hasAccount ? (
            <Badge variant="outline" className="text-[10px] text-success border-success/30">
              Active
            </Badge>
          ) : (
            <>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Invited
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={loading}
                onClick={() => handleResendInvite(user)}
                title="Resend invite email"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              </Button>
            </>
          )}
          {!isSelf && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={loading}
                onClick={() => handleChangeRole(user)}
                title={`Change to ${isAdmin ? 'Annotator' : 'Admin'}`}
              >
                <ArrowUpDown className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={loading}
                onClick={() => handleDelete(user)}
                title="Delete account"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Manage admins and evaluators. Invited users set their own password.
          </p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(''); setSuccess('') }}>
          <DialogTrigger render={<Button />}>
            <Plus className="mr-2 h-4 w-4" />
            Invite
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Invite Team Member</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={role === 'EVALUATOR' ? 'default' : 'outline'}
                    onClick={() => setRole('EVALUATOR')}
                  >
                    <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                    Annotator
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={role === 'ADMIN' ? 'default' : 'outline'}
                    onClick={() => setRole('ADMIN')}
                  >
                    <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                    Admin
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="amber@leanlabeducation.org"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-name">
                  Name <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="invite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Amber Wang"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {success && (
                <p className="flex items-center gap-1.5 text-sm text-success">
                  <Check className="h-3.5 w-3.5" />
                  {success}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={sending || !email.trim()}>
                  {sending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send Invite'
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Admins */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Admins ({admins.length})
        </h2>
        <div className="mt-2 rounded-md border border-border">
          {admins.map((user, idx) => (
            <UserRow key={user.id} user={user} idx={idx} />
          ))}
        </div>
      </div>

      {/* Annotators */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Annotators ({evaluators.length})
        </h2>
        {evaluators.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No annotators yet. Invite them from here or from a project&apos;s Annotators tab.
          </p>
        ) : (
          <div className="mt-2 rounded-md border border-border">
            {evaluators.map((user, idx) => (
              <UserRow key={user.id} user={user} idx={idx} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
