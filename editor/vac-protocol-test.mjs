// Protocoltest gespreksnotities per persoon (vacgesprek:<id>:u<user>) tegen het lokale harnas +
// lokale Hocuspocus: eigen document schrijven, collega's alleen-lezen (server-afgedwongen).
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
  return { cookie, csrf: (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1] }
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
  const p = new HocuspocusProvider({ url: WS, name: docName, document: doc, token: tok,
    onSynced: ({ state }) => { if (state) gesynct = true }, onAuthenticationFailed: () => { geweigerd = true } })
  return { doc, p, gesynct: () => gesynct, geweigerd: () => geweigerd }
}
function zetTekst(doc, veld, tekst) {
  const frag = doc.getXmlFragment(veld)
  doc.transact(() => {
    frag.delete(0, frag.length)
    const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText(tekst)]); frag.insert(0, [p])
  })
}
const lees = (doc, veld) => doc.getXmlFragment(veld).toString().replace(/<[^>]+>/g, '')
function jwt(claims, geheim) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const kop = b64({ alg: 'HS256', typ: 'JWT' }), inh = b64(claims)
  return `${kop}.${inh}.${crypto.createHmac('sha256', geheim).update(`${kop}.${inh}`).digest('base64url')}`
}

const sanne = await sessie(9), kris = await sessie(34), bob = await sessie(7), casper = await sessie(4)
const vragen = JSON.parse(sql('SELECT gespreksvragen FROM vacatures WHERE id=1'))
const v1 = 'v_' + vragen[0].id, v2 = 'v_' + vragen[1].id
await api(sanne, '/modules/vacatures/api.php', { action: 'overzicht' })
check('notitietabel kreeg user_id (migratie)', sql("SHOW COLUMNS FROM vacature_gesprek_notities LIKE 'user_id'").startsWith('user_id'))
check('unieke sleutel per persoon', sql("SHOW INDEX FROM vacature_gesprek_notities WHERE Key_name='uq_sol_vraag_user'").length > 0 && sql("SHOW INDEX FROM vacature_gesprek_notities WHERE Key_name='uq_sol_vraag'") === '')

// Tokens en documentlijst
let t = await token(kris, 167)
check('Kris token 167', t.status === 200 && t.data.docName === 'vacgesprek:167', JSON.stringify(t).slice(0, 200))
const docsKris = t.data.docs || []
check('Kris: eigen doc schrijvend, Sanne lezend', docsKris[0]?.docName === 'vacgesprek:167:u34' && docsKris[0].schrijven === true && docsKris.some(d => d.docName === 'vacgesprek:167:u9' && !d.schrijven), JSON.stringify(docsKris))
const tokKris = t.data.token
t = await token(bob, 167); check('Bob zonder uitnodiging geen token', t.status === 403)
await api(sanne, '/modules/vacatures/api.php', { action: 'panel_uitnodigen', user_id: 7, sollicitatie_ids: [167] })
t = await token(bob, 167); const tokBob = t.data.token
check('Bob na uitnodiging: eigen doc + Kris + Sanne', t.status === 200 && t.data.docs[0].docName === 'vacgesprek:167:u7' && t.data.docs.length === 3, JSON.stringify(t.data.docs))
t = await token(kris, 167)
check('Kris ziet Bob nu ook in de lijst', t.data.docs.some(d => d.docName === 'vacgesprek:167:u7'))
t = await token(casper, 167); check('Casper geen token', t.status === 403)
t = await token(sanne, 167); const tokSanne = t.data.token

// Kris schrijft in zijn eigen document, Sanne leest live mee
const kEigen = verbind('vacgesprek:167:u34', tokKris)
const sLeestK = verbind('vacgesprek:167:u34', tokSanne)
const sEigen = verbind('vacgesprek:167:u9', tokSanne)
for (let i = 0; i < 40 && !(kEigen.gesynct() && sLeestK.gesynct() && sEigen.gesynct()); i++) await wacht(100)
check('alle drie verbonden', kEigen.gesynct() && sLeestK.gesynct() && sEigen.gesynct())
zetTekst(kEigen.doc, v1, 'Kris: vijf jaar boekhouding')
zetTekst(sEigen.doc, v1, 'Sanne: kent AFAS')
await wacht(900)
check('Sanne ziet live wat Kris in zijn vak typt', lees(sLeestK.doc, v1) === 'Kris: vijf jaar boekhouding', lees(sLeestK.doc, v1))

