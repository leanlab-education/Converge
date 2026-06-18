import { vi, beforeEach } from 'vitest'
import { mockDeep, mockReset, type DeepMockProxy } from 'vitest-mock-extended'
import type { PrismaClient } from '@/generated/prisma/client'

// Deep mock of the Prisma client. Import this module FIRST in any DB-bound
// test (before the module under test) so the vi.mock below is registered
// before @/lib/db is resolved. Set query return values per test, e.g.:
//   prismaMock.score.findMany.mockResolvedValue([...])
export const prismaMock = mockDeep<PrismaClient>()

vi.mock('@/lib/db', () => ({ prisma: prismaMock }))

beforeEach(() => {
  mockReset(prismaMock)
})

export type PrismaMock = DeepMockProxy<PrismaClient>
