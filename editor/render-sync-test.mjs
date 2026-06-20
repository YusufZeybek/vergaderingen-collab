/** End-to-end test tegen de PRODUCTIE Render-server: JWT-auth + Yjs-sync over wss. */
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import crypto from 'crypto'

const WS = process.env.WS_URL || 'wss://vergaderingen-collab.onrender.com'
const DOC = 'meeting:99999' // niet-bestaande test-meeting (geen seed, snapshot raakt 0 rijen)
const SECRET = process.env.JWT_SECRET
const b64 = (b) => Buffer.from(b).toString('base64url')
function jwt(claims) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64(JSON.stringify(claims))
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}
const now = Math.floor(Date.now() / 1000)
const mk = (sub, name, color) => jwt({ sub, name, color, doc: DOC, iat: now, exp: now + 3600 })

function client(token) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: WS, name: DOC, document: doc, token, WebSocketPolyfill: globalThis.WebSocket })
  return { doc, provider, text: doc.getText('t') }
}
const synced = (p, label) => new Promise((res, rej) => {
  p.on('synced', () => res())
  p.on('authenticationFailed', (d) => rej(new Error(`${label}: auth GEWEIGERD — ${JSON.stringify(d)}`)))
  setTimeout(() => rej(new Error(`${label}: timeout (server koud/uit?)`)), 90000)
})
const wait = (ms) => new Promise(r => setTimeout(r, ms))

try {
  console.log(`Verbinden met ${WS} (free tier kan ~50s koud opstarten)...`)
  const A = client(mk('a', 'TestA', '#1182A4'))
  await synced(A.provider, 'A')
  console.log('✅ Client A verbonden + JWT-auth OK + gesynchroniseerd')

  const B = client(mk('b', 'TestB', '#e11d48'))
  await synced(B.provider, 'B')
  console.log('✅ Client B verbonden')

  A.text.insert(0, 'Live test vanaf Render ')
  await wait(2000)
  const ok = B.text.toString().includes('Live test vanaf Render')
  console.log(ok ? '✅ A→B SYNC WERKT op de productie-server (auth + Mongo + CRDT)' : '❌ sync mislukt: ' + JSON.stringify(B.text.toString()))

  A.provider.destroy(); B.provider.destroy()
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.log('❌ ' + e.message)
  process.exit(1)
}
