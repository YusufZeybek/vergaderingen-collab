# Vergaderingen Collab (Fase 1) — Yjs + Tiptap + Hocuspocus

Echte Google-Docs-achtige live samenwerking voor de Vergaderingen-module: **conflict-vrij gelijktijdig typen** (CRDT) + **zichtbare deelnemer-cursors**. Vervangt de zelfgebouwde block-merge-editor.

## Architectuur

```
  Browser (PHP-pagina)                Render.com (Node)              Combell (PHP/MySQL)
  ┌────────────────────┐   wss://     ┌──────────────────┐   HTTPS   ┌──────────────────┐
  │ Tiptap + Yjs       │◄────────────►│ Hocuspocus server │◄─────────►│ collab.php        │
  │ (dist/...min.js)   │  CRDT-sync   │  - JWT-auth       │  load/    │  - token (sessie) │
  │ HocuspocusProvider │  + cursors   │  - Mongo persist  │  snapshot │  - load stream_html│
  └────────────────────┘              │  - seed/snapshot  │           │  - snapshot→MySQL │
        ▲ JWT van collab.php?token    └────────┬─────────┘           └──────────────────┘
        │                                       │ Yjs-state
        │                              ┌─────────▼────────┐
        └── HTML blijft in MySQL ◄─────│ MongoDB (Atlas)  │  (binaire Yjs-updates)
            (bron-van-waarheid)        └──────────────────┘
```

- **Combell/PHP kan geen WS-server draaien** → die staat op Render. PHP doet enkel: JWT uitgeven, HTML leveren voor de seed, en de HTML-snapshot terug ontvangen.
- **MySQL `stream_html` blijft bron-van-waarheid**: Render schrijft periodiek (debounce 5s) een HTML-snapshot terug → de rest van het portaal (read-only views, export, zoeken) blijft werken. Rollback = feature-flag, geen dataverlies.
- **Seed is race-vrij**: gebeurt server-side in Hocuspocus `onLoadDocument` (één canoniek doc per vergadering), niet client-side.

## Mappenstructuur
- `server/` — Hocuspocus WS-server (deploy naar Render). `server.js`, `package.json`, `render.yaml`, `.env.example`, `dev-server.js` (lokaal testen).
- `editor/` — vanilla Tiptap-bundle. `src/editor.js` → `dist/mtg-collab-editor.min.js` (esbuild). `demo.html` voor lokale 2-tab-test.
- PHP-bridge leeft in het portaal: `personeel/modules/vergaderingen/collab.php`.

## Versies (gepind, juni 2026)
Tiptap **3.27.1** (let op v3: `CollaborationCaret` i.p.v. -cursor, `undoRedo:false` i.p.v. `history:false`), Hocuspocus **4.3.0**, yjs **13.6.31**, y-mongodb-provider **0.2.1**, jsonwebtoken **9.0.3**, esbuild **0.28.1**.

---

## Lokaal testen (bewijst live cursors zonder Render/Mongo/PHP)

```bash
# 1) editor bundelen
cd editor && npm install && npm run build      # → dist/mtg-collab-editor.min.js

# 2) minimale dev-server (geen auth, in-memory, geen Mongo/PHP)
cd ../server && npm install && node dev-server.js   # ws://localhost:1234

# 3) open editor/demo.html in TWEE browser-tabs → typ in beide:
#    je ziet elkaars cursor (naam+kleur) en gelijktijdig typen convergeert zonder verlies.
```

---

## Productie-deploy

### A. Secrets genereren (1×)
```bash
openssl rand -hex 32   # → COLLAB_JWT_SECRET
openssl rand -hex 32   # → COLLAB_SNAPSHOT_SECRET
```

### B. Server-.env (Combell, personeel-portaal) — append, NOOIT .env deployen
```
COLLAB_WS_URL=wss://vergaderingen-collab.onrender.com
COLLAB_JWT_SECRET=<zelfde als Render>
COLLAB_SNAPSHOT_SECRET=<zelfde als Render>
```

### C. Render Web Service (regio Frankfurt = EU/GDPR)
- New → Blueprint (gebruik `server/render.yaml`) of handmatig Web Service, rootDir `server`, `npm install` / `npm start`, plan **Starter** (free slaapt → ongeschikt).
- Env vars: `MONGO_URI`, `COLLAB_JWT_SECRET`, `COLLAB_SNAPSHOT_SECRET` (zelfde als PHP), `PHP_BRIDGE_URL=https://personeel.kvcwesterlo.be/modules/vergaderingen/collab.php`.
- Repo: push deze map naar GitHub (of een subfolder-service) zodat Render kan deployen.

### D. Editor-bundle naar het portaal
```bash
cd editor && npm run build
# kopieer dist/mtg-collab-editor.min.js (+ .map) naar personeel/modules/vergaderingen/collab/
# en deploy via rsync (zie feedback-deploy-ssh)
```

### E. Inschakelen per vergadering (gefaseerd)
1. Eerst voor NIEUWE vergaderingen of een testgroep (feature-flag).
2. De PHP-pagina laadt `mtg-collab-editor.min.js`, haalt een token via `collab.php?action=token&meeting_id=<id>`, en `MtgCollabEditor.mount({...})`.
3. Bestaande/afgesloten vergaderingen blijven read-only uit MySQL tot bewezen stabiel.
4. Pas dan: de oude server-merge (keep-both/3-way) uitzetten.

## Wat de gebruiker (Yusuf) nog moet aanleveren
- **MongoDB-URI** (aparte DB; gratis Atlas-cluster volstaat) → Render `MONGO_URI`.
- **Render-service** aangemaakt (Starter, Frankfurt) — repo pushen.
- De editor-UI-integratie (toolbar-knoppen koppelen aan `c.cmd.*`, en de bestaande opmaak-CSS voor Tiptap's task-list/highlight) is de laatste stap vóór brede uitrol.
