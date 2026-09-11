# Cloudflare-Infrastruktur

Zwei Worker und ein R2-Bucket. Beides läuft im Free Tier: R2 gibt 10 GB Speicher
und **kostenlosen Egress**, Workers 100.000 Requests/Tag, Cloudflare Access
50 Nutzer.

```
infra/cdn/     web3d-cdn     GET /a/:key      öffentlich, ohne Access
infra/studio/  web3d-studio  SPA + /api/*     hinter Cloudflare Access
```

Die Trennung ist der Kern des Setups: das Studio darf nur brandung sehen, die
Assets muss jede Kundenseite laden können. **Niemals eine Access-Policy auf
`web3d-cdn` legen** – damit wären alle eingebetteten Widgets auf Kundenseiten
sofort tot.

Der eigentliche Upload läuft an beiden Workern vorbei: `/api/sign` gibt eine
presigned URL aus, der Browser lädt direkt nach R2. Deshalb greift das
100-MB-Request-Limit des Free-Plans nicht.

## Einrichtung

Reihenfolge einhalten – der Studio-Worker braucht die CDN-URL, und die
Access-Policy braucht den deployten Worker.

### 0. Beim richtigen Cloudflare-Konto anmelden

`wrangler login` fragt **nicht**, als wer du dich anmelden willst: der
OAuth-Flow übernimmt die Cloudflare-Session, die im Standardbrowser gerade
aktiv ist. Wer dort mit einem anderen Konto eingeloggt ist, deployt still und
leise in das falsche – die eingetippte Adresse spielt keine Rolle.

Deterministisch ist deshalb der Weg über ein API-Token, das gar keine
Browser-Session anfassen kann:

1. Im **richtigen** Konto: Dashboard → My Profile → API Tokens → *Create Token*
   → Vorlage **Edit Cloudflare Workers** (enthält auch Workers R2 Storage).
2. Account-ID aus der Übersichtsseite dazunehmen, falls das Konto mehrere hat.

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…      # nur nötig bei mehreren Konten
npx wrangler whoami                 # prüfen, bevor irgendwas deployt wird
```

Wer lieber OAuth nutzt: vorher auf `dash.cloudflare.com` ausloggen oder den
Login-Link in einem privaten Fenster öffnen, sonst greift wieder dieselbe
Session.

`npx wrangler whoami` vor jedem Schritt ist die billigste Absicherung – ein
Deploy ins falsche Konto fällt sonst erst auf, wenn die Worker-URL nicht
erreichbar ist.

**Token-Hygiene:** `wrangler logout` verweigert die Arbeit, wenn das
Access-Token bereits abgelaufen ist – das langlebige Refresh-Token bleibt dann
in `~/Library/Preferences/.wrangler/config/default.toml` liegen. Muss ein
Zugang wirklich entwertet werden, hilft nur der Widerruf am Endpunkt:

```bash
curl -X POST https://dash.cloudflare.com/oauth2/revoke \
  --data-urlencode "client_id=54d11594-84e4-41aa-b438-e81b8fa78ee7" \
  --data-urlencode "token=<refresh_token aus der Datei>"
```

### 1. Bucket

```bash
npx wrangler r2 bucket create web3d-assets
```

CORS für den Direkt-Upload. Die Regel liegt versioniert in
`infra/r2/cors.json` – setzen, sobald die Studio-Origin bekannt ist (also nach
Schritt 4), und die Origin dort bei einer neuen Subdomain nachziehen:

```bash
npx wrangler r2 bucket cors set web3d-assets --file infra/r2/cors.json
npx wrangler r2 bucket cors list web3d-assets
```

Achtung beim Schema: die CLI erwartet das native R2-Format
(`{"rules":[{"allowed":{"origins":…,"methods":…,"headers":…}}]}`), während der
JSON-Editor im Dashboard die S3-Schreibweise mit `AllowedOrigins` nutzt. Wer das
verwechselt, bekommt nur „must contain a 'rules' array".

Ohne diese Regel schlägt jeder Upload als Netzwerkfehler fehl – der Browser
zeigt dann keinen HTTP-Status, sondern nur einen abgebrochenen Request.

### 2. CDN-Worker

```bash
cd infra/cdn && npx wrangler deploy
```

Die ausgegebene `https://web3d-cdn.<subdomain>.workers.dev` in
`infra/studio/wrangler.toml` als `CDN_BASE` eintragen.

