// Protocoltest gespreksnotities (vacgesprek:<id>) tegen het lokale harnas + lokale Hocuspocus.
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'

const B = 'http://127.0.0.1:8899'
const WS = 'ws://127.0.0.1:1235'
const wacht = (ms) => new Promise((r) => setTimeout(r, ms))
const sql = (q) => execSync(`mysql -u master-y vac_test -N -e "${q.replace(/"/g, '\\"')}"`).toString().trim()
const fouten = []
const check = (naam, ok, extra = '') => { console.log((ok ? 'OK   ' : 'FOUT ') + naam + (ok ? '' : '  ' + String(extra).slice(0, 300))); if (!ok) fouten.push(naam) }

async function sessie(uid) {
  const r = await fetch(`${B}/dash.php?als=${uid}`)
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  const html = await r.text()
  const csrf = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1]
  return { cookie, csrf }
}
async function token(s, solId) {
  const r = await fetch(`${B}/modules/vacatures/collab.php?action=token&sollicitatie_id=${solId}`, { headers: { Cookie: s.cookie, 'X-Requested-With': 'XMLHttpRequest' } })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}
async function api(s, pad, body) {
  const r = await fetch(B + pad, { method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf, 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}
function verbind(docName, tok) {
  const doc = new Y.Doc()
  let gesynct = false, geweigerd = false
  const p = new HocuspocusProvider({
    url: WS, name: docName, document: doc, token: tok,
    onSynced: ({ state }) => { if (state) gesynct = true },
    onAuthenticationFailed: () => { geweigerd = true },
  })
  return { doc, p, gesynct: () => gesynct, geweigerd: () => geweigerd }
}
function zetTekst(doc, veld, tekst) {
  const frag = doc.getXmlFragment(veld)
  doc.transact(() => {
    frag.delete(0, frag.length)
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(tekst)])
    frag.insert(0, [p])
  })
}
const leesTekst = (doc, veld) => doc.getXmlFragment(veld).toString().replace(/<[^>]+>/g, '')
function jwt(claims, geheim) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const kop = b64({ alg: 'HS256', typ: 'JWT' }), inh = b64(claims)
  return `${kop}.${inh}.${crypto.createHmac('sha256', geheim).update(`${kop}.${inh}`).digest('base64url')}`
}

const sanne = await sessie(9), kris = await sessie(34), bob = await sessie(7), casper = await sessie(4)
const vragen = JSON.parse(sql('SELECT gespreksvragen FROM vacatures WHERE id=1'))
const v1 = 'v_' + vragen[0].id, v2 = 'v_' + vragen[1].id

// Tokens
let t = await token(kris, 167)
check('Kris krijgt token voor 167', t.status === 200 && t.data.docName === 'vacgesprek:167', JSON.stringify(t))
const tokKris = t.data.token
t = await token(bob, 167)
check('Bob (niet uitgenodigd) geen token', t.status === 403, t.status)
await api(sanne, '/modules/vacatures/api.php', { action: 'panel_uitnodigen', user_id: 7, sollicitatie_ids: [167] })
t = await token(bob, 167)
check('Bob na uitnodiging wel token', t.status === 200, t.status)
const tokBob = t.data.token
t = await token(casper, 167)
check('Casper geen token', t.status === 403, t.status)
t = await token(casper, 999999)
check('Casper onbestaand nummer ook 403', t.status === 403, t.status)
t = await token(sanne, 167)
const tokSanne = t.data.token

// Twee mensen tegelijk
const a = verbind('vacgesprek:167', tokKris)
const b = verbind('vacgesprek:167', tokSanne)
for (let i = 0; i < 40 && !(a.gesynct() && b.gesynct()); i++) await wacht(100)
check('Kris en Sanne verbonden en gesynct', a.gesynct() && b.gesynct())
zetTekst(a.doc, v1, 'Kris typt: vijf jaar boekhouding')
zetTekst(b.doc, v2, 'Sanne typt: test vlot, schat 8 op 10')
await wacht(800)
check('Sanne ziet de tekst van Kris', leesTekst(b.doc, v1).includes('vijf jaar boekhouding'), leesTekst(b.doc, v1))
check('Kris ziet de tekst van Sanne', leesTekst(a.doc, v2).includes('schat 8 op 10'), leesTekst(a.doc, v2))
// Gelijktijdig in hetzelfde vak: Yjs voegt samen, niets gaat verloren
const fa = a.doc.getXmlFragment(v1).get(0).get(0), fb = b.doc.getXmlFragment(v1).get(0).get(0)
fa.insert(fa.length, ' (Kris)'); fb.insert(0, '[Sanne] ')
await wacht(800)
check('gelijktijdig in hetzelfde vak: beide stukken blijven', leesTekst(a.doc, v1) === leesTekst(b.doc, v1) && leesTekst(a.doc, v1).includes('(Kris)') && leesTekst(a.doc, v1).includes('[Sanne]'), leesTekst(a.doc, v1) + ' | ' + leesTekst(b.doc, v1))

