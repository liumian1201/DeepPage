/* 最小 WebDAV 测试服务器（零依赖，仅测试用）
 *
 * 为什么需要它：v1.5.5 审计把「未做真实 WebDAV 服务器联调」列为边界 ——
 * BUG-040（上传失败仍记 manifest）/ BUG-042（目录穿越）/ BUG-061（GC 结果不落云端）
 * 都是「只有真的发请求、真的看服务端状态才能证伪」的缺陷，桩 fetch 只能证明「发出了什么请求」，
 * 证明不了「服务端最终留下了什么」。
 *
 * 支持：OPTIONS / PROPFIND(Depth:1) / MKCOL / PUT / GET / DELETE
 * 额外能力：
 *   · state.log        每条请求 { method, url, path, auth }
 *   · state.failPut    匹配到的 PUT 返回 507（模拟配额满/网络失败），用于 BUG-040
 *   · 目录穿越可观测   服务器根目录 = 临时目录，WebDAV 基地址是 <root>/dav/DeepPage，
 *                      在 <root>/ 下放哨兵文件即可验证「越界删除」是否真的发生
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.json': 'application/json', '.bin': 'application/octet-stream', '.zip': 'application/zip' };

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createWebdavServer(rootDir) {
  const state = {
    log: [],            // { method, url, path, auth }
    failPut: null,      // 子串匹配 → 该 PUT 返回 507
    failPutStatus: 507,
    failPutCount: 0,
  };

  /** URL 路径 → 文件系统路径（不允许越出 rootDir） */
  function resolveFs(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath.split('?')[0]); } catch (e) { return null; }
    const abs = path.resolve(rootDir, '.' + path.posix.normalize(p));
    if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) return null;
    return abs;
  }

  function propfindResponse(absPath, hrefPath, depth) {
    const st = fs.statSync(absPath);
    const entries = [{ href: hrefPath, stat: st }];
    if (depth === '1' && st.isDirectory()) {
      for (const name of fs.readdirSync(absPath)) {
        const child = path.join(absPath, name);
        entries.push({ href: hrefPath.replace(/\/$/, '') + '/' + encodeURIComponent(name), stat: fs.statSync(child) });
      }
    }
    const body = entries.map((e) => {
      const isDir = e.stat.isDirectory();
      return '<D:response><D:href>' + xmlEscape(e.href) + (isDir && !/\/$/.test(e.href) ? '/' : '') + '</D:href>'
        + '<D:propstat><D:prop>'
        + '<D:getlastmodified>' + e.stat.mtime.toUTCString() + '</D:getlastmodified>'
        + '<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>'
        + '<D:getcontentlength>' + (isDir ? 0 : e.stat.size) + '</D:getcontentlength>'
        + '</D:prop></D:propstat></D:response>';
    }).join('');
    return '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' + body + '</D:multistatus>';
  }

  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/';
    state.log.push({ method: req.method, url: urlPath, path: urlPath.split('?')[0], auth: req.headers.authorization || '' });

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL',
      'Access-Control-Allow-Headers': 'Authorization, Depth, Content-Type',
      'DAV': '1',
    };
    const send = (code, body, extra) => {
      res.writeHead(code, Object.assign({}, cors, extra || {}));
      res.end(body === undefined ? '' : body);
    };

    if (req.method === 'OPTIONS') return send(200, '');

    const abs = resolveFs(urlPath);
    if (!abs) return send(400, 'bad path');

    if (req.method === 'PROPFIND') {
      if (!fs.existsSync(abs)) return send(404, 'not found');
      return send(207, propfindResponse(abs, urlPath, req.headers.depth), { 'Content-Type': 'application/xml; charset=utf-8' });
    }

    if (req.method === 'MKCOL') {
      if (fs.existsSync(abs)) return send(405, 'exists');
      try { fs.mkdirSync(abs, { recursive: true }); return send(201, ''); } catch (e) { return send(500, e.message); }
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (state.failPut && urlPath.indexOf(state.failPut) !== -1) {
          state.failPutCount++;
          return send(state.failPutStatus, 'injected failure');
        }
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, body);
          return send(201, '');
        } catch (e) { return send(500, e.message); }
      });
      return;
    }

    if (req.method === 'GET') {
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(404, 'not found');
      return send(200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    }

    if (req.method === 'DELETE') {
      if (!fs.existsSync(abs)) return send(404, 'not found');
      try {
        const st = fs.statSync(abs);
        if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
        else fs.unlinkSync(abs);
        return send(204, '');
      } catch (e) { return send(500, e.message); }
    }

    return send(405, 'method not allowed');
  });

  return {
    state,
    server,
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() { return new Promise((resolve) => { try { server.close(() => resolve()); } catch (e) { resolve(); } }); },
    /** 清空请求日志（便于「这一段没发任何越界请求」这类断言） */
    resetLog() { state.log.length = 0; },
    /** 某方法的全部请求路径 */
    pathsFor(method) { return state.log.filter((l) => l.method === method).map((l) => l.path); },
  };
}

module.exports = { createWebdavServer };
