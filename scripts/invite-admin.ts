import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { randomBytes } from 'crypto'
import { assertNotProduction, positionalArgs } from './_guard.js'

const [email, name = null] = positionalArgs()

if (!email) {
  console.error('Usage: npx tsx scripts/invite-admin.ts <email> [name] [--allow-prod]')
  process.exit(1)
}

async function main() {
  // Inviting a global admin to production is a legitimate use — but only on
  // purpose: --allow-prod plus typing the host name back.
  await assertNotProduction('invite-admin')

  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })

  const normalized = email.trim().toLowerCase()

  let user = await prisma.user.findUnique({ where: { email: normalized } })

  if (user?.hashedPassword) {
    console.log(`User ${normalized} already has an account (role: ${user.role}).`)
    await prisma.$disconnect()
    return
  }

  if (!user) {
    user = await prisma.user.create({
      data: { email: normalized, name, role: 'ADMIN' },
    })
    console.log(`Created ADMIN user: ${normalized}`)
  } else {
    await prisma.user.update({
      where: { email: normalized },
      data: { role: 'ADMIN' },
    })
    console.log(`Updated ${normalized} to ADMIN role`)
  }

  // Create invite token
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)

  await prisma.authToken.updateMany({
    where: { email: normalized, type: 'INVITE', usedAt: null },
    data: { usedAt: new Date() },
  })

  await prisma.authToken.create({
    data: { email: normalized, token, type: 'INVITE', expiresAt },
  })

  const appUrl = process.env.APP_URL || 'https://writing-evaluator.vercel.app'
  console.log(`\nInvite link (expires in 72h):\n${appUrl}/invite/${token}`)

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
