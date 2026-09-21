// 엑셀 일괄 실익분석 — 업로드 파싱 · 결과 칼럼화 · 양식 생성.
//
// [흐름] 사건번호가 적힌 엑셀 업로드 → 사건마다 법원 조회 → 매물 한 줄씩 칼럼화 → 엑셀 다운로드
//
// [메모리 원칙] 수백 건을 한 브라우저 탭에서 돌린다. 지키는 규칙 넷:
//   1. 업로드 워크북은 사건번호만 뽑고 즉시 버린다. 스타일·수식·날짜 변환을 모두 끄고 읽는다.
//   2. 시트를 JSON 배열로 통째로 펼치지 않는다. 필요한 칸만 주소로 집어 읽는다.
//      (sheet_to_json 은 행마다 객체를 만들어 키 문자열이 행 수만큼 복제된다)
//   3. 조회 응답(명세서 비고·감정평가 요점·사진 메타까지 붙어 무겁다)은 한 줄로 접은 뒤
//      즉시 버린다. 응답 원본을 모아두지 않는다 — 접은 결과만 남긴다.
//   4. 출력 행은 객체가 아니라 '배열'이다. 36개 칼럼 × N행이면 객체는 키 문자열을
//      36×N번 복제하지만 배열은 값만 담는다. 셀 스타일도 미리 만들어 참조만 공유한다.

import * as XLSX from "xlsx-js-style";
import { caseNoFromCell } from "./caseNo.js";
import { benefitOf, extractAmounts, monthsBetween, NOT_FOUND_LABEL, opposability, scopeTenants, TAX_PARTY, VERDICT_LABEL, ymdLabel, num } from "./caseModel.js";

// 한 번에 받을 사건 수 상한. 법원 서버에 대한 예의이기도 하고,
// 이걸 넘기면 한 탭에서 도는 시간이 실무 인내심을 넘는다(건당 3~8초).
export const MAX_CASES = 200;
const MAX_SCAN_ROWS = 20000;   // 업로드 파일 훑는 행 상한(악성·오염 파일 방어)

// ── 업로드 읽기 ──────────────────────────────────────────────

// 헤더 비교용 정규화: 공백·괄호·구분자 제거 + 끝의 단위 표기 제거
//   "우리 채권액(원)" → "우리채권액"
const norm = (s) => String(s || "").replace(/[\s()[\]{}_·.\-/\\]/g, "").replace(/(원|₩|KRW)$/i, "");

// 입력 칼럼 별칭. 사건번호만 필수고 나머지는 있으면 쓴다.
// ⚠ 부분일치로 찾으면 "선순위채권"이 "채권액"에 걸린다. 정규화 후 '완전일치'만 본다.
const FIELD_ALIASES = [
  ["caseNo", ["사건번호", "사건", "경매사건", "경매사건번호", "법원사건번호", "타경"]],
  ["claim", ["우리채권액", "채권액", "청구채권액", "채권잔액", "여신잔액", "대출잔액", "미회수금액"]],
  ["senior", ["선순위채권", "선순위", "선순위채권합계", "선순위합계", "선순위금액"]],
  ["assumed", ["인수권리금액", "인수금액", "인수권리"]],
  ["cost", ["집행비용", "경매비용", "예상집행비용"]],
  ["ref", ["관리번호", "고객번호", "채권번호", "계좌번호", "여신번호", "채무자", "고객명", "거래처"]],
];

function cellText(ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return "";
  return String(cell.w ?? cell.v ?? "").trim();
}
// "368,000,000" / "3억" 같은 표기가 섞여 들어온다. 숫자만 남겨 읽고, 억/만 단위는 곱한다.
function cellMoney(ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return null;
  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : null;
  const s = String(cell.v ?? "").trim();
  if (!s) return null;
  const m = /^([0-9,.]+)\s*(억|만)?\s*원?$/.exec(s.replace(/\s/g, ""));
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  return m[2] === "억" ? base * 1e8 : m[2] === "만" ? base * 1e4 : base;
}

