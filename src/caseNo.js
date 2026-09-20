// 사건번호 표기 정규화 — API 입력 검증과 엑셀 추출이 같은 규칙을 써야 한다.
// (엑셀 업로드가 생기면서 한 군데에 모았다. 두 곳에 각자 정규식을 두면
//  화면에서는 되는 사건번호가 업로드에서만 조용히 빠지는 사고가 난다.)

// 연도 제정신 검사. 사건번호 앞 4자리는 접수 연도다.
// 이게 없으면 사업자번호 "1234567890" 이 "1234타경567890" 으로 둔갑한다(실제로 테스트에서 났다).
const MIN_YEAR = 1990;
const okYear = (y) => { const n = Number(y); return n >= MIN_YEAR && n <= new Date().getFullYear() + 1; };

// "2024 타경 115858", "2024타경115858", "2024-115858", "2024115858" → "2024타경115858"
// 셀 전체가 사건번호일 때만 인정한다.
export function normalizeCaseNo(raw) {
  const s = String(raw || "").replace(/\s/g, "");
  const m = /^(\d{4})(?:타경|-)?(\d{1,6})$/.exec(s);
  return m && okYear(m[1]) ? `${m[1]}타경${m[2]}` : null;
}

// 문장 안에서 찾아낸다: "서울중앙지방법원 2024타경115858 부동산임의경매" → ["2024타경115858"]
// strict=true 면 '타경'을 반드시 요구한다.
//   ⚠ 어느 칼럼이 사건번호인지 모른 채 시트 전체를 훑을 때는 반드시 strict 로 쓴다.
//     느슨하게 두면 전화번호 "02-1234-5678" 이 "1234타경5678" 로 잡힌다.
const SCAN_LOOSE = /(\d{4})\s*(?:타경|-)\s*(\d{1,6})/g;
const SCAN_STRICT = /(\d{4})\s*타경\s*(\d{1,6})/g;
export function extractCaseNos(text, { strict = false } = {}) {
  const re = strict ? SCAN_STRICT : SCAN_LOOSE;
  re.lastIndex = 0;   // 모듈 전역 정규식이라 직전 사용의 lastIndex 가 남지 않게 한다
  const out = [];
  for (const m of String(text || "").matchAll(re)) if (okYear(m[1])) out.push(`${m[1]}타경${m[2]}`);
  return out;
}

// 셀 하나에서 사건번호 하나를 뽑는다.
//   기본(사건번호 칼럼이라고 알고 있을 때): 셀 전체 일치 → 부분 스캔
//   strict(어느 칼럼인지 모를 때): '타경'이 박힌 것만
export function caseNoFromCell(text, opts) {
  if (opts?.strict) return extractCaseNos(text, opts)[0] || null;
  return normalizeCaseNo(text) || extractCaseNos(text)[0] || null;
}
