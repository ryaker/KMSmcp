/**
 * OAuth discovery / DCR stubs.
 *
 * Verifies the four endpoints Claude Code's MCP SDK probes during its OAuth
 * fallback chain all return a clean JSON 404 so the SDK falls through to an
 * unauthenticated connection. Previously /register returned 501, which the SDK
 * surfaces as a fatal "SDK auth failed: Dynamic client registration is not
 * supported by this MCP server. Auth is tunnel-delegated — connect without
 * OAuth." error in the UI.
 *
 * Also verifies the info-disclosure hardening: the detailed error_description
 * and the `mcp_auth: "tunnel-delegated"` debug field only ship on localhost
 * requests. Public-facing responses get a generic body.
 */

import request from 'supertest'
import { HttpTransport, HttpTransportConfig } from '../transport/HttpTransport.js'

const CONFIG: HttpTransportConfig = {
  port: 0, // never actually bound — we drive Express via supertest
  host: 'localhost',
  cors: { origin: true, credentials: true },
  // High limit so the four+ requests in a single test never trip 429.
  rateLimit: { windowMs: 60_000, max: 1000 }
}

const LOCAL_ENDPOINTS: Array<{ method: 'get' | 'post'; path: string }> = [
  { method: 'get',  path: '/.well-known/oauth-protected-resource' },
  { method: 'get',  path: '/.well-known/oauth-authorization-server' },
  { method: 'get',  path: '/.well-known/openid-configuration' },
  { method: 'post', path: '/register' }
]

describe('HttpTransport — OAuth/DCR stubs', () => {
  let transport: HttpTransport

  beforeEach(() => {
    transport = new HttpTransport(CONFIG)
  })

  afterEach(async () => {
    await transport.stop()
  })

  describe('localhost requests (Host: localhost)', () => {
    for (const { method, path } of LOCAL_ENDPOINTS) {
      it(`${method.toUpperCase()} ${path} returns 404 with JSON body and debug field`, async () => {
        const app = (transport as any).app

        const res = await (method === 'get' ? request(app).get(path) : request(app).post(path).send({}))
          .set('Host', 'localhost')

        expect(res.status).toBe(404)
        expect(res.headers['content-type']).toMatch(/application\/json/)
        expect(res.body).toMatchObject({
          error: 'oauth_not_supported',
          mcp_auth: 'tunnel-delegated'
        })
        expect(typeof res.body.error_description).toBe('string')
      })
    }

    it('POST /register specifically returns 404 (was 501 prior to this fix)', async () => {
      const app = (transport as any).app

      const res = await request(app)
        .post('/register')
        .set('Host', 'localhost')
        .send({ client_name: 'test-client', redirect_uris: ['http://localhost/cb'] })

      // The fix: SDK treats 501 as a fatal DCR-rejected error; 404 as
      // "no such endpoint, fall through to unauthenticated."
      expect(res.status).toBe(404)
      expect(res.status).not.toBe(501)
      expect(res.body.error).toBe('oauth_not_supported')
    })
  })

  describe('public (non-localhost) requests — info-disclosure hardening', () => {
    for (const { method, path } of LOCAL_ENDPOINTS) {
      it(`${method.toUpperCase()} ${path} returns 404 JSON WITHOUT mcp_auth debug field`, async () => {
        const app = (transport as any).app

        const res = await (method === 'get' ? request(app).get(path) : request(app).post(path).send({}))
          .set('Host', 'kms.yaker.org')

        expect(res.status).toBe(404)
        expect(res.headers['content-type']).toMatch(/application\/json/)
        expect(res.body).toMatchObject({ error: 'oauth_not_supported' })
        // Hardening: tunnel-delegated debug field must not leak to the public.
        expect(res.body).not.toHaveProperty('mcp_auth')
      })
    }
  })
})
