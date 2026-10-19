import NextAuth, { CredentialsSignin } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { prisma } from './db'
import { SERVICE_UNAVAILABLE_CODE } from './auth-errors'
import { normalizeEmail } from './email-address'
import { verifyStudyFlowToken } from './studyflow-token'
import { resolveCallbackUrl } from './callback-url'

// Thrown when sign-in fails for a reason that isn't the user's fault (e.g. the
// database is unreachable or over quota). Auth.js passes `code` through to the
// login page, which shows a "temporarily unavailable" message instead of
// "Invalid email or password".
class ServiceUnavailableSignin extends CredentialsSignin {
  code = SERVICE_UNAVAILABLE_CODE
}

type CredentialsInput = Partial<Record<'email' | 'password' | 'studyflow_token', unknown>>

// Returns the signed-in user, or null for bad credentials / an invalid link.
// Throws on infrastructure errors (DB down) — authorize() maps those to
// ServiceUnavailableSignin.
async function authorizeCredentials(credentials: CredentialsInput) {
  if (!credentials?.email) return null

  const email = normalizeEmail(credentials.email as string)

  // StudyFlow magic link flow
  if (credentials.studyflow_token) {
    const verified = await verifyStudyFlowToken(
      credentials.studyflow_token as string,
      email
    )
    if (!verified) return null

    // Find or create user. `verified.email` is the normalized address the
    // token was issued for — the same value `email` holds once normalized, and
    // the one every other writer stores.
    let user = await prisma.user.findUnique({ where: { email: verified.email } })
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: verified.email,
          name: verified.name || null,
          role: 'EVALUATOR',
        },
      })
    }

    // Auto-assign to project(s) linked to StudyFlow
    // Try direct project_id from JWT first, then fall back to all StudyFlow-linked projects
    if (verified.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: verified.projectId },
      })
      if (project) {
        await prisma.projectEvaluator.upsert({
          where: {
            projectId_userId: { projectId: project.id, userId: user.id },
          },
          create: { projectId: project.id, userId: user.id },
          update: {},
        })
      }
    } else if (verified.studyId) {
      // No project_id but has study_id — assign to projects linked to this specific study
      const studyflowProjects = await prisma.project.findMany({
        where: { studyflowStudyId: verified.studyId },
        select: { id: true },
      })
      for (const project of studyflowProjects) {
        await prisma.projectEvaluator.upsert({
          where: {
            projectId_userId: { projectId: project.id, userId: user.id },
          },
          create: { projectId: project.id, userId: user.id },
          update: {},
        })
      }
    }

    return { id: user.id, email: user.email, name: user.name, role: user.role }
  }

  // Standard password flow
  if (!credentials.password) return null

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user?.hashedPassword) return null

  const isValid = await compare(credentials.password as string, user.hashedPassword)
  if (!isValid) return null

  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        studyflow_token: { label: 'StudyFlow Token', type: 'text' },
      },
      async authorize(credentials) {
        try {
          return await authorizeCredentials(credentials)
        } catch (error) {
          console.error('[auth] sign-in failed with a server error', error)
          throw new ServiceUnavailableSignin()
        }
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user
      const { pathname, searchParams, origin } = request.nextUrl
      const isPublicPage =
        pathname === '/login' ||
        pathname.startsWith('/invite/') ||
        pathname.startsWith('/reset-password')

      // Public API routes that don't require authentication
      const isPublicApiRoute =
        pathname.startsWith('/api/auth/') ||
        pathname === '/api/invite/accept' ||
        pathname === '/api/reset-password' ||
        pathname === '/api/reset-password/accept' ||
        pathname.startsWith('/api/cron/')

      if (isPublicApiRoute) return true

      // Someone already signed in has no business on the login page: send them
      // on to where they were headed (Auth.js appends `callbackUrl` when it
      // bounces an unauthenticated request here), or home. The one exception
      // is a StudyFlow launch, which asserts who should be signed in — let the
      // login page complete it even if another account is signed in on this
      // browser (shared devices), and let its failure screen show.
      if (pathname === '/login' && isLoggedIn) {
        const isStudyFlowFlow =
          searchParams.has('studyflow_token') || searchParams.has('studyflow')
        if (!isStudyFlowFlow) {
          const target = resolveCallbackUrl(searchParams.get('callbackUrl'), origin)
          return Response.redirect(new URL(target, origin))
        }
      }
      if (!isLoggedIn && !isPublicPage) return false

      return true
    },
    jwt({ token, user }) {
      if (user) {
        token.role = (user as { role: string }).role
        token.id = user.id
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.role = token.role as string
        session.user.id = token.id as string
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
  },
})
