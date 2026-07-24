/**
 * Database seed entrypoint.
 *
 * `seedAdmin(db, username, password)` is exported so both the production
 * `prisma db seed` entrypoint and the e2e test setup can call it with the
 * appropriate credentials:
 *  - Production reads `ADMIN_SEED_USERNAME` / `ADMIN_SEED_PASSWORD` from env
 *    and fails fast (throws) when either is missing — never silently skipping
 *    the bootstrap admin.
 *  - The e2e harness calls `seedAdmin` directly with test credentials, so no
 *    env var is required to run tests.
 */
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { fileURLToPath } from 'node:url';

/**
 * True when this file is the process entrypoint (i.e. invoked as
 * `node prisma/seed.ts` directly), as opposed to being imported by the e2e
 * test harness. Uses `import.meta.url` so the check works under both ESM and
 * `node --experimental-strip-types` (CommonJS `require.main` is unavailable
 * once the loader treats the file as an ES module).
 */
function isMainEntry(): boolean {
  if (typeof process === 'undefined' || process.argv.length < 2) return false;
  const entry = process.argv[1];
  try {
    return entry === fileURLToPath(import.meta.url);
  } catch {
    return entry === import.meta.url;
  }
}

export interface SeedAdminDeps {
  /** Prisma client (or PrismaService in app context). */
  db: Pick<PrismaClient, 'adminUser'>;
  username: string;
  password: string;
}

/**
 * Idempotently upsert the bootstrap admin: if the username already exists,
 * only the password hash (and not the status/lockout counters) is refreshed,
 * so re-running the seed cannot silently re-enable a locked/disabled admin.
 */
export async function seedAdmin({
  db,
  username,
  password,
}: SeedAdminDeps): Promise<{ id: string; username: string }> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await db.adminUser.upsert({
    where: { username },
    create: { username, passwordHash, status: 'ACTIVE' },
    // On update we only refresh the password — leave status/lockout/version
    // alone so an operator who disabled the account isn't undone by a re-seed.
    update: { passwordHash },
    select: { id: true, username: true },
  });
  return admin;
}

/**
 * Production seed entrypoint. Reads credentials from the environment; throws
 * synchronously if either is absent so `prisma db seed` exits non-zero rather
 * than silently leaving the system without a loginable admin.
 */
async function main(): Promise<void> {
  const username = process.env.ADMIN_SEED_USERNAME;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'ADMIN_SEED_USERNAME and ADMIN_SEED_PASSWORD must be set to seed the bootstrap admin',
    );
  }
  const db = new PrismaClient();
  try {
    const admin = await seedAdmin({ db, username, password });
    // eslint-disable-next-line no-console
    console.log(`Seeded admin '${admin.username}' (${admin.id})`);
  } finally {
    await db.$disconnect();
  }
}

// Skip auto-run during test/import; only execute when invoked directly.
if (isMainEntry()) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
