// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import {
  assertProjectDimensions,
  assertProjectMembers,
} from '@/lib/project-scope'

describe('assertProjectMembers', () => {
  it('passes an empty list without querying', async () => {
    await expect(assertProjectMembers('p1', [])).resolves.toEqual({ ok: true })
    expect(prismaMock.projectEvaluator.findMany).not.toHaveBeenCalled()
  })

  it('passes when every id has a ProjectEvaluator row on the project', async () => {
    prismaMock.projectEvaluator.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
    ] as never)

    await expect(assertProjectMembers('p1', ['u1', 'u2'])).resolves.toEqual({
      ok: true,
    })
    expect(prismaMock.projectEvaluator.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', userId: { in: ['u1', 'u2'] } },
      select: { userId: true },
    })
  })

  it('fails with a singular message when one id is from another project', async () => {
    prismaMock.projectEvaluator.findMany.mockResolvedValue([
      { userId: 'u1' },
    ] as never)

    const result = await assertProjectMembers('p1', ['u1', 'outsider'])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe(
      'One of the selected users is not an annotator on this project.'
    )
  })

  it('fails with a count when several ids are missing', async () => {
    prismaMock.projectEvaluator.findMany.mockResolvedValue([] as never)

    const result = await assertProjectMembers('p1', ['a', 'b', 'c'])
    expect(result).toEqual({
      ok: false,
      error: '3 of the selected users are not annotators on this project.',
    })
  })

  it('dedupes ids before comparing, so a repeated id is not counted as missing', async () => {
    prismaMock.projectEvaluator.findMany.mockResolvedValue([
      { userId: 'u1' },
    ] as never)

    await expect(assertProjectMembers('p1', ['u1', 'u1'])).resolves.toEqual({
      ok: true,
    })
    expect(prismaMock.projectEvaluator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p1', userId: { in: ['u1'] } },
      })
    )
  })
})

describe('assertProjectDimensions', () => {
  it('passes an empty list without querying', async () => {
    await expect(assertProjectDimensions('p1', [])).resolves.toEqual({
      ok: true,
    })
    expect(prismaMock.rubricDimension.count).not.toHaveBeenCalled()
  })

  it('passes when the project owns every dimension', async () => {
    prismaMock.rubricDimension.count.mockResolvedValue(2)

    await expect(assertProjectDimensions('p1', ['d1', 'd2'])).resolves.toEqual({
      ok: true,
    })
    expect(prismaMock.rubricDimension.count).toHaveBeenCalledWith({
      where: { projectId: 'p1', id: { in: ['d1', 'd2'] } },
    })
  })

  it("fails when a dimension belongs to another project's rubric", async () => {
    prismaMock.rubricDimension.count.mockResolvedValue(1)

    const result = await assertProjectDimensions('p1', ['d1', 'foreign'])
    expect(result).toEqual({
      ok: false,
      error:
        "One of the selected criteria is not part of this project's rubric.",
    })
  })

  it('reports how many are missing when more than one is', async () => {
    prismaMock.rubricDimension.count.mockResolvedValue(0)

    const result = await assertProjectDimensions('p1', ['x', 'y'])
    expect(result).toEqual({
      ok: false,
      error: "2 of the selected criteria are not part of this project's rubric.",
    })
  })

  it('dedupes ids so a repeated id does not inflate the expected count', async () => {
    prismaMock.rubricDimension.count.mockResolvedValue(1)

    await expect(assertProjectDimensions('p1', ['d1', 'd1'])).resolves.toEqual({
      ok: true,
    })
  })
})
