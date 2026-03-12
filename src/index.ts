// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Entry Point
// ═══════════════════════════════════════════════════════════════════════════

import { Bot } from './engine/bot';
import { logger } from './utils/logger';

const bot = new Bot();

async function main(): Promise<void> {
  try {
    await bot.start();
  } catch (err) {
    logger.error('Fatal error during startup', { error: (err as Error).message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

main();
