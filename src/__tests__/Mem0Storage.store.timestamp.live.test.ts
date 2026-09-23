/**
 * LIVE smoke test — real add() against the Mem0 API to verify the temporal
 * stamp reaches the wire and the extractor honours it.
 *
 * Skipped unless KMS_MEM0_LIVE_SMOKE=1, so CI and an ordinary `npm test`
 * never touch the network or spend tokens. To run on this machine (MEM0_API_KEY
 * in the environment or via doppler):
 *
 *   KMS_MEM0_LIVE_SMOKE=1 doppler run -p ry-local -c dev_personal -- \
 *     npx jest src/__tests__/Mem0Storage.store.timestamp.live.test.ts
 *
 * Asserts the wire contract: a knowledge entry with a 2023-03-06 narrative
 * timestamp produces a shard whose text carries that date (not the ingestion
 * date "September 22, 2026", the DolphinBench-probe corruption this fixes).
 */

import { Mem0Storage } from '../storage/Mem0Storage.js'

const live = process.env.KMS_MEM0_LIVE_SMOKE === '1' ? describe : describe.skip

live('Mem0 temporal-stamp live smoke', () => {
  it('extracts a 2023 narrative event under a 2023 event timestamp', async () => {
    if (!process.env.MEM0_API_KEY) {
      throw new Error('KMS_MEM0_LIVE_SMOKE=1 but MEM0_API_KEY is not set')
    }

    const storage = new Mem0Storage({
      apiKey: process.env.MEM0_API_KEY,
      defaultUserId: 'smoke_ts_probe'
    } as any)
    await storage.initialize()

    const knowledge = {
      id: `smoke-ts-${Date.now()}`,
      content: 'On March 6, 2023, I signed the lease for the apartment on Maple Street.',
      contentType: 'memory',
      source: 'personal',
      // Disposable namespace — smoke writes never touch production users.
      userId: `smoke_ts_probe_${Date.now()}`,
      metadata: {},
      timestamp: new Date('2023-03-06T12:00:00Z'),
      confidence: 0.8
    }

    await storage.store(knowledge as any)

    // Give the extractor a beat, then read back everything in the namespace
    // and assert the narrative date survived.
    await new Promise(r => setTimeout(r, 4000))

    const memories = await (storage as any).client.getAll({ filters: { user_id: knowledge.userId } }) as any
    const rows = memories.results ?? memories
    expect(rows.length).toBeGreaterThan(0)

    const texts: string[] = rows.map((r: any) => r.memory ?? r.text ?? '')
    console.error(JSON.stringify({ namespace: knowledge.userId, texts }, null, 2))

    const joined = texts.join('\n').toLowerCase()
    expect(joined).toContain('march 6, 2023')
    // The corruption signature this fix targets: ingestion date replacing the
    // narrative date in extracted text. (The ingestion date can legitimately
    // appear in other shards, so this asserts the *lease* shard carries the
    // narrative date rather than the ingestion date.)
    const leaseShard = texts.find(t => /lease/i.test(t))
    expect(leaseShard).toBeDefined()
    expect(leaseShard!.toLowerCase()).toContain('2023')
  }, 60_000)

  afterAll(async () => {
    // Best-effort cleanup of the disposable namespace. If deleteAll fails we
    // still want the run to count the assertions above.
    try {
      const storage = new Mem0Storage({
        apiKey: process.env.MEM0_API_KEY,
        defaultUserId: 'smoke_ts_probe'
      } as any)
      await storage.initialize()
      await (storage as any).client.deleteAll({ filters: { user_id: 'smoke_ts_probe' } })
    } catch {
      // smoke namespace is disposable; ignore cleanup failures
    }
  })
})