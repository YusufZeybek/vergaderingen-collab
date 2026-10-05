/**
 * Sollicitatiegesprek: live samen notities nemen per vraag (Vacatures-module van het portaal).
 *
 * Zelfde techniek als de vergaderingen (Yjs + Tiptap + Hocuspocus op Render), maar met ÉÉN Yjs-doc
 * per gesprek ("vacgesprek:<sollicitatie-id>") en één Tiptap-editor per vraag. Elke editor schrijft
 * in een eigen XmlFragment (field "v_<vraag-id>"), zodat de antwoorden per vraag gescheiden blijven
 * en de server ze per vraag naar MySQL kan terugschrijven. Eén provider, één websocket, één
 * awareness: y-prosemirror houdt per editor bij welke cursor bij welk fragment hoort.
 *
 * Bewust een kleine editor: alinea's, vet/cursief, opsommingen. Geen afbeeldingen of koppen.
 *
 * Gebruik (na het laden van vac-gesprek-collab.bundle.js):
 *   const c = VacGesprekCollab.mount({
 *     wsUrl, docName: 'vacgesprek:167', token, user: { name, color },
 *     velden: [{ element, field: 'v_1a2b3c4d', placeholder: 'Wat zegt de kandidaat?' }, ...],
 *     onStatus(s), onSynced(), onAuthFail(reason), onAanwezig(lijst), onWijziging(field),
 *   })
 *   c.tekst(field)  → platte tekst van één vak
 *   c.destroy()
 */

import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

function colorForName(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 70% 45%)`
}

export function mount({ wsUrl, docName, token, user, velden, onStatus, onSynced, onAuthFail, onAanwezig, onWijziging }) {
  if (!Array.isArray(velden) || !velden.length) throw new Error('mount: geen velden')
  const me = {
    name: (user && user.name) || 'Onbekend',
    color: (user && user.color) || colorForName((user && user.name) || ''),
  }

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docName,
    document: ydoc,
    token: typeof token === 'function' ? token : () => token,
    onAuthenticationFailed: ({ reason }) => { onAuthFail && onAuthFail(reason) },
    onStatus: ({ status }) => { onStatus && onStatus(status) },
    onSynced: ({ state }) => { if (state) onSynced && onSynced() },
  })

  const editors = {}
  velden.forEach(({ element, field, placeholder }) => {
    if (!element || !field) return
    editors[field] = new Editor({
      element,
      extensions: [
        StarterKit.configure({
          undoRedo: false, // Yjs levert de historie
          heading: false, codeBlock: false, blockquote: false, horizontalRule: false, code: false,
          link: false,
        }),
        Placeholder.configure({ placeholder: placeholder || '' }),
        Collaboration.configure({ document: ydoc, field }),
        CollaborationCaret.configure({ provider, user: me }),
      ],
      onUpdate: ({ transaction }) => {
        // Alleen eigen wijzigingen melden, niet wat binnenkomt van een collega.
        if (onWijziging && !transaction.getMeta('y-sync$')) onWijziging(field)
      },
    })
  })

  // Wie zit er mee in het document (awareness: een toestand per open venster).
  const aanwezig = () => {
    const namen = new Map()
    provider.awareness.getStates().forEach((st) => {
      const u = st && st.user
      if (u && u.name) namen.set(u.name, u.color || colorForName(u.name))
    })
    return Array.from(namen, ([name, color]) => ({ name, color }))
  }
  const opAanwezig = () => { onAanwezig && onAanwezig(aanwezig()) }
  provider.awareness.on('change', opAanwezig)

  return {
    provider,
    editors,
    ydoc,
    aanwezig,
    tekst: (field) => (editors[field] ? editors[field].getText({ blockSeparator: '\n' }) : ''),
    focus: (field) => { if (editors[field]) editors[field].commands.focus('end') },
    zetTekst: (field, tekst) => {
      // Voor het vangnet: tekst uit een gewoon vak in een leeg live-vak zetten.
      const ed = editors[field]
      if (!ed || !tekst) return
      const html = String(tekst).split(/\n/).map((r) => '<p>' + r
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>').join('')
      ed.commands.setContent(html)
    },
    destroy: () => {
      provider.awareness.off('change', opAanwezig)
      Object.values(editors).forEach((e) => { try { e.destroy() } catch (_) {} })
      try { provider.destroy() } catch (_) {}
      try { ydoc.destroy() } catch (_) {}
    },
  }
}

export { colorForName }
