/** Verifieert dat de productie-server meeting:77 correct seedt uit MySQL (GVARIA). */
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import crypto from 'crypto'
const WS = 'wss://vergaderingen-collab.onrender.com'
const DOC = process.env.DOC || 'meeting:77'
const SECRET = process.env.JWT_SECRET
const b64 = b => Buffer.from(b).toString('base64url')
function jwt(c) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64(JSON.stringify(c))
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}
const now = Math.floor(Date.now() / 1000)
const token = jwt({ sub: 'seedtest', name: 'SeedTest', doc: DOC, iat: now, exp: now + 3600 })
const doc = new Y.Doc()
const p = new HocuspocusProvider({ url: WS, name: DOC, document: doc, token, WebSocketPolyfill: globalThis.WebSocket })
const synced = new Promise((res, rej) => {
  p.on('synced', () => res())
  p.on('authenticationFailed', d => rej(new Error('auth geweigerd: ' + JSON.stringify(d))))
  setTimeout(() => rej(new Error('timeout (cold start?)')), 90000)
})
try {
  console.log(`Verbinden met ${DOC} (seed-check)…`)
  await synced
  await new Promise(r => setTimeout(r, 2000))
  const frag = doc.getXmlFragment('default')
  const s = frag.toString()
  const txt = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  console.log('fragment-len', s.length, '| woorden', txt.split(' ').filter(Boolean).length)
  console.log(txt.includes('GVARIA')
    ? '✅ SEED OK — GVARIA staat in het collab-doc! De browser toont je notities.'
    : '❌ geen GVARIA in het doc: ' + txt.slice(0, 140))
  p.destroy(); process.exit(0)
} catch (e) { console.log('❌', e.message); p.destroy(); process.exit(1) }
