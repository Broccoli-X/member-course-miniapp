import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * E2E config — kept separate from the default unit glob so a plain
 * `vitest run` (unit tests) never picks up the e2e specs. The e2e suite spins
 * up the full Nest app and hits a real MySQL test DB, hence the generous 60s
 * timeouts (argon2 hashing plus DB round-trips).
 *
 * SWC is used (instead of vitest's default esbuild loader) so that TypeScript
 * `experimentalDecorators` + `emitDecoratorMetadata` are honoured at runtime —
 * NestJS constructor-injection-by-type relies on `design:paramtypes` reflection
 * metadata which esbuild does not emit.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
