import { prisma } from '@/lib/db'
import { createToken } from '@/lib/tokens'
import { sendResetEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { email } = await request.json()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const normalizedEmail = email.trim().toLowerCase()

  // Always return success to prevent email enumeration. A server failure (DB
  // down, email provider error) returns 503 whether or not the account exists,
  // so it reveals nothing — but it stops the page from claiming a link was sent.
  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } })

    if (user) {
      const token = await createToken(normalizedEmail, 'RESET')
      await sendResetEmail(normalizedEmail, token)
    }
  } catch (error) {
    console.error('[reset-password] failed to send reset link', error)
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 })
  }

  return NextResponse.json({ success: true })
}
