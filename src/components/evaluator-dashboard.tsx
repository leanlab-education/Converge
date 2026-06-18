'use client'

import { useRouter } from 'next/navigation'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { FileText } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { MyTimeCard } from '@/components/my-time-card'

interface BatchInfo {
  id: string
  releaseId: string | null
  name: string
  status: string
  itemCount: number
  scoredCount: number
  discrepancyCount?: number
  reconciledCount?: number
}

interface TeamInfo {
  teamId: string
  teamName: string
  criteria: string[]
  partnerId: string | null
  partnerName: string | null
}

interface EvaluatorProject {
  id: string
  projectId: string
  project: {
    id: string
    name: string
    description: string | null
    status: string
    usePseudonyms: boolean
  }
  assignmentCount: number
  completedCount: number
  batches: BatchInfo[]
  team?: TeamInfo | null
}

export function EvaluatorDashboard({
  projects,
  userName,
}: {
  projects: EvaluatorProject[]
  userName: string
}) {
  const router = useRouter()

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">My Projects</h1>
          <p className="text-sm text-muted-foreground">
            Welcome, {userName}. Select a project to begin evaluating.
          </p>
        </div>

        <MyTimeCard />

        {projects.length === 0 ? (
          <div className="py-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">No projects assigned</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              You have not been assigned to any evaluation projects yet. Check
              back later or contact your project administrator.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {projects.map((ep) => {
              const pct =
                ep.assignmentCount > 0
                  ? Math.round(
                      (ep.completedCount / ep.assignmentCount) * 100
                    )
                  : 0
              const isComplete = pct === 100
              return (
                <Card
                  key={ep.id}
                  className="cursor-pointer transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10"
                  onClick={() => router.push(`/projects/${ep.project.id}`)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">
                        {ep.project.name}
                      </CardTitle>
                      <Badge
                        variant="outline"
                        className={
                          isComplete
                            ? 'bg-status-complete-bg text-status-complete-text'
                            : 'bg-status-active-bg text-status-active-text'
                        }
                      >
                        {isComplete ? 'Complete' : `${pct}%`}
                      </Badge>
                    </div>
                    {ep.project.description && (
                      <CardDescription>
                        {ep.project.description}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <Progress value={pct} />
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {ep.completedCount}/{ep.assignmentCount} scored
                      </span>
                    </div>
                    {ep.batches.length > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {ep.batches.filter(b => b.status === 'SCORING').length} batch{ep.batches.filter(b => b.status === 'SCORING').length !== 1 ? 'es' : ''} open
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}
