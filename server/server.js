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
 * Sinds 5 okt 2026 ook "vacgesprek:<sollicitatie-id>": de live notities van een sollicitatiegesprek
 * (Vacatures-module). Eén doc per gesprek met een XmlFragment per vraag ("v_<vraag-id>"). Die docs
 * hebben een eigen PHP-bridge (VAC_BRIDGE_URL) en een STRIKTE doc-binding in onAuthenticate: het
 * gaat om kandidatendossiers, een token voor iets anders mag er nooit binnen.
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

// Image met width + data-align — MOET overeenkomen met de client (editor.js) zodat de breedte/
// uitlijning de HTML-snapshot overleeft (anders strippen generateHTML/generateJSON ze).
const ImageWithAttrs = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => { const w = el.getAttribute('width'); return w ? parseInt(w, 10) : null },
        renderHTML: (a) => (a.width ? { width: a.width } : {}),
      },
      align: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-align'),
        renderHTML: (a) => (a.align ? { 'data-align': a.align } : {}),
      },
    }
  },
})

const extensions = [
  StarterKit.configure({ undoRedo: false }), // v3-naam! Yjs doet de undo/redo-historie
  Underline,
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  TaskList,
  TaskItem.configure({ nested: true }),
  ImageWithAttrs,
]

// .trim() = robuust tegen een onzichtbare spatie/newline die bij plakken in Render env kan sluipen
// (zou anders de HMAC-vergelijking breken → permission-denied).
const PORT = process.env.PORT || '10000'
const MONGO_URI = (process.env.MONGO_URI || '').trim()
const COLLAB_JWT_SECRET = (process.env.COLLAB_JWT_SECRET || '').trim()
const COLLAB_SNAPSHOT_SECRET = (process.env.COLLAB_SNAPSHOT_SECRET || '').trim()
const PHP_BRIDGE_URL = (process.env.PHP_BRIDGE_URL || '').trim()
// Bridge voor de gespreksnotities. Standaard naast die van de vergaderingen, zodat er op Render
// geen extra env-variabele nodig is.
const VAC_BRIDGE_URL = (process.env.VAC_BRIDGE_URL
  || PHP_BRIDGE_URL.replace('/modules/vergaderingen/collab.php', '/modules/vacatures/collab.php')).trim()
const VAC = 'vacgesprek:'
const VAC_FIELD = /^v_[a-z0-9]{4,16}$/
const VERSIE = '2026-10-05-vacgesprek'

const isVac = (naam) => String(naam || '').startsWith(VAC)
const normDoc = (naam) => { try { return decodeURIComponent(String(naam || '')) } catch (_) { return String(naam || '') } }

for (const [k, v] of Object.entries({ MONGO_URI, COLLAB_JWT_SECRET, COLLAB_SNAPSHOT_SECRET, PHP_BRIDGE_URL })) {
  if (!v) { console.error(`[FATAL] env ${k} ontbreekt`); process.exit(1) }
}

const mdb = new MongodbPersistence(MONGO_URI, { collectionName: 'yjs-docs', flushSize: 100 })

// Debounce per documentnaam voor de (duurdere) HTML→MySQL-snapshot.
const snapshotTimers = new Map()

// Diagnostiek: onthoud de laatste auth-poging zodat /debug 'm kan tonen (geen logs nodig).
let lastAuth = null

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

/* ── Gespreksnotities (vacgesprek:<id>) ─────────────────────────────────────── */

/** Bestaande notities uit MySQL in lege velden zetten (bv. na verlies van de Mongo-state). */
async function seedGesprek(documentName, document) {
  let velden = {}
  try {
    const res = await fetch(`${VAC_BRIDGE_URL}?action=load&doc=${encodeURIComponent(documentName)}`,
      { headers: { 'X-Collab-Secret': COLLAB_SNAPSHOT_SECRET } })
    if (!res.ok) { console.warn(`[gesprek] load HTTP ${res.status} voor ${documentName}`); return }
    const data = await res.json().catch(() => ({}))
    velden = (data && typeof data.velden === 'object' && data.velden) || {}
  } catch (e) { console.warn('[gesprek] load:', e.message); return }

  for (const [veld, html] of Object.entries(velden)) {
    if (!VAC_FIELD.test(veld) || typeof html !== 'string' || !html.trim()) continue
    if (document.getXmlFragment(veld).length > 0) continue // al inhoud: Mongo wint
    try {
      const json = generateJSON(html, extensions)
      if (!json || !Array.isArray(json.content) || !json.content.length) continue
      const seeded = TiptapTransformer.toYdoc(json, veld, extensions)
      Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded))
    } catch (e) { console.warn(`[gesprek] seed ${documentName}/${veld}:`, e.message) }
  }
}

