import type { Session } from 'electron'
import { promises as dns } from 'dns'
import { isIP } from 'net'
import { isLocalHostname, isPrivateAddress } from './netGuard'

/**
 * The app frame's CSP allows https: images, so an app could aim <img> at a device on the
 * local network (a blind GET). Requests from app frames to local addresses are cancelled
 * unless Settings → Network allows the local network. Remote images still load.
 *
 * Best effort: Chromium resolves names itself after this check, so a hostname that changes
 * its DNS answer in between (rebinding) can still get through. host.fetch() has no such gap.
 */
export function guardAppFrameRequests(ses: Session, allowLocal: () => Promise<boolean>): void {
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    let fromApp = false
    try {
      fromApp = !!details.frame?.url.startsWith('appframe:')
    } catch {
      // disposed frame: nothing left to protect
    }
    if (!fromApp) return callback({})
    void isLocalTarget(details.url)
      .then(async (local) => local && !(await allowLocal()))
      .catch(() => false)
      .then((block) => callback(block ? { cancel: true } : {}))
  })
}

async function isLocalTarget(url: string): Promise<boolean> {
  const host = new URL(url).hostname
  if (isLocalHostname(host)) return true
  if (isIP(host.replace(/^\[|\]$/g, ''))) return false // a public literal
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true })
    return addrs.some((a) => isPrivateAddress(a.address))
  } catch {
    return false // unresolvable: Chromium's own request fails as well
  }
}
