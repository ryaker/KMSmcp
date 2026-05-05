/**
 * Integration tests for FACTCache.invalidate() — L1 glob semantics.
 *
 * Guards against the bug fixed in commit 3b1b7914 (PR #36):
 *   invalidate('kms:search:*') used to call key.includes('kms:search:*')
 *   on the L1 Map, with the literal `*` still in the pattern. Real keys
 *   look like 'kms:search:<sha256-hash>' and never contain `*`, so L1
 *   entries were silently never invalidated after flag/supersede/delete
 *   while L2 Redis (which wraps in `*...*`) worked fine.
 *
 * The fix strips leading/trailing `*` before the L1 includes() check so
 * L1 and L2 use the same substring-match semantics. These tests exercise
 * a REAL FACTCache instance (no jest.fn() over invalidate) with L2
 * disabled, which is the blind spot the previous unit tests missed.
 */

import { FACTCache } from '../cache/FACTCache.js'
import type { KMSConfig } from '../types/index.js'

// Minimal Redis stub: status reports 'disconnected' so FACTCache never
// touches L2. The .on() handlers are recorded but never fired, so
// l2Active stays false for the entire test lifetime.
function createDisconnectedRedisStub(): any {
  return {
    status: 'disconnected',
    on: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    keys: jest.fn()
  }
}

describe('FACTCache.invalidate() — L1 glob semantics (regression for 3b1b7914)', () => {
  const factConfig: KMSConfig['fact'] = {
    l1CacheSize: 10485760, // 10MB
    l2CacheTTL: 300000,    // 5 min
    l3CacheTTL: 600000     // 10 min
  }

  let cache: FACTCache
  let redisStub: any
  // FACTCache schedules a cleanup setInterval in its constructor. Track and
  // clear any timers it creates so jest can exit cleanly.
  const intervalHandles: NodeJS.Timeout[] = []
  let originalSetInterval: typeof setInterval

  beforeAll(() => {
    originalSetInterval = global.setInterval
    global.setInterval = ((fn: any, ms: number, ...args: any[]) => {
      const handle = originalSetInterval(fn, ms, ...args)
      // Don't keep the event loop alive on this handle.
      if (typeof (handle as any).unref === 'function') (handle as any).unref()
      intervalHandles.push(handle)
      return handle
    }) as any
  })

  afterAll(() => {
    intervalHandles.forEach(h => clearInterval(h))
    global.setInterval = originalSetInterval
  })

  beforeEach(async () => {
    redisStub = createDisconnectedRedisStub()
    cache = new FACTCache(factConfig, redisStub)

    // Populate L1 with realistic key shapes
    await cache.set('kms:search:abc123hashxyz', { hits: ['a'] })
    await cache.set('kms:search:def456hashxyz', { hits: ['b'] })
    await cache.set('kms:knowledge:user:richard_yaker:type:fact:ctx:foo', { id: 'k1' })
    await cache.set('kms:knowledge:user:richard_yaker:type:insight:ctx:bar', { id: 'k2' })
    await cache.set('kms:knowledge:user:X:ctx:abc-123', { id: 'k3' })
    await cache.set('unrelated:key:1', { id: 'u1' })
  })

  it('invalidate("kms:search:*") removes both search keys (the original bug)', async () => {
    // Sanity: all keys present before
    expect(await cache.get('kms:search:abc123hashxyz')).not.toBeNull()
    expect(await cache.get('kms:search:def456hashxyz')).not.toBeNull()

    await cache.invalidate('kms:search:*')

    // Both search keys should be gone
    expect(await cache.get('kms:search:abc123hashxyz')).toBeNull()
    expect(await cache.get('kms:search:def456hashxyz')).toBeNull()

    // Knowledge and unrelated keys preserved
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:fact:ctx:foo')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:insight:ctx:bar')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:X:ctx:abc-123')).not.toBeNull()
    expect(await cache.get('unrelated:key:1')).not.toBeNull()
  })

  it('invalidate("*abc-123*") removes the key containing abc-123', async () => {
    await cache.invalidate('*abc-123*')

    expect(await cache.get('kms:knowledge:user:X:ctx:abc-123')).toBeNull()

    // Everything else preserved
    expect(await cache.get('kms:search:abc123hashxyz')).not.toBeNull()
    expect(await cache.get('kms:search:def456hashxyz')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:fact:ctx:foo')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:insight:ctx:bar')).not.toBeNull()
    expect(await cache.get('unrelated:key:1')).not.toBeNull()
  })

  it('invalidate("kms:knowledge") substring-matches both knowledge keys', async () => {
    await cache.invalidate('kms:knowledge')

    // All three knowledge-prefixed keys should be gone
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:fact:ctx:foo')).toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:insight:ctx:bar')).toBeNull()
    expect(await cache.get('kms:knowledge:user:X:ctx:abc-123')).toBeNull()

    // Search and unrelated preserved
    expect(await cache.get('kms:search:abc123hashxyz')).not.toBeNull()
    expect(await cache.get('kms:search:def456hashxyz')).not.toBeNull()
    expect(await cache.get('unrelated:key:1')).not.toBeNull()
  })

  it('invalidate with a pattern that matches nothing leaves L1 intact', async () => {
    await cache.invalidate('nope:no:match')

    expect(await cache.get('kms:search:abc123hashxyz')).not.toBeNull()
    expect(await cache.get('kms:search:def456hashxyz')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:fact:ctx:foo')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:richard_yaker:type:insight:ctx:bar')).not.toBeNull()
    expect(await cache.get('kms:knowledge:user:X:ctx:abc-123')).not.toBeNull()
    expect(await cache.get('unrelated:key:1')).not.toBeNull()
  })

  it('does not touch L2 Redis when the stub reports disconnected', async () => {
    await cache.invalidate('kms:search:*')

    // The whole point of the disconnected stub: invalidate should never
    // call into Redis. If this assertion ever fails, the test is no
    // longer exercising the real L1 path in isolation.
    expect(redisStub.keys).not.toHaveBeenCalled()
    expect(redisStub.del).not.toHaveBeenCalled()
  })
})