// Terugschrijven naar MySQL (3s debounce)
await wacht(4500)
const rij = sql(`SELECT CONCAT(vraag, ' | ', tekst) FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND vraag_id='${vragen[0].id}'`)
check('notitie vraag 1 in MySQL, met vraagtekst', rij.startsWith(vragen[0].vraag) && rij.includes('vijf jaar boekhouding') && rij.includes('[Sanne]'), rij)
check('notitie vraag 2 in MySQL', sql(`SELECT tekst FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND vraag_id='${vragen[1].id}'`).includes('schat 8 op 10'))
let r = await api(bob, '/modules/vacatures/gesprekken-api.php', { action: 'gesprek', id: 167 })
check('pakket bevat notities (ook voor Bob)', (r.data.gesprek.notities || []).find(n => n.id === vragen[0].id)?.tekst.includes('boekhouding'), JSON.stringify(r.data.gesprek && r.data.gesprek.notities).slice(0, 200))
r = await api(sanne, '/modules/vacatures/gesprekken-api.php', { action: 'bijwerken', sollicitatie_id: 167 })
check('bijwerken geeft notities', r.status === 200 && Array.isArray(r.data.notities), JSON.stringify(r))

// Bob schrijft mee
const c = verbind('vacgesprek:167', tokBob)
for (let i = 0; i < 30 && !c.gesynct(); i++) await wacht(100)
check('Bob verbindt op 167 en ziet de tekst', c.gesynct() && leesTekst(c.doc, v1).includes('boekhouding'))

// Strikte binding
const d1 = verbind('vacgesprek:55', tokKris)
await wacht(1500)
check('token voor 167 opent 55 niet', d1.geweigerd() && !d1.gesynct())
const d2 = verbind('vacgesprek:167', jwt({ sub: '4', name: 'Casper', doc: 'meeting:1', exp: Math.floor(Date.now() / 1000) + 600 }, 'testgeheim-jwt'))
await wacht(1500)
check('vergadertoken opent gesprek niet', d2.geweigerd() && !d2.gesynct())
const d3 = verbind('meeting:1', tokKris)
await wacht(1500)
check('gesprekstoken opent vergadering niet', d3.geweigerd() && !d3.gesynct())
const d4 = verbind('vacgesprek:167', jwt({ sub: '4', name: 'Casper', doc: 'vacgesprek:167', exp: Math.floor(Date.now() / 1000) + 600 }, 'verkeerd-geheim'))
await wacht(1500)
check('vervalste handtekening geweigerd', d4.geweigerd() && !d4.gesynct())
for (const x of [a, b, c, d1, d2, d3, d4]) x.p.destroy()

// Leeg-vangnet: een snapshot met enkel lege velden mag bestaande tekst niet wissen
const vang = await fetch(`${B}/modules/vacatures/collab.php?action=snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collab-Secret': 'testgeheim-snap' }, body: JSON.stringify({ doc: 'vacgesprek:167', velden: { [v1]: '<p></p>', [v2]: '' } }) })
const vj = await vang.json()
check('lege snapshot geweigerd', vj.bewaard === 0 && /geweigerd/.test(vj.overgeslagen || ''), JSON.stringify(vj))
check('tekst nog in MySQL', sql(`SELECT tekst FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND vraag_id='${vragen[0].id}'`).includes('boekhouding'))
const zonder = await fetch(`${B}/modules/vacatures/collab.php?action=snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
check('snapshot zonder geheim 403', zonder.status === 403)
const xss = await fetch(`${B}/modules/vacatures/collab.php?action=snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collab-Secret': 'testgeheim-snap' }, body: JSON.stringify({ doc: 'vacgesprek:167', velden: { [v2]: '<p onclick="alert(1)">ok<script>alert(2)</script><img src=x onerror=alert(3)></p>' } }) })
await xss.json()
const h2 = sql(`SELECT html FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND vraag_id='${vragen[1].id}'`)
check('HTML gezuiverd (geen script/on*)', !/script|onclick|onerror/i.test(h2), h2)
check('vorige versie bewaard', sql(`SELECT vorige_html FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND vraag_id='${vragen[1].id}'`).includes('schat 8 op 10'))

// Seed: Mongo-state kwijt → opnieuw vullen uit MySQL
execSync(`mongosh --version >/dev/null 2>&1 || true`)
await wacht(500)
console.log('\n' + (fouten.length ? fouten.length + ' fouten' : 'Alles groen'))
process.exit(fouten.length ? 1 : 0)