### 3. R2-API-Token

Dashboard → R2 → API → *Manage API tokens* → **Object Read & Write**, nur für
`web3d-assets`. Die Account-ID steht auf derselben Seite.

```bash
cd infra/studio
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

### 4. Studio-Worker

```bash
npm run build          # erzeugt dist/, das der Worker als Static Assets ausliefert
cd infra/studio && npx wrangler deploy
```

### 5. Cloudflare Access

Zero Trust einmalig initialisieren (Team-Namen wählen, Free-Plan). Dann
Workers & Pages → `web3d-studio` → Settings → **Access** aktivieren, Policy:

- Action: *Allow*
- Include: *Emails ending in* → `@brandung.de`

Login per One-Time-PIN an die Mailadresse – kein Identity Provider nötig.

Das funktioniert auch auf `*.workers.dev`, weil die Policy am Worker hängt und
nicht an einem Hostname. Genau deshalb braucht dieses Setup keine eigene
DNS-Zone.

Anschließend aus Zero Trust → Access → Applications → `web3d-studio` in
`infra/studio/wrangler.toml` eintragen:

- `ACCESS_AUD` – der *Application Audience tag*
- `ACCESS_TEAM_DOMAIN` – z. B. `brandung.cloudflareaccess.com`

Beide **müssen** gesetzt sein. Fehlt eines, fällt `src/auth.ts` auf die
lokale `DEV_IDENTITY` zurück – in einem deployten Worker heißt das: jeder
`/api/*`-Aufruf wird abgelehnt, nicht durchgelassen.

### 6. Widget veröffentlichen

Für `scripts/publish-widget.ts` ein **Service Token** anlegen (Zero Trust →
Access → Service Auth) und es in den Policies der Studio-Application unter
*Service Auth* zulassen.

```bash
STUDIO_BASE=https://web3d-studio.<subdomain>.workers.dev \
CF_ACCESS_CLIENT_ID=… \
CF_ACCESS_CLIENT_SECRET=… \
npm run publish:widget
```

Das Skript schreibt `src/widget-release.json` – **committen**, sonst erzeugen
neue Embeds weiter die alte Bundle-URL.

## Lokale Entwicklung

```bash
cd infra/studio && npx wrangler dev    # Terminal 1, Port 8787
npm run dev                            # Terminal 2, Port 5173
```

Der Vite-Proxy leitet `/api` an 8787 weiter, sodass der Client immer denselben
relativen Pfad nutzt. Ohne `ACCESS_AUD` akzeptiert der Worker eine
`DEV_IDENTITY` aus `[vars]` – nur lokal wirksam.

Komplett ohne Worker arbeiten: `VITE_ASSET_HOSTING=off` in `.env.local`. Der
Export-Dialog zeigt dann nur Download und „in Ordner speichern".

## Was wo liegt

| Prefix | Inhalt | Cache-Control |
|---|---|---|
| `a/<16 hex>.<ext>` | Modelle und HDRIs, content-adressiert | `immutable`, 1 Jahr |
| `w/<version>-<hash>/…js` | Widget-Bundles | `immutable`, 1 Jahr |
| `p/<uuid>.json` | Projekt-Dokumente (Szene, keine Binärdaten) | `no-store` |

Die Grammatik dieser Keys steht in `src/lib/storage/asset-key.ts` – einmal, für
Browser und Worker gemeinsam. `infra/shared/asset-key.ts` re-exportiert sie nur.

## Grenzen und Kosten

- **50 MB pro Datei.** Geprüft im Client *und* über die signierte
  `Content-Length`, die R2 selbst durchsetzt. Größere Modelle erst im Editor
  über „Optimieren" verkleinern.
- **2 MB pro Projekt-Dokument.** Der einzige Posten, der unbemerkt wachsen
  kann, ist das Thumbnail (Data-URL).
- Assets werden beim Löschen eines Projekts **nicht** entfernt: sie sind
  content-adressiert, können von mehreren Projekten geteilt werden und bedienen
  womöglich noch ein Embed auf einer Kundenseite.
