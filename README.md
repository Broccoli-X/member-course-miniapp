# member-course-miniapp

Member + lesson-hour asset management for a single institution / campus (2C).
A pnpm monorepo with three apps sharing a contracts package:

- `apps/api` — NestJS 11 + Prisma 6 + MySQL 8.4 (admin auth, mini-program WeChat
  auth + phone binding, member/student CRUD, course/package catalog, offline
  order lifecycle, manual hour adjustments, hour ledger, member asset queries).
- `apps/admin-web` — Vue 3 + Vite + Element Plus + Pinia administrator console.
- `apps/miniapp` — native WeChat mini program (member self-service + assets).
- `packages/contracts` — framework-free TypeScript contracts shared across apps.

Money and lesson hours are `DECIMAL(10,2)` (HTTP carries them as 2-dp strings);
lesson-hour balances change only through append-only postings + allocations.

## Prerequisites

- Node.js >= 22.14
- pnpm 11 (`corepack enable`)
- MySQL 8.4 reachable locally for the integration / e2e suites

## Install

```bash
pnpm install
pnpm --filter @member-course/api prisma generate --schema apps/api/prisma/schema.prisma
```

## Run the M1 verification gate locally

The M1 acceptance gate is a closed-loop end-to-end journey plus a concurrency
suite plus an admin-web browser flow. All run against a real MySQL instance
(no Testcontainers).

1. Start MySQL 8.4 and create the test database:

   ```bash
   mysql -h 127.0.0.1 -u root -e "CREATE DATABASE IF NOT EXISTS member_course_test;"
   ```

2. Apply migrations + generate the Prisma client:

   ```bash
   pnpm --filter @member-course/api prisma migrate deploy --schema apps/api/prisma/schema.prisma
   pnpm --filter @member-course/api prisma generate --schema apps/api/prisma/schema.prisma
   ```

3. Run the full gate:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test                                    # unit tests, all workspaces
   pnpm test:integration                        # API integration (real MySQL)
   pnpm test:e2e                                # API end-to-end journey (real MySQL)
   pnpm build
   pnpm --filter @member-course/api prisma validate --schema apps/api/prisma/schema.prisma
   ```

   Each command must exit 0. `git status --short` should be empty afterwards.

### Running the suites without `pnpm --filter` (non-interactive shells)

Some shells trip pnpm's `verifyDepsBeforeRun` guard. In that case invoke the
binaries directly:

```bash
# API integration (real MySQL):
cd apps/api && RUN_INTEGRATION=1 \
  TEST_DATABASE_URL=mysql://root@127.0.0.1:3306/member_course_test \
  node ../../node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts --reporter=verbose

# API e2e journey (real MySQL):
cd apps/api && TEST_DATABASE_URL=mysql://root@127.0.0.1:3306/member_course_test \
  node ../../node_modules/vitest/vitest.mjs run \
  --config vitest.e2e.config.ts --reporter=verbose

# admin-web Playwright (needs the API + Vite dev server running):
cd apps/admin-web && node node_modules/@playwright/test/cli.js test
```

## admin-web Playwright e2e

The admin-web browser suite drives the SPA against the live API + MySQL. It
needs:

- The API running on `http://localhost:3000` (`pnpm --filter @member-course/api start`).
- The bootstrap admin seeded (`ADMIN_SEED_USERNAME=admin ADMIN_SEED_PASSWORD=Admin@123456 pnpm --filter @member-course/api prisma db seed`).
- The Playwright chromium browser installed
  (`pnpm --filter @member-course/admin-web exec playwright install chromium`).

Then:

```bash
pnpm --filter @member-course/admin-web test:e2e
```

The login + order-flow tests self-skip when the API is not reachable, so the
SPA-router redirect test still runs in any environment.

## CI

`.github/workflows/ci.yml` runs the full M1 gate on every push / pull request
against a MySQL 8.4 service container. The workflow:

1. Starts `mysql:8.4` as a service container with an empty root password.
2. Applies `prisma migrate deploy` + `prisma generate` + `prisma validate`.
3. Runs `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `build`.
4. Installs the Playwright chromium browser, starts the API, seeds the admin,
   and runs `pnpm --filter @member-course/admin-web test:e2e`.
5. Finishes with `git diff --check` (whitespace / conflict-marker guard).

Every step must exit 0 for the gate to pass.

## Layout

```
apps/
  api/            NestJS API (Prisma schema + migrations under prisma/)
  admin-web/      Vue 3 admin console (Playwright e2e under e2e/)
  miniapp/        native WeChat mini program
packages/
  contracts/      shared TypeScript contracts
.github/workflows/ci.yml   M1 verification CI gate
```
