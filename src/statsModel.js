// 매각통계 응답의 '용도 위계' 모델. 화면·엑셀·역추적이 공용으로 쓴다.
// (원래 App.jsx 안에 있던 것을 역추적 기능과 공유하려고 분리했다. 로직은 그대로.)

// 매각통계 위계: 대분류 코드로 묶어 단일/세부/소계/전체 구분
// ⚠ 어떤 필드가 '대분류 코드'인지 응답마다 다를 수 있어, 후보 필드 중
//   '소계가 홀로 떨어지지 않고 그룹을 정확히 닫는' 필드를 자동 선택한다.
// ⚠ header가 대분류명("단독주택,다가구주택")을 그대로 담고 있어 이게 가장 정확하다.
//   코드 필드(lclAuctnGdsUsgCd)는 세부용도마다 값이 달라서(11/111/1111) 그룹이 안 묶이고,
//   그 결과 소계가 홀로 떨어져 라벨이 "소계 소계"가 되고 겸용이 어느 그룹인지도 잃는다.
const GRP_FIELDS = ["header", "lclAuctnGdsUsgCd", "lclDspslGdsLstUsgCd", "mclAuctnGdsUsgCd", "mclDspslGdsLstUsgCd"];
function segmentBy(rows, keyFn) {
  const segs = [];
  for (const r of rows) {
    const k = keyFn(r);
    const last = segs[segs.length - 1];
    if (last && last.k === k) last.rows.push(r);
    else segs.push({ k, rows: [r] });
  }
  return segs;
}
// 세그먼트가 올바른 위계인지 위반 점수(0=정상): 소계는 length>1 그룹의 마지막에 1개만
function segViolation(seg) {
  const names = seg.rows.map((r) => r.lclDspslGdsLstUsgNm);
  const subs = names.filter((n) => n === "소계").length;
  const tot = names.filter((n) => n === "전체").length;
  if (tot > 0) return seg.rows.length > 1 ? 1 : 0;          // 전체는 단독 행
  if (seg.rows.length === 1) return subs > 0 ? 1 : 0;        // 소계가 홀로면 위반
  return subs === 1 && names[names.length - 1] === "소계" ? 0 : 1;
}
export function groupRows(rows) {
  rows = rows || [];
  let best = null, bestScore = Infinity;
  for (const f of GRP_FIELDS) {
    if (!rows.some((r) => r[f] != null && r[f] !== "")) continue;
    const segs = segmentBy(rows, (r) => String(r[f] ?? ""));
    const score = segs.reduce((a, s) => a + segViolation(s), 0);
    if (score < bestScore) { bestScore = score; best = segs; }
    if (score === 0) break;
  }
  if (!best) best = segmentBy(rows, (r) => String(r.lclDspslGdsLstUsgNm ?? ""));
  const out = [];
  for (const g of best) {
    const multi = g.rows.length > 1;
    const leaves = g.rows.map((r) => r.lclDspslGdsLstUsgNm);
    const distinct = [...new Set(leaves)];
    // 그룹 라벨: 용도명이 모두 같으면 그게 대분류명, 다르면 세부(겸용/소계/전체 제외) 합성
    const label = distinct.length === 1 ? distinct[0]
      : (leaves.filter((n) => n !== "겸용" && n !== "소계" && n !== "전체").join(",") || distinct[0]);
    for (const r of g.rows) {
      const name = r.lclDspslGdsLstUsgNm;
      const kind = name === "전체" ? "total" : name === "소계" ? "subtotal" : (multi ? "detail" : "single");
      out.push({ r, kind, group: label, leaf: name });
    }
  }
  return out;
}
