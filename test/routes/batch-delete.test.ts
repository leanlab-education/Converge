// Mocks must be registered BEFORE the route under test is imported.
import { signInAs } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from '@/app/api/projects/[projectId]/batches/[batchId]/route'

function deleteBatch(projectId = 'p1', batchId = 'b1') {
  return DELETE(
    new NextRequest(
      `http://localhost/api/projects/${projectId}/batches/${batchId}`,
      { method: 'DELETE' }
    ),
    { params: Promise.resolve({ projectId, batchId }) }
  )
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  prismaMock.$transaction.mockImplementation(((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.resolve(arg)) as never)
  prismaMock.batch.findUnique.mockResolvedValue({
    status: 'DRAFT',
    projectId: 'p1',
  } as never)
  prismaMock.score.count.mockResolvedValue(0)
  prismaMock.feedbackItem.updateMany.mockResolvedValue({ count: 45 } as never)
  prismaMock.batch.delete.mockResolvedValue({ id: 'b1' } as never)
})

describe('DELETE /api/projects/[projectId]/batches/[batchId]', () => {
  it('refuses with 409 when the DRAFT batch still has scores (unpublished after scoring)', async () => {
    prismaMock.score.count.mockResolvedValue(90)

    const res = await deleteBatch()

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error:
        'This batch has 90 recorded scores. Deleting it would orphan annotation data. Leave it unpublished instead.',
    })
    expect(prismaMock.score.count).toHaveBeenCalledWith({
      where: { feedbackItem: { batchId: 'b1' } },
    })
    expect(prismaMock.batch.delete).not.toHaveBeenCalled()
    expect(prismaMock.feedbackItem.updateMany).not.toHaveBeenCalled()
  })

  it('uses the singular for a single score', async () => {
    prismaMock.score.count.mockResolvedValue(1)

    const res = await deleteBatch()

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('This batch has 1 recorded score.')
  })

  it('still refuses non-DRAFT batches with 400 before counting scores', async () => {
    prismaMock.batch.findUnique.mockResolvedValue({
      status: 'SCORING',
      projectId: 'p1',
    } as never)

    const res = await deleteBatch()

    expect(res.status).toBe(400)
    expect(prismaMock.score.count).not.toHaveBeenCalled()
    expect(prismaMock.batch.delete).not.toHaveBeenCalled()
  })

  it("clears the items' slotIndex and displayOrder in the same transaction as the delete", async () => {
    const res = await deleteBatch()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    // Reset while batchId is still set (the FK SetNull detaches the items on
    // delete), so the next batch over them gets a fresh shuffle.
    expect(prismaMock.feedbackItem.updateMany).toHaveBeenCalledWith({
      where: { batchId: 'b1' },
      data: { slotIndex: null, displayOrder: null },
    })
    expect(prismaMock.batch.delete).toHaveBeenCalledWith({ where: { id: 'b1' } })
    const resetOrder = prismaMock.feedbackItem.updateMany.mock.invocationCallOrder[0]
    const deleteOrder = prismaMock.batch.delete.mock.invocationCallOrder[0]
    expect(resetOrder).toBeLessThan(deleteOrder)

    // Both operations go through one batched transaction.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const txArg = prismaMock.$transaction.mock.calls[0][0] as unknown
    expect(Array.isArray(txArg)).toBe(true)
    expect((txArg as unknown[]).length).toBe(2)
  })

  it('404s for a batch in another project', async () => {
    prismaMock.batch.findUnique.mockResolvedValue({
      status: 'DRAFT',
      projectId: 'other',
    } as never)

    expect((await deleteBatch()).status).toBe(404)
    expect(prismaMock.batch.delete).not.toHaveBeenCalled()
  })
})
