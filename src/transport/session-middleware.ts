/**
 * MCP Session Persistence Middleware for Node.js
 *
 * Tracks MCP sessions in SQLite so they survive server restarts.
 * Uses the same database as Python MCPs (~/.claude-ops/events.db).
 *
 * Strategy:
 * 1. Track session IDs in SQLite when created
 * 2. On restart, sessions in SQLite but not in memory are "known but stale"
 * 3. For stale sessions, let the transport create a new session
 * 4. Client continues seamlessly with new session ID
 */

import Database from 'better-sqlite3';
import { Request, Response, NextFunction } from 'express';
import * as os from 'os';
import * as path from 'path';

// Header names (must match MCP SDK and Python middleware)
const MCP_SESSION_ID_HEADER = 'mcp-session-id';

// Database path (shared with Python MCPs)
const DB_PATH = path.join(os.homedir(), '.claude-ops', 'events.db');

// Track active sessions in memory
const activeSessions = new Set<string>();

// Initialize database connection
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        session_id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        user_agent TEXT,
        client_ip TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,
        request_count INTEGER DEFAULT 1
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_sessions_service
      ON mcp_sessions(service)
    `);

    console.log('[session-middleware] Initialized SQLite session persistence');
  }
  return db;
}

/**
 * Check if a session ID exists in SQLite (was valid before restart)
 */
function isKnownSession(sessionId: string): boolean {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM mcp_sessions WHERE session_id = ?')
      .get(sessionId);
    return row !== undefined;
  } catch (e) {
    console.error('[session-middleware] Error checking session:', e);
    return false;
  }
}

/**
 * Register a new session in SQLite and memory
 */
function registerSession(
  sessionId: string,
  service: string,
  userAgent: string = '',
  clientIp: string = ''
): void {
  activeSessions.add(sessionId);

  try {
    getDb()
      .prepare(`
        INSERT OR REPLACE INTO mcp_sessions
        (session_id, service, user_agent, client_ip, last_used_at, request_count)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP,
          COALESCE((SELECT request_count FROM mcp_sessions WHERE session_id = ?), 0) + 1)
      `)
      .run(sessionId, service, userAgent, clientIp, sessionId);
  } catch (e) {
    console.error('[session-middleware] Error registering session:', e);
  }
}

/**
 * Update last_used timestamp for an active session
 */
function updateSessionUsage(sessionId: string): void {
  try {
    getDb()
      .prepare(`
        UPDATE mcp_sessions
        SET last_used_at = CURRENT_TIMESTAMP, request_count = request_count + 1
        WHERE session_id = ?
      `)
      .run(sessionId);
  } catch (e) {
    // Non-critical, just log
    console.debug('[session-middleware] Failed to update session usage:', e);
  }
}

/**
 * Get client IP from request, preferring forwarded headers
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return Array.isArray(forwarded)
      ? forwarded[0].split(',')[0].trim()
      : forwarded.split(',')[0].trim();
  }
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) {
    return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  }
  return req.socket.remoteAddress || 'unknown';
}

export interface SessionMiddlewareOptions {
  service: string;
}

/**
 * Express middleware for MCP session persistence
 *
 * Usage:
 *   app.use('/mcp', sessionMiddleware({ service: 'alexa-mcp' }));
 */
export function sessionMiddleware(options: SessionMiddlewareOptions) {
  const { service } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.headers[MCP_SESSION_ID_HEADER] as string | undefined;

    if (sessionId) {
      if (activeSessions.has(sessionId)) {
        // Session is active in memory - pass through
        updateSessionUsage(sessionId);
      } else if (isKnownSession(sessionId)) {
        // Session was valid before restart - strip header so transport creates new one
        console.log(`[session-middleware] Recovering session ${sessionId.substring(0, 12)}... for ${service}`);
        delete req.headers[MCP_SESSION_ID_HEADER];
      } else {
        // Unknown session - let transport handle (will return error or create new)
        console.debug(`[session-middleware] Unknown session ${sessionId.substring(0, 12)}...`);
      }
    }

    // Capture response to track new session IDs
    const originalSend = res.send.bind(res);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const clientIp = getClientIp(req);

    res.send = function(body: any) {
      // Check for new session ID in response headers
      const newSessionId = res.getHeader(MCP_SESSION_ID_HEADER) as string | undefined;
      if (newSessionId && !activeSessions.has(newSessionId)) {
        registerSession(newSessionId, service, userAgent, clientIp);
      }
      return originalSend(body);
    };

    next();
  };
}

/**
 * Get session statistics for monitoring
 */
export function getSessionStats(): {
  activeInMemory: number;
  totalInDb: number;
  byService: Record<string, number>;
} {
  const stats = {
    activeInMemory: activeSessions.size,
    totalInDb: 0,
    byService: {} as Record<string, number>,
  };

  try {
    const totalRow = getDb()
      .prepare('SELECT COUNT(*) as count FROM mcp_sessions')
      .get() as { count: number };
    stats.totalInDb = totalRow.count;

    const serviceRows = getDb()
      .prepare('SELECT service, COUNT(*) as count FROM mcp_sessions GROUP BY service')
      .all() as Array<{ service: string; count: number }>;

    for (const row of serviceRows) {
      stats.byService[row.service] = row.count;
    }
  } catch (e) {
    console.error('[session-middleware] Error getting stats:', e);
  }

  return stats;
}

/**
 * Cleanup sessions older than specified days
 */
export function cleanupOldSessions(days: number = 7): number {
  try {
    const result = getDb()
      .prepare(`
        DELETE FROM mcp_sessions
        WHERE datetime(last_used_at) < datetime('now', ?)
      `)
      .run(`-${days} days`);

    if (result.changes > 0) {
      console.log(`[session-middleware] Cleaned up ${result.changes} old sessions`);
    }
    return result.changes;
  } catch (e) {
    console.error('[session-middleware] Error cleaning up sessions:', e);
    return 0;
  }
}

/**
 * Direct export for registering sessions from transport classes
 * (for use outside of Express middleware pattern)
 */
export function registerSessionDirect(
  sessionId: string,
  service: string,
  userAgent: string = '',
  clientIp: string = ''
): void {
  registerSession(sessionId, service, userAgent, clientIp);
}

/**
 * Export isKnownSession for transport classes to check session validity
 */
export { isKnownSession };
