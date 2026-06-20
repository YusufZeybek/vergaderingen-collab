/**
 * Headless bewijs van conflict-vrije CRDT-sync met de ECHTE stack (yjs + @hocuspocus/provider)
 * tegen een lokale dev-server. Twee onafhankelijke clients; een edit in client A moet bij client
 * B landen, en GELIJKTIJDIGE edits moeten convergeren (geen verlies/dubbeling).
 *
 * Run: dev-server draait op ws://localhost:1234, dan: node sync-test.mjs
 */
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const URL = 'ws://localhost:1234'
const DOC = 'synctest:' + Date.now()

function client(name) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: URL, name: DOC, document: doc, token: 'dev',
    WebSocketPolyfill: globalThis.WebSocket, // node 25 heeft global WebSocket
  })
  return { doc, provider, text: doc.getText('t') }
}

const synced = (p) => new Promise((res) => p.on('synced', () => res()))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n, x ?? '') } }

const A = client('A')
const B = client('B')
await Promise.all([synced(A.provider), synced(B.provider)])
console.log('[1] beide clients gesynchroniseerd')

// A typt → moet bij B landen
A.text.insert(0, 'Hallo van A. ')
await wait(400)
ok('A→B propagatie', B.text.toString().includes('Hallo van A.'), JSON.stringify(B.text.toString()))

// Gelijktijdige edits aan WEERSZIJDEN → convergentie zonder verlies
A.text.insert(A.text.length, '[A-eind]')
B.text.insert(0, '[B-begin]')
await wait(600)
const ta = A.text.toString(), tb = B.text.toString()
ok('A en B convergeren naar identieke staat', ta === tb, `\n    A=${JSON.stringify(ta)}\n    B=${JSON.stringify(tb)}`)
ok('geen dataverlies (beide edits aanwezig)', ta.includes('[A-eind]') && ta.includes('[B-begin]') && ta.includes('Hallo van A.'), JSON.stringify(ta))

// Derde, verse client krijgt de volledige staat van de server (persistente sync)
const C = client('C')
await synced(C.provider)
await wait(300)
ok('verse client C krijgt volledige doc-staat', C.text.toString() === ta, `\n    C=${JSON.stringify(C.text.toString())}`)

A.provider.destroy(); B.provider.destroy(); C.provider.destroy()
console.log(`\n=== ${pass} pass / ${fail} fail ===`)
process.exit(fail ? 1 : 0)
