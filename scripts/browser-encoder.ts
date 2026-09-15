/**
 * Runs the browser half of the HDRI conversion, for a CLI that has no DOM.
 *
 * Starts Vite in middleware-free dev mode so `scripts/hdri-encoder.html` and
 * every module it imports resolve exactly as they do in the app, launches the
 * system Chrome headless, and talks to it over the DevTools protocol. No new
 * dependency: Vite is already here, Node brings a `WebSocket`, and Chrome is on
 * the machine of anyone who would run this.
 *
 * Deliberately not Puppeteer or Playwright. Both would pull a second browser
 * binary of a few hundred megabytes into the repository for one build step that
 * runs when the example HDRIs change, which is roughly never.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where Chrome lives, in the order worth trying. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const DEBUG_PORT = 9422;

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export type EncodeRequest = {
  url: string;
  width: number;
  height: number;
  maxComponent: number;
  format: 'ultrahdr' | 'webp';
  quality?: number;
};

export type BrowserEncoder = {
  /** Encodes one image and returns the file bytes. */
  encode: (request: EncodeRequest) => Promise<Uint8Array>;
  /** Dev-server origin, for building the URLs passed to `encode`. */
  origin: string;
  close: () => Promise<void>;
};

async function findChrome(): Promise<string> {
  const { access } = await import('node:fs/promises');
  for (const path of CHROME_PATHS) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw new Error(
    'no Chrome found. The Ultra HDR encoder needs a WebGL context, so this step ' +
      'needs Chrome or Chromium installed. Pass --radiance to write .hdr files instead.',
  );
}

async function waitForDevTools(timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Chrome did not expose a DevTools endpoint');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function connect(wsUrl: string): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map<number, Pending>();
    let nextId = 0;

    socket.onerror = () => reject(new Error('DevTools socket failed'));
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        error?: unknown;
        result?: Record<string, unknown>;
      };
      if (message.id === undefined) return;
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result ?? {});
    };
    socket.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res as (value: unknown) => void, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => socket.close(),
      });
  });
}

export async function startBrowserEncoder(root: string): Promise<BrowserEncoder> {
  const server: ViteDevServer = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    server: { port: 0, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('dev server did not bind a port');
  // `localhost`, not `127.0.0.1`: Vite binds ::1, and the v4 loopback is then
  // refused outright.
  const origin = `http://localhost:${address.port}`;

  const chrome = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'hdri-encoder-'));
  const child: ChildProcess = spawn(
    chrome,
    [
      '--headless',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // SwiftShader is what gives headless a WebGL2 context with float render
      // targets, which the gain-map encoder needs and no GPU is present for.
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `${origin}/scripts/hdri-encoder.html`,
    ],
    { stdio: 'ignore' },
  );

  const cdp = await connect(await waitForDevTools());

  async function evaluate(expression: string): Promise<unknown> {
    const result = (await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { exceptionDetails?: { text: string }; result?: { value?: unknown } };
    if (result.exceptionDetails) {
      throw new Error(`browser: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  // The page is a module, so it is ready a tick after the document is.
  const deadline = Date.now() + 20_000;
  while (!(await evaluate('Boolean(window.hdriEncoderReady)').catch(() => false))) {
    if (Date.now() > deadline) throw new Error('the encoder page never became ready');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    origin,
    async encode(request) {
      const value = (await evaluate(
        `window.encodeHdriPreset(${JSON.stringify(request)})`,
      )) as { base64: string } | undefined;
      if (!value?.base64) throw new Error('the encoder returned nothing');
      return new Uint8Array(Buffer.from(value.base64, 'base64'));
    },
    async close() {
      cdp.close();
      child.kill();
      await server.close();
      // Chrome keeps writing to its profile for a moment after the kill, so a
      // single rmdir loses the race against its own model store. Retries, and
      // a leftover directory in the system temp is not worth failing the run.
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}
