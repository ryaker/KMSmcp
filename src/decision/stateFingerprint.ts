/**
 * Fingerprint of exactly what a DecisionEngine was shown.
 *
 * Decision logs store this instead of the state: a row must be attributable to its input
 * without the log becoming a second, unflagged copy of the knowledge base — one that
 * `kms_supersede` and `kms_delete` would never reach.
 */

import crypto from 'crypto'
import type { DecisionJson } from './types.js'

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: DecisionJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`
}

/**
 * sha256 of the canonical state, with the named top-level keys left out — for fields the
 * engine needs but that would make the same input hash differently on every call (a clock).
 */
export function fingerprintState(state: DecisionJson, excludeTopLevelKeys: readonly string[] = []): string {
  const hashed =
    excludeTopLevelKeys.length > 0 && state && typeof state === 'object' && !Array.isArray(state)
      ? Object.fromEntries(Object.entries(state).filter(([k]) => !excludeTopLevelKeys.includes(k)))
      : state
  return crypto.createHash('sha256').update(canonicalJson(hashed)).digest('hex')
}
