/** Lokale diagnostiek: zelfde onAuthenticate als server.js + logging. Geen Mongo/PHP. */
import { Server } from '@hocuspocus/server'
import jwt from 'jsonwebtoken'
const SECRET = process.env.JWT_SECRET
const server = new Server({
  port: 1235, address: '127.0.0.1',
  async onAuthenticate({ token, documentName }) {
    console.log('[auth] token aanwezig?', !!token, '| len', token ? token.length : 0, '| docName', JSON.stringify(documentName))
    let payload
    try { payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] }) }
    catch (e) { console.log('[auth] verify FOUT:', e.message); throw new Error('Not authorized') }
    console.log('[auth] verify OK | payload.doc', JSON.stringify(payload.doc))
    if (payload.doc && payload.doc !== documentName) { console.log('[auth] DOC MISMATCH'); throw new Error('doc mismatch') }
    console.log('[auth] ✅ toegelaten')
    return { user: { name: payload.name } }
  },
})
server.listen()
console.log('[authtest] ws://localhost:1235')
