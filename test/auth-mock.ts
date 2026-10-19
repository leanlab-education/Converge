import { vi, beforeEach } from 'vitest'

// Mock of `@/lib/auth` for route-handler tests. Import this module BEFORE the
// route under test (and alongside ./prisma-mock) so the vi.mock below is
// registered before @/lib/auth is resolved — importing the real module would
// boot NextAuth. Set the session per test with `signInAs(...)`.
export const authMock = vi.fn()

vi.mock('@/lib/auth', () => ({ auth: authMock }))

export type TestSessionUser = {
  id: string
  role: 'ADMIN' | 'EVALUATOR'
  email?: string
}

export function signInAs(user: TestSessionUser) {
  authMock.mockResolvedValue({
    user: {
      id: user.id,
      role: user.role,
      email: user.email ?? `${user.id}@test.com`,
    },
  })
}

export function signedOut() {
  authMock.mockResolvedValue(null)
}

beforeEach(() => {
  authMock.mockReset()
})
