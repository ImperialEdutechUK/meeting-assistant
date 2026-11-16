// Entry point of the meeting worker container.
// job mode (default): runs one meeting, then exits.
// standby mode: started on a schedule; keeps Chrome ready and takes one meeting after another
// until the end of the standby window, so joins during working hours are near instant.

import { loadWorkerConfig, secondsUntilUkTime } from '../core/config.js';
import { errorMessage, logger } from '../core/log.js';
import { runWorker } from './worker.js';

const log = logger('worker-main');

async function standby(): Promise<void> {
  const config = loadWorkerConfig();
  log.info('Scheduled worker started', { mode: config.mode, until: config.standbyUntil });
  for (;;) {
    const remaining = secondsUntilUkTime(config.standbyUntil);
    if (remaining <= 0) break;
    // Re-launch Chrome at least hourly so a long idle browser never goes stale.
    const result = await runWorker({ config: { ...config, claimWaitSeconds: Math.min(remaining, 3600) } });
    if (result.outcome !== 'no-meeting') log.info('Standby worker finished a meeting', { ...result });
  }
  log.info('Standby window over, exiting');
}

// receiver: the same scheduled loop as standby, but it answers calls to the assistant's Teams account.
const run = loadWorkerConfig().mode !== 'job'
  ? standby().then(() => 0)
  : runWorker({ config: loadWorkerConfig() }).then((result) => {
      log.info('Done', { ...result });
      return result.outcome === 'failed' ? 1 : 0;
    });

run
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error('Worker crashed', { error: errorMessage(err) });
    process.exit(1);
  });
