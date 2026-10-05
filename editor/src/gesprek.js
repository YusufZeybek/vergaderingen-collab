/**
 * Sollicitatiegesprek: live notities per vraag (Vacatures-module van het portaal).
 *
 * Zelfde techniek als de vergaderingen (Yjs + Tiptap + Hocuspocus op Render), maar elke persoon aan
 * tafel heeft een EIGEN document per gesprek: "vacgesprek:<sollicitatie-id>:u<user-id>", met een
 * XmlFragment per vraag ("v_<vraag-id>"). Je typt enkel in je eigen vakken; de vakken van je
 * collega's lees je live mee (alleen-lezen). De server dwingt dat af: op andermans document is de
 * verbinding read-only, elke wijziging wordt geweigerd. Zo kan niemand de tekst van een ander
 * aanpassen, en is altijd duidelijk wie wat schreef.
 *
 * Alle documenten lopen over ÉÉN websocket (HocuspocusProviderWebsocket, providers gekoppeld met
 * attach()). Bewust een kleine editor: alinea's, vet/cursief, opsommingen.
 *
 * Gebruik (na het laden van vac-gesprek-collab.bundle.js):
 *   const c = VacGesprekCollab.mount({
 *     wsUrl, token, user: { name, color },
 *     docs: [
 *       { docName: 'vacgesprek:167:u9', schrijven: true,
 *         velden: [{ element, field: 'v_1a2b3c4d', placeholder: '…' }, …] },
 *       { docName: 'vacgesprek:167:u34', schrijven: false, velden: [...] },
 *     ],
 *     onStatus(s), onSynced(), onAuthFail(docName, reason), onAanwezig(lijst), onInhoud(docName, field, leeg),
 *   })
 *   c.tekst(docName, field), c.leeg(docName, field), c.destroy()
 */

import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'

function colorForName(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 70% 45%)`
}

export function mount({ wsUrl, token, user, docs, onStatus, onSynced, onAuthFail, onAanwezig, onInhoud }) {
  if (!Array.isArray(docs) || !docs.length) throw new Error('mount: geen documenten')
  const me = {
    name: (user && user.name) || 'Onbekend',
    color: (user && user.color) || colorForName((user && user.name) || ''),
  }
  const tok = typeof token === 'function' ? token : () => token

  const socket = new HocuspocusProviderWebsocket({ url: wsUrl })
  socket.on('status', ({ status }) => { onStatus && onStatus(status) })

  // Pas "gesynct" als elk document zijn eerste sync kreeg.
  const nogTeSyncen = new Set(docs.map((d) => d.docName))

  // onInhoud hoogstens één keer per beeldje en per vak, zodat snel typen het scherm niet afremt.
  const teMelden = new Map()
  let meldGepland = false
  const meldInhoud = (docName, field, ed) => {
    if (!onInhoud) return
    teMelden.set(docName + '\u0000' + field, [docName, field, ed])
    if (meldGepland) return
    meldGepland = true
    requestAnimationFrame(() => {
      meldGepland = false
      const lijst = Array.from(teMelden.values())
      teMelden.clear()
      lijst.forEach(([d, f, e]) => onInhoud(d, f, e.isEmpty))
    })
  }

  const aanwezig = () => {
    const namen = new Map()
    providers.forEach(({ provider }) => {
      provider.awareness && provider.awareness.getStates().forEach((st) => {
        const u = st && st.user
        if (u && u.name) namen.set(u.name, u.color || colorForName(u.name))
      })
    })
    return Array.from(namen, ([name, color]) => ({ name, color }))
  }
  const opAanwezig = () => { onAanwezig && onAanwezig(aanwezig()) }

  const providers = docs.map(({ docName, schrijven, velden }) => {
    const ydoc = new Y.Doc()
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docName,
      document: ydoc,
      token: tok,
      onAuthenticationFailed: ({ reason }) => { onAuthFail && onAuthFail(docName, reason) },
      onSynced: ({ state }) => {
        if (!state) return
        nogTeSyncen.delete(docName)
        if (!nogTeSyncen.size && onSynced) onSynced()
      },
    })
    provider.attach()
    if (provider.awareness) {
      provider.awareness.setLocalStateField('user', me)
      provider.awareness.on('change', opAanwezig)
    }

    const editors = {}
    ;(velden || []).forEach(({ element, field, placeholder }) => {
      if (!element || !field) return
      const ed = new Editor({
        element,
        editable: !!schrijven,
        extensions: [
          StarterKit.configure({
            undoRedo: false, // Yjs levert de historie
            heading: false, codeBlock: false, blockquote: false, horizontalRule: false, code: false,
            link: false,
          }),
          Placeholder.configure({ placeholder: schrijven ? (placeholder || '') : '' }),
          Collaboration.configure({ document: ydoc, field }),
        ],
        onUpdate: () => meldInhoud(docName, field, ed),
        onCreate: () => meldInhoud(docName, field, ed),
      })
      editors[field] = ed
    })
    return { docName, ydoc, provider, editors }
  })

  const zoek = (docName) => providers.find((p) => p.docName === docName)

  return {
    socket,
    aanwezig,
    tekst: (docName, field) => {
      const p = zoek(docName)
      return p && p.editors[field] ? p.editors[field].getText({ blockSeparator: '\n' }) : ''
    },
    leeg: (docName, field) => {
      const p = zoek(docName)
      return !p || !p.editors[field] || p.editors[field].isEmpty
    },
    destroy: () => {
      providers.forEach(({ provider, ydoc, editors }) => {
        if (provider.awareness) provider.awareness.off('change', opAanwezig)
        Object.values(editors).forEach((e) => { try { e.destroy() } catch (_) {} })
        try { provider.destroy() } catch (_) {}
        try { ydoc.destroy() } catch (_) {}
      })
      try { socket.destroy() } catch (_) {}
    },
  }
}

export { colorForName }
