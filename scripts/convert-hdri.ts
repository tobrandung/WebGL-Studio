/**
 * Turns source `.exr` / `.hdr` files into web-ready presets under
 * `public/hdri/`, plus the generated manifest the picker reads.
 *
 * Output is Ultra HDR, not Radiance. Radiance is the format this wrote first,
 * and it is the one the studio cannot publish: `image/vnd.radiance` is not on
 * the upload allowlist, deliberately, because a 1k `.hdr` is 1.4 MB and has no
 * business on a web page. Every project that picked a preset therefore failed
 * to share its environment. Ultra HDR keeps the real highlight range at about a
 * tenth of the size and is an ordinary JPEG to anything that does not know
 * about gain maps.
 *
 * Decode and resample still run on plain `node`: they are pure arithmetic and
 * every module below `src/lib/hdri/` that this touches is DOM-free on purpose.
 * The encoder is the exception. It drives gain-map passes through a
 * `WebGLRenderer`, so that step goes to a headless Chrome over
 * `scripts/browser-encoder.ts`, running the app's own encoder. Pass
 * `--radiance` for the old behaviour, which needs no browser.
 *
 *   node scripts/convert-hdri.ts
 *   node scripts/convert-hdri.ts assets/example-hdris/satara_night_4k.exr --size 2048x1024
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertToRadiance, equirectHeightFor } from '../src/lib/hdri/pipeline.ts';
import { extensionForFormat, slugifyName } from '../src/lib/hdri/format.ts';
import { startBrowserEncoder, type BrowserEncoder } from './browser-encoder.ts';
import { sampleSwatch } from '../src/lib/hdri/swatch.ts';
import type { HdriPreset } from '../src/lib/hdri/types.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DEFAULT_SOURCE_DIR = join(ROOT, 'assets/example-hdris');
const DEFAULT_OUT_DIR = join(ROOT, 'public/hdri');
const DEFAULT_MANIFEST = join(ROOT, 'src/lib/hdri/presets.generated.ts');
/** Scratch space for the float dumps the browser encoder reads. Removed after. */
const TMP_DIR = join(ROOT, '.hdri-encode');
const SOURCE_EXTENSIONS = new Set(['.exr', '.hdr']);

type Options = {
  files: string[];
  sizes: Array<{ width: number; height: number }>;
  outDir: string;
  manifest: string;
  preferFloat32: boolean;
  force: boolean;
  dryRun: boolean;
  /** Write Radiance instead of Ultra HDR. Needs no browser, cannot be published. */
  radiance: boolean;
};

function parseArgs(argv: string[]): Options {
  const files: string[] = [];
  const sizes: Array<{ width: number; height: number }> = [];
  let outDir = DEFAULT_OUT_DIR;
  let manifest = DEFAULT_MANIFEST;
  let preferFloat32 = true;
  let force = false;
  let dryRun = false;
  let radiance = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--size': {
        const value = argv[++i] ?? '';
        const match = /^(\d+)(?:[x×](\d+))?$/i.exec(value);
        if (!match) throw new Error(`--size expects WxH or W, got "${value}"`);
        const width = Number(match[1]);
        sizes.push({ width, height: match[2] ? Number(match[2]) : equirectHeightFor(width) });
        break;
      }
      case '--out':
        outDir = resolve(argv[++i] ?? '');
        break;
      case '--manifest':
        manifest = resolve(argv[++i] ?? '');
        break;
      case '--half':
        preferFloat32 = false;
        break;
      case '--radiance':
        radiance = true;
        break;
      case '--force':
        force = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'node scripts/convert-hdri.ts [files...] [options]',
            '',
            '  files          .exr/.hdr sources. Default: assets/example-hdris/*',
            '  --size WxH     target resolution, repeatable. Default 1024x512',
            '  --out DIR      output directory. Default public/hdri',
            '  --manifest P   generated module. Default src/lib/hdri/presets.generated.ts',
            '  --radiance     write .hdr instead of Ultra HDR (no browser needed)',
            '  --half         decode at half precision (less memory, clips above 65504)',
            '  --force        overwrite existing outputs',
            '  --dry-run      report what would be written',
          ].join('\n'),
        );
        process.exit(0);
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        files.push(resolve(arg));
    }
  }

  if (!sizes.length) sizes.push({ width: 1024, height: 512 });
  return { files, sizes, outDir, manifest, preferFloat32, force, dryRun, radiance };
}

