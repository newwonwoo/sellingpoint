// 낙찰가율 역추적 — "이 낙찰가율이 나오는 기간이 대체 어디냐"를 찾는다.
//
// [왜] 외부 서비스가 "평균 낙찰가율 74%"만 던져주고 기간·산식을 안 밝히는 경우가 많다.
//   기간을 모르면 우리 숫자와 왜 다른지 설명이 안 되고, 고객 응대도 못 한다.
//
// [어떻게] 월 단위 통계를 한 번만 받아두면 (시작월 × 종료월) 모든 구간을 로컬에서 합산할 수 있다.
//   법원에 구간별로 다시 묻지 않아도 되고, 월별 합계 = 구간 조회 값과 정확히 일치하는 것도 확인했다.
//
// [산식 2종] 같은 74%라도 어떻게 계산했느냐에 따라 나오는 기간이 달라진다.
//   · 금액가중(법원 공식·우리 앱 기준): 매각가합 ÷ 감정가합
//   · 대분류 단순평균: 용도별 대분류(아파트/단독다가구/연립다세대/토지/상업…) 매각가율을 그냥 평균
//     (용도별 표를 그대로 평균내는 서비스가 실제로 있다. 구성비를 무시해서 값이 달라진다.)

import { groupRows } from "./statsModel.js";

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const zero = () => ({ auctn: 0, dspsl: 0, aee: 0, amt: 0 });
const add = (t, r) => {
  t.auctn += n(r.auctnNum); t.dspsl += n(r.dspslNum);
  t.aee += n(r.aeeEvlGrsAmt); t.amt += n(r.dspslGrsAmt);
  return t;
};

// YYYYMM 을 n개월 이동
export function shiftYM(ym, months) {
  let y = +String(ym).slice(0, 4);
  let m = +String(ym).slice(4) - 1 + months;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return `${y}${String(m + 1).padStart(2, "0")}`;
}
// start~end 사이 월 목록
export function monthRange(startYM, endYM) {
  const out = [];
  for (let m = String(startYM); m <= String(endYM); m = shiftYM(m, 1)) {
    out.push(m);
    if (out.length > 600) break; // 안전장치
  }
  return out;
}

// 한 달치 응답 행 → { total, cats: {대분류: 합계}, leaves: {세부용도: 합계} }
// 소계 행은 세부용도 합과 중복이므로 버린다(대분류는 세부용도를 직접 더해서 만든다).
//
// 대분류 키는 법원이 준 header("단독주택,다가구주택")를 그대로 쓴다.
// 목록을 코드에 박아두면 전국 조회에 나오는 자동차·선박 같은 용도가 통째로 누락된다.
// (실제로 전국 6개월 기준 37,108건 중 5,250건이 빠졌었다.)
export function bucketMonth(rows) {
  const bucket = { total: zero(), cats: {}, leaves: {}, catOrder: [] };
  const items = groupRows(rows || []);
  for (const it of items) {
    if (it.kind === "total") { add(bucket.total, it.r); continue; }
    if (it.kind === "subtotal") continue;                       // 세부용도 합과 중복
    bucket.leaves[it.leaf] = add(bucket.leaves[it.leaf] || zero(), it.r);
    const cat = String(it.r?.header || it.group || it.leaf).trim();
    if (!cat || cat === "전체") continue;
    if (!bucket.cats[cat]) { bucket.cats[cat] = zero(); bucket.catOrder.push(cat); }
    add(bucket.cats[cat], it.r);
  }
  // '전체' 행이 없는 응답이면 세부용도 합으로 대체
  if (!bucket.total.auctn && !bucket.total.aee) {
    for (const v of Object.values(bucket.leaves)) {
      bucket.total.auctn += v.auctn; bucket.total.dspsl += v.dspsl;
      bucket.total.aee += v.aee; bucket.total.amt += v.amt;
    }
  }
  return bucket;
}

// 수집된 데이터에 실제로 등장한 대분류 (법원이 내려주는 순서 유지)
export function categoriesOf(monthly) {
  const seen = [];
  for (const m of Object.keys(monthly).sort()) {
    for (const c of monthly[m]?.catOrder || []) if (!seen.includes(c)) seen.push(c);
  }
  return seen;
}

const pct = (amt, aee) => (aee ? (amt / aee) * 100 : null);

