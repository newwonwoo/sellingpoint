// 법원 매각통계의 시군구 코드(adongSggCd) 해석 유틸.
//
// [문제] 법원은 시군구를 자체 3자리 코드로 관리하는데, 이 코드가 현행 법정동 코드와 어긋난다.
//   1990년대 행정구역 코드 개편 '이전' 번호가 그대로 남아 있어서, 법정동 코드 뒤 3자리를
//   그대로 보내면 빈 결과가 돌아오는 구가 있다. (2026-08 기준 실측)
//     금천구 11545 → 데이터는 전부 "540"에 있고 "545"는 0건
//     광진구 11215 → 210 / 강북구 11305 → 300
//     인천 부평구 28237 → 240 / 계양구 28245 → 250 / 광주 남구 29155 → 150
//     고양시 덕양구 41281 → 471 / 이천시 41500 → 530
//   반대로 연수구(185·180)·파주시(480·510)·강릉시(150·85A)처럼 한 구의 데이터가
//   두 코드에 나뉘어 담긴 곳도 있다. 한쪽만 조회하면 절반이 사라진다.
//
// [해결] 코드를 하드코딩하지 않는다. 법원 시군구 목록(selectAdong)에서 '이름이 같은 코드'를
//   전부 찾아 모두 조회한 뒤 합산한다. 목록을 못 받으면 기존처럼 뒤 3자리로 폴백한다.
//   → 법원이 코드를 또 바꿔도 목록만 따라가면 되므로 앱 수정이 필요 없다.

const noSpace = (s) => String(s ?? "").replace(/\s+/g, "");

// 시군구 이름 → 법원 코드 배열. courtList는 [{code,name}] (api/court-adong 응답을 정규화한 것).
// 목록이 없거나 이름이 안 맞으면 법정동 뒤 3자리로 폴백한다.
export function courtSggCodes(sggName, sggCode, courtList) {
  const fallback = String(sggCode ?? "").slice(-3);
  const name = noSpace(sggName);
  const hits = [];
  if (name && Array.isArray(courtList)) {
    for (const o of courtList) {
      const c = String(o?.code ?? "");
      if (c && noSpace(o?.name) === name && !hits.includes(c)) hits.push(c);
    }
  }
  if (!hits.length) return fallback ? [fallback] : [];
  // 목록이 낡아 현행 코드가 빠져 있을 수 있으니 폴백 코드도 함께 조회한다(빈 응답이면 합산에 영향 없음).
  if (fallback && !hits.includes(fallback)) hits.push(fallback);
  return hits;
}

// 같은 이름의 옵션을 한 줄로 합친다. 드롭다운에 "금천구"가 두 번 뜨고
// 그중 하나를 고르면 0건이 나오던 문제를 없앤다. value(code)는 코드들을 콤마로 이은 문자열.
export function dedupeSggOptions(list) {
  const out = [], byName = new Map();
  for (const o of list || []) {
    const name = String(o?.name ?? "").trim();
    const code = String(o?.code ?? "").trim();
    if (!name || !code || name === "테스트구") continue; // 테스트구: 법원 목록에 섞여 있는 시험용 항목
    const cur = byName.get(name);
    if (cur) { if (!cur.codes.includes(code)) cur.codes.push(code); continue; }
    const opt = { name, codes: [code] };
    byName.set(name, opt);
    out.push(opt);
  }
  return out.map((o) => ({ ...o, code: o.codes.join(",") }));
}

// ── 여러 코드의 통계 응답 합산 ──
// 매각가율은 개별 비율의 평균이 아니라 금액가중(매각가합÷감정가합)으로 다시 계산해야 한다.
const SUM_KEYS = ["auctnNum", "dspslNum", "aeeEvlGrsAmt", "dspslGrsAmt"];
const rowKey = (r) => `${r?.lclAuctnGdsUsgCd ?? ""}|${r?.lclDspslGdsLstUsgNm ?? ""}`;
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0);

// 응답에서 통계 행 배열을 꺼낸다(스키마가 바뀌어도 견디도록 가장 긴 객체배열을 폴백으로).
export function pickStatRows(obj) {
  const direct = obj?.data?.rletCortDspslStats;
  if (Array.isArray(direct)) return direct;
  let best = [];
  const visit = (o) => {
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" && !Array.isArray(o[0]) && o.length > best.length) best = o;
      o.forEach(visit);
    } else if (o && typeof o === "object") Object.values(o).forEach(visit);
  };
  visit(obj);
  return best;
}

// 코드별 행 배열들을 용도 단위로 합친다.
// 주의: 경매 0건인 용도는 응답에서 아예 빠지므로 코드마다 행 구성이 다르다.
// 화면·엑셀의 위계(소계/전체) 판정이 '행 순서'에 의존하므로 순서를 보존하며 병합한다.
export function mergeStatRows(lists) {
  const src = (lists || []).filter((l) => Array.isArray(l) && l.length);
  if (src.length === 0) return [];
  if (src.length === 1) return src[0].map((r) => ({ ...r }));

  const map = new Map();
  const seq = [];   // 행 순서(가장 행이 많은 응답을 기준으로 삼고, 없는 행은 이웃 뒤에 끼워 넣는다)
  for (const list of [...src].sort((a, b) => b.length - a.length)) {
    let prev = null;
    for (const r of list) {
      const k = rowKey(r);
      let cur = map.get(k);
      if (!cur) {
        cur = { ...r };
        for (const key of SUM_KEYS) cur[key] = 0;
        map.set(k, cur);
        const at = prev ? seq.indexOf(prev) : -1;
        if (at >= 0) seq.splice(at + 1, 0, k); else seq.push(k);
      }
      for (const key of SUM_KEYS) cur[key] += toNum(r[key]);
      prev = k;
    }
  }
  return seq.map((k) => {
    const r = map.get(k);
    r.dspslRate = pct(r.dspslNum, r.auctnNum);
    r.dspslAmtRate = pct(r.dspslGrsAmt, r.aeeEvlGrsAmt);
    return r;
  });
}
