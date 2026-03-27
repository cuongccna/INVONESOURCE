/**
 * Shared Winston logger for the bot module.
 */
import { createLogger, format, transports } from 'winston';

export const logger = createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${String(message)}${metaStr}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/bot-error.log', level: 'error', maxsize: 5_000_000, maxFiles: 3 }),
    new transports.File({ filename: 'logs/bot-combined.log', maxsize: 10_000_000, maxFiles: 5 }),
  ],
});
