/**
 * Lichtgewicht afbeelding-markup: teken pijlen / kaders / cirkels / tekst / vrij op een screenshot,
 * "flatten" naar een nieuwe PNG, upload via het portaal-endpoint en geef de nieuwe URL terug.
 * De geannoteerde afbeelding vervangt de originele in de notitie → voor iedereen zichtbaar via sync.
 *
 * openMarkup({ src, uploadUrl, csrfToken }) → Promise<string|null>  (nieuwe URL, of null bij annuleren)
 */
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e }

export function openMarkup({ src, uploadUrl, csrfToken }) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // zelfde origin → geen taint, toBlob werkt
    img.onerror = () => resolve(null)
    img.onload = () => build()
    img.src = src

    function build() {
      const W = img.naturalWidth || 800, H = img.naturalHeight || 600
      const overlay = el('div', 'mtgmk-overlay')
      const bar = el('div', 'mtgmk-bar')
      const stage = el('div', 'mtgmk-stage')
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H; canvas.className = 'mtgmk-canvas'
      const ctx = canvas.getContext('2d')

      const fit = () => {
        const s = Math.min(window.innerWidth * 0.92 / W, window.innerHeight * 0.74 / H, 1)
        canvas.style.width = Math.round(W * s) + 'px'
        canvas.style.height = Math.round(H * s) + 'px'
      }
      fit()

      const shapes = []
      let tool = 'arrow', color = '#ef4444', cur = null
      const lw = Math.max(2, Math.round(W / 320))
      const fs = Math.max(14, Math.round(W / 26))

      const redraw = () => {
        ctx.clearRect(0, 0, W, H)
        ctx.drawImage(img, 0, 0, W, H)
        const all = cur ? shapes.concat([cur]) : shapes
        for (const s of all) drawShape(ctx, s)
      }
      redraw()

      const pt = (e) => {
        const r = canvas.getBoundingClientRect()
        return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }
      }
      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId)
        const p = pt(e)
        if (tool === 'text') {
          const t = prompt('Tekst:')
          if (t) { shapes.push({ type: 'text', color, x: p.x, y: p.y, text: t, fs }); redraw() }
          return
        }
        cur = { type: tool, color, lw, x0: p.x, y0: p.y, x1: p.x, y1: p.y, points: [[p.x, p.y]] }
      })
      canvas.addEventListener('pointermove', (e) => {
        if (!cur) return
        const p = pt(e); cur.x1 = p.x; cur.y1 = p.y
        if (cur.type === 'pen') cur.points.push([p.x, p.y])
        redraw()
      })
      const end = () => { if (cur) { shapes.push(cur); cur = null; redraw() } }
      canvas.addEventListener('pointerup', end)
      canvas.addEventListener('pointercancel', end)

      // --- toolbar ---
      const tool_ = (name, label, title) => {
        const b = el('button', 'mtgmk-tool' + (name === tool ? ' is-active' : ''))
        b.innerHTML = label; b.title = title; b.type = 'button'
        b.onclick = () => { tool = name; bar.querySelectorAll('.mtgmk-tool').forEach(x => x.classList.remove('is-active')); b.classList.add('is-active') }
        return b
      }
      const sep = () => el('span', 'mtgmk-sep')
      bar.append(
        tool_('arrow', '↗', 'Pijl'),
        tool_('rect', '▭', 'Kader'),
        tool_('ellipse', '◯', 'Cirkel'),
        tool_('pen', '✎', 'Vrij tekenen'),
        tool_('text', 'T', 'Tekst'),
        sep(),
      )
      ;['#ef4444', '#1182A4', '#22c55e', '#eab308', '#111827', '#ffffff'].forEach((c, i) => {
        const sw = el('button', 'mtgmk-color' + (i === 0 ? ' is-active' : ''))
        sw.type = 'button'; sw.style.background = c; sw.title = 'Kleur'
        sw.onclick = () => { color = c; bar.querySelectorAll('.mtgmk-color').forEach(x => x.classList.remove('is-active')); sw.classList.add('is-active') }
        bar.append(sw)
      })
      const undo = el('button', 'mtgmk-act'); undo.type = 'button'; undo.textContent = '↶'; undo.title = 'Ongedaan'
      undo.onclick = () => { shapes.pop(); redraw() }
      const spacer = el('span', 'mtgmk-spacer')
      const cancel = el('button', 'mtgmk-act'); cancel.type = 'button'; cancel.textContent = 'Annuleer'
      cancel.onclick = () => { close(); resolve(null) }
      const done = el('button', 'mtgmk-act mtgmk-done'); done.type = 'button'; done.textContent = '✓ Klaar'
      done.onclick = () => {
        done.disabled = true; done.textContent = 'Opslaan…'
        canvas.toBlob(async (blob) => {
          if (!blob) { close(); return resolve(null) }
          try {
            const fd = new FormData()
            fd.append('image', blob, 'markup.png'); fd.append('file', blob, 'markup.png')
            const res = await fetch(uploadUrl, {
              method: 'POST', credentials: 'include',
              headers: { 'X-Requested-With': 'XMLHttpRequest', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
              body: fd,
            })
            const data = await res.json().catch(() => ({}))
            close(); resolve(data.url || data.src || data.path || data.location || null)
          } catch (e) { close(); resolve(null) }
        }, 'image/png')
      }
      bar.append(sep(), undo, spacer, cancel, done)

      stage.append(canvas)
      overlay.append(bar, stage)
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); resolve(null) } })
      document.body.append(overlay)
      window.addEventListener('resize', fit)
      function close() { window.removeEventListener('resize', fit); overlay.remove() }
    }
  })
}

function drawShape(ctx, s) {
  ctx.save()
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.lw || 3
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  if (s.type === 'rect') {
    ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0))
  } else if (s.type === 'ellipse') {
    ctx.beginPath(); ctx.ellipse((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.abs(s.x1 - s.x0) / 2, Math.abs(s.y1 - s.y0) / 2, 0, 0, 2 * Math.PI); ctx.stroke()
  } else if (s.type === 'pen') {
    ctx.beginPath(); s.points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke()
  } else if (s.type === 'text') {
    ctx.font = `bold ${s.fs}px system-ui, -apple-system, sans-serif`; ctx.textBaseline = 'top'
    ctx.lineWidth = Math.max(3, s.fs / 6); ctx.strokeStyle = 'rgba(255,255,255,.9)'
    ctx.strokeText(s.text, s.x, s.y); ctx.fillStyle = s.color; ctx.fillText(s.text, s.x, s.y)
  } else if (s.type === 'arrow') {
    ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke()
    const a = Math.atan2(s.y1 - s.y0, s.x1 - s.x0), h = Math.max(12, (s.lw || 3) * 4.5)
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x1 - h * Math.cos(a - Math.PI / 6), s.y1 - h * Math.sin(a - Math.PI / 6))
    ctx.lineTo(s.x1 - h * Math.cos(a + Math.PI / 6), s.y1 - h * Math.sin(a + Math.PI / 6))
    ctx.closePath(); ctx.fill()
  }
  ctx.restore()
}
