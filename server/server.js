/**
 * Vergaderingen Collab Server — Hocuspocus (Yjs) WebSocket-server.
 *
 * Draait op Render.com (Web Service, WebSockets out-of-the-box). De PHP/Combell-kant kan dit niet
 * (geen langlopende processen). Verantwoordelijkheden:
 *   - WebSocket-sync van de Yjs-documenten (conflict-vrij gelijktijdig typen + live cursors)
 *   - JWT-auth (HS256, gedeeld geheim met PHP) in onAuthenticate
 *   - Persistentie van de binaire Yjs-state naar MongoDB (y-mongodb-provider)
 *   - Eénmalige seed van bestaande MySQL-HTML in een leeg doc (onLoadDocument → PHP GET)
 *   - Periodieke HTML-snapshot TERUG naar MySQL (afterStoreDocument → PHP POST), zodat de rest
 *     van het portaal op de HTML-kolom blijft werken en MySQL bron-van-waarheid blijft.
 *
 * Documentnaam-conventie: "meeting:<id>" (1 Yjs-doc per vergadering).
 *
 * Env (zie .env.example):
 *   PORT                     (Render zet dit; default 10000)
 *   MONGO_URI                MongoDB-connectiestring (aparte DB voor collab)
 *   COLLAB_JWT_SECRET        gedeeld HS256-geheim met PHP (token-uitgifte)
 *   COLLAB_SNAPSHOT_SECRET   gedeeld geheim voor de PHP load/snapshot-bridge
 *   PHP_BRIDGE_URL           bv https://personeel.kvcwesterlo.be/modules/vergaderingen/collab.php
 */

import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { MongodbPersistence } from 'y-mongodb-provider'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { generateHTML, generateJSON } from '@tiptap/html'
import jwt from 'jsonwebtoken'
import * as Y from 'yjs'

// Schema-pariteit: EXACT dezelfde extensie-set als de client (editor/src/editor.js),
// anders mist de server nodes/marks bij HTML-generatie en gaat opmaak verloren.
import { StarterKit } from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'

const FIELD = 'default' // XmlFragment-naam die Tiptap Collaboration standaard gebruikt

const extensions = [
  StarterKit.configure({ undoRedo: false }), // v3-naam! Yjs doet de undo/redo-historie
  Underline,
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
]

// .trim() = robuust tegen een onzichtbare spatie/newline die bij plakken in Render env kan sluipen
// (zou anders de HMAC-vergelijking breken → permission-denied).
const PORT = process.env.PORT || '10000'
const MONGO_URI = (process.env.MONGO_URI || '').trim()
const COLLAB_JWT_SECRET = (process.env.COLLAB_JWT_SECRET || '').trim()
const COLLAB_SNAPSHOT_SECRET = (process.env.COLLAB_SNAPSHOT_SECRET || '').trim()
const PHP_BRIDGE_URL = (process.env.PHP_BRIDGE_URL || '').trim()

for (const [k, v] of Object.entries({ MONGO_URI, COLLAB_JWT_SECRET, COLLAB_SNAPSHOT_SECRET, PHP_BRIDGE_URL })) {
  if (!v) { console.error(`[FATAL] env ${k} ontbreekt`); process.exit(1) }
}

const mdb = new MongodbPersistence(MONGO_URI, { collectionName: 'yjs-docs', flushSize: 100 })

// Debounce per documentnaam voor de (duurdere) HTML→MySQL-snapshot.
const snapshotTimers = new Map()

/** Haal de bestaande MySQL-HTML op voor de eenmalige seed van een leeg doc. */
async function fetchStreamHtml(documentName) {
  const url = `${PHP_BRIDGE_URL}?action=load&doc=${encodeURIComponent(documentName)}`
  const res = await fetch(url, { headers: { 'X-Collab-Secret': COLLAB_SNAPSHOT_SECRET } })
  if (!res.ok) { console.warn(`[seed] load HTTP ${res.status} voor ${documentName}`); return '' }
  const data = await res.json().catch(() => ({}))
  return typeof data.html === 'string' ? data.html : ''
}

