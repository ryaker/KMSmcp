/**
 * Tests for `scripts/cron/run-importer.sh` and the launchd plists that
 * drive the Granola + Slack-huddle importers on a 15-min cron.
 *
 * What's covered:
 *   1. `plutil -lint` validates each plist (pure config — that's the right test).
 *   2. The runner script:
 *        - exits 64 (EX_USAGE) for missing/unknown importer names
 *        - prepends `/opt/homebrew/bin` to PATH
 *        - resolves the right tsx entry point per importer name:
 *            granola        → scripts/import-granola.ts --source=cache-v6
 *            slack-huddles  → src/scripts/import-slack-huddles-cli.ts
 *        - takes a PID-file lock (second concurrent run exits 75 EX_TEMPFAIL)
 *
 * Strategy: we don't actually run npx/tsx (no network, no KMS available).
 * Instead we point the runner at a fake bin dir whose `npx` binary just
 * echoes "npx <args>" + the live PATH and exits 0. Asserting on that line
 * lets us pin the runner's wiring without depending on real tooling.
 */

import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'cron', 'run-importer.sh')
const GRANOLA_PLIST = join(REPO_ROOT, 'scripts', 'cron', 'com.ryaker.kms-granola-importer.plist')
const SLACK_PLIST = join(REPO_ROOT, 'scripts', 'cron', 'com.ryaker.kms-slack-huddle-importer.plist')

describe('scripts/cron — launchd plists', () => {
  it.each([
    ['granola', GRANOLA_PLIST],
    ['slack-huddles', SLACK_PLIST]
  ])('%s plist passes plutil -lint', (_label: string, path: string) => {
    expect(existsSync(path)).toBe(true)
    // `plutil -lint` returns 0 on valid plist, non-zero with a message otherwise.
    expect(() => execFileSync('plutil', ['-lint', path], { encoding: 'utf-8' })).not.toThrow()
  })

  it('granola plist labels job + fires every 900 s + does not RunAtLoad', () => {
    const xml = readFileSync(GRANOLA_PLIST, 'utf-8')
    expect(xml).toContain('<string>com.ryaker.kms-granola-importer</string>')
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
    expect(xml).toContain('scripts/cron/run-importer.sh')
    expect(xml).toContain('<string>granola</string>')
    expect(xml).toContain('/Users/ryaker/Library/Logs/kms-cron/granola.launchd.log')
  })

  it('slack-huddle plist labels job + fires every 900 s + does not RunAtLoad', () => {
    const xml = readFileSync(SLACK_PLIST, 'utf-8')
    expect(xml).toContain('<string>com.ryaker.kms-slack-huddle-importer</string>')
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
    expect(xml).toContain('scripts/cron/run-importer.sh')
    expect(xml).toContain('<string>slack-huddles</string>')
    expect(xml).toContain('/Users/ryaker/Library/Logs/kms-cron/slack-huddles.launchd.log')
  })
})

