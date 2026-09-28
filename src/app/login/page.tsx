'use client'

import { Suspense } from 'react'
import { signIn } from 'next-auth/react'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import {
  PASSWORD_SIGN_IN_MESSAGES,
  STUDYFLOW_SIGN_IN_MESSAGES,
  classifySignInFailure,
  isSignInFailure,
} from '@/lib/auth-errors'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const studyflowToken = searchParams.get('studyflow_token')
  const studyflowEmail = searchParams.get('email')
  const isStudyflowLaunch = !!(studyflowToken && studyflowEmail)
  // Set after a failed StudyFlow launch. Kept in the URL (not state) so a
  // refresh still shows the StudyFlow screen rather than the password form.
  const studyflowFailure = searchParams.get('studyflow')

  // StudyFlow magic link auto-login
  useEffect(() => {
    if (!studyflowToken || !studyflowEmail) return

    signIn('credentials', {
      email: studyflowEmail,
      studyflow_token: studyflowToken,
      redirect: false,
    })
      .then(classifySignInFailure, () => 'unavailable' as const)
      .then((failure) => {
        // Replace (not push) so the token URL is removed from browser history
        // and can't be reused.
        router.replace(failure ? `/login?studyflow=${failure}` : '/')
      })
  }, [studyflowToken, studyflowEmail, router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })

      const failure = classifySignInFailure(result)
      if (failure) {
        setError(PASSWORD_SIGN_IN_MESSAGES[failure])
      } else {
        router.push('/')
      }
    } catch {
      setError(PASSWORD_SIGN_IN_MESSAGES.unavailable)
    } finally {
      setLoading(false)
    }
  }

  if (isStudyflowLaunch) {
    return (
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Signing in from StudyFlow...</p>
      </div>
    )
  }

  // StudyFlow annotators have no password here, so a failed launch gets its
  // own screen with no password form or reset link — only "go back to
  // StudyFlow", which mints a fresh link.
  if (isSignInFailure(studyflowFailure)) {
    return (
      <Card className="w-full max-w-md shadow-lg text-center">
        <CardHeader>
          <CardTitle className="text-2xl">Couldn&apos;t sign you in</CardTitle>
          <CardDescription>{STUDYFLOW_SIGN_IN_MESSAGES[studyflowFailure]}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Writing Evaluator</CardTitle>
        <CardDescription>
          Sign in to access the evaluation dashboard
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
          <div className="text-center">
            <Link href="/reset-password" className="text-sm text-muted-foreground hover:text-foreground">
              Forgot your password?
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-primary/5 px-4">
      <Suspense
        fallback={
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  )
}