// 업로드 파일(ArrayBuffer) → { items, stats }
// items: [{ caseNo, ref, claim, senior, assumed, cost }]
export function readCaseInputs(buf) {
  // 스타일·수식·날짜 객체를 만들지 않는다. 우리가 쓰는 건 값뿐인데
  // 이 옵션들을 켜면 셀마다 객체가 하나씩 더 생긴다.
  const wb = XLSX.read(buf, {
    type: "array", sheets: 0,
    cellStyles: false, cellNF: false, cellHTML: false, cellFormula: false,
    cellDates: false, sheetStubs: false, bookVBA: false, bookDeps: false,
  });
  const name = wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : null;
  if (!ws || !ws["!ref"]) return { items: [], stats: { rows: 0, found: 0, dupes: 0, mode: "none" } };

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const lastRow = Math.min(range.e.r, range.s.r + MAX_SCAN_ROWS);
  const lastCol = Math.min(range.e.c, range.s.c + 200);

  // 1) 헤더 행 찾기 — 위에서 10행 안에 '사건번호' 계열 칼럼이 있으면 그 행이 헤더다.
  let headRow = -1;
  const cols = {};
  for (let r = range.s.r; r <= Math.min(range.s.r + 9, lastRow); r++) {
    const hit = {};
    for (let c = range.s.c; c <= lastCol; c++) {
      const key = norm(cellText(ws, r, c));
      if (!key) continue;
      for (const [field, aliases] of FIELD_ALIASES) {
        if (hit[field] != null) continue;
        if (aliases.includes(key)) { hit[field] = c; break; }
      }
    }
    if (hit.caseNo != null) { headRow = r; Object.assign(cols, hit); break; }
  }

  const items = [];
  const seen = new Set();
  let scanned = 0, dupes = 0;
  const push = (caseNo, extra) => {
    scanned++;
    if (seen.has(caseNo)) { dupes++; return; }
    seen.add(caseNo);
    items.push({ caseNo, ...extra });
  };

  if (headRow >= 0) {
    for (let r = headRow + 1; r <= lastRow; r++) {
      const caseNo = caseNoFromCell(cellText(ws, r, cols.caseNo));
      if (!caseNo) continue;
      push(caseNo, {
        ref: cols.ref != null ? cellText(ws, r, cols.ref) : "",
        claim: cols.claim != null ? cellMoney(ws, r, cols.claim) : null,
        senior: cols.senior != null ? cellMoney(ws, r, cols.senior) : null,
        assumed: cols.assumed != null ? cellMoney(ws, r, cols.assumed) : null,
        cost: cols.cost != null ? cellMoney(ws, r, cols.cost) : null,
      });
    }
  } else {
    // 2) 헤더가 없거나 이름이 다르면 — 모든 칸에서 사건번호 패턴을 줍는다.
    //    이때는 채권액 같은 부가 칼럼을 신뢰할 수 없으니 사건번호만 가져간다.
    //    ⚠ strict: 어느 칼럼인지 모르고 훑는 중이라 '타경'이 박힌 것만 받는다.
    //      느슨하게 두면 전화번호·사업자번호가 사건번호로 둔갑한다.
    for (let r = range.s.r; r <= lastRow; r++) {
      for (let c = range.s.c; c <= lastCol; c++) {
        const caseNo = caseNoFromCell(cellText(ws, r, c), { strict: true });
        if (caseNo) push(caseNo, { ref: "", claim: null, senior: null, assumed: null, cost: null });
      }
    }
  }

  return {
    items,
    stats: {
      rows: lastRow - range.s.r + 1,
      found: scanned, dupes,
      mode: headRow >= 0 ? "header" : items.length ? "scan" : "none",
      columns: headRow >= 0 ? Object.keys(cols) : [],
      truncated: range.e.r > lastRow,
    },
  };
}

