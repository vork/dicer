/**
 * Serves a built directory under a path prefix, the way a GitHub Pages project
 * site is hosted. Records anything it could not find, so a caller can fail on a
 * 404 rather than only noticing when the page misbehaves.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export async function serveBuild({ root, prefix, port }) {
  const base = path.resolve(root);
  const missing = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith(prefix)) {
      missing.push(`${url.pathname} (outside ${prefix})`);
      response.writeHead(404).end('not found');
      return;
    }

    let relative = url.pathname.slice(prefix.length) || 'index.html';
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.join(base, relative);
    // Refuse anything that resolves outside the served directory.
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      missing.push(url.pathname);
      response.writeHead(404).end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // A service worker must not be pinned by the HTTP cache, or an update can
      // never reach a browser that already has one.
      'cache-control': path.basename(file) === 'sw.js' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, missing, url: `http://127.0.0.1:${port}${prefix}` };
}
