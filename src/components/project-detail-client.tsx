'use client'

import { useRouter } from 'next/navigation'
import { useState, useCallback, useEffect } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Plus,
  Upload,
  Download,
  Users,
  FileText,
  BarChart3,
  Loader2,
  ArrowLeft,
  CheckCircle,
  Eye,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { statusColors } from '@/lib/status-colors'
import { TeamManagement } from '@/components/team-management'
import { BatchCreator } from '@/components/batch-creator'
import { ImportEvaluatorsDialog } from '@/components/import-evaluators-dialog'
import { FeedbackItemsTab, type FeedbackItemRow } from '@/components/feedback-items-tab'
import { UserAvatar } from '@/components/user-avatar'
import { displayAnnotatorName } from '@/lib/generate-name'
import { OverviewTab } from '@/components/overview-tab'
import { Progress } from '@/components/ui/progress'
import { formatDuration, type Period } from '@/lib/activity-tracker-config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 2) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RubricDimension {
  id: string
  key: string
  label: string
  description: string | null
  sortOrder: number
  scaleMin: number
  scaleMax: number
  scoreLabelJson: string | null
}

interface Project {
  id: string
  name: string
  description: string | null
  status: string
  discrepancyThreshold: number
  studyflowStudyId: string | null
  usePseudonyms: boolean
  createdAt: string
  rubric: RubricDimension[]
  _count: {
    feedbackItems: number
    evaluators: number
  }
}

interface EvaluatorRow {
  id: string
  user: {
    id: string
    name: string | null
    email: string
  }
  role?: string
  assignedCount: number
  completedCount: number
  lastScoredAt: string | null
  team: { id: string; name: string } | null
}

interface ProjectTeam {
  id: string
  name: string
}

interface BatchRow {
  id: string
  name: string
  activityId: string | null
  conjunctionId: string | null
  status: string
  size: number
  sortOrder: number
  itemCount: number
  progressPct: number
  type: string
  isDoubleScored: boolean
  isHidden?: boolean
  discrepancyCount?: number
  reconciledCount?: number
  irrSummary?: {
    applicableTeamCount: number
    computedTeamCount: number
    readyTeamCount: number
    averageAgreementPct: number | null
    lowestAgreementPct: number | null
    perDimension: {
      dimensionId: string
      dimensionLabel: string
      agreementPct: number | null
      agreedPairs: number
      totalPairs: number
    }[]
  } | null
  ranges: {
    id: string
    startFeedbackId: string
    endFeedbackId: string
    itemCount: number
  }[]
  teamReleases: {
    id: string
    teamId: string
    teamName: string
    isVisible: boolean
    status: string
    scorerUserId: string | null
    adjudicatorId: string | null
    scorer: { id: string; email: string; name: string | null } | null
    members: { id: string; email: string; name: string | null }[]
    dimensions: { id: string; label: string }[]
    progressPct: number
    irr?: {
      isApplicable: boolean
      isReady: boolean
      agreementPct: number | null
      agreedPairs: number
      totalPairs: number
      perDimension: {
        dimensionId: string
        dimensionLabel: string
        agreementPct: number | null
        agreedPairs: number
        totalPairs: number
      }[]
    } | null
  }[]
  evaluators: {
    id: string
    email: string
    name: string | null
    scoringRole?: string
    isVisible?: boolean
  }[]
}