// ── 결과 칼럼 ────────────────────────────────────────────────
// t: n=금액(원) / r=비율(%) / c=건수 / 나머지는 문자열
export const OUT_COLS = [
  { label: "입력참조", w: 12 },
  { label: "사건번호", w: 15 },
  { label: "법원", w: 16 },
  { label: "담당계", w: 10 },
  { label: "매물", w: 6 },
  { label: "소재지", w: 34 },
  { label: "물건용도", w: 13 },
  { label: "면적(㎡)", w: 10, t: "c" },
  { label: "매각기일", w: 12 },
  { label: "유찰", w: 6, t: "c" },
  { label: "감정가(원)", w: 15, t: "n" },
  { label: "최저가(원)", w: 15, t: "n" },
  { label: "낙찰가율(%)", w: 11, t: "r" },
  { label: "예상낙찰가(원)", w: 16, t: "n" },
  { label: "우리채권액(원)", w: 15, t: "n" },
  { label: "선순위채권(원)", w: 15, t: "n" },
  { label: "인수권리(원)", w: 15, t: "n" },
  { label: "집행비용(원)", w: 14, t: "n" },
  { label: "배당재원(원)", w: 15, t: "n" },
  { label: "배당가능액(원)", w: 15, t: "n" },
  { label: "회수액(원)", w: 15, t: "n" },
  { label: "회수율(%)", w: 10, t: "r" },
  { label: "실익판정", w: 15 },
  { label: "최선순위설정", w: 22 },
  { label: "청구금액(원)", w: 15, t: "n" },
  { label: "배당요구종기", w: 12 },
  { label: "임차인", w: 7, t: "c" },
  { label: "인수임차인", w: 9, t: "c" },
  { label: "조세채권", w: 8, t: "c" },
  { label: "이해관계인", w: 9, t: "c" },
  { label: "경매신청자", w: 12 },
  { label: "가격시점", w: 12 },
  { label: "감정경과(개월)", w: 12, t: "c" },
  { label: "명세서", w: 10 },
  { label: "인수권리 내용", w: 40 },
  { label: "법정지상권", w: 20 },
  { label: "특이사항", w: 46 },
];
const VERDICT_COL = OUT_COLS.findIndex((c) => c.label === "실익판정");

// 한 사건 응답 → 매물별 행 배열. 응답 원본은 호출부에서 바로 버린다.
// input: 업로드 시트에서 온 { ref, claim, senior, assumed, cost }
export function caseRows(data, input) {
  const lots = data?.lots || [];
  if (!lots.length) return [failRow(data?.caseNo || input?.caseNo, input, "물건 없음", "error")];

  const ci = data.caseInfo || {};
  const taxCount = (ci.parties || []).filter((p) => TAX_PARTY.has(p.type)).reduce((a, p) => a + p.count, 0);
  const insolvency = (ci.relatedCases || []).some((r) => r.insolvency);
  const scopes = scopeTenants(data);
  const baseDate = data.appraisal?.priceBaseDate || "";

  return lots.map((lot, i) => {
    const tn = scopes[i] || { list: [], scoped: true };
    const assumeList = tn.list.filter((t) => opposability(t.moveIn, lot.seniorDate).assume);
    // 인수금액: 업로드에 적어 왔으면 그 값, 아니면 인수권리 문장에서 뽑은 최대 금액
    const autoAssumed = Math.max(0, ...extractAmounts(lot.assumedRights), 0);
    const assumed = input?.assumed != null ? input.assumed : autoAssumed;
    const b = benefitOf({
      expected: lot.expected, assumed,
      cost: input?.cost, senior: input?.senior, claim: input?.claim,
    });
    const gap = monthsBetween(baseDate, lot.saleDate);

    // 특이사항 — 담당자가 필터를 걸 칼럼. 실익을 깎거나 판정을 못 믿게 만드는 것만 모은다.
    const flags = [];
    if (lot.detailReady === false && !data.partial) flags.push("명세서 미공개");
    if (lot.assumedRights) flags.push("인수권리 있음");
    if (assumeList.length) flags.push(`대항력 임차인 ${assumeList.length}명`);
    if (!tn.scoped && tn.list.length) flags.push("임차인 매물구분 불명");
    if (taxCount) flags.push(`조세채권 ${taxCount}건`);
    if (insolvency) flags.push("회생·파산 관련사건");
    if (ci.appealed) flags.push("항고");
    if (ci.suspended) flags.push("집행정지");
    if (lot.failCount >= 3) flags.push(`유찰 ${lot.failCount}회 — 예상낙찰가 불확실`);
    if (gap != null && gap >= 18) flags.push(`감정 ${Math.floor(gap / 12)}년 ${gap % 12}개월 경과`);
    if (!lot.rate) flags.push("낙찰가율 조회 실패");
    else if (lot.exact === false && !data.partial) flags.push("용도 매칭 실패 — 전체 낙찰가율 적용");
    if (data.courtConflict) flags.push("동일 사건번호가 여러 법원에 있음 — 법원 확인 필요");
    // 검색에 안 잡혀 사건내역에서 감정가만 건져온 매물. 없는 값이 많다는 걸 반드시 알려야 한다.
    if (data.partial) flags.push("매각물건 검색 미노출 — 사건내역의 감정가로 계산(면적·유찰·명세서·용도 없음, 낙찰가율은 시군구 전체)");
    // 다른 사건번호의 감정가를 쓴 것이라 반드시 밝힌다.
    if (data.parentCase) flags.push(`중복경매 — 감정가·소재지는 모사건 ${data.parentCase}의 값`);
    if (lot.usageMix?.length > 1) flags.push(`용도 혼재 ${lot.usageMix.join(" ")}`);
    // ⚠ 한 사건에 매물이 여럿이면 우리 채권액을 매물마다 그대로 적용한다(매물별 시나리오).
    //   칼럼을 세로로 더하면 같은 채권을 여러 번 세게 된다. 파일에 못 박아 둔다.
    if (lots.length > 1) flags.push(`이 사건 매물 ${lots.length}건 — 채권액이 매물마다 중복 적용됨(회수액 세로합 금지)`);

    const o = lot.objects?.[0] || {};
    const addr = [lot.sido, lot.sigungu, lot.dong, o.jibun, o.building, o.unit]
      .filter(Boolean).join(" ")
      + (lot.objects?.length > 1 ? ` 외 ${lot.objects.length - 1}건` : "");

    return [
      input?.ref || "",
      data.caseNo || "",
      data.court || "",
      data.dept || "",
      lot.lotNo || "",
      addr,
      lot.usage || "",
      lot.areaSum == null ? null : round1(lot.areaSum),
      ymdLabel(lot.saleDate),
      lot.failCount == null ? null : num(lot.failCount),
      num(lot.appraisal),
      num(lot.minPrice) || null,
      lot.rate ? round1(lot.rate) : null,
      lot.rate ? Math.round(lot.expected) : null,
      b.K || null,
      b.S || null,
      b.A || null,
      b.C || null,
      b.E ? Math.round(b.pool) : null,
      b.E ? Math.round(b.ours) : null,
      b.K > 0 ? Math.round(b.recovered) : null,
      b.rate != null ? round1(b.rate) : null,
      VERDICT_LABEL[b.verdict],
      lot.seniorDate || "",
      num(lot.claimAmount) || null,
      ymdLabel(lot.demandDeadline),
      tn.list.length,
      assumeList.length,
      taxCount,
      num(ci.partyCount) || null,
      ci.applicant?.name || "",
      ymdLabel(baseDate),
      gap ?? null,
      lot.detailReady === false ? "미공개" : lot.seniorDate ? "공개" : "",
      lot.assumedRights || "",
      lot.surfaceRight || "",
      flags.join(" / "),
    ];
  });
}

