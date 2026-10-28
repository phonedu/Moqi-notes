/**
 * 局域网静态服务 —— 让手机能看官网。
 *
 * 手机浏览器打不开电脑上的 file:// 路径，所以要在电脑上起一个 HTTP 服务，
 * 手机连同一个 Wi-Fi，访问 http://<电脑局域网IP>:<端口>。
 *
 * 用法：
 *   node website/serve.mjs          # 默认 8899
 *   node website/serve.mjs 9000     # 换端口
 *
 * 零依赖：只用 Node 内置模块，不装任何包。
 * 绑 0.0.0.0（不是 127.0.0.1），否则只有本机能访问。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2]) || 8899;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

    // 目录穿越防护：解析后的路径必须仍在 ROOT 之内
    const target = normalize(join(ROOT, rel));
    if (!target.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end('403');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 — 没有这个文件: ' + rel);
      console.log(`  404  ${rel}`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // 调试期间不缓存，改完刷新就能看到
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end('500');
    console.error('  500 ', err.message);
  }
});

// 找出所有非回环的 IPv4 地址，手机要用其中一个
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 被占用了。换一个：node website/serve.mjs 9000\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n墨契官网 · 局域网预览已启动\n');
  console.log(`  本机       http://localhost:${PORT}`);
  for (const { name, address } of addrs) {
    console.log(`  ${name.padEnd(10)} http://${address}:${PORT}   ← 手机用这个`);
  }
  console.log('\n手机要连同一个 Wi-Fi。按 Ctrl+C 停止。\n');
});