interface BatchRefreshOptions {
  silent?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectDetailClient({
  initialProject,
  initialEvaluators,
  initialScoredItemCount,
  initialFeedbackItemsData,
  initialActiveTab,
}: {
  initialProject: Project
  initialEvaluators: EvaluatorRow[]
  initialScoredItemCount: number
  initialFeedbackItemsData: {
    items: FeedbackItemRow[]
    total: number
    unassignedTotal: number
    filterOptions: { activityIds: string[]; conjunctionIds: string[] }
  }
  initialActiveTab: string
}) {
  const router = useRouter()
  const projectId = initialProject.id

  const [project, setProject] = useState<Project>(initialProject)
  const [evaluators, setEvaluators] = useState<EvaluatorRow[]>(initialEvaluators)
  const [scoredItemCount] = useState(initialScoredItemCount)
  const [activeTab, setActiveTab] = useState(initialActiveTab)

  // Add evaluator dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [evalEmail, setEvalEmail] = useState('')
  const [evalName, setEvalName] = useState('')
  const [addingEvaluator, setAddingEvaluator] = useState(false)
  const [evalError, setEvalError] = useState('')
  const [evalSuccess, setEvalSuccess] = useState('')

  // Batches
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [batchesLoading, setBatchesLoading] = useState(false)

  // Teams (for inline team assignment in Annotators table + Add Annotator dialog)
  const [teams, setTeams] = useState<ProjectTeam[]>([])
  const [teamPickerUser, setTeamPickerUser] = useState<EvaluatorRow | null>(null)
  const [teamPickerSaving, setTeamPickerSaving] = useState(false)
  const [teamPickerError, setTeamPickerError] = useState('')
  const [evalInitialTeamId, setEvalInitialTeamId] = useState<string>('')

  // Export filters
  const [exportActivity, setExportActivity] = useState('')
  const [exportConjunction, setExportConjunction] = useState('')
  const [discrepancyBatchId, setDiscrepancyBatchId] = useState('')

  // Annotator activity time
  const [timePeriod, setTimePeriod] = useState<Period>('month')
  const [timeData, setTimeData] = useState<
    Map<string, { annotationSeconds: number; otherSeconds: number }>
  >(new Map())

  // ---------------------------------------------------------------------------
  // Data re-fetching (after mutations)
  // ---------------------------------------------------------------------------

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`)
      if (res.ok) {
        const data = await res.json()
        setProject(data)
      }
    } catch (err) {
      console.error('Failed to fetch project:', err)
    }
  }, [projectId])

  const handleTogglePseudonyms = useCallback(async (value: boolean) => {
    setProject((p) => ({ ...p, usePseudonyms: value }))
    await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usePseudonyms: value }),
    })
  }, [projectId])

  const handleStatusChange = useCallback(async (value: string) => {
    const previous = project.status
    setProject((p) => ({ ...p, status: value }))
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: value }),
    })
    if (!res.ok) {
      setProject((p) => ({ ...p, status: previous }))
      alert('Failed to update project status')
    }
  }, [projectId, project.status])

  const fetchEvaluators = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/evaluators`)
      if (res.ok) {
        const data = await res.json()
        setEvaluators(data)
      }
    } catch (err) {
      console.error('Failed to fetch evaluators:', err)
    }
  }, [projectId])

  const fetchBatches = useCallback(async (options?: BatchRefreshOptions) => {
    if (!options?.silent) {
      setBatchesLoading(true)
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/batches`)
      if (res.ok) {
        const data = await res.json()
        setBatches(data)
      }
    } catch (err) {
      console.error('Failed to fetch batches:', err)
    } finally {
      if (!options?.silent) {
        setBatchesLoading(false)
      }
    }
  }, [projectId])

  useEffect(() => {
    if (activeTab === 'batches' || activeTab === 'overview') {
      fetchBatches()
    }
  }, [activeTab, fetchBatches])

  const fetchTeams = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/teams`)
      if (res.ok) {
        const data = await res.json()
        setTeams(data.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })))
      }
    } catch (err) {
      console.error('Failed to fetch teams:', err)
    }
  }, [projectId])

  useEffect(() => {
    fetchTeams()
  }, [fetchTeams])

  const fetchAnnotatorTime = useCallback(
    async (period: Period) => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/annotator-time?period=${period}`
        )
        if (!res.ok) return
        const data = (await res.json()) as {
          annotators: { userId: string; annotationSeconds: number; otherSeconds: number }[]
        }
        const next = new Map<string, { annotationSeconds: number; otherSeconds: number }>()
        for (const row of data.annotators) {
          next.set(row.userId, {
            annotationSeconds: row.annotationSeconds,
            otherSeconds: row.otherSeconds,
          })
        }
        setTimeData(next)
      } catch (err) {
        console.error('Failed to fetch annotator time:', err)
      }
    },
    [projectId]
  )

  useEffect(() => {
    if (activeTab === 'evaluators') {
      fetchAnnotatorTime(timePeriod)
    }
  }, [activeTab, timePeriod, fetchAnnotatorTime])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleAddEvaluator(e: React.FormEvent) {
    e.preventDefault()
    setEvalError('')
    setEvalSuccess('')
    setAddingEvaluator(true)

    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: evalEmail.trim(),
          name: evalName.trim() || null,
          projectId,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        // If a team was selected, assign now (best-effort — failure surfaces but invite succeeded)
        if (evalInitialTeamId && data.userId) {
          const teamRes = await fetch(
            `/api/projects/${projectId}/evaluators/${data.userId}/team`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ teamId: evalInitialTeamId }),
            }
          )
          if (!teamRes.ok) {
            const teamErr = await teamRes.json().catch(() => ({}))
            setEvalError(`Annotator added but team assignment failed: ${teamErr.error || 'unknown error'}`)
            await fetchEvaluators()
            await fetchProject()
            return
          }
        }
        setEvalEmail('')
        setEvalName('')
        setEvalInitialTeamId('')
        if (data.invited) {
          setEvalSuccess('Invitation email sent!')
        } else if (data.alreadyHasPassword) {
          setEvalSuccess('Annotator added (already has an account).')
        }
        await fetchEvaluators()
        await fetchProject()
        // Auto-close after a brief delay so the user sees the success message
        setTimeout(() => {
          setAddDialogOpen(false)
          setEvalSuccess('')
        }, 1500)
      } else {
        const err = await res.json()
        setEvalError(err.error || 'Failed to add evaluator')
      }
    } catch (err) {
      console.error('Failed to add evaluator:', err)
      setEvalError('Something went wrong')
    } finally {
      setAddingEvaluator(false)
    }
  }

  async function handleSetTeam(userId: string, teamId: string | null) {
    setTeamPickerSaving(true)
    setTeamPickerError('')
    try {
      const res = await fetch(
        `/api/projects/${projectId}/evaluators/${userId}/team`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId }),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setTeamPickerError(err.error || 'Failed to update team')
        return
      }
      await Promise.all([fetchEvaluators(), fetchTeams()])
      setTeamPickerUser(null)
    } catch (err) {
      console.error('Failed to update team:', err)
      setTeamPickerError('Something went wrong')
    } finally {
      setTeamPickerSaving(false)
    }
  }

  function handleExport(type: 'original' | 'reconciled') {
    const params = new URLSearchParams({ projectId, type })
    if (exportActivity) params.set('activityId', exportActivity)
    if (exportConjunction) params.set('conjunctionId', exportConjunction)
    window.open(`/api/export?${params.toString()}`, '_blank')
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function parseScoreLabels(
    json: string | null
  ): Record<string, { label: string; description: string }> {
    if (!json) return {}
    try {
      return JSON.parse(json)
    } catch {
      return {}
    }
  }

  const totalItems = project._count.feedbackItems
  const completionPct =
    totalItems > 0 ? Math.round((scoredItemCount / totalItems) * 100) : 0

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

  return (
    <AppShell
      projectContext={{
        id: project.id,
        name: project.name,
        activeTab,
        onTabChange: (tab) => {
          setActiveTab(tab)
          if (tab === 'batches') fetchBatches()
        },
      }}
    >
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            className="mb-2"
            onClick={() => router.push('/admin')}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            All Projects
          </Button>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {project.name}
              </h1>
              {/* Project status — set manually by an admin (organizational only) */}
              <div className="relative">
                <Badge
                  variant="outline"
                  className={`${statusColors[project.status] || ''} pr-6`}
                >
                  {project.status}
                </Badge>
                <select
                  aria-label="Project status"
                  value={project.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  title="Change project status"
                >
                  <option value="SETUP">SETUP</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="COMPLETE">COMPLETE</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
            {totalItems > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/evaluate/${projectId}`)}
              >
                <Eye className="mr-2 h-3.5 w-3.5" />
                Preview Annotator View
              </Button>
            )}
          </div>
          {project.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => {
          setActiveTab(v)
          if (v === 'batches') fetchBatches()
        }}>
          {/* Mobile-only tab list (sidebar handles desktop nav) */}
          <TabsList className="lg:hidden">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="evaluators">Annotators</TabsTrigger>
            <TabsTrigger value="teams">Teams</TabsTrigger>
            <TabsTrigger value="batches">Batches</TabsTrigger>
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="rubric">Rubric</TabsTrigger>
            <TabsTrigger value="export">Data</TabsTrigger>
          </TabsList>

          {/* ============== OVERVIEW TAB ============== */}
          <TabsContent value="overview" className="mt-6">
            <OverviewTab
              project={project}
              scoredItemCount={scoredItemCount}
              evaluators={evaluators}
              batches={batches}
              projectId={projectId}
              onNavigateToTab={(tab) => {
                setActiveTab(tab)
                if (tab === 'batches') fetchBatches()
              }}
              onImportData={() => router.push(`/admin/${projectId}/import`)}
              usePseudonyms={project.usePseudonyms}
              onTogglePseudonyms={handleTogglePseudonyms}
            />
          </TabsContent>

          {/* ============== ANNOTATORS TAB ============== */}
          <TabsContent value="evaluators" className="mt-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-semibold">Annotators</h2>
                <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5 text-xs">
                  {(['week', 'month', 'all'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setTimePeriod(p)}
                      className={`px-2.5 py-1 rounded transition-colors ${
                        timePeriod === p
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {p === 'week' ? 'This week' : p === 'month' ? 'This month' : 'All time'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                {project.studyflowStudyId && (
                  <ImportEvaluatorsDialog
                    projectId={projectId}
                    onImported={() => { fetchEvaluators(); fetchProject() }}
                  />
                )}
                <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                  <DialogTrigger render={<Button />}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Annotator
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Annotator</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleAddEvaluator} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="eval-email">Email</Label>
                        <Input
                          id="eval-email"
                          type="email"
                          value={evalEmail}
                          onChange={(e) => setEvalEmail(e.target.value)}
                          placeholder="annotator@example.com"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="eval-name">Name (optional)</Label>
                        <Input
                          id="eval-name"
                          value={evalName}
                          onChange={(e) => setEvalName(e.target.value)}
                          placeholder="Jane Doe"
                        />
                      </div>
                      {teams.length > 0 && (
                        <div className="space-y-2">
                          <Label>Team (optional)</Label>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setEvalInitialTeamId('')}
                              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-all duration-200 ${
                                evalInitialTeamId === ''
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-background text-foreground border-border hover:border-primary/40'
                              }`}
                            >
                              No team
                            </button>
                            {teams.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => setEvalInitialTeamId(t.id)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-all duration-200 ${
                                  evalInitialTeamId === t.id
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-background text-foreground border-border hover:border-primary/40'
                                }`}
                              >
                                {t.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        An invitation email will be sent so they can set their own password.
                      </p>
                      {evalError && (
                        <p className="text-sm text-destructive">{evalError}</p>
                      )}
                      {evalSuccess && (
                        <p className="text-sm text-success">{evalSuccess}</p>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setAddDialogOpen(false)
                            setEvalError('')
                            setEvalSuccess('')
                            setEvalInitialTeamId('')
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={addingEvaluator || !evalEmail}
                        >
                          {addingEvaluator ? (
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
            </div>

            {evaluators.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No annotators assigned to this project yet.
              </div>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Annotator</TableHead>
                      <TableHead className="max-w-[10rem]">Email</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead className="text-right w-20">Assigned</TableHead>
                      <TableHead className="text-right w-20">Completed</TableHead>
                      <TableHead className="w-28">Progress</TableHead>
                      <TableHead className="text-right w-24 whitespace-nowrap">Time</TableHead>
                      <TableHead className="pr-5 whitespace-nowrap">Last Active</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {evaluators.map((ev) => {
                      const pct = ev.assignedCount > 0
                        ? Math.round((ev.completedCount / ev.assignedCount) * 100)
                        : 0
                      const low = pct < 50 && ev.assignedCount > 0
                      const lastActive = ev.lastScoredAt
                        ? formatRelativeTime(ev.lastScoredAt)
                        : 'Never'
                      return (
                        <TableRow key={ev.id} className="group/row hover:bg-muted/30 transition-colors">
                          <TableCell className="pl-5">
                            <div className="flex items-center gap-2.5">
                              <UserAvatar name={ev.user.id} size={28} />
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium text-foreground">{displayAnnotatorName(ev.user.id, ev.user.name, project.usePseudonyms)}</p>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const newRole = ev.role === 'PROJECT_ADMIN' ? 'EVALUATOR' : 'PROJECT_ADMIN'
                                    try {
                                      const res = await fetch(
                                        `/api/projects/${projectId}/evaluators/${ev.user.id}/role`,
                                        {
                                          method: 'PATCH',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ role: newRole }),
                                        }
                                      )
                                      if (res.ok) {
                                        setEvaluators((prev) =>
                                          prev.map((e) =>
                                            e.id === ev.id ? { ...e, role: newRole } : e
                                          )
                                        )
                                      }
                                    } catch {
                                      // silently fail
                                    }
                                  }}
                                  className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                                    ev.role === 'PROJECT_ADMIN'
                                      ? 'bg-primary/10 text-primary hover:bg-primary/20'
                                      : 'bg-muted text-muted-foreground hover:bg-muted/80 opacity-0 group-hover/row:opacity-100'
                                  }`}
                                  title={ev.role === 'PROJECT_ADMIN' ? 'Click to remove project admin' : 'Click to make project admin'}
                                >
                                  {ev.role === 'PROJECT_ADMIN' ? 'Admin' : 'Make Admin'}
                                </button>
                              </div>
                              {low && <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[10rem] truncate" title={ev.user.email}>{ev.user.email}</TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => {
                                setTeamPickerError('')
                                setTeamPickerUser(ev)
                              }}
                              className="text-xs px-2 py-1 rounded-md border border-border bg-background hover:border-primary/40 hover:bg-muted/40 transition-all duration-200 text-foreground"
                            >
                              {ev.team ? ev.team.name : (
                                <span className="text-muted-foreground">Assign team</span>
                              )}
                            </button>
                          </TableCell>
                          <TableCell className="text-right text-sm">{ev.assignedCount}</TableCell>
                          <TableCell className="text-right text-sm">{ev.completedCount}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 min-w-28">
                              <Progress
                                value={pct}
                                className={`h-1.5 flex-1 ${low ? '[&>div]:bg-destructive' : ''}`}
                              />
                              <span className={`text-xs font-medium w-8 text-right shrink-0 ${low ? 'text-destructive' : 'text-muted-foreground'}`}>
                                {pct}%
                              </span>
                            </div>
                          </TableCell>
                          {(() => {
                            const t = timeData.get(ev.user.id)
                            const annotation = t?.annotationSeconds ?? 0
                            const other = t?.otherSeconds ?? 0
                            return (
                              <TableCell
                                className="text-right text-xs tabular-nums whitespace-nowrap text-muted-foreground"
                                title={`Annotating: ${formatDuration(annotation)} · Other: ${formatDuration(other)}`}
                              >
                                {formatDuration(annotation + other)}
                              </TableCell>
                            )
                          })()}
                          <TableCell className="pr-5 text-xs text-muted-foreground whitespace-nowrap">{lastActive}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>

          {/* ============== TEAMS TAB ============== */}
          <TabsContent value="teams" className="mt-6">
            <TeamManagement
              projectId={projectId}
              evaluators={evaluators.map((ev) => ({
                userId: ev.user.id,
                user: ev.user,
              }))}
              rubricDimensions={project.rubric.map((d) => ({
                id: d.id,
                key: d.key,
                label: d.label,
                sortOrder: d.sortOrder,
              }))}
              usePseudonyms={project.usePseudonyms}
            />
          </TabsContent>

          {/* ============== BATCHES TAB ============== */}
          <TabsContent value="batches" className="mt-6">
            <BatchCreator
              projectId={projectId}
              evaluators={evaluators.map((ev) => ({
                userId: ev.user.id,
                user: ev.user,
              }))}
              batches={batches}
              onBatchesChange={fetchBatches}
              batchesLoading={batchesLoading}
              usePseudonyms={project.usePseudonyms}
            />
          </TabsContent>

          {/* ============== ITEMS TAB ============== */}
          <TabsContent value="items" className="mt-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Feedback Items</h2>
              <p className="text-sm text-muted-foreground">
                All feedback items in this project and their batch assignment.
              </p>
            </div>
            <FeedbackItemsTab
              projectId={projectId}
              initialData={initialFeedbackItemsData}
            />
          </TabsContent>

          {/* ============== RUBRIC TAB ============== */}
          <TabsContent value="rubric" className="mt-6 space-y-4">
            <h2 className="text-lg font-semibold">Rubric Criteria</h2>
            <p className="text-sm text-muted-foreground">
              The scoring rubric applied to each feedback item. Editing is not
              available in this version.
            </p>

            {project.rubric.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No rubric criteria configured.
              </div>
            ) : (
              <div className="space-y-4">
                {project.rubric.map((dim) => {
                  const labels = parseScoreLabels(dim.scoreLabelJson)
                  return (
                    <Card key={dim.id}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">{dim.label}</CardTitle>
                        {dim.description && (
                          <CardDescription>{dim.description}</CardDescription>
                        )}
                      </CardHeader>
                      <CardContent>
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          Options
                        </p>
                        {Object.keys(labels).length > 0 && (
                          <div className="space-y-1">
                            {Object.entries(labels).map(([, info]) => (
                              <div
                                key={info.label}
                                className="flex items-start gap-2 text-sm"
                              >
                                <div>
                                  <span className="font-medium">
                                    {info.label}
                                  </span>
                                  {info.description && (
                                    <span className="text-muted-foreground">
                                      {' '}
                                      &mdash; {info.description}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* ============== EXPORT TAB ============== */}
          <TabsContent value="export" className="mt-6 space-y-8">

            {/* Import section */}
            <div>
              <h2 className="text-lg font-semibold">Import</h2>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Upload a CSV file to import feedback items into this project.
              </p>
              <Button
                variant="outline"
                onClick={() => router.push(`/admin/${projectId}/import`)}
              >
                <Upload className="mr-2 h-4 w-4" />
                Import Data
              </Button>
            </div>

            <div className="border-t border-border" />

            {/* Export section */}
            <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Export</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Download evaluation scores as CSV files for analysis.
              </p>
            </div>

            {/* Export filters */}
            {(() => {
              const expActivityIds = [...new Set(batches.map((b) => b.activityId).filter(Boolean) as string[])].sort()
              const expConjunctionIds = [...new Set(
                batches
                  .filter((b) => (exportActivity ? b.activityId === exportActivity : true))
                  .map((b) => b.conjunctionId)
                  .filter(Boolean) as string[]
              )].sort()
              return (
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">Filter:</span>
                  <select
                    className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors"
                    value={exportActivity}
                    onChange={(e) => {
                      setExportActivity(e.target.value)
                      setExportConjunction('')
                    }}
                  >
                    <option value="">All activities</option>
                    {expActivityIds.map((id) => (
                      <option key={id} value={id}>Activity {id}</option>
                    ))}
                  </select>
                  <select
                    className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors"
                    value={exportConjunction}
                    onChange={(e) => setExportConjunction(e.target.value)}
                  >
                    <option value="">All conjunctions</option>
                    {expConjunctionIds.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                  {(exportActivity || exportConjunction) && (
                    <button
                      onClick={() => { setExportActivity(''); setExportConjunction('') }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )
            })()}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Original Scores</CardTitle>
                  <CardDescription>
                    Raw scores from each evaluator, one row per evaluator per
                    feedback item.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="mb-4 text-xs text-muted-foreground">
                    Columns: feedback_ID, evaluator_email,{' '}
                    {project.rubric.map((d) => d.label).join(', ')}, notes,
                    feedback_source, timestamp
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleExport('original')}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Original CSV
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Reconciled Scores
                  </CardTitle>
                  <CardDescription>
                    The final score for every item: the reconciled/adjudicated
                    value for double-scored batches, plus the single score for
                    independent batches.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="mb-4 text-xs text-muted-foreground">
                    Columns: feedback_ID, evaluator_email,{' '}
                    {project.rubric.map((d) => d.label).join(', ')}, notes,
                    feedback_source, timestamp
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => handleExport('reconciled')}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export Reconciled CSV
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Discrepancy Report
                  </CardTitle>
                  <CardDescription>
                    Pre-reconciliation report of all scoring differences between evaluators.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="mb-4 text-xs text-muted-foreground">
                    Columns: feedback_ID, dimension, evaluator_A_score,
                    evaluator_B_score, difference
                  </p>
                  {(() => {
                    const reconcilingBatches = batches.filter(
                      (b) => b.status === 'RECONCILING' || b.status === 'COMPLETE'
                    )
                    if (reconcilingBatches.length === 0) {
                      return (
                        <p className="text-xs text-muted-foreground italic">
                          No batches in reconciliation or complete status.
                        </p>
                      )
                    }
                    return (
                      <div className="flex flex-col gap-3">
                        <select
                          className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors"
                          value={discrepancyBatchId}
                          onChange={(e) => setDiscrepancyBatchId(e.target.value)}
                        >
                          <option value="">Select batch...</option>
                          {reconcilingBatches.map((b) => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                        <Button
                          variant="outline"
                          disabled={!discrepancyBatchId}
                          onClick={() => {
                            const params = new URLSearchParams({ projectId, type: 'discrepancies', batchId: discrepancyBatchId })
                            window.open(`/api/export?${params.toString()}`, '_blank')
                          }}
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Export Discrepancies CSV
                        </Button>
                      </div>
                    )
                  })()}
                </CardContent>
              </Card>
            </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* ============== TEAM PICKER DIALOG ============== */}
      <Dialog
        open={teamPickerUser !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTeamPickerUser(null)
            setTeamPickerError('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Assign team
              {teamPickerUser && (
                <span className="block text-sm font-normal text-muted-foreground mt-1">
                  {displayAnnotatorName(teamPickerUser.user.id, teamPickerUser.user.name, project.usePseudonyms)} · {teamPickerUser.user.email}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No teams yet. Create a team in the Teams tab first.
            </p>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                disabled={teamPickerSaving}
                onClick={() => teamPickerUser && handleSetTeam(teamPickerUser.user.id, null)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border transition-all duration-200 ${
                  teamPickerUser?.team === null
                    ? 'bg-primary/5 border-primary/40'
                    : 'bg-background border-border hover:border-primary/40 hover:bg-muted/40'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className="text-sm font-medium text-foreground">No team</span>
                {teamPickerUser?.team === null && (
                  <CheckCircle className="h-4 w-4 text-primary" />
                )}
              </button>
              {teams.map((t) => {
                const selected = teamPickerUser?.team?.id === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={teamPickerSaving}
                    onClick={() => teamPickerUser && handleSetTeam(teamPickerUser.user.id, t.id)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border transition-all duration-200 ${
                      selected
                        ? 'bg-primary/5 border-primary/40'
                        : 'bg-background border-border hover:border-primary/40 hover:bg-muted/40'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="text-sm font-medium text-foreground">
                      {t.name}
                    </span>
                    {selected && <CheckCircle className="h-4 w-4 text-primary" />}
                  </button>
                )
              })}
            </div>
          )}
          {teamPickerError && (
            <p className="text-sm text-destructive mt-2">{teamPickerError}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Each annotator can only be on one team per project. Switching teams is blocked once they have scored items on the involved dimensions.
          </p>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={teamPickerSaving}
              onClick={() => {
                setTeamPickerUser(null)
                setTeamPickerError('')
              }}
            >
              {teamPickerSaving ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                'Close'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
