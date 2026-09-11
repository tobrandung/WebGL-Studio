/**
 * Publishes the built widget bundle to the asset CDN and pins its URL.
 *
 * Runs on plain `node` — the types are stripped by the runtime, same as the
 * other scripts here.
 *
 *   npm run publish:widget
 *
 * The bundle lands under `w/<version>-<hash8>/web3d-widget.iife.js`, which is
 * what makes an embed snippet durable: the URL a customer pasted into Webflow
 * keeps resolving to the exact bundle it was generated against, so shipping a
 * new widget cannot change the behaviour of a page nobody is looking at.
 * Publishing the same bytes twice is a no-op.
 *
 * Authentication is a Cloudflare Access **service token** rather than a browser
 * session, because there is no browser here. Create one under Zero Trust →
 * Access → Service Auth and add it to the studio application's policies:
 *
 *   STUDIO_BASE=https://web3d-studio.<subdomain>.workers.dev \
 *   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… npm run publish:widget
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const BUNDLE = join(ROOT, 'dist-widget/web3d-widget.iife.js');
const RELEASE_FILE = join(ROOT, 'src/widget-release.json');
const FILE_NAME = 'web3d-widget.iife.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Fehlt: ${name}. Siehe Kommentar in scripts/publish-widget.ts.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const studioBase = requireEnv('STUDIO_BASE').replace(/\/$/, '');
  const accessHeaders = {
    'CF-Access-Client-Id': requireEnv('CF_ACCESS_CLIENT_ID'),
    'CF-Access-Client-Secret': requireEnv('CF_ACCESS_CLIENT_SECRET'),
  };

  // Copied into a Uint8Array over a plain ArrayBuffer. Node's Buffer is a
  // Uint8Array at runtime, but it is typed over ArrayBufferLike and fetch's
  // BodyInit only accepts a view over an ArrayBuffer.
  let bundle: Uint8Array<ArrayBuffer>;
  try {
    const raw = await readFile(BUNDLE);
    bundle = new Uint8Array(raw.byteLength);
    bundle.set(raw);
  } catch {
    console.error(`${BUNDLE} fehlt. Erst \`npm run build:widget\` ausführen.`);
    process.exit(1);
  }

  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const hash8 = createHash('sha256').update(bundle).digest('hex').slice(0, 8);
  const key = `w/${version}-${hash8}/${FILE_NAME}`;

  const lookup = await fetch(`${studioBase}/api/sign?key=${encodeURIComponent(key)}`, {
    headers: accessHeaders,
    redirect: 'manual',
  });
  if (lookup.status === 401 || lookup.status === 302 || lookup.status === 303) {
    console.error('Access hat die Anfrage abgelehnt – Service-Token prüfen.');
    process.exit(1);
  }
  if (!lookup.ok) {
    console.error(`Abfrage fehlgeschlagen: HTTP ${lookup.status} ${await lookup.text()}`);
    process.exit(1);
  }
  const { exists, publicUrl } = (await lookup.json()) as { exists: boolean; publicUrl: string };

  if (exists) {
    console.log(`Unverändert – ${key} liegt bereits im CDN.`);
  } else {
    const signed = await fetch(`${studioBase}/api/sign`, {
      method: 'POST',
      headers: { ...accessHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        key,
        contentType: 'text/javascript',
        size: bundle.byteLength,
      }),
    });
    if (!signed.ok) {
      console.error(`Signatur fehlgeschlagen: HTTP ${signed.status} ${await signed.text()}`);
      process.exit(1);
    }
    const { uploadUrl, headers } = (await signed.json()) as {
      uploadUrl: string;
      headers: Record<string, string>;
    };

    // The signed headers have to be replayed exactly; content-length is set by
    // undici from the body and is covered by the same signature.
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
      ),
      body: bundle,
    });
    if (!put.ok) {
      console.error(`Upload fehlgeschlagen: HTTP ${put.status} ${await put.text()}`);
      process.exit(1);
    }
    console.log(`Hochgeladen: ${key} (${(bundle.byteLength / 1024).toFixed(0)} kB)`);
  }

  await writeFile(
    RELEASE_FILE,
    `${JSON.stringify({ url: publicUrl, version: `${version}-${hash8}`, publishedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`src/widget-release.json aktualisiert → ${publicUrl}`);
  console.log('Nicht vergessen: die Datei committen, damit neue Embeds diese Version verwenden.');
}

await main();
