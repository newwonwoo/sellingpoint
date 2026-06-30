// registry.js — jeonse-pnu의 inputs.py + registry_parser.py 를 JS로 1:1 포팅
// (sellingpoint는 시군구만 필요해서 PNU/공시가/confidence는 제외)
//
// 입력 3종 판별:
//   1) 등기고유번호(14자리)  예) "1146-1996-072481"  → 번호→주소는 콜백 필요(미연결 시 안내)
//   2) 등기부 소재지 주소     예) "서울 강서구 화곡동 504-32 정원빌라 제202호"
//   3) 일반 주소(도로명/지번)  예) "화곡로 123" / "화곡동 504-32"

// ── 시도 약칭 → 정식명칭 (원본 _SIDO 동일) ──
const SIDO = {
  "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시",
  "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시",
  "울산": "울산광역시", "세종": "세종특별자치시", "경기": "경기도",
  "강원": "강원특별자치도", "충북": "충청북도", "충남": "충청남도",
  "전북": "전북특별자치도", "전남": "전라남도", "경북": "경상북도",
  "경남": "경상남도", "제주": "제주특별자치도",
};

// ── 정규식 (원본 동일) ──
const RE_REG_NO = /^\s*(\d{4})-?(\d{4})-?(\d{6})\s*$/;   // 등기고유번호 14자리(4-4-6)
const RE_ROAD = /(로|길)\s*\d/;                            // 도로명 힌트
const RE_HO = /제?\s*([A-Za-z]?\d{1,4}(?:-\d{1,4})?)\s*호/; // 호
const RE_CHUNG = /(지하\s*\d+|[Bb]\d+|제?\s*\d+)\s*층/;     // 층
const RE_JIBUN = /(산)?\s*(\d{1,4})(?:-(\d{1,4}))?/;        // 지번
const RE_EXTRA_PARCEL = /외\s*\d+\s*필지/;                  // 외 N필지

export function isRegistryNumber(text) {
  return RE_REG_NO.test(text || "");
}
export function normalizeRegistryNumber(text) {
  const m = RE_REG_NO.exec(text || "");
  return m ? m[1] + m[2] + m[3] : null;
}
export function looksLikeRoadAddress(text) {
  return RE_ROAD.test(text || "");
}

// 등기부 소재지 문자열 → {시도,시군구,읍면동,산여부,본번,부번,건물명,층,호,경고}
export function parseRegistryAddress(raw) {
  const result = {
    원본: raw || "", 시도: null, 시군구: null, 읍면동: null,
    산여부: "0", 본번: null, 부번: null, 건물명: null, 층: null, 호: null, 경고: [],
  };
  if (!raw || !raw.trim()) { result.경고.push("빈 입력"); return result; }

  let s = raw.split(/\s+/).filter(Boolean).join(" "); // 공백 정리

  // '외 N필지' → 주의 플래그 후 제거
  if (RE_EXTRA_PARCEL.test(s)) {
    result.경고.push("복수필지(외 N필지) - 대표필지로 처리됨");
    s = s.replace(RE_EXTRA_PARCEL, "");
  }

  // 1) 호 (뒤에서부터 의미상, search는 첫 매칭)
  const mHo = RE_HO.exec(s);
  if (mHo) {
    result.호 = mHo[1];
    s = s.slice(0, mHo.index) + s.slice(mHo.index + mHo[0].length);
  } else {
    result.경고.push("호 미인식");
  }

  // 2) 층
  const mChung = RE_CHUNG.exec(s);
  if (mChung) {
    result.층 = mChung[1].replace(/\s/g, "");
    s = s.slice(0, mChung.index) + s.slice(mChung.index + mChung[0].length);
  }

  // 3) 시도 표준화
  s = s.trim();
  let tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const first = tokens[0];
    let matched = false;
    for (const [abbr, full] of Object.entries(SIDO)) {
      if (first === full || first === abbr) { result.시도 = full; tokens = tokens.slice(1); matched = true; break; }
    }
    if (!matched && Object.values(SIDO).includes(first)) { result.시도 = first; tokens = tokens.slice(1); }
  }

  // 4) 시군구 (xx시/군/구), 시+구 동시표기(성남시 분당구) 대응
  if (tokens.length && /[시군구]$/.test(tokens[0])) {
    result.시군구 = tokens[0]; tokens = tokens.slice(1);
    if (tokens.length && /구$/.test(tokens[0])) {
      result.시군구 = (result.시군구 + " " + tokens[0]).trim(); tokens = tokens.slice(1);
    }
  }

  // 5) 읍면동
  if (tokens.length && /[동읍면가리]$/.test(tokens[0])) {
    result.읍면동 = tokens[0]; tokens = tokens.slice(1);
  } else {
    result.경고.push("읍면동 미인식");
  }

  // 6) 남은 토큰에서 지번 + 건물명
  const rest = tokens.join(" ").trim();
  const mJibun = RE_JIBUN.exec(rest);
  if (mJibun) {
    if (mJibun[1] === "산") result.산여부 = "1";
    result.본번 = mJibun[2];
    result.부번 = mJibun[3] || "0";
    const tail = rest.slice(mJibun.index + mJibun[0].length).replace(/^[\s.,번지호]+|[\s.,번지호]+$/g, "");
    if (tail) result.건물명 = tail;
  } else {
    result.경고.push("지번 미인식");
  }

  return result;
}

// 지번(본번-부번) 파생값
export function jibunOf(p) {
  if (!p.본번) return null;
  return (!p.부번 || p.부번 === "0") ? p.본번 : `${p.본번}-${p.부번}`;
}
// 정제엔진/시군구 매칭에 넘길 지번주소 문자열
export function jibunAddressOf(p) {
  const parts = [p.시도, p.시군구, p.읍면동].filter(Boolean);
  let addr = parts.join(" ");
  if (p.본번) {
    const san = p.산여부 === "1" ? "산 " : "";
    addr += ` ${san}${jibunOf(p)}`;
  }
  return addr.trim();
}

// 입력 라우터: 등기고유번호/등기부주소/도로명주소/지번주소 분기
// registryLookup(번호)→주소문자열 콜백을 주면 등기번호도 주소로 이어붙임(미연결 시 needsAddressLookup=true)
export function routeInput(text, registryLookup = null) {
  const raw = (text || "").trim();

  // 1) 등기고유번호?
  if (isRegistryNumber(raw)) {
    const reg = normalizeRegistryNumber(raw);
    const routed = { 종류: "등기고유번호", 원본: raw, 등기고유번호: reg, parsed: null, needsAddressLookup: false };
    if (registryLookup) {
      const addr = registryLookup(reg);
      if (addr) { routed.parsed = parseRegistryAddress(addr); return routed; }
    }
    routed.needsAddressLookup = true;
    return routed;
  }

  // 2) 주소 → 도로명/등기부/지번 구분
  const parsed = parseRegistryAddress(raw);
  if (looksLikeRoadAddress(raw)) {
    return { 종류: "도로명주소", 원본: raw, parsed, needsAddressLookup: false };
  }
  const 종류 = (parsed.호 || parsed.건물명) ? "등기부주소" : "지번주소";
  return { 종류, 원본: raw, parsed, needsAddressLookup: false };
}
