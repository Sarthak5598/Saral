import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration is read and validated exactly once, here, at boot.
 *
 * Two deliberate choices:
 *  - Parse failures crash the process immediately with a readable list of what
 *    is wrong. A pipeline that starts with a missing token and then silently
 *    logs "0 items synced" every 3 hours is the worst failure mode available.
 *  - Nothing else in the codebase reads process.env. Modules import `env`, so
 *    configuration is typed and the full surface is visible in one file.
 */

const driver = z.enum(['local', 'aws']);

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_PORT: z.coerce.number().int().positive().default(3000),
    APP_ROUTE_PREFIX: z.string().startsWith('/').default('/api/v1'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_OUTPUT: z.enum(['dev', 'json']).default('json'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    META_ACCESS_TOKEN: z.string().min(1, 'META_ACCESS_TOKEN is required'),
    META_IG_USER_ID: z.string().min(1),
    META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v24.0'),
    META_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),

    SYNC_MAX_MEDIA_PER_RUN: z.coerce.number().int().positive().max(10_000).default(500),
    // Meta caps these edges at 50 per page.
    SYNC_PAGE_SIZE: z.coerce.number().int().positive().max(50).default(25),
    DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),
    META_THROTTLE_THRESHOLD_PCT: z.coerce.number().int().min(1).max(100).default(80),
    /**
     * Generous by default because the hashtag edges are slow - measured at ~8s
     * per page against v24.0, with occasional stalls beyond 30s. A tight timeout
     * turns Meta's latency into spurious failures.
     */
    META_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

    QUEUE_DRIVER: driver.default('local'),
    STORAGE_DRIVER: driver.default('local'),
    SCHEDULER_DRIVER: driver.default('local'),

    LOCAL_STORAGE_DIR: z.string().default('./storage'),
    RECENT_SYNC_CRON: z.string().default('0 */3 * * *'),

    AWS_REGION: z.string().default('eu-west-2'),
    S3_BUCKET: z.string().optional(),
    SQS_QUEUE_URL: z.string().optional(),
    SQS_DLQ_URL: z.string().optional(),
    SQS_VISIBILITY_TIMEOUT: z.coerce.number().int().positive().default(300),
    SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
    EVENTBRIDGE_SCHEDULE_NAME: z.string().default('sync-recent-hashtag-media'),
    EVENTBRIDGE_SCHEDULE_ROLE_ARN: z.string().optional(),

    METRICS_ENABLED: booleanish.default('true'),
  })
  // Driver-specific settings are optional in general but required once that
  // driver is actually selected. Catching this at boot rather than on the first
  // job means a misconfigured deploy fails loudly and instantly.
  .superRefine((value, ctx) => {
    if (value.STORAGE_DRIVER === 'aws' && !value.S3_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BUCKET'],
        message: 'S3_BUCKET is required when STORAGE_DRIVER=aws',
      });
    }

    if (value.QUEUE_DRIVER === 'aws' && !value.SQS_QUEUE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SQS_QUEUE_URL'],
        message: 'SQS_QUEUE_URL is required when QUEUE_DRIVER=aws',
      });
    }

    // EventBridge Scheduler targets SQS directly, so an AWS scheduler is
    // meaningless without an AWS queue to deliver into.
    if (value.SCHEDULER_DRIVER === 'aws' && value.QUEUE_DRIVER !== 'aws') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_DRIVER'],
        message: 'SCHEDULER_DRIVER=aws requires QUEUE_DRIVER=aws (EventBridge delivers to SQS)',
      });
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Thrown rather than logged: the logger itself depends on this config.
    throw new Error(`Invalid environment configuration:\n${problems}\n\nSee .env.example.`);
  }

  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
