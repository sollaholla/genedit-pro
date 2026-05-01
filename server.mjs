import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 8080);
const distDir = fileURLToPath(new URL('./dist/', import.meta.url));
const indexPath = path.join(distDir, 'index.html');

const allowedArtifactHosts = new Set([
  'app-uploads.krea.ai',
  'img.theapi.app',
  'storage.theapi.app',
]);

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
]);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname === '/api/artifact-proxy') {
      await proxyArtifact(req, res, requestUrl);
      return;
    }
    await serveStatic(req, res, requestUrl);
  } catch (error) {
    console.error(error);
    sendText(res, 500, 'Internal server error');
  }
});

server.listen(port, () => {
  console.log(`GenEdit Pro listening on ${port}`);
});

async function proxyArtifact(req, res, requestUrl) {
  setIsolationHeaders(res);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const targetValue = requestUrl.searchParams.get('url');
  if (!targetValue) {
    sendText(res, 400, 'Missing url parameter');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetValue);
  } catch {
    sendText(res, 400, 'Invalid url parameter');
    return;
  }

  if (targetUrl.protocol !== 'https:' || !allowedArtifactHosts.has(targetUrl.hostname)) {
    sendText(res, 403, 'Artifact host is not allowed');
    return;
  }

  const upstream = await fetch(targetUrl, {
    headers: {
      accept: req.headers.accept ?? '*/*',
      'user-agent': 'GenEdit-Pro/1.0 artifact proxy',
    },
  });

  res.statusCode = upstream.status;
  res.statusMessage = upstream.statusText;
  copyHeader(upstream, res, 'content-type');
  copyHeader(upstream, res, 'content-length');
  copyHeader(upstream, res, 'accept-ranges');

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

async function serveStatic(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setStaticHeaders(res, false);
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const requestedPath = safeStaticPath(requestUrl.pathname);
  const filePath = requestedPath ? await existingFilePath(requestedPath) : null;
  const resolvedPath = filePath ?? indexPath;
  const isAsset = resolvedPath.includes(`${path.sep}assets${path.sep}`);
  setStaticHeaders(res, isAsset);
  res.setHeader('Content-Type', mimeTypes.get(path.extname(resolvedPath)) ?? 'application/octet-stream');

  if (req.method === 'HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }

  createReadStream(resolvedPath)
    .on('error', () => sendText(res, 404, 'Not found'))
    .pipe(res);
}

function safeStaticPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const absolutePath = path.join(distDir, normalizedPath);
  if (!absolutePath.startsWith(distDir)) return null;
  return absolutePath;
}

async function existingFilePath(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

function setStaticHeaders(res, isAsset) {
  setIsolationHeaders(res);
  res.setHeader('Cache-Control', isAsset ? 'public, max-age=31536000, immutable' : 'no-store');
}

function setIsolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
}

function copyHeader(upstream, res, headerName) {
  const value = upstream.headers.get(headerName);
  if (value) res.setHeader(headerName, value);
}

function sendText(res, statusCode, message) {
  res.statusCode = statusCode;
  if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}
