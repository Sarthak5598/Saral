import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Unit tests stub the network; integration tests hit the Docker Postgres and
    // are kept serial so they cannot race each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      LOG_OUTPUT: 'json',
      // Placeholders so lib/env validation passes without a real .env in CI.
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/hashtag_media',
      META_ACCESS_TOKEN: 'test-token',
      META_IG_USER_ID: '17841480695597364',
    },
  },
});
