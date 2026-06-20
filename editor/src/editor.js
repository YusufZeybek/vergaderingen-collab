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

const FIELD = 'default'

// Stabiele kleur per gebruikersnaam (zelfde palet-idee als de oude remote-carets).
function colorForName(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 70% 45%)`
}

export function mount({ element, wsUrl, docName, token, user, onStatus, onAuthFail, onSynced }) {
  if (!element) throw new Error('mount: element ontbreekt')
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
      Image,
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