async function collectSources(files: string[]): Promise<string[]> {
  if (files.length) return files;
  const entries = await readdir(DEFAULT_SOURCE_DIR).catch(() => {
    throw new Error(`no sources given and ${relative(ROOT, DEFAULT_SOURCE_DIR)} is not readable`);
  });
  return entries
    .filter((name) => SOURCE_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(DEFAULT_SOURCE_DIR, name));
}

/** `studio_small_08_4k.exr` -> `studio-small-08`; the source tier is dropped. */
function slugFor(fileName: string): string {
  const stem = basename(fileName, extname(fileName)).replace(/[_-]\d+k$/i, '');
  return slugifyName(stem);
}

function labelFor(slug: string): string {
  return slug
    .split('-')
    .map((word) => (/^\d+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Character tag guessed from the file name. Poly Haven and most HDRI libraries
 * encode it there; anything unrecognised simply gets no badge rather than a
 * wrong one.
 */
const TAG_KEYWORDS: Array<[RegExp, string]> = [
  [/studio|photostudio/i, 'Studio'],
  [/sunset|sunrise|dusk|dawn|golden/i, 'Sonnenuntergang'],
  [/night|moon/i, 'Nacht'],
  [/puresky|sky|field|forest|park|street|city|urban|beach/i, 'Außen'],
  [/room|interior|hall|office|workshop|garage|indoor/i, 'Innenraum'],
];

function tagFor(fileName: string): string | undefined {
  for (const [pattern, tag] of TAG_KEYWORDS) {
    if (pattern.test(fileName)) return tag;
  }
  return undefined;
}

/** 512 -> `0.5k`, 1024 -> `1k`, 2048 -> `2k`. */
function tierFor(width: number): string {
  const k = width / 1024;
  if (!Number.isInteger(k * 2)) return `${width}px`;
  return `${k % 1 === 0 ? k : k.toFixed(1)}k`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function renderManifest(presets: HdriPreset[], sources: string[]): string {
  const body = presets
    .map((preset) => {
      const tag = preset.tag ? `\n    tag: ${JSON.stringify(preset.tag)},` : '';
      return `  {
    id: ${JSON.stringify(preset.id)},
    label: ${JSON.stringify(preset.label)},
    file: ${JSON.stringify(preset.file)},
    format: ${JSON.stringify(preset.format)},
    width: ${preset.width},
    height: ${preset.height},
    byteSize: ${preset.byteSize},
    swatch: ${JSON.stringify(preset.swatch)},${tag}
    source: {
      fileName: ${JSON.stringify(preset.source.fileName)},
      width: ${preset.source.width},
      height: ${preset.source.height},
    },
  },`;
    })
    .join('\n');

  return `// AUTO-GENERATED by scripts/convert-hdri.ts — do not edit by hand.
// Sources: ${sources.map((file) => basename(file)).join(', ') || 'none'}
// Regenerate with: npm run presets:hdri

import type { HdriPreset } from './types.ts';

export const HDRI_PRESETS: readonly HdriPreset[] = [
${body}
];
`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sources = await collectSources(options.files);
  if (!sources.length) throw new Error('no source files found');

  console.log(
    `${sources.length} source(s) -> ${options.sizes.map((s) => `${s.width}x${s.height}`).join(', ')}` +
      ` in ${relative(ROOT, options.outDir)}${options.dryRun ? ' (dry run)' : ''}`,
  );
  if (!options.dryRun) await mkdir(options.outDir, { recursive: true });

  const presets: HdriPreset[] = [];

  // Started lazily and only when something is actually going to be encoded, so
  // a dry run and `--radiance` never pay for a browser.
  const browser: { encoder?: BrowserEncoder } = {};
  const browserEncoder = async (): Promise<BrowserEncoder> => {
    browser.encoder ??= await startBrowserEncoder(ROOT);
    return browser.encoder;
  };

  try {
  for (const source of sources) {
    const fileName = basename(source);
    const slug = slugFor(fileName);
    const raw = await readFile(source);
    // A Node Buffer is a view into a shared pool — handing `raw.buffer` to the
    // loader passes the whole pool at the wrong offset, which shows up as
    // "no header found" or as garbage pixels.
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

    for (const size of options.sizes) {
      const format = options.radiance ? 'hdr' : 'ultrahdr';
      const outName = `${slug}-${tierFor(size.width)}${extensionForFormat(format)}`;
      const outPath = join(options.outDir, outName);
      if (!options.force && !options.dryRun && (await exists(outPath))) {
        console.log(`  skip  ${outName} (exists, use --force)`);
        continue;
      }

      const started = Date.now();
      // Radiance is produced either way: it is what carries the resampled image
      // out of the Node pipeline, and for Ultra HDR only the float data is used.
      const { bytes: radianceBytes, image, source: info } = await convertToRadiance(
        buffer,
        fileName,
        size,
        {
          preferFloat32: options.preferFloat32,
          comments: [`converted from ${fileName} by scripts/convert-hdri.ts`],
        },
      );

      let bytes = radianceBytes;
      if (!options.radiance) {
        // The float image goes to the browser as a raw dump next to the page.
        // Base64 through the DevTools protocol would be a third bigger for the
        // 6 MB a 1k image weighs, and it is thrown away either way.
        const dumpName = `${slug}-${tierFor(size.width)}.f32`;
        const dumpPath = join(TMP_DIR, dumpName);
        await mkdir(TMP_DIR, { recursive: true });
        await writeFile(dumpPath, Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
        const encoder = await browserEncoder();
        bytes = await encoder.encode({
          url: `${encoder.origin}/${relative(ROOT, dumpPath)}`,
          width: image.width,
          height: image.height,
          maxComponent: image.maxComponent,
          format: 'ultrahdr',
        });
        await rm(dumpPath, { force: true });
      }

      if (!options.dryRun) await writeFile(outPath, bytes);

      presets.push({
        id: `${slug}-${tierFor(size.width)}`,
        label: labelFor(slug),
        file: outName,
        format,
        width: image.width,
        height: image.height,
        byteSize: bytes.byteLength,
        swatch: sampleSwatch(image),
        tag: tagFor(fileName),
        source: { fileName, width: info.width, height: info.height },
      });

      console.log(
        `  ok    ${outName}  ${info.width}x${info.height} -> ${image.width}x${image.height}` +
          `  ${formatBytes(raw.byteLength)} -> ${formatBytes(bytes.byteLength)}` +
          `  peak ${info.maxComponent.toFixed(1)}  ${Date.now() - started} ms`,
      );
    }
  }
  } finally {
    await browser.encoder?.close();
    await rm(TMP_DIR, { recursive: true, force: true });
  }

  presets.sort((a, b) => a.label.localeCompare(b.label, 'de') || a.width - b.width);
  if (!options.dryRun) await writeFile(options.manifest, renderManifest(presets, sources));

  const total = presets.reduce((sum, preset) => sum + preset.byteSize, 0);
  console.log(`\n${presets.length} preset(s), ${formatBytes(total)} total`);
  console.log(options.dryRun ? 'dry run — nothing written' : `manifest: ${relative(ROOT, options.manifest)}`);
}

main().catch((error: unknown) => {
  console.error(`convert-hdri: ${(error as Error).message}`);
  process.exitCode = 1;
});