describe('scripts/cron/run-importer.sh', () => {
  let workdir: string
  let logDir: string
  let lockDir: string
  let fakeBin: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'kms-cron-test-'))
    logDir = join(workdir, 'logs')
    lockDir = join(workdir, 'locks')
    fakeBin = join(workdir, 'fakebin')
    mkdirSync(logDir, { recursive: true })
    mkdirSync(lockDir, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })

    // Stub `npx` — record the args + the live PATH so the test can assert on
    // both. Touching a sentinel file lets a second concurrent run prove it
    // never got past the lock.
    const stubNpx = `#!/bin/bash
echo "npx-invoked: $*" >&2
echo "live-path: $PATH" >&2
echo "called" > "${workdir}/npx-called"
exit 0
`
    writeFileSync(join(fakeBin, 'npx'), stubNpx)
    chmodSync(join(fakeBin, 'npx'), 0o755)
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  function runScript(
    args: string[],
    extraEnv: Record<string, string> = {}
  ): { status: number | null; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: workdir,
      KMS_CRON_LOG_DIR: logDir,
      KMS_CRON_LOCK_DIR: lockDir,
      // Sentinel — keeps the runner from trying to source a real .env or
      // wrap with `doppler run`.
      KMS_BEARER_TOKEN: 'test-bearer-token',
      // Hard-pin the npx binary the runner invokes so the test asserts
      // wiring without depending on the host's npm/tsx install.
      KMS_CRON_NPX: join(fakeBin, 'npx'),
      ...extraEnv
    }
    const res = spawnSync('/bin/bash', [SCRIPT_PATH, ...args], { env, encoding: 'utf-8' })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  }

  it('exits 64 (EX_USAGE) when no importer name is given', () => {
    const res = runScript([])
    expect(res.status).toBe(64)
    expect(res.stderr).toMatch(/usage:/i)
  })

  it('exits 64 for an unknown importer name', () => {
    const res = runScript(['mystery-importer'])
    expect(res.status).toBe(64)
    expect(res.stderr).toMatch(/unknown importer/i)
  })

  it('granola: invokes tsx with cache-v6 source flag', () => {
    const res = runScript(['granola'])
    expect(res.status).toBe(0)
    expect(existsSync(join(workdir, 'npx-called'))).toBe(true)

    const log = readFileSync(join(logDir, 'granola.log'), 'utf-8')
    expect(log).toContain('npx-invoked: --yes tsx scripts/import-granola.ts --source=cache-v6')
    // Runner must prepend Homebrew to PATH so a real launchd-only env still
    // resolves node/npm/npx — the live PATH echoed by the stub proves it.
    expect(log).toContain('/opt/homebrew/bin')
    expect(log).toMatch(/finished granola importer: exit=0/)
  })

  it('slack-huddles: invokes tsx with the CLI entry', () => {
    const res = runScript(['slack-huddles'])
    expect(res.status).toBe(0)

    const log = readFileSync(join(logDir, 'slack-huddles.log'), 'utf-8')
    expect(log).toContain('npx-invoked: --yes tsx src/scripts/import-slack-huddles-cli.ts')
    expect(log).toContain('/opt/homebrew/bin')
    expect(log).toMatch(/finished slack-huddles importer: exit=0/)
  })

  it('PID-file lock prevents concurrent runs (second exits EX_TEMPFAIL=75)', () => {
    // Fake npx that blocks long enough for a second invocation to race in
    // and observe the lock.
    const slowNpx = `#!/bin/bash
echo "slow-npx" > "${workdir}/slow-running"
sleep 2
exit 0
`
    writeFileSync(join(fakeBin, 'npx'), slowNpx)
    chmodSync(join(fakeBin, 'npx'), 0o755)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: workdir,
      KMS_CRON_LOG_DIR: logDir,
      KMS_CRON_LOCK_DIR: lockDir,
      KMS_BEARER_TOKEN: 'test-bearer-token',
      KMS_CRON_NPX: join(fakeBin, 'npx')
    }

    // Spawn slow run in background.
    const { spawn } = require('child_process')
    const slow = spawn('/bin/bash', [SCRIPT_PATH, 'granola'], { env, stdio: 'ignore' })

    // Wait for the slow run to actually start (lock file written + sleep called).
    const start = Date.now()
    while (!existsSync(join(workdir, 'slow-running')) && Date.now() - start < 3000) {
      // Tiny blocking sleep so we don't spin the event loop.
      execFileSync('/bin/sleep', ['0.05'])
    }

    // Second invocation should refuse to run and exit 75 EX_TEMPFAIL.
    const second = spawnSync('/bin/bash', [SCRIPT_PATH, 'granola'], { env, encoding: 'utf-8' })
    expect(second.status).toBe(75)

    // Drain the slow run.
    return new Promise<void>(resolve => {
      slow.on('exit', () => resolve())
    })
  }, 15000)
})
