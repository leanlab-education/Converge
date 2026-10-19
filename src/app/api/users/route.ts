import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parseEmail } from '@/lib/email-address'
import { Role } from '@/generated/prisma/client'
import { hash } from 'bcryptjs'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json(users)
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { name, password, role } = body

  if (!body.email || !password) {
    return NextResponse.json(
      { error: 'Email and password are required' },
      { status: 400 }
    )
  }

  // Store the address lowercased like every other writer. Sign-in and password
  // reset lowercase before looking the account up, so one created with the
  // casing as typed could never sign in or reset.
  const email = parseEmail(body.email)
  if (!email) {
    return NextResponse.json(
      { error: 'Enter a valid email address' },
      { status: 400 }
    )
  }

  // Check for existing user
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json(
      { error: 'A user with this email already exists' },
      { status: 409 }
    )
  }

  const hashedPassword = await hash(password, 12)

  const userRole: Role =
    role === 'ADMIN' ? Role.ADMIN : Role.EVALUATOR

  const user = await prisma.user.create({
    data: {
      email,
      name: name || null,
      hashedPassword,
      role: userRole,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  })

  return NextResponse.json(user, { status: 201 })
}