// 조회 안 된 사건도 한 줄 남긴다 — 올린 사건이 전부 결과에 있어야 대사가 된다.
// ⚠ 전부 "조회 실패"로 뭉뚱그리면 안 된다. 종결된 사건과 오타는 담당자가 할 일이 완전히 다르다.
//   실익판정 칸에 사유를 그대로 넣어야 필터로 갈라낼 수 있다.
export function failRow(caseNo, input, message, reason, status) {
  const row = new Array(OUT_COLS.length).fill(null);
  row[0] = input?.ref || "";
  row[1] = caseNo || "";
  row[2] = status?.court || "";
  row[14] = input?.claim ?? null;
  row[15] = input?.senior ?? null;
  row[17] = input?.cost ?? null;
  if (status?.claimAmount) row[24] = status.claimAmount;
  row[VERDICT_COL] = NOT_FOUND_LABEL[reason] || NOT_FOUND_LABEL.error;
  row[OUT_COLS.length - 1] = message || "";
  return row;
}

const round1 = (v) => { const n = Number(v); return Number.isFinite(n) && n ? Math.round(n * 10) / 10 : null; };

// ── 엑셀 만들기 ──────────────────────────────────────────────
// 셀 스타일은 여기서 한 번만 만들고 셀에는 '참조'만 꽂는다.
// 셀마다 스타일 객체를 새로 만들면 36칼럼 × 수백 행만큼 객체가 생긴다.
const LINE = { style: "thin", color: { rgb: "D7DEE8" } };
const BOX = { top: LINE, bottom: LINE, left: LINE, right: LINE };
const HEAD_STYLE = {
  fill: { patternType: "solid", fgColor: { rgb: "0C6B58" } },
  font: { color: { rgb: "FFFFFF" }, bold: true, sz: 11 },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: BOX,
};
const S_TEXT = { border: BOX, alignment: { vertical: "center", horizontal: "left", wrapText: false } };
const S_NUM = { border: BOX, alignment: { vertical: "center", horizontal: "right" }, numFmt: "#,##0" };
const S_RATE = { border: BOX, alignment: { vertical: "center", horizontal: "right" }, numFmt: "0.0" };
const S_CNT = { border: BOX, alignment: { vertical: "center", horizontal: "center" }, numFmt: "#,##0" };
const VERDICT_STYLE = {
  "실익 없음": mkVerdict("8E1B16", "F7CFCC"),
  "일부 회수": mkVerdict("8A5200", "FBE6BE"),
  "전액 회수 가능": mkVerdict("0C6B58", "C7E8DD"),
  "우리 채권액을 입력하세요": mkVerdict("69748A", "EEF2F7"),
  "판단 불가": mkVerdict("69748A", "EEF2F7"),
  "종결된 사건": mkVerdict("69748A", "EEF2F7"),
  "매각기일 없음": mkVerdict("8A5200", "FBE6BE"),
  "부동산 사건 아님": mkVerdict("69748A", "EEF2F7"),
  "사건번호 확인 필요": mkVerdict("8E1B16", "F7CFCC"),
  "조회 실패": mkVerdict("8E1B16", "EEF2F7"),
};
function mkVerdict(fg, bg) {
  return {
    border: BOX, alignment: { vertical: "center", horizontal: "center" },
    fill: { patternType: "solid", fgColor: { rgb: bg } },
    font: { bold: true, color: { rgb: fg }, sz: 11 },
  };
}
const styleFor = (col) => (col.t === "n" ? S_NUM : col.t === "r" ? S_RATE : col.t === "c" ? S_CNT : S_TEXT);

