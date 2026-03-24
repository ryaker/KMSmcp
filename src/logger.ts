/**
 * Minimal leveled logger — writes to stderr only (safe for MCP stdio transport).
 * Controlled by LOG_LEVEL env var: debug | info | warn | error (default: warn)
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

const configured = (process.env.LOG_LEVEL?.toLowerCase() ?? 'warn') as Level
const threshold = LEVELS[configured] ?? LEVELS.warn

const emit = (level: Level, ...args: unknown[]) => {
  if (LEVELS[level] >= threshold) console.error(`[${level.toUpperCase()}]`, ...args)
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', ...args),
  info:  (...args: unknown[]) => emit('info',  ...args),
  warn:  (...args: unknown[]) => emit('warn',  ...args),
  error: (...args: unknown[]) => emit('error', ...args),
  /** Lazy variant — skips string building when level is disabled.
   *  Use when the message involves expensive operations (joins, serialization):
   *  logger.lazy('debug', () => `big ${array.join(', ')}`)
   */
  lazy: (level: Level, msg: () => string) => {
    if (LEVELS[level] >= threshold) console.error(`[${level.toUpperCase()}]`, msg())
  },
}
