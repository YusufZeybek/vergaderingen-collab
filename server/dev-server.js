/**
 * Lokale dev-server: Hocuspocus ZONDER auth/Mongo/PHP, in-memory. Enkel om live cursors +
 * conflict-vrij gelijktijdig typen lokaal te bewijzen (open editor/demo.html in 2 tabs).
 * NIET voor productie — productie = server.js.
 */
import { Server } from '@hocuspocus/server'

const server = new Server({
  port: 1234,
  address: '127.0.0.1',
  name: 'collab-dev',
  // geen onAuthenticate → alle connecties toegestaan (enkel lokaal!)
})

server.listen()
console.log('[dev] Hocuspocus op ws://localhost:1234 (geen auth, in-memory)')
