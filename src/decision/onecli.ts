/**
 * OneCLI gateway transport — a `fetch` that routes through the local credential gateway.
 *
 * OneCLI is an authenticating forward proxy (default `http://localhost:10255`). It
 * terminates TLS with its own CA, matches the destination host against its credential
 * table, and rewrites the Authorization header with the real secret — so the calling
 * process authenticates to the *gateway* with an agent token and never sees the provider
 * key at all.
 *
 * Same wiring as `nanobanana_mcp_server/services/gemini_client.py` on this machine:
 * `Proxy-Authorization: Basic base64("<token>:")`, trust `~/Dev/onecli/certs/ca.pem`.
 *
 * Scoped to a dispatcher on this one fetch, deliberately NOT `HTTPS_PROXY` /
 * `setGlobalDispatcher`: a process-wide proxy would also reroute MongoDB Atlas, Mem0 and
 * Ollama traffic through a gateway that has no business seeing it, and would put the
 * agent token into an env-var URL that child processes inherit.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../logger.js'

export const ONECLI_TOKEN_ENV = 'ONECLI_TOKEN'
export const ONECLI_GATEWAY_ENV = 'ONECLI_GATEWAY'
export const ONECLI_CA_CERT_ENV = 'ONECLI_CA_CERT'
export const ONECLI_DEFAULT_CA_CERT = path.join(os.homedir(), 'Dev/onecli/certs/ca.pem')

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * A gateway-routed fetch, or null when the gateway is not configured.
 *
 * Both the token and the gateway URL must be present — a token alone is not enough to
 * guess where the gateway lives, and guessing would send an agent token to whatever
 * happens to be listening on the default port.
 */
export function createOneCliFetch(env: NodeJS.ProcessEnv = process.env): FetchLike | null {
  const token = env[ONECLI_TOKEN_ENV]?.trim()
  const gateway = env[ONECLI_GATEWAY_ENV]?.trim()
  if (!token || !gateway) return null

  const caPath = env[ONECLI_CA_CERT_ENV]?.trim() || ONECLI_DEFAULT_CA_CERT
  let ca: Buffer | undefined
  try {
    ca = fs.readFileSync(caPath)
  } catch {
    // Without the CA the gateway's re-signed certificate fails verification and every
    // call errors. Say why here, once, rather than leaving a TLS error per candidate.
    logger.warn(`decision: OneCLI CA certificate not readable at ${caPath}; gateway TLS will fail verification`)
  }

  const dispatcher = new ProxyAgent({
    uri: gateway,
    token: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
    ...(ca ? { requestTls: { ca } } : {}),
  })

  // undici's fetch and the global fetch share a shape but not a nominal type; the
  // dispatcher must be paired with the undici build it came from, hence `undiciFetch`.
  return (input, init) =>
    undiciFetch(input, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}
