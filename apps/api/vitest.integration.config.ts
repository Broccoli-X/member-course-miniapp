import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration-spec.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Integration specs share a single physical MySQL test DB and each
    // truncates a different subset of tables in beforeEach. Running them in
    // parallel would have one file's truncate drop another file's in-flight
    // rows (and break FK chains). Force files to run one at a time so each
    // spec owns the DB for the duration of its run — mirroring the e2e config.
    fileParallelism: false,
  },
});