// monthly: { "202601": bucket, ... }  대상(target)은 "전체" | 대분류명 | 세부용도명
function sumRange(monthly, months, pick) {
  const t = zero();
  for (const m of months) {
    const b = monthly[m];
    if (!b) continue;
    const src = pick(b);
    if (!src) continue;
    t.auctn += src.auctn; t.dspsl += src.dspsl; t.aee += src.aee; t.amt += src.amt;
  }
  return t;
}
// 대분류에 있으면 그걸, 없으면 세부용도로 본다(둘 다 같은 이름일 수 있어 대분류 우선).
const pickerFor = (target) =>
  target === "전체" ? (b) => b.total : (b) => b.cats[target] || b.leaves[target];

// 한 구간의 값. method: "weighted"(금액가중) | "catavg"(대분류 단순평균)
export function rateOf(monthly, months, target, method, cats) {
  if (method === "catavg") {
    const list = cats || categoriesOf(monthly);
    const vals = [];
    for (const c of list) {
      const t = sumRange(monthly, months, (b) => b.cats[c]);
      const v = pct(t.amt, t.aee);
      if (v != null && t.dspsl > 0) vals.push(v);   // 매각 0건 대분류는 평균에서 제외
    }
    if (!vals.length) return null;
    const all = sumRange(monthly, months, (b) => b.total);
    return { rate: vals.reduce((a, b) => a + b, 0) / vals.length, sold: all.dspsl, auctn: all.auctn, aee: all.aee, amt: all.amt, cats: vals.length };
  }
  const t = sumRange(monthly, months, pickerFor(target));
  const r = pct(t.amt, t.aee);
  return r == null ? null : { rate: r, sold: t.dspsl, auctn: t.auctn, aee: t.aee, amt: t.amt };
}

// 자주 쓰는 "자연스러운" 기간 — 결과 정렬에서 위로 올린다
const NATURAL_LENGTHS = new Set([3, 6, 12, 18, 24, 36, 60]);

// 모든 (시작월, 종료월) 조합을 훑어 target 값에 맞는 구간을 찾는다.
// opts: { target, methods, tolerance, minSold, endFrom, endTo, maxLength }
export function findWindows(monthly, targetRate, opts = {}) {
  const {
    target = "전체",
    methods = ["weighted", "catavg"],
    tolerance = 0.5,
    minSold = 10,
    endFrom = null,      // 종료월 하한 (정보기준일이 있으면 좁힐 수 있다)
    endTo = null,
    maxLength = 60,
  } = opts;

  const all = Object.keys(monthly).sort();
  const ends = all.filter((m) => (!endFrom || m >= endFrom) && (!endTo || m <= endTo));
  const cats = categoriesOf(monthly);   // 한 번만 구해 재사용 (구간마다 다시 훑지 않도록)
  // 대분류 단순평균은 '모든 용도를 평균낸 값'이라 특정 용도를 고른 경우엔 의미가 없다.
  const useMethods = target === "전체" ? methods : methods.filter((m) => m !== "catavg");
  const hits = [];
  for (const method of useMethods) {
    for (const end of ends) {
      const ei = all.indexOf(end);
      for (let L = 1; L <= maxLength; L++) {
        const si = ei - L + 1;
        if (si < 0) break;
        const months = all.slice(si, ei + 1);
        const v = rateOf(monthly, months, target, method, cats);
        if (!v || v.sold < minSold) continue;
        if (Math.abs(v.rate - targetRate) > tolerance) continue;
        hits.push({
          method, target, start: all[si], end, months: L,
          rate: v.rate, sold: v.sold, auctn: v.auctn, aee: v.aee, amt: v.amt,
          natural: NATURAL_LENGTHS.has(L),
          gap: Math.abs(v.rate - targetRate),
        });
      }
    }
  }
  // 자연스러운 기간 → 오차 작은 순 → 표본 큰 순
  hits.sort((a, b) =>
    (b.natural - a.natural) || (a.gap - b.gap) || (b.sold - a.sold));
  return hits;
}

// 결과가 없을 때 "가장 가까운 값"을 보여주기 위한 참고표
export function referenceGrid(monthly, opts = {}) {
  const { target = "전체", method = "weighted", ends = [], lengths = [3, 6, 12, 24, 36] } = opts;
  const all = Object.keys(monthly).sort();
  const out = [];
  for (const end of ends) {
    const ei = all.indexOf(end);
    if (ei < 0) continue;
    const row = { end, cells: [] };
    for (const L of lengths) {
      const si = ei - L + 1;
      if (si < 0) { row.cells.push({ months: L, rate: null }); continue; }
      const v = rateOf(monthly, all.slice(si, ei + 1), target, method);
      row.cells.push({ months: L, rate: v ? v.rate : null, sold: v ? v.sold : 0, start: all[si] });
    }
    out.push(row);
  }
  return out;
}
