export { auth as proxy } from '@/lib/auth'

export const config = {
  // Run the auth check on every route except the Auth.js endpoints and static
  // assets. /login is deliberately included: the `authorized` callback in
  // auth.ts is what sends an already signed-in visitor on from the login page
  // (honoring Auth.js's `callbackUrl`), and that code can only run if the
  // proxy sees the request.
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
}
