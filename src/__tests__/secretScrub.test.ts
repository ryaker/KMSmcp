/**
 * Secret scrubbing — masks credentials before any backend sees a write, and
 * leaves the everyday KMS vocabulary (git SHAs, fingerprints, env var NAMES,
 * placeholders) alone. False positives matter as much as misses: a scrubber
 * that eats SHAs corrupts the knowledge it is protecting.
 */
import { scrubSecrets, scrubWrite } from '../security/secretScrub.js'

const HEX64 = '6a16f0adcd9e745b7208aeaaa5633121f2c6db23a3b9b838789c4e0c44668fac'

describe('scrubSecrets — masks credentials', () => {
  const cases: Array<[string, string, string]> = [
    ['url token param', `curl "https://catalog.yaker.org/dl/1?token=${HEX64}"`, 'url_credential'],
    ['bearer header', `-H "Authorization: Bearer ${HEX64}"`, 'bearer_token'],
    ['env assignment', `KMS_BEARER_TOKEN=${HEX64}`, 'env_secret'],
    ['json key', `{"api_key": "abcd1234efgh5678ijkl"}`, 'keyed_secret'],
    ['anthropic', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv0123', 'anthropic_key'],
    ['github', 'ghp_' + 'A'.repeat(20) + 'b'.repeat(16), 'github_token'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
    ['slack', 'xoxb-12345678-abcdefghij', 'slack_token'],
    ['jwt', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'jwt'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'private_key'],
  ]
  it.each(cases)('%s', (_name, input, type) => {
    const r = scrubSecrets(input)
    expect(r.text).toContain(`[REDACTED:${type}]`)
    expect(r.redactions).toEqual([{ type, count: 1 }])
    expect(r.text).not.toContain(HEX64)
  })

  it('keeps the key name so the masked fact stays readable', () => {
    expect(scrubSecrets(`KMS_BEARER_TOKEN=${HEX64}`).text).toBe('KMS_BEARER_TOKEN=[REDACTED:env_secret]')
    expect(scrubSecrets(`/dl/x?token=${HEX64}&y=1`).text).toBe('/dl/x?token=[REDACTED:url_credential]&y=1')
  })
})

describe('scrubSecrets — leaves ordinary KMS content alone', () => {
  const clean = [
    `fingerprint ${HEX64}`,                                   // SHA-256, no credential context
    'merged as aa59e2d4, commit 3bfd2d47e1c2a9d0b8f7e6d5c4b3a2918f7e6d5c',  // git SHAs
    'TYPESAFE_API_KEY is unset in dev_eng',                   // env var NAME, no value
    'KMS_JEV_SHADOW_REORDER=1 and OLLAMA_KEEP_ALIVE=30m',     // short values
    'curl "https://catalog.yaker.org/dl/{asset_id}?token=<TOKEN>"', // placeholder
    'export KMS_BEARER_TOKEN=${KMS_BEARER_TOKEN}',            // variable reference
    'OLLAMA_BASE_URL=http://100.127.128.76:11434',            // not a secret name
  ]
  it.each(clean)('%s', text => {
    expect(scrubSecrets(text)).toEqual({ text, redactions: [] })
  })

  it('is idempotent — a masked value is never re-matched', () => {
    const once = scrubSecrets(`KMS_BEARER_TOKEN=${HEX64}`).text
    expect(scrubSecrets(once)).toEqual({ text: once, redactions: [] })
  })
})

describe('scrubWrite — content plus string metadata', () => {
  it('scrubs metadata strings and string arrays, merging counts', () => {
    const r = scrubWrite(`token=${HEX64} in content`.replace('token=', '?token='), {
      note: `Bearer ${HEX64}`,
      tags: [`api_key="${'z'.repeat(4)}abcdef123456"`, 'plain'],
      count: 3,
    })
    expect(r.content).toContain('[REDACTED:url_credential]')
    expect(r.metadata!.note).toBe('Bearer [REDACTED:bearer_token]')
    expect(r.metadata!.tags[1]).toBe('plain')
    expect(r.metadata!.count).toBe(3)
    expect(r.redactions).toEqual(expect.arrayContaining([
      { type: 'url_credential', count: 1 }, { type: 'bearer_token', count: 1 }, { type: 'keyed_secret', count: 1 },
    ]))
  })

  it('returns no redactions and unchanged input for clean writes', () => {
    const r = scrubWrite('Phoenix has 8 cameras', { subject: 'Phoenix.camera_count' })
    expect(r).toEqual({ content: 'Phoenix has 8 cameras', metadata: { subject: 'Phoenix.camera_count' }, redactions: [] })
  })
})