function sheetFromRows(rows) {
  const ws = XLSX.utils.aoa_to_sheet([OUT_COLS.map((c) => c.label), ...rows]);
  ws["!cols"] = OUT_COLS.map((c) => ({ wch: c.w }));
  // 칼럼이 37개라 필터가 없으면 못 쓴다(실익판정·특이사항으로 거르는 게 주 사용법).
  // ⚠ 틀고정(freeze pane)은 넣지 않았다 — xlsx-js-style 0.18.5 의 쓰기 경로에 없어서
  //   !views/!freeze 를 넣어도 파일에 안 들어간다(라이브러리 확인 + 출력 XML 확인).
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: OUT_COLS.length - 1 } }) };
  ws["!rows"] = [{ hpt: 28 }];
  for (let c = 0; c < OUT_COLS.length; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = HEAD_STYLE;
  }
  for (let i = 0; i < rows.length; i++) {
    for (let c = 0; c < OUT_COLS.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c })];
      if (!cell) continue;
      cell.s = c === VERDICT_COL ? (VERDICT_STYLE[cell.v] || S_TEXT) : styleFor(OUT_COLS[c]);
    }
  }
  return ws;
}

// 2번째 시트 — 이 파일이 무엇을 근거로 계산됐는지. 실익 판단은 근거가 남아야 쓸 수 있다.
function metaSheet(meta) {
  const aoa = [
    ["분석 조건"],
    ["생성일시", meta.createdAt],
    ["낙찰가율 기준기간", meta.period],
    ["업로드 사건 수", meta.caseCount],
    ["결과 행 수(매물 기준)", meta.rowCount],
    ["조회 실패", meta.failCount],
    [],
    ["읽는 방법"],
    ["예상낙찰가", "감정가 × 해당 시군구·용도 낙찰가율(법원 매각통계). 시세가 아니라 통계 추정치입니다."],
    ["배당재원", "예상낙찰가 − 인수권리 − 집행비용"],
    ["배당가능액", "배당재원 − 선순위채권. 우리 순위까지 내려오는 금액입니다."],
    ["회수액", "배당가능액과 우리 채권액 중 작은 값. 초과분은 후순위·채무자 몫입니다."],
    [],
    ["반드시 확인할 것"],
    ["선순위채권", "등기부를 봐야 나옵니다. 업로드 시트에 적어 오지 않으면 0으로 계산됩니다."],
    ["집행비용", "법원이 공개하지 않습니다. 업로드 시트에 적어 오지 않으면 0으로 계산됩니다."],
    ["인수권리 금액", "명세서 문장에서 자동으로 뽑은 값입니다. 문장을 직접 확인하세요."],
    ["조세채권", "교부권자·압류권자 '건수'만 공개됩니다. 금액은 법원이 공개하지 않습니다."],
    ["임차인 보증금", "현황조사서에 '미상'으로 오는 경우가 많습니다."],
    ["이해관계인 이름", "법원이 마스킹해서 제공합니다(안OO). 동일인 확인은 따로 해야 합니다."],
    ["명세서 미공개", "매각물건명세서는 매각기일이 가까워야 공개됩니다. 그 전에는 선순위·청구금액이 비어 있습니다."],
    [],
    ["조회되는 사건과 안 되는 사건"],
    ["기준", "법원 매각물건 검색은 '지금 매각이 진행 중인 물건 목록'입니다. 사건 아카이브가 아닙니다."],
    ["", "→ 앞으로 잡힌 매각기일이 있는 부동산 매물이 그 사건에 있어야 조회됩니다."],
    ["종결된 사건", "매각·취하·기각으로 끝난 사건. 기일 범위를 어떻게 줘도 안 나옵니다. 실익분석 대상이 아닙니다."],
    ["매각기일 없음", "사건은 진행 중인데 기일이 아직 없거나 변경·취소됐습니다. 기일이 잡히면 조회됩니다."],
    ["부동산 사건 아님", "자동차·선박 경매입니다. 이 도구는 부동산만 봅니다."],
    ["사건번호 확인 필요", "전국 어느 법원에도 그 번호가 없습니다. 이때만 오타를 의심하세요."],
    ["", "사유는 사건내역 조회로 확인합니다(종결 여부는 법원의 종국구분코드 그대로)."],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 24 }, { wch: 92 }];
  for (const r of [0, 7, 13]) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (cell) cell.s = { font: { bold: true, sz: 12, color: { rgb: "0C6B58" } } };
  }
  return ws;
}

