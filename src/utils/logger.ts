// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Logger
// Winston-based structured logging with retro terminal formatting
// ═══════════════════════════════════════════════════════════════════════════

import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const terminalFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ▐ ${level} ▐ ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    terminalFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), terminalFormat),
    }),
    new winston.transports.File({
      filename: 'logs/pred-arb.log',
      maxsize: 10_000_000,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/errors.log',
      level: 'error',
      maxsize: 10_000_000,
      maxFiles: 5,
    }),
  ],
});

export function createChildLogger(module: string) {
  return logger.child({ module });
}
