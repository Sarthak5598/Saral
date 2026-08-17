/**
 * Scheduler port - whatever causes a sync to happen every 3 hours.
 *
 * The two implementations differ in an important way that the interface has to
 * accommodate: node-cron runs *inside* this process, while EventBridge Scheduler
 * runs in AWS and keeps firing whether or not anything of ours is running.
 *
 * Hence the split between `ensureSchedules` (declare the schedule; for AWS this
 * is a one-off provisioning call, idempotent) and `start`/`stop` (run the
 * in-process timer; a no-op under AWS).
 */
export interface Scheduler {
  readonly provider: 'node-cron' | 'eventbridge';

  /**
   * Makes the schedule exist. Idempotent - safe to call on every boot.
   *
   * Under AWS this creates or updates the EventBridge schedule whose target is
   * the SQS queue. Note what it does NOT do: name any hashtag. The schedule sends
   * a DISPATCH_DUE_SYNCS message and the worker resolves which hashtags are due
   * from the database, so tracking a new tag never requires touching AWS.
   */
  ensureSchedules(): Promise<void>;

  /** Begins in-process scheduling. No-op when AWS owns the clock. */
  start(): Promise<void>;

  stop(): Promise<void>;
}
