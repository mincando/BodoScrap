// 크롬 확장프로그램을 쓰지 않을 때의 실행 방법: node server.js → http://localhost:8765
// 하는 일은 두 가지뿐이다: index.html/app.js 제공, /proxy?url= 로 외부 페이지 중계(브라우저 CORS 우회).
// Node 18+ 내장 기능만 사용 (npm install 불필요)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const tls = require('tls');

// 백신·보안 프로그램이 HTTPS를 검사하는 PC에서는 그 인증서가 OS 저장소에만 있어 Node가 거부한다.
// Node 22.15+/23.10+ 에서는 OS 인증서 저장소도 함께 신뢰하도록 한다.
if (tls.getCACertificates && tls.setDefaultCACertificates) {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch { /* 이전 버전은 기본 인증서만 사용 */ }
}

const PORT = 8765;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }
    try {
      const r = await fetch(target, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, redirect: 'follow' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(String(e.cause?.code || e.message));
    }
  }
  const file = path.join(__dirname, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^([\\/])+/, ''));
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`보도자료 → 네이버 뉴스 추출기 실행 중: ${addr} (종료: Ctrl+C)`);
  if (!process.argv.includes('--no-browser')) {
    exec((process.platform === 'win32' ? 'start "" ' : process.platform === 'darwin' ? 'open ' : 'xdg-open ') + addr);
  }
});
