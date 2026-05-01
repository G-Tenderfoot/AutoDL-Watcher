import { BrowserWindow, session } from 'electron'

const AUTODL_URL = 'https://www.autodl.com/console/instance/list'
const AUTODL_HOME = 'https://www.autodl.com'
const AUTH_PARTITION = 'persist:autodl-auth'
const CAPTURE_FILTER = { urls: ['https://www.autodl.com/api/*'] }

type AuthCapture = { jwt: string; cookie: string }

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  const value = key ? headers[key] : undefined
  return Array.isArray(value) ? value.join('; ') : value ?? ''
}

function extractJwt(value: string): string {
  const trimmed = value.trim().replace(/^Bearer\s+/i, '')
  return trimmed.startsWith('eyJ') ? trimmed : ''
}

function mergeCookieHeaders(...headers: string[]): string {
  const cookies = new Map<string, string>()
  for (const header of headers) {
    for (const part of header.split(';')) {
      const item = part.trim()
      if (!item) continue
      const eq = item.indexOf('=')
      if (eq <= 0) continue
      cookies.set(item.slice(0, eq), item.slice(eq + 1))
    }
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ')
}

export function openAuthWindow(): Promise<AuthCapture> {
  return new Promise((resolve, reject) => {
    const authSession = session.fromPartition(AUTH_PARTITION)
    const win = new BrowserWindow({
      width: 1024,
      height: 720,
      title: '登录 AutoDL',
      webPreferences: {
        partition: AUTH_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    let settled = false
    let retries = 0
    let capturedJwt = ''
    let capturedCookie = ''

    const cleanup = () => {
      authSession.webRequest.onBeforeSendHeaders(CAPTURE_FILTER, null)
    }

    const getSessionCookieHeader = async (): Promise<string> => {
      const cookies = await authSession.cookies.get({ url: AUTODL_HOME })
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    }

    const finish = async (source: string) => {
      if (settled || !capturedJwt) return

      const cookie = mergeCookieHeaders(capturedCookie, await getSessionCookieHeader())
      if (!cookie) return

      settled = true
      cleanup()
      console.log(`[AUTH] credentials captured via ${source}`)
      resolve({ jwt: capturedJwt, cookie })
      if (!win.isDestroyed()) win.close()
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
      if (!win.isDestroyed()) win.close()
    }

    // Capture real network request headers from the authenticated AutoDL page.
    // This sees HttpOnly cookies that document.cookie cannot expose.
    authSession.webRequest.onBeforeSendHeaders(CAPTURE_FILTER, (details, callback) => {
      const jwt = extractJwt(readHeader(details.requestHeaders, 'authorization'))
      const cookie = readHeader(details.requestHeaders, 'cookie')
      if (jwt) capturedJwt = jwt
      if (cookie) capturedCookie = mergeCookieHeaders(capturedCookie, cookie)
      if (jwt || cookie) setTimeout(() => void finish('network request'), 0)
      callback({ requestHeaders: details.requestHeaders })
    })

    // Inject a hook to capture the Authorization header from API requests
    // This is a fallback for environments where webRequest misses app-level headers.
    const injectHook = `
      (function() {
        if (window.__autodlHookInstalled) return;
        window.__autodlHookInstalled = true;

        function setJwt(value) {
          if (!value || typeof value !== 'string') return;
          var token = value.replace(/^Bearer\\s+/i, '').trim();
          if (token.indexOf('eyJ') === 0) window.__JWT__ = token;
        }

        function readHeaders(headers) {
          if (!headers) return;
          if (headers instanceof Headers) {
            setJwt(headers.get('Authorization') || headers.get('authorization'));
            return;
          }
          if (Array.isArray(headers)) {
            headers.forEach(function(pair) {
              if (pair && String(pair[0]).toLowerCase() === 'authorization') setJwt(String(pair[1]));
            });
            return;
          }
          Object.keys(headers).forEach(function(key) {
            if (key.toLowerCase() === 'authorization') setJwt(String(headers[key]));
          });
        }

        // Override fetch
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          readHeaders(init && init.headers);
          if (input instanceof Request) readHeaders(input.headers);
          return origFetch.apply(this, arguments);
        };

        // Override XHR setRequestHeader
        const origSet = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          if (String(name).toLowerCase() === 'authorization') setJwt(value);
          return origSet.call(this, name, value);
        };
      })();
    `

    const installHook = () => {
      if (win.isDestroyed()) return
      win.webContents.executeJavaScript(injectHook).catch(() => {})
    }

    win.webContents.on('dom-ready', installHook)
    win.webContents.on('did-finish-load', installHook)
    win.webContents.on('did-navigate-in-page', installHook)

    // Poll for captured JWT
    const tryCapture = () => {
      if (settled) return
      if (retries >= 300) {
        fail(new Error('登录超时，未能获取 AutoDL 登录凭证。请确认已完成登录，并停留在实例列表页。'))
        return
      }
      retries++

      win.webContents.executeJavaScript('({ jwt: window.__JWT__ || "", cookie: document.cookie })')
        .then((result: { jwt: string; cookie: string }) => {
          const jwt = extractJwt(result?.jwt ?? '')
          if (jwt) capturedJwt = jwt
          if (result?.cookie) {
            capturedCookie = mergeCookieHeaders(capturedCookie, result.cookie)
          }
          return finish('page hook')
        })
        .catch(() => undefined)
        // Schedule next poll
        if (!settled) setTimeout(tryCapture, 1000)
    }

    // Start polling after page load
    win.webContents.on('did-finish-load', () => {
      setTimeout(tryCapture, 1500)
    })

    // Retry after navigation (e.g., after login redirect)
    win.webContents.on('did-navigate', (_e, url: string) => {
      installHook()
      if (url.includes('/console/instance') || url.includes('/console/homepage')) {
        setTimeout(tryCapture, 1500)
        setTimeout(tryCapture, 4000)
      }
    })

    win.loadURL(AUTODL_URL)

    win.on('closed', () => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error('未完成登录'))
      }
    })
  })
}
