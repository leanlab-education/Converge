'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Plus, Loader2, Trash2 } from 'lucide-react'
import { TeamAvatar, UserAvatar } from '@/components/user-avatar'
import { displayAnnotatorName } from '@/lib/generate-name'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserInfo {
  id: string
  name: string | null
  email: string
}

interface DimensionInfo {
  id: string
  key: string
  label: string
  sortOrder: number
}

interface Team {
  id: string
  name: string
  members: { id: string; userId: string; user: UserInfo }[]
  dimensions: { id: string; dimensionId: string; dimension: DimensionInfo }[]
}

interface EvaluatorOption {
  userId: string
  user: UserInfo
}

interface Props {
  projectId: string
  evaluators: EvaluatorOption[]
  rubricDimensions: DimensionInfo[]
  usePseudonyms?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamManagement({ projectId, evaluators, rubricDimensions, usePseudonyms = true }: Props) {
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/teams`)
      if (res.ok) {
        const data = await res.json()
        setTeams(data)
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchTeams()
  }, [fetchTeams])

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  // Evaluators already on a team
  const assignedUserIds = new Set(
    teams.flatMap((t) => t.members.map((m) => m.userId))
  )

  // Dimensions already assigned to a team
  const assignedDimensionIds = new Set(
    teams.flatMap((t) => t.dimensions.map((d) => d.dimensionId))
  )

  const availableEvaluators = evaluators.filter(
    (e) => !assignedUserIds.has(e.userId)
  )

  const availableDimensions = rubricDimensions.filter(
    (d) => !assignedDimensionIds.has(d.id)
  )

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError('')
    setCreating(true)

    try {
      const res = await fetch(`/api/projects/${projectId}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: teamName.trim(),
          memberUserIds: selectedMembers,
          dimensionIds: selectedDimensions,
        }),
      })

      if (res.ok) {
        setTeamName('')
        setSelectedMembers([])
        setSelectedDimensions([])
        setCreateOpen(false)
        await fetchTeams()
      } else {
        const err = await res.json()
        setCreateError(err.error || 'Failed to create team')
      }
    } catch (err) {
      console.error('Failed to create team:', err)
      setCreateError('Something went wrong')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(teamId: string) {
    setDeleting(teamId)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/teams/${teamId}`,
        { method: 'DELETE' }
      )
      if (res.ok) {
        await fetchTeams()
      } else {
        const err = await res.json()
        setError(err.error || 'Failed to delete team')
      }
    } catch (err) {
      console.error('Failed to delete team:', err)
    } finally {
      setDeleting(null)
    }
  }

  function toggleMember(userId: string) {
    setSelectedMembers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    )
  }

  function toggleDimension(dimId: string) {
    setSelectedDimensions((prev) =>
      prev.includes(dimId)
        ? prev.filter((id) => id !== dimId)
        : [...prev, dimId]
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Annotator Teams</h2>
          <p className="text-sm text-muted-foreground">
            Pair annotators and assign each team their rubric criteria.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="mr-2 h-4 w-4" />
            Create Team
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Annotator Team</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              {/* Team name */}
              <div className="space-y-2">
                <Label htmlFor="team-name">Team Name</Label>
                <Input
                  id="team-name"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g., Team Alpha"
                  required
                />
              </div>

              {/* Member selection */}
              <div className="space-y-2">
                <Label>
                  Members{' '}
                  <span className="text-muted-foreground">
                    ({selectedMembers.length} selected)
                  </span>
                </Label>
                {availableEvaluators.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    All evaluators are already assigned to teams.
                  </p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                    {availableEvaluators.map((ev) => (
                      <label
                        key={ev.userId}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={selectedMembers.includes(ev.userId)}
                          onChange={() => toggleMember(ev.userId)}
                          className="rounded border-input"
                        />
                        <span>{ev.user.name || ev.user.email}</span>
                        {ev.user.name && (
                          <span className="text-muted-foreground">
                            ({ev.user.email})
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Dimension selection */}
              <div className="space-y-2">
                <Label>
                  Criteria{' '}
                  <span className="text-muted-foreground">
                    ({selectedDimensions.length} selected)
                  </span>
                </Label>
                {availableDimensions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    All criteria are already assigned to teams.
                  </p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                    {availableDimensions.map((dim) => (
                      <label
                        key={dim.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={selectedDimensions.includes(dim.id)}
                          onChange={() => toggleDimension(dim.id)}
                          className="rounded border-input"
                        />
                        <span className="font-medium">{dim.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {createError && (
                <p className="text-sm text-destructive">{createError}</p>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false)
                    setCreateError('')
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    creating ||
                    !teamName.trim() ||
                    selectedMembers.length === 0 ||
                    selectedDimensions.length === 0
                  }
                >
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Team'
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Summary stats */}
      <div className="flex gap-4 text-sm text-muted-foreground">
        <span>
          {teams.length} team{teams.length !== 1 ? 's' : ''} created
        </span>
        <span>&middot;</span>
        <span>
          {assignedUserIds.size}/{evaluators.length} evaluators assigned
        </span>
        <span>&middot;</span>
        <span>
          {assignedDimensionIds.size}/{rubricDimensions.length} criteria assigned
        </span>
      </div>

      {/* Team cards */}
      {teams.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No teams created yet. Create teams to pair evaluators and assign
          criteria.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {teams.map((team) => (
            <Card key={team.id} className="transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <TeamAvatar name={team.id} size={26} />
                    {team.name}
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(team.id)}
                    disabled={deleting === team.id}
                  >
                    {deleting === team.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Members */}
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Members
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {team.members.map((m) => (
                      <Badge key={m.id} variant="secondary" className="flex items-center gap-1.5 pl-1">
                        <UserAvatar name={m.userId} size={16} />
                        {displayAnnotatorName(m.userId, m.user.name, usePseudonyms)}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Criteria */}
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Criteria
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {team.dimensions
                      .sort((a, b) => a.dimension.sortOrder - b.dimension.sortOrder)
                      .map((d) => (
                        <Badge key={d.id} variant="outline">
                          {d.dimension.label}
                        </Badge>
                      ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
