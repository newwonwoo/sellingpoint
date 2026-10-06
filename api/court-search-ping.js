/**
 * GET /api/court-search-ping  (진단용 · 임시 — 확인 후 삭제)
 *
 * 목적: Vercel 서울(icn1)에서 대법원 나의사건검색에 접속되는지, 페이지 구조가 어떤지 확인한다.
 * - 대상 URL은 고정값이며 사용자 입력을 받지 않는다 (SSRF 없음)
 * - 대조군: 기존 앱이 서울 리전에서 정상 사용 중인 courtauction.go.kr
 * - 읽기(GET)만 수행하고 아무것도 저장하지 않는다
 */
import { lookup } from 'node:dns/promises';

const TARGET = 'https://safind.scourt.go.kr/sf/mysafind.jsp';
const CONTROL = 'https://www.courtauction.go.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 12000;
const DNS_TIMEOUT_MS = 8000;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms)),
  ]);

async function dnsCheck(host) {
  try {
    const r = await withTimeout(lookup(host), DNS_TIMEOUT_MS);
    return { ok: true, address: r.address };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

// 한국 사이트는 EUC-KR 인 경우가 있어 charset 을 헤더 → meta 순으로 찾아 디코딩한다.
function decode(buf, contentType) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '') || /charset=["']?([\w-]+)/i.exec(head);
  const label = m ? m[1] : 'utf-8';
  try {
    return { charset: label.toLowerCase(), text: new TextDecoder(label).decode(buf) };
  } catch {
    return { charset: `${label.toLowerCase()}(미지원→utf-8)`, text: new TextDecoder('utf-8').decode(buf) };
  }
}

// 캡차가 어디에 있는지 보려고 태그 목록만 뽑는다 (전체 HTML은 반환하지 않음).
function analyze(html) {
  const tags = (re, n = 15) =>
    [...html.matchAll(re)].slice(0, n).map((m) => m[0].replace(/\s+/g, ' ').slice(0, 220));
  const lower = html.toLowerCase();
  return {
    imgs: tags(/<img\b[^>]*>/gi),
    iframes: tags(/<iframe\b[^>]*>/gi),
    forms: tags(/<form\b[^>]*>/gi),
    scripts: tags(/<script\b[^>]*\bsrc=[^>]*>/gi),
    keywordHits: ['captcha', 'vcode', 'secure', '보안문자', '자동입력', '캡차'].filter((k) => lower.includes(k)),
    snippet: html.replace(/\s+/g, ' ').slice(0, 600),
  };
}

async function httpCheck(url, withHtml) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const out = {
      status: r.status,
      finalUrl: r.url,
      contentType: r.headers.get('content-type'),
      bytes: buf.length,
      ms: Date.now() - t0,
    };
    if (withHtml) {
      const { charset, text } = decode(buf, out.contentType);
      out.charset = charset;
      out.html = analyze(text);
    }
    return out;
  } catch (e) {
    return {
      error: (e.cause && e.cause.code) || e.name || 'ERR',
      message: String((e.cause && e.cause.message) || e.message).slice(0, 200),
      ms: Date.now() - t0,
    };
  }
}

async function egressIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    return (await r.json()).ip;
  } catch {
    return null;
  }
}

const verdictOf = (http) => (http.status !== undefined ? `응답 수신 (HTTP ${http.status})` : `접속 실패 (${http.error})`);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const [targetDns, targetHttp, controlDns, controlHttp, ip] = await Promise.all([
    dnsCheck(new URL(TARGET).hostname),
    httpCheck(TARGET, true),
    dnsCheck(new URL(CONTROL).hostname),
    httpCheck(CONTROL, false),
    egressIp(),
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(
    JSON.stringify(
      {
        verdict: {
          대법원_나의사건검색: verdictOf(targetHttp),
          대조군_법원경매정보: verdictOf(controlHttp),
        },
        checkedAt: new Date().toISOString(),
        region: process.env.VERCEL_REGION || null,
        egressIp: ip,
        target: { url: TARGET, dns: targetDns, http: targetHttp },
        control: { url: CONTROL, dns: controlDns, http: controlHttp },
      },
      null,
      2
    )
  );
}
