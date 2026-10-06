// 보도자료 → 네이버 뉴스 검색 결과 수집기
// 모든 수집·파싱 로직은 여기(브라우저 JS)에 있다. 다른 사이트를 읽는 통로만 실행 방식에 따라 다르다.
//  - 크롬 확장프로그램: 확장 권한(host_permissions)으로 직접 fetch
//  - node server.js : 같은 출처의 /proxy?url= 로 우회 (브라우저 CORS 제한 때문)
'use strict';

const $ = (id) => document.getElementById(id);
const MODE = location.protocol === 'chrome-extension:' ? 'ext'
  : location.protocol.startsWith('http') ? 'proxy' : 'file';

let release = null, rows = [], sortKey = 'datetime', sortAsc = true, stopFlag = false;

// ---------------------------------------------------------------- 네트워크
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let naverLast = 0;
const NAVER_GAP = 300;   // 네이버 요청 간 최소 간격(ms)

async function getText(url) {
  if (/naver\.com/.test(url)) {
    const wait = naverLast + NAVER_GAP - Date.now();
    naverLast = Math.max(Date.now(), naverLast + NAVER_GAP);
    if (wait > 0) await sleep(wait);
  }
  const target = MODE === 'proxy' ? '/proxy?url=' + encodeURIComponent(url) : url;
  const r = await fetch(target, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  // 국내 언론사 중 EUC-KR 페이지가 아직 많다
  let cs = (/charset=([\w-]+)/i.exec(r.headers.get('content-type') || '') || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
    cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
  }
  try { return new TextDecoder(cs.toLowerCase()).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}
const parseHtml = (s) => new DOMParser().parseFromString(s, 'text/html');

// ---------------------------------------------------------------- 공통 유틸
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const txt = (el) => (el?.textContent || '').replace(/새 창 열림/g, '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;   // toISOString()은 UTC라 하루 밀림
const fmtDT = (d) => `${localIso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
function shiftDate(iso, days) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return localIso(d); }
function meta(doc, ...names) {
  for (const n of names) {
    const v = doc.querySelector(`meta[property="${n}"],meta[name="${n}"],meta[itemprop="${n}"]`)?.getAttribute('content');
    if (v && v.trim()) return v.trim();
  }
  return '';
}

// ---------------------------------------------------------------- 1. 보도자료
async function parseRelease(url) {
  const doc = parseHtml(await getText(url));
  let title = txt(doc.querySelector('.view_title, .view_tit, .board_view .tit, .bbs_view .subject, .view-title, .tit_view, .title_view'))
    || meta(doc, 'og:title');
  if (!title) {   // "보도·뉴스 - 보도자료 - 제목 | 기관명" 형태
    title = txt(doc.querySelector('title')).split(/\s+\|\s+/)[0].split(' - ').pop().trim();
  }
  const html = doc.body?.innerHTML || '';
  let m = /(?:게시일|등록일|작성일|배포일|보도일|일자)\s*(?:<[^>]+>\s*)*(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/.exec(html)
    || /(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/.exec(txt(doc.body));
  const date = m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
  const org = meta(doc, 'og:site_name') || (/\|\s*([^|]+)$/.exec(txt(doc.querySelector('title'))) || [])[1] || '';
  return { url, title, date, org: org.trim() };
}

// ---------------------------------------------------------------- 검색어·키워드 제안
const STOP = new Set(['등', '및', '위한', '위해', '대한', '통해', '연다', '열어', '시대', '나선다', '본격', '추진',
  '개최', '진행', '실시', '확대', '강화', '지원', '함께', '올해', '내년', '오는', '이번', '새로운', '모든']);
// 기사에서 자주 바꿔 쓰는 표현 (보도자료 표현 → 기사 표현)
const SYN = { '인공지능': 'AI', '케이': 'K', '사물인터넷': 'IoT', '가상현실': 'VR', '증강현실': 'AR',
  '중소기업': '중기', '대한민국': '韓', '케이팝': 'K팝' };
const ORG_ABBR = { '문화체육관광부': '문체부', '과학기술정보통신부': '과기정통부', '기획재정부': '기재부',
  '행정안전부': '행안부', '산업통상자원부': '산업부', '고용노동부': '노동부', '보건복지부': '복지부',
  '국토교통부': '국토부', '해양수산부': '해수부', '농림축산식품부': '농식품부', '중소벤처기업부': '중기부',
  '여성가족부': '여가부', '기후에너지환경부': '기후부', '국가보훈부': '보훈부', '개인정보보호위원회': '개인정보위',
  '방송통신위원회': '방통위', '공정거래위원회': '공정위', '금융위원회': '금융위' };

const cleanText = (s) => s.replace(/[‘’“”"'「」『』<>《》〈〉()\[\]…]/g, ' ').replace(/[·ㆍ]/g, ' ').replace(/\s+/g, ' ').trim();

function orgShort(org) {
  for (const [full, abbr] of Object.entries(ORG_ABBR)) if ((org || '').includes(full)) return abbr;
  return (org || '').replace(/\s.*$/, '');
}

function suggestKeywords(title) {
  const words = cleanText(title.replace(/[,，\-]/g, ' ')).split(' ')
    .map(w => w.replace(/(으로|에서|에게|까지|부터|이며|하고|으로써|와|과|을|를|은|는|이|가|의|에|도|로)$/, ''))
    .filter(w => w.length >= 2 && !STOP.has(w))
    .map(w => SYN[w] ? `${w}|${SYN[w]}` : w);
  return [...new Set(words)];
}

function suggestQueries(title, org) {
  const qs = [];
  const add = q => { q = [...new Set(q.split(/\s+/).filter(Boolean))].join(' '); if (q && !qs.includes(q)) qs.push(q); };   // 단어 중복 제거
  add(cleanText(title.replace(/[,，]/g, ' ')));
  const parts = title.split(/[,，…–—]|\s-\s/).map(cleanText).filter(p => p.split(' ').length >= 2);
  if (parts.length > 1) parts.forEach(add);
  // 짧은 핵심어 검색: 기사 제목은 보도자료보다 짧고 약칭·영문 표기를 많이 씀. 첫 구절이 보통 핵심 내용
  const core = suggestKeywords(parts[0] || title).map(k => k.split('|').pop());
  const short = orgShort(org);
  if (core.length >= 3) {
    add(core.slice(0, 4).join(' '));
    add(core.slice(0, 2).concat(core.slice(-2)).join(' '));
    if (short) add(short + ' ' + core.slice(-3).join(' '));
  }
  return qs;
}

// ---------------------------------------------------------------- 2. 네이버 뉴스 검색
const SEARCH_API = 'https://s.search.naver.com/p/newssearch/4/api/tab/more';

// 검색결과 날짜 표기("2026.09.03." / "3시간 전") → {date, datetime}
function parseListDate(s) {
  let m = /(\d{4})\.(\d{1,2})\.(\d{1,2})\./.exec(s);
  if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, datetime: '' };
  m = /(\d+)\s*(분|시간|일|주)\s*전/.exec(s);
  if (m) {
    const d = new Date(Date.now() - (+m[1]) * { '분': 6e4, '시간': 36e5, '일': 864e5, '주': 6048e5 }[m[2]]);
    return { date: localIso(d), datetime: m[2] === '분' || m[2] === '시간' ? fmtDT(d) : '' };
  }
  return { date: '', datetime: '' };
}

function parseSearchHtml(html) {
  const doc = parseHtml(html);
  const items = [];
  for (const a of doc.querySelectorAll('a[data-heatmap-target=".tit"]')) {
    // 제목 링크 하나만 포함하는 가장 큰 상위 요소 = 기사 한 건
    let box = a.parentElement;
    while (box.parentElement && box.parentElement.querySelectorAll('a[data-heatmap-target=".tit"]').length === 1) box = box.parentElement;
    const press = [...box.querySelectorAll('a[data-heatmap-target=".prof"]')].map(txt).find(Boolean) || '';
    const dateText = [...box.querySelectorAll('.sds-comps-profile-info-subtext, .info, span')]
      .map(txt).find(t => /^\d{4}\.\d{1,2}\.\d{1,2}\.$|^\d+\s*(분|시간|일|주)\s*전$/.test(t)) || '';
    const nav = box.querySelector('a[data-heatmap-target=".nav"]')?.getAttribute('href') || '';
    items.push({
      title: txt(a),
      link: a.getAttribute('href') || '',
      press,
      naver: nav,
      snippet: txt(box.querySelector('a[data-heatmap-target=".body"]')),
      ...parseListDate(dateText),
    });
  }
  return items;
}

async function naverSearch(query, ds, de, maxPages, onPage) {
  const d1 = ds.replaceAll('-', '.'), d2 = de.replaceAll('-', '.');
  let url = SEARCH_API + '?' + new URLSearchParams({
    ssc: 'tab.news.all', where: 'news', query, sort: '1', pd: '3', ds: d1, de: d2,
    nso: `so:dd,p:from${d1.replaceAll('.', '')}to${d2.replaceAll('.', '')},a:all`, start: '1',
  });
  const out = [];
  for (let page = 1; url && page <= maxPages && !stopFlag; page++) {
    const j = JSON.parse(await getText(url));
    const html = (j.collection || []).map(c => c.html || '').join('');
    const items = parseSearchHtml(html);
    if (!items.length) break;
    out.push(...items);
    onPage?.(page, out.length);
    url = j.url ? (j.url.startsWith('/') ? 'https://s.search.naver.com' + j.url : j.url) : '';
  }
  return out;
}

// ---------------------------------------------------------------- 정확한 보도시각
function toKstString(iso) {
  const d = new Date(iso.trim().replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T'));
  return isNaN(d) ? '' : fmtDT(d);
}

async function naverArticleTime(url) {
  const doc = parseHtml(await getText(url));
  const v = doc.querySelector('[data-date-time]')?.getAttribute('data-date-time');   // 첫 번째 = 입력 시각
  return v ? v.slice(0, 16) : '';
}

async function originalTime(url) {
  const doc = parseHtml(await getText(url));
  let v = meta(doc, 'article:published_time', 'og:article:published_time', 'og:regDate', 'datePublished',
    'pubdate', 'publish-date', 'article:published', 'dable:published_time');
  if (!v) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      const m = /"datePublished"\s*:\s*"([^"]+)"/.exec(s.textContent);
      if (m) { v = m[1]; break; }
    }
  }
  if (/^\d{12,14}$/.test(v)) v = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:00+09:00`;
  return v ? toKstString(v) : '';
}

async function resolveTime(row) {
  const tries = [];
  if (/n\.news\.naver\.com/.test(row.naver)) tries.push(() => naverArticleTime(row.naver));
  if (row.link) tries.push(() => originalTime(row.link));
  for (const t of tries) {
    try {
      const dt = await t();
      // 수정일 등 엉뚱한 날짜를 집는 사이트가 있어 검색결과 날짜와 크게 다르면 버린다
      if (dt && (!row.date || Math.abs(new Date(dt.slice(0, 10)) - new Date(row.date)) <= 2 * 864e5)) return dt;
    } catch { /* 다음 방법으로 */ }
  }
  return '';
}

// ---------------------------------------------------------------- 관련도
function scoreOf(row, keywords) {
  if (!keywords.length) return { score: 1, hit: [] };
  const hay = (row.title + ' ' + row.snippet).replace(/\s+/g, '').toLowerCase();
  const hit = keywords.filter(k => k.split('|').some(alt => hay.includes(alt.replace(/\s+/g, '').toLowerCase())));
  return { score: hit.length / keywords.length, hit };
}

// ---------------------------------------------------------------- UI: 1단계
if (MODE === 'file') {
  $('modeWarn').classList.remove('hidden');
}

$('btnLoad').onclick = async () => {
  const url = $('url').value.trim();
  if (!url) return;
  const box = $('releaseInfo');
  box.classList.remove('hidden');
  box.innerHTML = '<span class="muted">불러오는 중…</span>';
  $('btnLoad').disabled = true;
  try {
    release = await parseRelease(url);
    box.innerHTML = `<b>${esc(release.title || '(제목을 찾지 못함)')}</b><br>
      <span class="muted">${esc(release.org)} · 게시일 ${esc(release.date || '알 수 없음')}</span>`;
    $('queries').value = suggestQueries(release.title, release.org).join('\n');
    $('keywords').value = suggestKeywords(release.title).join(', ');
    const base = release.date || localIso(new Date());
    $('ds').value = shiftDate(base, -1);   // 엠바고 기사는 전날 나가기도 함
    $('de').value = shiftDate(base, 7);
    $('secSearch').classList.remove('hidden');
  } catch (e) {
    box.innerHTML = `<span class="err">불러오기 실패: ${esc(e.message)}</span>`;
  } finally {
    $('btnLoad').disabled = false;
  }
};
$('url').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLoad').click(); });

// ---------------------------------------------------------------- UI: 2단계
function setProg(done, total, text) {
  $('progBar').style.width = total ? (100 * done / total) + '%' : '0';
  $('progText').textContent = text;
}

const normLink = (u) => u.replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');

$('btnSearch').onclick = async () => {
  const queries = $('queries').value.split('\n').map(s => s.trim()).filter(Boolean);
  const keywords = $('keywords').value.split(',').map(s => s.trim()).filter(Boolean);
  const ds = $('ds').value, de = $('de').value, pages = parseInt($('pages').value, 10) || 10;
  if (!queries.length || !ds || !de) return alert('검색어와 기간을 입력하세요.');

  stopFlag = false;
  $('btnSearch').disabled = true;
  $('btnStop').classList.remove('hidden');
  $('prog').classList.remove('hidden');
  $('secResult').classList.remove('hidden');
  rows = [];
  renderTable();

  const byKey = new Map();
  const errors = [];
  for (let i = 0; i < queries.length && !stopFlag; i++) {
    try {
      const items = await naverSearch(queries[i], ds, de, pages,
        (p, n) => setProg(i, queries.length, `검색 중 (${i + 1}/${queries.length}) "${queries[i]}" — ${p}페이지, ${n}건`));
      for (const it of items) {
        const key = normLink(it.link) || it.press + '|' + it.title;
        const prev = byKey.get(key);
        if (prev) { prev.naver ||= it.naver; if (!prev.queries.includes(queries[i])) prev.queries.push(queries[i]); continue; }
        const { score, hit } = scoreOf(it, keywords);
        const row = { ...it, queries: [queries[i]], score, hit, checked: score * 100 >= +$('thr').value };
        byKey.set(key, row);
        rows.push(row);
      }
      renderTable();
    } catch (e) { errors.push(`검색 "${queries[i]}": ${e.message}`); }
  }

  // 검색결과에는 날짜만 있으므로, 기사 페이지에서 시:분까지 확인
  if ($('exactTime').checked) {
    const queue = rows.filter(r => !r.datetime);
    const total = queue.length;
    let done = 0;
    const worker = async () => {
      while (queue.length && !stopFlag) {
        const r = queue.shift();
        r.datetime = await resolveTime(r);
        done++;
        setProg(done, total, `보도시각 확인 중 ${done}/${total}`);
        if (done % 5 === 0 || done === total) renderTable();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  const noTime = rows.filter(r => !r.datetime).length;
  setProg(1, 1, `${stopFlag ? '중지됨. ' : '완료. '}뉴스 ${rows.length}건 (네이버뉴스 링크 ${rows.filter(r => r.naver).length}건)` +
    (noTime ? ` · 시각 미확인 ${noTime}건은 날짜만 표기` : '') +
    (errors.length ? ` · 오류 ${errors.length}건: ${errors.slice(0, 2).join(' / ')}` : ''));
  $('btnSearch').disabled = false;
  $('btnStop').classList.add('hidden');
  renderTable();
};
$('btnStop').onclick = () => { stopFlag = true; };

// ---------------------------------------------------------------- UI: 3단계
const when = (r) => r.datetime || r.date;

function sorted() {
  const get = sortKey === 'datetime' ? when : (r) => r[sortKey];
  const dir = sortAsc ? 1 : -1;
  return [...rows].sort((a, b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * dir);
}

function renderTable() {
  $('tbody').innerHTML = sorted().map(r => {
    const idx = rows.indexOf(r);
    const pct = Math.round(r.score * 100);
    return `<tr class="${r.checked ? '' : 'off'}">
      <td><input type="checkbox" data-i="${idx}" ${r.checked ? 'checked' : ''}></td>
      <td class="nowrap">${esc(when(r))}</td>
      <td class="nowrap">${esc(r.press)}</td>
      <td><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>
        ${r.naver ? `<a class="nbadge" href="${esc(r.naver)}" target="_blank" rel="noopener" title="네이버뉴스">N</a>` : ''}</td>
      <td class="nowrap" title="${esc(r.hit.join(', '))}"><span class="score">${pct}%</span><span class="bar"><i style="width:${pct}%"></i></span></td>
    </tr>`;
  }).join('');
  const n = rows.filter(r => r.checked).length;
  $('count').textContent = `— ${rows.length}건 중 ${n}건 선택`;
  $('chkAll').checked = rows.length > 0 && n === rows.length;
  $('preview').textContent = toCsv();
}

$('tbody').addEventListener('change', e => {
  const i = e.target.dataset.i;
  if (i !== undefined) { rows[i].checked = e.target.checked; renderTable(); }
});
$('chkAll').onchange = e => { rows.forEach(r => r.checked = e.target.checked); renderTable(); };
$('thr').oninput = () => {
  $('thrVal').textContent = $('thr').value + '%';
  rows.forEach(r => r.checked = r.score * 100 >= +$('thr').value);
  renderTable();
};
document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  sortAsc = sortKey === k ? !sortAsc : k !== 'score';
  sortKey = k;
  renderTable();
});

function csvCell(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function toCsv() {
  const out = [['보도일시', '언론사', '제목', '링크', '네이버뉴스 링크']];
  sorted().filter(r => r.checked).forEach(r => out.push([when(r), r.press, r.title, r.link, r.naver]));
  return out.map(row => row.map(csvCell).join(',')).join('\r\n');
}

$('btnCsv').onclick = () => {
  const blob = new Blob(['﻿' + toCsv()], { type: 'text/csv;charset=utf-8' });   // BOM: 엑셀 한글 깨짐 방지
  const a = document.createElement('a');
  const name = (release?.title || 'news').replace(/[\\/:*?"<>|]/g, '').slice(0, 40).trim();
  a.href = URL.createObjectURL(blob);
  a.download = `${release?.date || ''}_${name}_보도목록.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('btnCopy').onclick = async () => {
  await navigator.clipboard.writeText(toCsv());
  $('btnCopy').textContent = '복사됨';
  setTimeout(() => $('btnCopy').textContent = 'CSV 복사', 1200);
};