export function buildResultBook(rows, meta) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), "실익분석");
  XLSX.utils.book_append_sheet(wb, metaSheet(meta), "분석조건");
  return wb;
}

// 업로드 양식 — 어떤 칼럼을 알아보는지 보여준다.
// 사건번호만 있어도 돌아가지만, 선순위·집행비용이 없으면 0으로 계산돼 실익이 과대평가된다.
export function buildTemplateBook() {
  const head = ["관리번호", "사건번호", "우리채권액", "선순위채권", "집행비용", "인수권리금액"];
  const aoa = [
    head,
    ["A-1001", "2024타경115858", 200000000, 300000000, 20000000, null],
    ["A-1002", "2023타경109238", 150000000, null, null, null],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }];
  for (let c = 0; c < head.length; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = HEAD_STYLE;
  }
  for (let r = 1; r <= 2; r++) {
    for (let c = 2; c < head.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.s = S_NUM;
    }
  }
  const notes = XLSX.utils.aoa_to_sheet([
    ["업로드 양식 안내"],
    ["사건번호", "필수. '2024타경115858' 형식. 앞에 법원명이 붙어 있어도 읽습니다."],
    ["관리번호", "선택. 내부 채권번호·고객명 등 아무 값이나. 결과 파일 첫 칼럼에 그대로 돌려드립니다."],
    ["우리채권액", "선택. 없으면 실익판정이 '우리 채권액을 입력하세요'로 나옵니다."],
    ["선순위채권", "선택(등기부 확인 필요). 없으면 0으로 계산돼 실익이 과대평가됩니다."],
    ["집행비용", "선택. 없으면 0으로 계산됩니다."],
    ["인수권리금액", "선택. 비워두면 매각물건명세서 문장에서 자동으로 뽑습니다."],
    [],
    ["칼럼 이름은 바꿔도 됩니다", "채권액 / 선순위 / 경매비용 같은 흔한 이름도 알아봅니다."],
    ["사건번호 칼럼을 못 찾으면", "시트 전체를 훑어 사건번호 형식만 주워 담습니다(부가 칼럼은 무시)."],
    [`한 번에 ${MAX_CASES}건까지`, "넘으면 파일을 나눠 올려주세요."],
  ]);
  notes["!cols"] = [{ wch: 24 }, { wch: 80 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "업로드");
  XLSX.utils.book_append_sheet(wb, notes, "안내");
  return wb;
}

// 워크북 → 파일 저장. Blob·objectURL 을 즉시 반납한다.
export function saveBook(wb, filename) {
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true });
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