// Sanne probeert in het vak van Kris te schrijven: de server weigert
zetTekst(sLeestK.doc, v1, 'GEKAAPT door Sanne')
await wacht(1200)
check('Kris zijn tekst blijft ongewijzigd (alleen-lezen afgedwongen)', lees(kEigen.doc, v1) === 'Kris: vijf jaar boekhouding', lees(kEigen.doc, v1))
const derde = verbind('vacgesprek:167:u34', tokKris)
for (let i = 0; i < 30 && !derde.gesynct(); i++) await wacht(100)
check('ook een verse verbinding ziet de originele tekst', lees(derde.doc, v1) === 'Kris: vijf jaar boekhouding', lees(derde.doc, v1))

// Terugschrijven naar MySQL, per persoon
await wacht(4500)
check('MySQL: rij voor Kris', sql(`SELECT tekst FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND user_id=34 AND vraag_id='${vragen[0].id}'`) === 'Kris: vijf jaar boekhouding')
check('MySQL: rij voor Sanne', sql(`SELECT tekst FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND user_id=9 AND vraag_id='${vragen[0].id}'`) === 'Sanne: kent AFAS')
check('MySQL: geen gekaapte tekst', !sql(`SELECT GROUP_CONCAT(tekst) FROM vacature_gesprek_notities WHERE sollicitatie_id=167`).includes('GEKAAPT'))
let r = await api(bob, '/modules/vacatures/gesprekken-api.php', { action: 'gesprek', id: 167 })
const n1 = (r.data.gesprek?.notities || []).find(n => n.id === vragen[0].id)
check('pakket: antwoorden per persoon met naam', n1 && n1.antwoorden.length === 2 && n1.antwoorden.some(a => a.naam === 'Kris Vandepaer') && n1.antwoorden.some(a => a.naam === 'Sanne Leirs'), JSON.stringify(n1))
check('pakket kent ik', r.data.gesprek?.ik === 7)

// Strikte binding
const x1 = verbind('vacgesprek:55:u34', tokKris); const x2 = verbind('vacgesprek:167', tokKris)
const x3 = verbind('meeting:1', tokKris)
const x4 = verbind('vacgesprek:167:u34', jwt({ sub: '4', name: 'Casper', doc: 'meeting:1', exp: Math.floor(Date.now() / 1000) + 600 }, 'testgeheim-jwt'))
const x5 = verbind('vacgesprek:167:u4', jwt({ sub: '4', name: 'Casper', doc: 'vacgesprek:167', exp: Math.floor(Date.now() / 1000) + 600 }, 'verkeerd'))
await wacht(2000)
check('token 167 opent gesprek 55 niet', x1.geweigerd() && !x1.gesynct())
check('oud formaat zonder persoon geweigerd', x2.geweigerd() && !x2.gesynct())
check('gesprekstoken opent vergadering niet', x3.geweigerd() && !x3.gesynct())
check('vergadertoken opent gesprek niet', x4.geweigerd() && !x4.gesynct())
check('vervalste handtekening geweigerd', x5.geweigerd() && !x5.gesynct())
for (const v of [kEigen, sLeestK, sEigen, derde, x1, x2, x3, x4, x5]) v.p.destroy()

// Vangnet en zuivering, per persoon
const post = (body) => fetch(`${B}/modules/vacatures/collab.php?action=snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Collab-Secret': 'testgeheim-snap' }, body: JSON.stringify(body) }).then(x => x.json())
let j = await post({ doc: 'vacgesprek:167:u34', velden: { [v1]: '<p></p>', [v2]: '' } })
check('lege snapshot boven tekst geweigerd', j.bewaard === 0 && /geweigerd/.test(j.overgeslagen || ''), JSON.stringify(j))
j = await post({ doc: 'vacgesprek:167', velden: { [v1]: '<p>x</p>' } })
check('snapshot zonder persoon in docnaam geweigerd', j.error === 'ongeldig doc', JSON.stringify(j))
await post({ doc: 'vacgesprek:167:u9', velden: { [v2]: '<p onclick="alert(1)">ok<script>alert(2)</script></p>' } })
check('HTML gezuiverd', !/script|onclick/i.test(sql(`SELECT html FROM vacature_gesprek_notities WHERE sollicitatie_id=167 AND user_id=9 AND vraag_id='${vragen[1].id}'`)))

console.log('\n' + (fouten.length ? fouten.length + ' fouten' : 'Alles groen'))
process.exit(fouten.length ? 1 : 0)
