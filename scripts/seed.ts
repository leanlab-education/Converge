import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { hash } from 'bcryptjs'
import { assertNotProduction } from './_guard.js'

async function main() {
  // Test accounts never belong in production. The guard refuses the known
  // production host outright and asks for a typed host confirmation on any
  // other Neon host (preview branches).
  await assertNotProduction('seed', { neverProduction: true })

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  })
  const prisma = new PrismaClient({ adapter })

  // Create admin user
  const hashedPassword = await hash('admin123', 12)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@leanlab.org' },
    update: {},
    create: {
      email: 'admin@leanlab.org',
      name: 'Admin',
      hashedPassword,
      role: 'ADMIN',
    },
  })
  console.log('Admin user created:', admin.email)

  // Create a test evaluator
  const evalPassword = await hash('eval123', 12)
  const evaluator = await prisma.user.upsert({
    where: { email: 'evaluator@test.com' },
    update: {},
    create: {
      email: 'evaluator@test.com',
      name: 'Test Evaluator',
      hashedPassword: evalPassword,
      role: 'EVALUATOR',
    },
  })
  console.log('Evaluator user created:', evaluator.email)

  await prisma.$disconnect()
}

main().catch(console.error)
