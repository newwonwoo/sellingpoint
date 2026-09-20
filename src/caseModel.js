// 사건 실익 판단 모델. 화면(App.jsx)과 엑셀 일괄분석(caseSheet.js)이 공용으로 쓴다.
// (원래 App.jsx 안에 있던 것을 엑셀 출력과 공유하려고 분리했다. 계산식은 그대로.
//  화면에 뜨는 판정과 엑셀에 찍히는 판정이 다르면 그 자체가 사고라 반드시 한 소스를 쓴다.)

export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 인수권리 문장에서 금액을 뽑는다. 예: "임대차보증금 368,000,000원" → 368000000
// 낙찰자가 떠안는 금액이라 예상낙찰가에서 빼야 배당재원이 나온다.
export function extractAmounts(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/([0-9][0-9,]{5,})\s*원/g)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

// 실익 계산 — 폭포수.
//   예상낙찰가 − 인수권리 − 집행비용 = 배당재원
//   배당재원 − 선순위채권 = 우리 배당가능액
// 인수권리는 낙찰자가 떠안으므로 그만큼 낮게 응찰한다. 배당에도 들어가지 않는다.
export function benefitOf({ expected, assumed, cost, senior, claim }) {
  const E = num(expected), A = num(assumed), C = num(cost), S = num(senior), K = num(claim);
  const pool = Math.max(0, E - A - C);          // 배당재원
  const ours = Math.max(0, pool - S);           // 우리 순위까지 내려온 금액
  // 배당은 채권액 한도까지만 받는다. 남는 건 후순위·채무자 몫이라 우리 회수액이 아니다.
  const recovered = K > 0 ? Math.min(ours, K) : ours;
  const rate = K > 0 ? (recovered / K) * 100 : null;
  const verdict = !E ? "unknown"
    : ours <= 0 ? "none"        // 배당가능액이 0이면 채권액과 무관하게 실익 없음
      : K <= 0 ? "needclaim"
        : ours >= K ? "full" : "partial";
  return { E, A, C, S, K, pool, ours, recovered, rate, verdict };
}
export const VERDICT_LABEL = {
  none: "실익 없음", partial: "일부 회수", full: "전액 회수 가능",
  needclaim: "우리 채권액을 입력하세요", unknown: "판단 불가",
};

// "2023.10.12.가압류" / "2023. 7. 3. 강제경매개시결정" → Date. 못 읽으면 null.
export function parseKoDate(text) {
  const m = /(\d{4})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})/.exec(String(text || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
// 대항력 판정 — 전입일이 최선순위 설정일자보다 앞서면 낙찰자가 인수한다.
export function opposability(moveIn, seniorDate) {
  const a = parseKoDate(moveIn), b = parseKoDate(seniorDate);
  if (!a || !b) return { known: false };
  return { known: true, assume: a < b, moveIn: a, senior: b };
}

// 가격시점(감정가 기준일)과 매각기일 사이 개월 수. 오래될수록 예상낙찰가가 빗나간다.
export function monthsBetween(ymdA, ymdB) {
  const p = (v) => { const s = String(v || ""); return s.length === 8 ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)) : null; };
  const a = p(ymdA), b = p(ymdB);
  if (!a || !b) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24 * 30.44));
}

// 조세채권 성격의 이해관계인 — 당해세는 근저당보다 먼저 배당된다.
export const TAX_PARTY = new Set(["교부권자", "압류권자"]);
export const ymdLabel = (v) => { const s = String(v || ""); return s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : s; };

// ── 조회 안 된 사건의 사유 ──────────────────────────────────
// 매각물건 검색은 '지금 매각 진행 중인 물건 목록'이라, 사건이 멀쩡히 있어도 종결됐거나
// 매각기일이 안 잡혀 있으면 0건이 온다. 이때 "사건번호를 확인하세요"는 대개 틀린 안내다.
// api/court-case.js 가 사건내역으로 가려낸 reason 을 사람 말로 옮긴다.
//   closed     종결 — 실익분석 대상이 아니다
//   no_date    사건은 진행 중인데 잡힌 매각기일이 없다(기일 미정·변경·취소, 집행정지 등)
//   not_realty 자동차·선박 경매 — 이 앱은 부동산만 본다. 기다려도 안 나온다
//   absent     어느 법원에도 없다 — 이때만 입력을 의심한다
export const NOT_FOUND_LABEL = {
  closed: "종결된 사건",
  no_date: "매각기일 없음",
  not_realty: "부동산 사건 아님",
  absent: "사건번호 확인 필요",
  error: "조회 실패",
};
export function notFoundText(d) {
  const where = [d?.court, d?.dept].filter(Boolean).join(" ");
  if (d?.reason === "closed") {
    return `${where ? where + " " : ""}${d.caseName || "사건"} — ${d.closedDate ? `${ymdLabel(d.closedDate)}에 ` : ""}종결된 사건입니다.`
      + " 매각이 끝났거나 취하·기각된 사건이라 매각물건 검색에 나오지 않습니다. 실익분석 대상이 아닙니다.";
  }
  if (d?.reason === "no_date") {
    return `${where ? where + " " : ""}${d.caseName || "사건"} — 사건은 진행 중이지만 잡힌 매각기일이 없습니다.`
      + (d.suspended ? ` 집행정지 상태입니다${d.suspendReason ? ` (${d.suspendReason})` : ""}.` : "")
      + (d.appealed ? " 항고가 있습니다." : "")
      + " 기일이 지정되면 조회됩니다.";
  }
  if (d?.reason === "not_realty") {
    return `${where ? where + " " : ""}${d.caseName || "사건"} — 부동산 경매가 아닙니다.`
      + " 이 화면은 부동산 매각물건만 조회합니다. 기일이 잡혀도 여기서는 나오지 않습니다.";
  }
  if (d?.reason === "absent") {
    return "전국 어느 법원에도 이 사건번호가 없습니다. 번호를 확인해주세요 (연도·타경·일련번호).";
  }
  return "조회하지 못했습니다.";
}

// ── 임차인을 매물별로 가른다 ──
// 현황조사서는 사건 단위로 오고 임차인은 objctSeq(목적물)에 묶여 있다. 매물이 여럿인
// 사건에서 전체 임차인을 모든 매물에 그대로 뿌리면, 남의 물건 임차인이 이 매물의
// 최선순위와 비교돼 '인수'로 잡힌다 — 실익 판정이 그만큼 틀어진다.
//
// ⚠ 목적물 번호가 비어 오거나 체계가 어긋나는 사건이 있다. 이때 임차인을 숨기면
//   인수 위험을 통째로 놓치므로, 전부 보여주되 scoped:false 로 '이 매물 것이 아닐 수
//   있음'을 알린다. 위험 정보는 감추는 쪽이 아니라 표시하는 쪽으로 틀린다.
export function scopeTenants(data) {
  const all = data?.survey?.tenants || [];
  const lots = data?.lots || [];
  const seqSets = lots.map((l) => new Set((l.objects || []).map((o) => String(o.seq)).filter(Boolean)));
  // 사건 전체에서 매핑이 한 번이라도 성립하면 그 체계를 믿는다.
  const mapped = all.length > 0 && all.some((t) => seqSets.some((s) => s.has(String(t.objectSeq ?? ""))));
  return lots.map((_, i) => (mapped
    ? { list: all.filter((t) => seqSets[i].has(String(t.objectSeq ?? ""))), scoped: true }
    : { list: all, scoped: lots.length <= 1 }));
}