/** Elk vraagveld als HTML terug naar MySQL. */
async function snapshotGesprek(documentName, document) {
  const velden = {}
  for (const veld of Array.from(document.share.keys())) {
    if (!VAC_FIELD.test(veld)) continue
    try {
      velden[veld] = generateHTML(TiptapTransformer.fromYdoc(document, veld), extensions)
    } catch (e) { console.warn(`[gesprek] html ${documentName}/${veld}:`, e.message) }
  }
  if (!Object.keys(velden).length) return
  try {
    const res = await fetch(`${VAC_BRIDGE_URL}?action=snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Collab-Secret': COLLAB_SNAPSHOT_SECRET },
      body: JSON.stringify({ doc: documentName, velden }),
    })
    if (!res.ok) console.warn(`[gesprek] snapshot HTTP ${res.status} voor ${documentName}`)
  } catch (e) { console.warn(`[gesprek] snapshot ${documentName}:`, e.message) }
}

const server = new Server({
  port: Number(PORT),
  address: '0.0.0.0',
  name: 'vergaderingen-collab',
  // Doc direct uit RAM lossen zodra de laatste verbinding weg is → geen "stale" document in
  // geheugen (anders blijft oude/test-inhoud hangen ondanks een lege DB). Bij heropenen wordt
  // vers uit Mongo/MySQL geladen.
  unloadImmediately: true,

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
        vacBridge: VAC_BRIDGE_URL,
        versie: VERSIE,
        lastAuth, // laatste auth-poging (kreeg de server een token? lengte? foutreden?)
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
  async onAuthenticate({ token, documentName, requestParameters }) {
    const tlen = token ? String(token).length : 0
    // Fallback: token mag ook als query-param ?token= meekomen (sommige proxies leveren de
    // Hocuspocus-auth-message minder betrouwbaar af dan een URL-param).
    let tok = token
    if ((!tok || tlen === 0) && requestParameters && typeof requestParameters.get === 'function') {
      tok = requestParameters.get('token') || tok
    }
    const usedLen = tok ? String(tok).length : 0
    let payload
    try {
      payload = jwt.verify(tok, COLLAB_JWT_SECRET, { algorithms: ['HS256'] })
    } catch (e) {
      lastAuth = { ok: false, tokenLen: tlen, paramLen: requestParameters && requestParameters.get ? (requestParameters.get('token') || '').length : 0, usedLen, docName: documentName, error: e.message, ts: new Date().toISOString() }
      console.warn('[auth] JWT verify faalde:', e.message, '| secret-len', COLLAB_JWT_SECRET.length, '| token-len', tlen, '| param-len', lastAuth.paramLen)
      throw new Error('Not authorized')
    }
    // Gespreksnotities: STRIKT. Een token voor een gesprek opent enkel dat gesprek, en een
    // gesprek opent enkel met een token dat ervoor uitgegeven is (ook geen vergadertoken).
    if ((isVac(documentName) || isVac(payload.doc)) && normDoc(payload.doc) !== normDoc(documentName)) {
      lastAuth = { ok: false, docName: documentName, error: 'vac-doc-binding', ts: new Date().toISOString() }
      console.warn('[auth] gesprek-doc geweigerd:', JSON.stringify(payload.doc), 'vs', JSON.stringify(documentName))
      throw new Error('Not authorized')
    }
    if (payload.doc && payload.doc !== documentName) {
      console.warn('[auth] doc-verschil (toegestaan):', JSON.stringify(payload.doc), 'vs', JSON.stringify(documentName))
    }
    lastAuth = { ok: true, tokenLen: tlen, usedLen, docName: documentName, name: payload.name, ts: new Date().toISOString() }
    console.log('[auth] OK voor', payload.name, '| doc', JSON.stringify(documentName))
    return { user: { id: payload.sub, name: payload.name || 'Onbekend', color: payload.color || '#1182A4' } }
  },

  // Eénmalige, race-vrije seed: server bezit het canonieke doc; draait 1× bij laden.
  async onLoadDocument({ documentName, document }) {
    if (isVac(documentName)) { await seedGesprek(documentName, document); return document }
    if (document.getXmlFragment(FIELD).length > 0) return document // al inhoud
    let html = ''
    try { html = await fetchStreamHtml(documentName) } catch (e) { console.warn('[seed]', e.message) }
    if (html && html.trim()) {
      let json = null
      try { json = generateJSON(html, extensions) }
      catch (e) { console.warn(`[seed] generateJSON faalde voor ${documentName}:`, e.message) }
      // VANGNET: als parsen faalt of leeg blijft maar er WAS tekst → behoud minstens de tekst als
      // alinea's (split op block-grenzen). Zo opent geen enkele oude vergadering ooit leeg.
      const hasContent = json && Array.isArray(json.content) && json.content.length > 0
      if (!hasContent) {
        const lines = html
          .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          .split('\n').map(s => s.trim()).filter(Boolean)
        if (lines.length) {
          json = { type: 'doc', content: lines.map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })) }
          console.warn(`[seed] fallback-tekst gebruikt voor ${documentName} (${lines.length} regels)`)
        }
      }
      if (json && Array.isArray(json.content) && json.content.length) {
        try {
          const seeded = TiptapTransformer.toYdoc(json, FIELD, extensions)
          Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded))
        } catch (e) {
          console.warn(`[seed] toYdoc mislukt voor ${documentName}:`, e.message)
        }
      }
    }
    return document
  },

  // HTML-snapshot terug naar MySQL — gedebounced (5s) per doc.
  async afterStoreDocument({ documentName, document }) {
    if (isVac(documentName)) {
      // Gespreksnotities sneller terug (3s): de evaluatie en het dossier lezen ze uit MySQL.
      clearTimeout(snapshotTimers.get(documentName))
      snapshotTimers.set(documentName, setTimeout(() => {
        snapshotTimers.delete(documentName)
        snapshotGesprek(documentName, document)
      }, 3000))
      return
    }
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
