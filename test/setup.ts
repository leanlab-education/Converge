// Global test setup.
//
// Many lib modules import `@/lib/db`, which constructs a Prisma client from
// DATABASE_URL at import time (lazily — it does not connect until a query is
// run). Unit tests exercise pure functions only, so a dummy connection string
// lets those modules import without a real database. Integration tests that
// actually query the DB set a real DATABASE_URL (via doppler) and run in a
// separate suite.
process.env.DATABASE_URL ||=
  'postgresql://test:test@localhost:5432/writing_evaluator_test'
process.env.AUTH_SECRET ||= 'test-secret-not-used-for-real-auth'
process.env.STUDYFLOW_LINK_SECRET ||= 'test-studyflow-secret'
process.env.APP_URL ||= 'http://localhost:3333'
