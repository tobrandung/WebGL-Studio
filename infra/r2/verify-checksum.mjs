/**
 * Proves that R2 enforces the signed SHA-256 checksum — the guarantee behind
 * content addressing.
 *
 * `handleSign` puts `x-amz-checksum-sha256` into the signature and refuses a
 * checksum that disagrees with the key. That is only worth anything if R2
 * actually recomputes the digest and rejects a mismatch, so this asks it
 * directly instead of taking the documentation's word for it:
 *
 *   1. a body that matches its checksum          → expected 200
 *   2. a different body under the same signature → expected 4xx
 *   3. the stored object                         → must still be the body from 1
 *
 * Reads credentials from infra/studio/.dev.vars and never prints them. Run:
 *
 *   node infra/r2/verify-checksum.mjs
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsV4Signer } from 'aws4fetch';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const VARS = join(ROOT, 'infra/studio/.dev.vars');
const BUCKET = 'web3d-assets';

async function credentials() {
  let text;
  try {
    text = await readFile(VARS, 'utf8');
  } catch {
    console.error(`${VARS} fehlt. Lege die Datei mit den R2-Zugangsdaten an:\n`);
    console.error('  R2_ACCOUNT_ID=…\n  R2_ACCESS_KEY_ID=…\n  R2_SECRET_ACCESS_KEY=…\n');
    console.error('Sie ist in .gitignore und wird von diesem Skript nie ausgegeben.');
    process.exit(1);
  }
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!env[name]) {
      console.error(`${name} fehlt in ${VARS}.`);
      process.exit(1);
    }
  }
  return env;
}

/** The same signature handleSign produces, so this tests the real thing. */
async function signPut(env, key, size, checksum) {
  const signer = new AwsV4Signer({
    url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${key}?X-Amz-Expires=300`,
    method: 'PUT',
    headers: {
      'content-type': 'model/gltf-binary',
      'content-length': String(size),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-amz-checksum-sha256': checksum,
    },
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    signQuery: true,
    allHeaders: true,
  });
  const signed = await signer.sign();
  return signed.url.toString();
}

function put(url, body) {
  return fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': 'model/gltf-binary',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64'),
    },
    body,
  });
}

const env = await credentials();

// Same length on purpose: content-length is signed too, and equal sizes keep
// this a test of the checksum rather than of the size guard.
const honest = Buffer.from('AAAAAAAAAAAAAAAA');
const forged = Buffer.from('BBBBBBBBBBBBBBBB');

const digest = createHash('sha256').update(honest).digest();
const key = `a/${digest.toString('hex').slice(0, 16)}.glb`;
const url = await signPut(env, key, honest.byteLength, digest.toString('base64'));

console.log(`Key: ${key}\n`);

const first = await put(url, honest);
console.log(`1. passender Body            → HTTP ${first.status} ${first.ok ? '(ok, erwartet 200)' : '(UNERWARTET)'}`);

// Reuses the very signature that approved `honest`, with different bytes — the
// attack this is meant to stop. The checksum header must stay the signed one,
// otherwise R2 would reject the signature and prove nothing about the digest.
const second = await fetch(url, {
  method: 'PUT',
  headers: {
    'content-type': 'model/gltf-binary',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-amz-checksum-sha256': digest.toString('base64'),
  },
  body: forged,
});
const secondBody = (await second.text()).replace(/\s+/g, ' ').slice(0, 160);
console.log(
  `2. fremder Body, gleiche Signatur → HTTP ${second.status} ${second.status >= 400 ? '(abgelehnt, wie erwartet)' : '(UNERWARTET AKZEPTIERT)'}`,
);
if (secondBody) console.log(`   R2 sagt: ${secondBody}`);

const readBack = await (async () => {
  const getUrl = await new AwsV4Signer({
    url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${key}?X-Amz-Expires=300`,
    method: 'GET',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    signQuery: true,
  }).sign();
  const res = await fetch(getUrl.url.toString());
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
})();

const intact = readBack !== null && readBack.equals(honest);
console.log(`3. gespeicherte Bytes            → ${intact ? 'unverändert (ok)' : 'VERÄNDERT ODER FEHLT'}`);

const pass = first.ok && second.status >= 400 && intact;
console.log(`\n${pass ? '✓ R2 erzwingt die Prüfsumme.' : '✗ Die Annahme trägt nicht — nicht deployen.'}`);
process.exit(pass ? 0 : 1);