/** Schrijf de HTML-snapshot terug naar MySQL (bron-van-waarheid voor de rest van het portaal). */
async function postSnapshot(documentName, html) {
  try {
    const res = await fetch(`${PHP_BRIDGE_URL}?action=snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Collab-Secret': COLLAB_SNAPSHOT_SECRET },
      body: JSON.stringify({ doc: documentName, html }),
    })
    if (!res.ok) console.warn(`[snapshot] HTTP ${res.status} voor ${documentName}`)
  } catch (e) {
    console.warn(`[snapshot] mislukt voor ${documentName}:`, e.message)
  }
}

const server = new Server({
  port: Number(PORT),
  address: '0.0.0.0',
  name: 'vergaderingen-collab',

  // Tijdelijk debug-endpoint (gated): GET /debug?key=<COLLAB_SNAPSHOT_SECRET> → bevestigt welke
  // secrets de DRAAIENDE server ziet, zonder logs te hoeven lezen. Verwijderbaar na go-live.
  onRequest({ request, response }) {
    return new Promise((resolve, reject) => {
      const url = request.url || ''
      if (!url.startsWith('/debug')) return resolve()
      const key = new URL(url, 'http://x').searchParams.get('key')
      if (key !== COLLAB_SNAPSHOT_SECRET) { response.writeHead(403); response.end('forbidden'); return reject() }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        jwtSecretLen: COLLAB_JWT_SECRET.length,
        jwtSecretHead: COLLAB_JWT_SECRET.slice(0, 6),
        jwtSecretTail: COLLAB_JWT_SECRET.slice(-4),
        snapshotLen: COLLAB_SNAPSHOT_SECRET.length,
        mongoHost: (MONGO_URI.match(/@([^/?]+)/) || [])[1] || null,
        bridge: PHP_BRIDGE_URL,
      }))
      return reject()
    })
  },

  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const persisted = await mdb.getYDoc(documentName)
        const update = Y.encodeStateAsUpdate(persisted)
        return update.length ? update : null
      },
      store: async ({ documentName, state }) => {
        await mdb.storeUpdate(documentName, state)
      },
    }),
  ],

  // JWT valideren (HS256, gedeeld geheim met PHP). Throw = connectie geweigerd.
  async onAuthenticate({ token, documentName }) {
    let payload
    try {
      payload = jwt.verify(token, COLLAB_JWT_SECRET, { algorithms: ['HS256'] })
    } catch (e) {
      console.warn('[auth] JWT verify faalde:', e.message, '| secret-len', COLLAB_JWT_SECRET.length, '| token-len', token ? token.length : 0)
      throw new Error('Not authorized')
    }
    // Doc-binding: NIET blokkeren (Render kan de ':' in de doc-naam anders in het pad encoderen
    // → vals-negatief). Enkel loggen voor de zekerheid; de echte gate is de JWT-handtekening.
    if (payload.doc && payload.doc !== documentName) {
      console.warn('[auth] doc-verschil (toegestaan):', JSON.stringify(payload.doc), 'vs', JSON.stringify(documentName))
    }
    console.log('[auth] OK voor', payload.name, '| doc', JSON.stringify(documentName))
    return { user: { id: payload.sub, name: payload.name || 'Onbekend', color: payload.color || '#1182A4' } }
  },

  // Eénmalige, race-vrije seed: server bezit het canonieke doc; draait 1× bij laden.
  async onLoadDocument({ documentName, document }) {
    if (document.getXmlFragment(FIELD).length > 0) return document // al inhoud
    let html = ''
    try { html = await fetchStreamHtml(documentName) } catch (e) { console.warn('[seed]', e.message) }
    if (html && html.trim()) {
      try {
        const json = generateJSON(html, extensions)
        const seeded = TiptapTransformer.toYdoc(json, FIELD, extensions)
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded))
      } catch (e) {
        console.warn(`[seed] HTML→Ydoc mislukt voor ${documentName}:`, e.message)
      }
    }
    return document
  },

  // HTML-snapshot terug naar MySQL — gedebounced (5s) per doc.
  async afterStoreDocument({ documentName, document }) {
    clearTimeout(snapshotTimers.get(documentName))
    snapshotTimers.set(documentName, setTimeout(async () => {
      snapshotTimers.delete(documentName)
      try {
        const json = TiptapTransformer.fromYdoc(document, FIELD)
        const html = generateHTML(json, extensions)
        await postSnapshot(documentName, html)
      } catch (e) {
        console.warn(`[snapshot] genereren mislukt voor ${documentName}:`, e.message)
      }
    }, 5000))
  },
})

server.listen()
console.log(`[vergaderingen-collab] luistert op :${PORT}`)
