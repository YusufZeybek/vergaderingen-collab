/**
 * Vergaderingen Collab Editor — vanilla Tiptap v3 + Yjs + Hocuspocus.
 *
 * Gebundeld door esbuild tot één IIFE-global `window.MtgCollabEditor` zodat de PHP-module het met
 * een <script>-tag kan laden (geen React/Vue, geen module-loader nodig op de pagina).
 *
 * Gebruik (in de PHP-pagina, ná het laden van dist/mtg-collab-editor.min.js):
 *   const c = MtgCollabEditor.mount({
 *     element: document.querySelector('#mtgCollabDoc'),
 *     wsUrl:   'wss://vergaderingen-collab.onrender.com',
 *     docName: 'meeting:77',
 *     token:   '<jwt van collab.php?action=token>',
 *     user:    { name: 'Yusuf', color: '#1182A4' },
 *     onStatus(s){...}, onAuthFail(r){...}, onSynced(){...},
 *   });
 *   // c.editor (Tiptap), c.provider (Hocuspocus), c.cmd (toolbar-commando's), c.destroy()
 */

import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { openMarkup } from './markup.js'

const FIELD = 'default'

// Upload-context voor de afbeeldings-NodeView (gezet in mount()).
let _uploadUrl = 'api.php?action=upload_stream_image'
let _csrf = ''

/** Image met breedte + uitlijning + een NodeView: sleep-hoekjes, S/M/L, links/midden/rechts,
 *  en een "Markeer"-knop die de markup-tool opent. width/data-align = zelfde conventie als de
 *  oude editor → kruis-compatibel in MySQL stream_html. */
const ResizableImage = Image.extend({
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
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrap = document.createElement('div')
      wrap.className = 'mtgc-img-wrap'
      const img = document.createElement('img')
      img.src = node.attrs.src
      if (node.attrs.alt) img.alt = node.attrs.alt
      const apply = () => {
        img.style.width = node.attrs.width ? node.attrs.width + 'px' : ''
        wrap.setAttribute('data-align', node.attrs.align || '')
      }
      apply()
      wrap.appendChild(img)

      const setAttrs = (attrs) => {
        if (typeof getPos !== 'function') return
        editor.chain().focus().setNodeSelection(getPos()).updateAttributes('image', attrs).run()
      }
      const btn = (label, title, fn) => {
        const b = document.createElement('button')
        b.type = 'button'; b.innerHTML = label; b.title = title; b.className = 'mtgc-img-tb'
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', (e) => { e.preventDefault(); fn() })
        return b
      }
      const tsep = () => { const s = document.createElement('span'); s.className = 'mtgc-img-tsep'; return s }
      const toolbar = document.createElement('div')
      toolbar.className = 'mtgc-img-toolbar'
      toolbar.append(
        btn('S', 'Klein', () => setAttrs({ width: Math.round((img.naturalWidth || 600) * 0.33) })),
        btn('M', 'Middel', () => setAttrs({ width: Math.round((img.naturalWidth || 600) * 0.6) })),
        btn('L', 'Groot', () => setAttrs({ width: null })),
        tsep(),
        btn('⟸', 'Links', () => setAttrs({ align: 'left' })),
        btn('≡', 'Midden', () => setAttrs({ align: 'center' })),
        btn('⟹', 'Rechts', () => setAttrs({ align: 'right' })),
        tsep(),
        btn('✎ Markeer', 'Tekenen op afbeelding', async () => {
          const url = await openMarkup({ src: node.attrs.src, uploadUrl: _uploadUrl, csrfToken: _csrf })
          if (url) setAttrs({ src: url })
        }),
        btn('🗑', 'Verwijderen', () => {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).deleteSelection().run()
        }),
      )
      wrap.appendChild(toolbar)

      // Sleep-hoekjes
      ;['nw', 'ne', 'sw', 'se'].forEach((c) => {
        const h = document.createElement('span')
        h.className = 'mtgc-img-h mtgc-img-h-' + c
        h.addEventListener('pointerdown', (e) => startResize(e, c))
        wrap.appendChild(h)
      })
      function startResize(e, corner) {
        e.preventDefault(); e.stopPropagation()
        const startX = e.clientX
        const startW = img.getBoundingClientRect().width
        const dir = (corner === 'ne' || corner === 'se') ? 1 : -1
        const onMove = (ev) => { img.style.width = Math.max(60, startW + dir * (ev.clientX - startX)) + 'px' }
        const onUp = () => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          setAttrs({ width: Math.round(img.getBoundingClientRect().width) })
        }
        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
      }

      return {
        dom: wrap,
        update: (updated) => {
          if (updated.type.name !== 'image') return false
          node = updated; img.src = node.attrs.src; apply(); return true
        },
        selectNode: () => wrap.classList.add('is-selected'),
        deselectNode: () => wrap.classList.remove('is-selected'),
        ignoreMutation: () => true,
      }
    }
  },
})

// Stabiele kleur per gebruikersnaam (zelfde palet-idee als de oude remote-carets).
function colorForName(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 70% 45%)`
}

export function mount({ element, wsUrl, docName, token, user, onStatus, onAuthFail, onSynced, uploadUrl, csrfToken }) {
  if (!element) throw new Error('mount: element ontbreekt')
  if (uploadUrl) _uploadUrl = uploadUrl
  _csrf = csrfToken || ''
  const me = {
    name: (user && user.name) || 'Onbekend',
    color: (user && user.color) || colorForName((user && user.name) || ''),
  }

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docName,
    document: ydoc,
    // Functie zodat bij reconnect een vers JWT opgehaald kan worden (token kan verlopen).
    token: typeof token === 'function' ? token : () => token,
    onAuthenticationFailed: ({ reason }) => { onAuthFail && onAuthFail(reason) },
    onStatus: ({ status }) => { onStatus && onStatus(status) },
    onSynced: ({ state }) => { if (state) onSynced && onSynced() },
  })

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }), // Yjs levert de history; v3-naam
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      TaskList,
      TaskItem.configure({ nested: true }),
      ResizableImage,
      Collaboration.configure({ document: ydoc, field: FIELD }),
      CollaborationCaret.configure({ provider, user: me }),
    ],
    // GEEN `content` — Yjs is de bron; seed gebeurt server-side (onLoadDocument).
  })

  // Commando's voor de bestaande toolbar-knoppen.
  const cmd = {
    bold: () => editor.chain().focus().toggleBold().run(),
    italic: () => editor.chain().focus().toggleItalic().run(),
    underline: () => editor.chain().focus().toggleUnderline().run(),
    heading: (level) => editor.chain().focus().toggleHeading({ level }).run(),
    bulletList: () => editor.chain().focus().toggleBulletList().run(),
    orderedList: () => editor.chain().focus().toggleOrderedList().run(),
    taskList: () => editor.chain().focus().toggleTaskList().run(),
    highlight: (color) => editor.chain().focus().toggleHighlight(color ? { color } : {}).run(),
    color: (color) => (color ? editor.chain().focus().setColor(color).run() : editor.chain().focus().unsetColor().run()),
    image: (src, alt) => editor.chain().focus().setImage({ src, alt: alt || '' }).run(),
    isActive: (name, attrs) => editor.isActive(name, attrs),
  }

  function updateUser(u) {
    Object.assign(me, u || {})
    if (editor.commands.updateUser) editor.commands.updateUser(me)
  }

  function destroy() {
    try { editor.destroy() } catch (e) {}
    try { provider.destroy() } catch (e) {}
    try { ydoc.destroy() } catch (e) {}
  }

  return { editor, provider, ydoc, cmd, updateUser, destroy }
}

export { colorForName }
