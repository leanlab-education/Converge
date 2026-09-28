import { Resend } from 'resend'

const FROM_EMAIL = 'Writing Evaluator <noreply@leanlabeducation.org>'

let _resend: Resend | null = null
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

function getAppUrl() {
  return process.env.APP_URL || 'https://writing-evaluator.vercel.app'
}

type InviteVariant = 'annotator' | 'admin' | 'project-admin'

export async function sendInviteEmail(
  email: string,
  token: string,
  name?: string | null,
  variant: InviteVariant = 'annotator',
  projectName?: string | null
) {
  const url = `${getAppUrl()}/invite/${token}`
  const greeting = name ? `Hi ${name},` : 'Hi,'

  let intro: string
  if (variant === 'admin') {
    intro = `You've been given admin access to Writing Evaluator. Click below to set your password and get started.`
  } else if (variant === 'project-admin') {
    const project = projectName ? `a test project ("${projectName}")` : 'a test project'
    intro = `You've been given admin access to ${project} in Writing Evaluator. Click below to set your password and get started.`
  } else {
    intro = `You've been invited to join Writing Evaluator as an annotator. Click below to set your password and get started.`
  }

  await getResend().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'You\'ve been invited to Writing Evaluator',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Writing Evaluator</h2>
        <p>${greeting}</p>
        <p>${intro}</p>
        <p style="margin: 24px 0;">
          <a href="${url}" style="background: #5b21b6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">
            Set Your Password
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">This link expires in 7 days.</p>
      </div>
    `,
  })
}

export async function sendResetEmail(email: string, token: string) {
  const url = `${getAppUrl()}/reset-password/${token}`

  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Reset your password — Writing Evaluator',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Writing Evaluator</h2>
        <p>We received a request to reset your password. Click the link below to set a new password.</p>
        <p style="margin: 24px 0;">
          <a href="${url}" style="background: #5b21b6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">
            Reset Password
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  })

  // Resend reports failures in the result rather than throwing.
  if (error) throw new Error(`Resend failed to send reset email: ${error.message}`)
}
