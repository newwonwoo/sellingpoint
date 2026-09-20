import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import regions from "./regions.json";
import { routeInput } from "./registry";
import { courtSggCodes, dedupeSggOptions } from "./courtCodes";
import { groupRows, matchUsageRow } from "./statsModel.js";
import { bucketMonth, categoriesOf, findWindows, monthRange, referenceGrid, shiftYM } from "./backtrack.js";

const YEARS = Array.from({ length: 12 }, (_, i) => 2026 - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

// 매각통계 응답 스키마 (확인된 컬럼명 → 한글 라벨 + 단위는 헤더에)
const SCHEMA = [
  { key: "lclDspslGdsLstUsgNm", label: "물건용도", unit: "", type: "text", w: "19%" },
  { key: "auctnNum", label: "경매건수", unit: "건", type: "int", w: "11%" },
  { key: "dspslNum", label: "매각건수", unit: "건", type: "int", w: "11%" },
  { key: "aeeEvlGrsAmt", label: "감정가", unit: "억원", type: "eok", w: "13%" },
  { key: "dspslGrsAmt", label: "매각가", unit: "억원", type: "eok", w: "13%" },
  { key: "dspslRate", label: "매각율", unit: "%", type: "rate", w: "10%" },
  { key: "dspslAmtRate", label: "매각가율", unit: "%", type: "rate", emph: true, w: "23%" },
];

function findRows(obj) {
  let best = [];
  const visit = (o) => {
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" && !Array.isArray(o[0])) {
        if (o.length > best.length) best = o;
      }
      o.forEach(visit);
    } else if (o && typeof o === "object") Object.values(o).forEach(visit);
  };
  visit(obj);
  return best;
}
function toOptions(data) {
  return findRows(data)
    .map((r) => {
      const e = Object.entries(r);
      const code = e.find(([k, v]) => /cd|code/i.test(k) && v != null && String(v).length <= 7)?.[1] ??
        e.find(([, v]) => /^\d{2,7}$/.test(String(v)))?.[1];
      const name = e.find(([k, v]) => /nm|name/i.test(k) && /[가-힣]/.test(String(v)))?.[1] ??
        e.find(([, v]) => /[가-힣]/.test(String(v)))?.[1];
      return { code: String(code ?? ""), name: String(name ?? "") };
    })
    .filter((o) => o.code && o.name && o.name !== "전체");
}

// 법원 시군구 목록: 시도별로 한 번만 받아 캐시한다(엑셀 전국수집에서 시도마다 재요청하지 않도록).
// 이 목록이 있어야 '금천구=540' 같이 법정동 코드와 어긋난 법원 코드를 찾을 수 있다.
const sggListCache = new Map();
function loadCourtSggList(sidoCode) {
  if (!sidoCode) return Promise.resolve([]);
  if (sggListCache.has(sidoCode)) return sggListCache.get(sidoCode);
  const p = (async () => {
    try {
      const r = await fetch("/api/court-adong", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ty: "2", sidoCode }),
      });
      return toOptions(await r.json());
    } catch { return []; }
  })();
  sggListCache.set(sidoCode, p);
  p.then((list) => { if (!list.length) sggListCache.delete(sidoCode); }); // 실패는 캐시하지 않음
  return p;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtInt = (v) => num(v).toLocaleString();
const fmtEok = (v) => { const n = num(v) / 1e8; return (n >= 100 ? Math.round(n) : Number(n.toFixed(1))).toLocaleString(); };
const fmtRate = (v) => (num(v) ? num(v).toFixed(1) : "-");
function fmtCell(type, v) {
  if (type === "int") return fmtInt(v);
  if (type === "eok") return fmtEok(v);
  if (type === "rate") return fmtRate(v);
  return v ?? "";
}
// 매각가율 셀: 숫자 + 감정가회수 100% 기준선이 있는 미니 막대 (실익분석 핵심 시각화)
function RateBar({ v, bad }) {
  const val = num(v);
  const band = val >= 100 ? "hi" : val >= 80 ? "mid" : val > 0 ? "lo" : "na";
  const w = Math.max(0, Math.min(val, 120)) / 120 * 100;
  return (
    <div className={`ratecell ${band}`}>
      <span className="ratev">{val ? val.toFixed(1) : "-"}{bad ? " ⚠" : ""}</span>
      <span className="ratebar"><i style={{ width: `${w}%` }} /></span>
    </div>
  );
}

// 엑셀 스타일링: 헤더 음영 + 소계/전체 강조 + 매각가율 컬럼 밴드색(가장 중요한 정보)
const XL_COLS = ["시도", "시군구", "물건용도", "경매건수", "매각건수", "감정가(원)", "매각가(원)", "매각율(%)", "매각가율(%)"];
function styleSheet(ws, rows, kinds) {
  const RATE = 8;
  const line = { style: "thin", color: { rgb: "D7DEE8" } };
  const box = { top: line, bottom: line, left: line, right: line };
  // 헤더
  for (let c = 0; c < XL_COLS.length; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[ref]) continue;
    ws[ref].s = {
      fill: { patternType: "solid", fgColor: { rgb: c === RATE ? "084A3D" : "0C6B58" } },
      font: { color: { rgb: "FFFFFF" }, bold: true, sz: 11 },
      alignment: { horizontal: "center", vertical: "center" }, border: box,
    };
  }
  rows.forEach((row, i) => {
    const R = i + 1;
    const nm = String(row["물건용도"] || "");
    const kind = (kinds && kinds[i]) || (nm === "전체" ? "total" : /소계$/.test(nm) ? "subtotal" : "single");
    const isTotal = kind === "total", isSub = kind === "subtotal", isDetail = kind === "detail";
    const rowFill = isTotal ? "DDE7F0" : isSub ? "EEF2F7" : null;
    for (let c = 0; c < XL_COLS.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: R, c });
      if (!ws[ref]) continue;
      const align = { vertical: "center", horizontal: c <= 2 ? "left" : "right" };
      if (c === 2 && isDetail) align.indent = 2;     // 세부용도 들여쓰기
      const s = { border: box, alignment: align };
      if (rowFill) s.fill = { patternType: "solid", fgColor: { rgb: rowFill } };
      if (isTotal || isSub) s.font = { bold: true };
      if (c >= 3 && c <= 6) s.numFmt = "#,##0";
      if (c === 7) s.numFmt = "0.0";
      if (c === RATE) {
        const v = num(row[XL_COLS[RATE]]);
        const band = v >= 100 ? { f: "0C6B58", b: "C7E8DD" } : v >= 80 ? { f: "8A5200", b: "FBE6BE" }
          : v > 0 ? { f: "8E1B16", b: "F7CFCC" } : { f: "69748A", b: rowFill || "FFFFFF" };
        s.fill = { patternType: "solid", fgColor: { rgb: band.b } };
        s.font = { bold: true, color: { rgb: band.f }, sz: 11 };
        s.numFmt = "0.0";
      }
      if (isTotal) s.border = { ...box, top: { style: "medium", color: { rgb: "0C6B58" } }, bottom: { style: "medium", color: { rgb: "0C6B58" } } };
      ws[ref].s = s;
    }
  });
  ws["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 9 }, { wch: 9 }, { wch: 16 }, { wch: 16 }, { wch: 9 }, { wch: 11 }];
  return ws;
}
// 행 정합성: 매각건수≤경매건수, 매각율=매각/경매, 매각가율=매각가/감정가
function checkRow(r) {
  const auctn = num(r.auctnNum), dspsl = num(r.dspslNum);
  const aee = num(r.aeeEvlGrsAmt), amt = num(r.dspslGrsAmt);
  const cntOk = dspsl <= auctn;
  const dOk = auctn === 0 ? dspsl === 0 : Math.abs(dspsl / auctn * 100 - num(r.dspslRate)) < 1;
  const aOk = aee === 0 ? true : Math.abs(amt / aee * 100 - num(r.dspslAmtRate)) < 1;
  return cntOk && dOk && aOk;
}
const isSubtotal = (name) => name === "소계" || name === "전체";
const ymLabel = (ym) => `${String(ym).slice(0, 4)}.${String(ym).slice(4)}`;
// 화면 탭 — 가동중 화면(조회)은 그대로 두고 새 기능은 탭으로 분리한다.
// tools(역추적)는 74% 정체를 파려고 만든 진단 도구라 평소엔 숨기고,
// 주소에 #tools 를 붙였을 때만 탭이 나타난다.
const TABS = [
  { key: "stats", label: "낙찰가율 조회" },
  { key: "case", label: "사건번호 실익" },
  { key: "tools", label: "역추적(진단)" },
];
const initialTab = () => {
  if (typeof window === "undefined") return "stats";
  const h = String(window.location.hash || "").replace(/^#\/?/, "");
  return TABS.some((t) => t.key === h) ? h : "stats";
};
// 인수권리 문장에서 금액을 뽑는다. 예: "임대차보증금 368,000,000원" → 368000000
// 낙찰자가 떠안는 금액이라 예상낙찰가에서 빼야 배당재원이 나온다.
function extractAmounts(text) {
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
function benefitOf({ expected, assumed, cost, senior, claim }) {
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
const VERDICT_LABEL = {
  none: "실익 없음", partial: "일부 회수", full: "전액 회수 가능",
  needclaim: "우리 채권액을 입력하세요", unknown: "판단 불가",
};
// "2023.10.12.가압류" / "2023. 7. 3. 강제경매개시결정" → Date. 못 읽으면 null.
function parseKoDate(text) {
  const m = /(\d{4})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})/.exec(String(text || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
// 대항력 판정 — 전입일이 최선순위 설정일자보다 앞서면 낙찰자가 인수한다.
function opposability(moveIn, seniorDate) {
  const a = parseKoDate(moveIn), b = parseKoDate(seniorDate);
  if (!a || !b) return { known: false };
  return { known: true, assume: a < b, moveIn: a, senior: b };
}
// 조세채권 성격의 이해관계인 — 당해세는 근저당보다 먼저 배당된다.
const TAX_PARTY = new Set(["교부권자", "압류권자"]);
const ymdLabel = (v) => { const s = String(v || ""); return s.length === 8 ? `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6)}` : s; };

// ── 2차 MVP: 주소 → 시군구 로컬 파싱 (외부 API 키 불필요) ──
// 시도 별칭(신·구 명칭 모두) → regions.json 시도코드. 긴 별칭 먼저 매칭.
const SIDO_ALIAS = [
  ["서울", "11"], ["부산", "26"], ["대구", "27"], ["인천", "28"], ["광주광역시", "29"], ["광주", "29"],
  ["대전", "30"], ["울산", "31"], ["세종", "36"], ["경기", "41"],
  ["강원특별자치도", "42"], ["강원", "42"],
  ["충청북도", "43"], ["충북", "43"], ["충청남도", "44"], ["충남", "44"],
  ["전북특별자치도", "45"], ["전라북도", "45"], ["전북", "45"], ["전라남도", "46"], ["전남", "46"],
  ["경상북도", "47"], ["경북", "47"], ["경상남도", "48"], ["경남", "48"],
  ["제주", "50"],
];
const sidoName = (code) => (regions.sido.find((s) => s.code === code) || {}).name || "";
// 주소 문자열에서 {시도코드, 시군구코드} 추출. 실패 시 needSgg/ambiguous/null.
function parseAddress(addr) {
  const a = (addr || "").trim().replace(/\s+/g, " ");
  if (!a) return null;
  const aNS = a.replace(/\s/g, "");
  // 1) 시도: 가장 먼저 등장하는 별칭(우편번호·앞 토큰이 있어도 인식). 긴 별칭 우선.
  let sd = null, sdAt = Infinity;
  for (const [alias, code] of SIDO_ALIAS) {
    const i = a.indexOf(alias);
    if (i >= 0 && (i < sdAt || (i === sdAt && alias.length > 2))) { sd = code; sdAt = i; }
  }
  // 2) 시군구: 해당 시도 목록에서 (공백제거) 부분일치, 긴 이름 우선("수원시 영통구")
  const pick = (list) => {
    const cands = [...(list || [])].sort((x, y) => y.name.length - x.name.length);
    for (const c of cands) if (aNS.includes(c.name.replace(/\s/g, ""))) return c;
    return null;
  };
  if (sd) {
    const list = regions.sigungu[sd] || [];
    let g = pick(list);
    if (!g && list.length === 1) g = list[0]; // 세종 등 단일 구
    if (g) return { sdCode: sd, sdName: sidoName(sd), sggCode: g.code, sggName: g.name };
    return { sdCode: sd, sdName: sidoName(sd), needSgg: true };
  }
  // 3) 시도 없음 → 전국에서 유니크 구 탐색 (구명이 맨 앞에 와야 함: "남구" 등 부분일치 오탐 차단)
  const pickPrefix = (list) => {
    const cands = [...(list || [])].sort((x, y) => y.name.length - x.name.length);
    for (const c of cands) if (aNS.startsWith(c.name.replace(/\s/g, ""))) return c;
    return null;
  };
  const hits = [];
  for (const s of regions.sido) { const g = pickPrefix(regions.sigungu[s.code]); if (g) hits.push({ sdCode: s.code, sdName: s.name, sggCode: g.code, sggName: g.name }); }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: hits };
  return null;
}
// 응답 행에서 용도 드롭다운 목록(소계 제외, 전체 포함)
function useOptions(rows) {
  const seen = new Set(), out = [];
  for (const r of rows || []) { const n = r.lclDspslGdsLstUsgNm; if (!n || n === "소계" || seen.has(n)) continue; seen.add(n); out.push(n); }
  return out;
}

export default function App() {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = String(now.getMonth() + 1).padStart(2, "0");
  const _lastE = new Date(curY, now.getMonth() - 1, 1);        // 지난달(완료된 마지막 달)
  const _def12S = new Date(curY, now.getMonth() - 12, 1);      // 기본: 지난달 포함 12개월
  const _p2 = (n) => String(n).padStart(2, "0");
  const [startY, setStartY] = useState(String(_def12S.getFullYear()));
  const [startM, setStartM] = useState(_p2(_def12S.getMonth() + 1));
  const [endY, setEndY] = useState(String(_lastE.getFullYear()));
  const [endM, setEndM] = useState(_p2(_lastE.getMonth() + 1));
  const [sido, setSido] = useState("");
  const [sigungu, setSigungu] = useState("");
  const [sgList, setSgList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [resp, setResp] = useState(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlMsg, setDlMsg] = useState("");

  // ── 2차 MVP: 주소조회 상태 ──
  const [addr, setAddr] = useState("");
  const [aLoc, setALoc] = useState(null);     // {sdCode,sdName,sggCode,sggName}
  const [aData, setAData] = useState(null);   // {m6,y1,y3} 각 기간 응답 행 배열
  const [aUse, setAUse] = useState("");       // 선택 용도
  const [aBusy, setABusy] = useState(false);
  const [aErr, setAErr] = useState("");
  const [aMsg, setAMsg] = useState("");
  const [aSido, setASido] = useState("");     // 수동 fallback
  const [aSgg, setASgg] = useState("");

  // ── 사건번호 실익 미리보기 상태 ──
  const [tab, setTab] = useState(initialTab);
  // #tools 로 한 번 들어오면 그 세션 동안은 진단 탭을 계속 쓸 수 있게 둔다.
  const [toolsUnlocked, setToolsUnlocked] = useState(
    () => typeof window !== "undefined" && window.location.hash.includes("tools"),
  );
  // 주소창 해시가 바뀌어도(뒤로가기·북마크) 탭이 따라가도록 한다.
  useEffect(() => {
    const onHash = () => {
      setTab(initialTab());
      if (window.location.hash.includes("tools")) setToolsUnlocked(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const showTools = toolsUnlocked || tab === "tools";

  const [caseNo, setCaseNo] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState("");
  const [cData, setCData] = useState(null);
  // 매물별 실익 입력 { [lotNo]: {claim, senior, assumed, cost} }
  const [cCalc, setCCalc] = useState({});
  const setCalcField = (lotNo, field, v) =>
    setCCalc((prev) => ({ ...prev, [lotNo]: { ...(prev[lotNo] || {}), [field]: v } }));

  // ── 낙찰가율 역추적 상태 ──
  const [btSido, setBtSido] = useState("11");
  const [btSgg, setBtSgg] = useState("");
  const [btSgList, setBtSgList] = useState(null);
  const [btGoal, setBtGoal] = useState("74");
  const [btTol, setBtTol] = useState("0.5");
  const [btTarget, setBtTarget] = useState("전체");
  const [btYears, setBtYears] = useState("3");
  const [btBusy, setBtBusy] = useState(false);
  const [btMsg, setBtMsg] = useState("");
  const [btErr, setBtErr] = useState("");
  // 수집한 월별 데이터는 들고 있는다 → 용도·목표값·오차를 바꿔도 법원에 다시 묻지 않고 즉시 재계산
  const [btData, setBtData] = useState(null);   // { monthly, endYM, label }

  useEffect(() => {
    setSigungu(""); setSgList(null);
    if (!sido) return;
    let alive = true;
    loadCourtSggList(sido).then((opts) => { if (alive) setSgList(opts.length ? opts : null); });
    return () => { alive = false; };
  }, [sido]);

  // 드롭다운: 법원 목록을 이름 기준으로 합친다(같은 '금천구'가 540·545 두 줄로 뜨던 것 → 한 줄).
  // 옵션 value는 코드들을 콤마로 이은 문자열이고, 조회 시 전부 조회해 합산한다.
  // 법원 목록을 못 받으면 regions.json + 법정동 뒤 3자리로 폴백.
  const sigunguOptions = useMemo(() => {
    if (sgList) return dedupeSggOptions(sgList);
    const list = sido ? regions.sigungu[sido] || [] : [];
    return list.map((g) => {
      const codes = courtSggCodes(g.name, g.code, null);
      return { name: g.name, codes, code: codes.join(",") };
    });
  }, [sgList, sido]);
  // 선택된 옵션의 법원 코드 배열 (미선택 = 시도 전체)
  const sigunguCodes = useMemo(
    () => (sigungu ? sigunguOptions.find((g) => g.code === sigungu)?.codes || sigungu.split(",") : []),
    [sigungu, sigunguOptions],
  );
  // 역추적 섹션의 시군구 목록 (메인 조회와 독립적으로 고를 수 있어야 해서 따로 둔다)
  useEffect(() => {
    setBtSgg(""); setBtSgList(null);
    if (!btSido) return;
    let alive = true;
    loadCourtSggList(btSido).then((opts) => { if (alive) setBtSgList(opts.length ? opts : null); });
    return () => { alive = false; };
  }, [btSido]);
  const btSggOptions = useMemo(() => {
    if (btSgList) return dedupeSggOptions(btSgList);
    const list = btSido ? regions.sigungu[btSido] || [] : [];
    return list.map((g) => {
      const codes = courtSggCodes(g.name, g.code, null);
      return { name: g.name, codes, code: codes.join(",") };
    });
  }, [btSgList, btSido]);

  // 수집 데이터가 있으면 실제 등장한 대분류를 용도 선택지로 쓴다(전국엔 자동차·선박 등도 나온다)
  const btUseList = useMemo(
    () => ["전체", ...(btData ? categoriesOf(btData.monthly) : [])],
    [btData],
  );
  const btHits = useMemo(() => {
    if (!btData) return null;
    const goal = Number(btGoal);
    if (!Number.isFinite(goal) || goal <= 0) return null;
    return findWindows(btData.monthly, goal, { target: btTarget, tolerance: Number(btTol), minSold: 5 });
  }, [btData, btGoal, btTol, btTarget]);
  const btGrid = useMemo(() => {
    if (!btData) return null;
    return referenceGrid(btData.monthly, {
      target: btTarget, method: "weighted",
      ends: [btData.endYM, shiftYM(btData.endYM, -1), shiftYM(btData.endYM, -2)],
    });
  }, [btData, btTarget]);

  const rawRows = useMemo(() => (resp ? findRows(resp) : []), [resp]);
  // 확인된 스키마면 그 컬럼만, 아니면 원본 키 전체(폴백)
  const known = rawRows.length && "lclDspslGdsLstUsgNm" in rawRows[0];
  const integ = useMemo(() => {
    if (!known) return null;
    const bad = rawRows.filter((r) => !checkRow(r)).length;
    return { total: rawRows.length, bad };
  }, [rawRows, known]);

  // 요약: '전체' 행 우선, 없으면 소계/전체 제외 합산으로 산출
  const summary = useMemo(() => {
    if (!known) return null;
    const tot = rawRows.find((r) => r.lclDspslGdsLstUsgNm === "전체");
    if (tot) return { amtRate: num(tot.dspslAmtRate), rate: num(tot.dspslRate), auctn: num(tot.auctnNum), dspsl: num(tot.dspslNum) };
    const base = rawRows.filter((r) => !isSubtotal(r.lclDspslGdsLstUsgNm));
    const s = base.reduce((a, r) => ({
      auctn: a.auctn + num(r.auctnNum), dspsl: a.dspsl + num(r.dspslNum),
      aee: a.aee + num(r.aeeEvlGrsAmt), amt: a.amt + num(r.dspslGrsAmt),
    }), { auctn: 0, dspsl: 0, aee: 0, amt: 0 });
    return { amtRate: s.aee ? s.amt / s.aee * 100 : 0, rate: s.auctn ? s.dspsl / s.auctn * 100 : 0, auctn: s.auctn, dspsl: s.dspsl };
  }, [rawRows, known]);

  const regionLabel = useMemo(() => {
    if (!sido) return "전국";
    const sn = regions.sido.find((s) => s.code === sido)?.name || sido;
    const gn = sigungu ? sigunguOptions.find((g) => g.code === sigungu)?.name : "";
    return gn ? `${sn} ${gn}` : sn;
  }, [sido, sigungu, sigunguOptions]);

  // 위계 모델: 대분류 코드로 묶어 단일/세부/소계/전체 구분 (화면·엑셀 공용 groupRows)
  const model = useMemo(() => (known ? groupRows(rawRows) : []), [rawRows, known]);

  function presetMonths(n) {
    const e = new Date(curY, now.getMonth() - 1, 1);   // 지난달(이번달 데이터 미완성이라 제외)
    const s = new Date(curY, now.getMonth() - n, 1);    // 지난달 포함 N개월
    setStartY(String(s.getFullYear())); setStartM(String(s.getMonth() + 1).padStart(2, "0"));
    setEndY(String(e.getFullYear())); setEndM(String(e.getMonth() + 1).padStart(2, "0"));
  }
  const presetThisYear = () => {
    setStartY(String(curY)); setStartM("01");
    // 올해 1월 ~ 지난달(이번달 미완성 제외). 1월이면 지난달이 작년이라 1월로 클램프.
    const em = now.getMonth() === 0 ? 1 : now.getMonth();
    setEndY(String(curY)); setEndM(_p2(em));
  };

  async function run() {
    setBusy(true); setError(""); setResp(null); setStatus("조회 중…");
    try {
      const r = await fetch("/api/court-stats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidoCode: sido, sigunguCodes, startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
      setResp(data);
      const n = findRows(data).length;
      // 코드가 둘 이상이면 합산했다는 사실을 밝힌다(법원 사이트 화면과 숫자가 달라 보일 수 있어서).
      const used = data?.meta?.sggCodesUsed;
      const merged = used && used.length > 1 ? ` · 법원코드 ${used.join("+")} 합산` : "";
      setStatus(n ? `완료 · ${n}개 행 (${startY}.${startM} ~ ${endY}.${endM})${merged}` : "응답은 받았지만 표 행이 없습니다(아래 원본 확인).");
    } catch (e) { setError(String(e.message || e)); setStatus(""); }
    finally { setBusy(false); }
  }

  // --- 엑셀 수집 공통 헬퍼 ---
  const periodTag = () => `${startY}${startM}_${endY}${endM}`;
  async function fetchStatsRows(sdCode, sggCodes) {
    const r = await fetch("/api/court-stats", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sidoCode: sdCode, sigunguCodes: sggCodes || [], startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    return findRows(data);
  }
  // 강원(42)/전북(45)은 법원이 신코드(51/52)를 쓸 수 있어 둘 다 시도해 맞는 코드 반환
  async function resolveSido(code) {
    const cands = code === "42" ? ["42", "51"] : code === "45" ? ["45", "52"] : [code];
    if (cands.length === 1) return code;
    for (const c of cands) { try { if ((await fetchStatsRows(c, [])).length) return c; } catch {} }
    return code;
  }

  // ── 2차 MVP: 최근 N개월 롤링 구간 ──
  function rollWindow(months) {
    const ym = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const e = new Date(curY, now.getMonth() - 1, 1);     // 지난달(이번달 미완성 제외)
    const s = new Date(curY, now.getMonth() - months, 1); // 지난달 포함 N개월
    const f = (v) => `${v.slice(0, 4)}.${v.slice(4)}`;
    return { startYM: ym(s), endYM: ym(e), label: `${f(ym(s))}~${f(ym(e))}` };
  }
  const PERIODS = [{ key: "m6", months: 6, name: "6개월" }, { key: "y1", months: 12, name: "1년" }, { key: "y3", months: 36, name: "3년" }];
  // 주소→구 확정된 loc으로 6개월·1년·3년 통계 동시 조회
  async function lookupByAddress(loc) {
    setABusy(true); setAErr(""); setAData(null); setAUse(""); setAMsg("");
    try {
      const eff = await resolveSido(loc.sdCode);
      // 법정동 뒤 3자리를 그대로 쓰면 금천구처럼 0건이 나오는 구가 있어 법원 목록에서 이름으로 찾는다.
      const sgg = courtSggCodes(loc.sggName, loc.sggCode, await loadCourtSggList(eff));
      const calls = PERIODS.map(async (p) => {
        const { startYM, endYM, label } = rollWindow(p.months);
        const r = await fetch("/api/court-stats", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sidoCode: eff, sigunguCodes: sgg, startYM, endYM }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
        return { key: p.key, rows: findRows(data), label };
      });
      const settled = await Promise.all(calls);
      const data = {};
      for (const s of settled) data[s.key] = { rows: s.rows, label: s.label };
      if (!PERIODS.some((p) => data[p.key]?.rows?.length)) throw new Error("해당 구간 통계 행이 없습니다(원본 응답 확인 필요)");
      setAData(data);
      const longest = data.y3?.rows?.length ? data.y3.rows : data.y1?.rows?.length ? data.y1.rows : data.m6.rows;
      const uses = useOptions(longest);
      setAUse(uses.find((u) => u.includes("아파트")) || uses[0] || "");
      const nm = loc.sggName && loc.sggName !== loc.sdName ? `${loc.sdName} ${loc.sggName}` : loc.sdName;
      setAMsg(nm);
    } catch (e) { setAErr(String(e.message || e)); }
    finally { setABusy(false); }
  }
  function onAddrSearch() {
    setAErr(""); setALoc(null);
    const raw = addr.trim();
    if (!raw) { setAErr("주소 또는 등기고유번호를 입력하세요 (예: 서울 강남구 / 1146-1996-072481)."); return; }
    // 입력 라우팅: 등기고유번호 / 등기부주소 / 도로명 / 지번
    const routed = routeInput(raw);
    if (routed.종류 === "등기고유번호") {
      // 번호→주소는 등본 열람(유료)이 있어야만 가능 → 콜백 미연결 시 안내
      setAErr(`등기고유번호(${routed.등기고유번호})는 번호만으로 자동 주소조회가 안 됩니다(등본 열람 필요). 주소·등기부 소재지를 입력하거나, 아래에서 직접 선택하세요.`);
      return;
    }
    const p = parseAddress(raw);
    if (!p) { setAErr("주소에서 시군구를 찾지 못했습니다. 아래에서 직접 선택하세요."); return; }
    if (p.ambiguous) { setAErr(`여러 지역(${p.ambiguous.map((h) => h.sdName).join("/")})과 일치합니다. 아래에서 직접 선택하세요.`); return; }
    if (p.needSgg) { setAErr(`${p.sdName} 안에서 구/군을 찾지 못했습니다. 아래에서 직접 선택하세요.`); setASido(p.sdCode); return; }
    setALoc(p); lookupByAddress(p);
  }
  function onManualLookup() {
    if (!aSido || !aSgg) { setAErr("시도와 구/군을 선택하세요"); return; }
    const g = (regions.sigungu[aSido] || []).find((x) => String(x.code) === String(aSgg));
    const loc = { sdCode: aSido, sdName: sidoName(aSido), sggCode: aSgg, sggName: g ? g.name : "" };
    setALoc(loc); lookupByAddress(loc);
  }
  // 선택 용도의 기간별 낙찰가율 + 보조지표
  const aCells = useMemo(() => {
    if (!aData || !aUse) return null;
    return PERIODS.map((p) => {
      const d = aData[p.key];
      const r = d?.rows?.find((x) => x.lclDspslGdsLstUsgNm === aUse);
      const rate = r ? num(r.dspslAmtRate) : null;
      const band = rate == null ? "na" : rate >= 100 ? "hi" : rate >= 80 ? "mid" : rate > 0 ? "lo" : "na";
      return {
        name: p.name, label: d?.label || "", rate, band,
        auc: r ? num(r.auctnNum) : 0, sold: r ? num(r.dspslNum) : 0,
        evl: r ? num(r.aeeEvlGrsAmt) : 0, sale: r ? num(r.dspslGrsAmt) : 0,
        bad: r ? !checkRow(r) : false,
      };
    });
  }, [aData, aUse]);
  const aUseList = useMemo(() => {
    if (!aData) return [];
    const longest = aData.y3?.rows?.length ? aData.y3.rows : aData.y1?.rows?.length ? aData.y1.rows : aData.m6?.rows || [];
    return useOptions(longest);
  }, [aData]);
  // 엑셀 행: 위계 item → 라벨(소계=그룹명+소계, 전체, 세부/단일=용도명)
  const excelLabel = (it) => it.kind === "total" ? "전체" : it.kind === "subtotal" ? `${it.group} 소계` : it.leaf;
  const mapItem = (sidoName, ggName, it) => ({
    시도: sidoName, 시군구: ggName || "(전체)", 물건용도: excelLabel(it),
    경매건수: num(it.r.auctnNum), 매각건수: num(it.r.dspslNum),
    "감정가(원)": num(it.r.aeeEvlGrsAmt), "매각가(원)": num(it.r.dspslGrsAmt),
    "매각율(%)": num(it.r.dspslRate), "매각가율(%)": num(it.r.dspslAmtRate),
  });
  // 한 시도의 구 전체 수집 (rows + kinds 동기 배열)
  async function collectSido(sd, onProg) {
    const eff = await resolveSido(sd.code);
    const courtList = await loadCourtSggList(eff);
    const list = regions.sigungu[sd.code] || [];
    const targets = list.length ? list : [{ code: "", name: "(전체)" }];
    const rows = [], kinds = []; let fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      onProg && onProg(i + 1, targets.length, g.name || "(전체)");
      try {
        const raw = await fetchStatsRows(eff, g.code ? courtSggCodes(g.name, g.code, courtList) : []);
        for (const it of groupRows(raw)) { rows.push(mapItem(sd.name, g.name, it)); kinds.push(it.kind); }
      } catch { fail++; }
      await new Promise((res) => setTimeout(res, 120));
    }
    return { rows, kinds, fail };
  }
  function toWorkbook(rows, kinds, sheetName) {
    const ws = XLSX.utils.json_to_sheet(rows, { header: XL_COLS });
    styleSheet(ws, rows, kinds);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 28));
    return wb;
  }

  // 버튼: 시도 선택 시 그 시도(또는 특정 구) xlsx 1개 / 미선택 시 전국 zip
  async function downloadExcel() {
    if (!sido) return downloadAllSido();
    setError(""); setDlBusy(true); setDlMsg("준비 중…");
    const sd = regions.sido.find((s) => s.code === sido) || { code: sido, name: sido };
    let rows = [], kinds = [], fail = 0;
    if (sigungu) {
      const name = sigunguOptions.find((g) => g.code === sigungu)?.name || "";
      setDlMsg(`수집 중 · ${name}`);
      try {
        const eff = await resolveSido(sd.code);
        const raw = await fetchStatsRows(eff, sigunguCodes);
        for (const it of groupRows(raw)) { rows.push(mapItem(sd.name, name, it)); kinds.push(it.kind); }
      } catch { fail++; }
    } else {
      const res = await collectSido(sd, (i, t, nm) => setDlMsg(`수집 중 ${i}/${t} · ${nm}`));
      rows = res.rows; kinds = res.kinds; fail = res.fail;
    }
    if (!rows.length) { setError("수집된 데이터가 없습니다 (WAF/IP 차단 또는 해당 기간 데이터 없음)."); setDlBusy(false); setDlMsg(""); return; }
    XLSX.writeFile(toWorkbook(rows, kinds, sd.name), `매각통계_${sd.name}_${periodTag()}.xlsx`);
    setDlMsg(`완료 · ${rows.length}행${fail ? ` (실패 ${fail})` : ""}`);
    setDlBusy(false);
  }

  // 전국 17개 시도 → 시도별 xlsx를 zip 하나로
  async function downloadAllSido() {
    setError(""); setDlBusy(true);
    const zip = new JSZip();
    let totalRows = 0, totalFail = 0;
    for (let s = 0; s < regions.sido.length; s++) {
      const sd = regions.sido[s];
      const { rows, kinds, fail } = await collectSido(sd, (i, t, nm) =>
        setDlMsg(`[${s + 1}/${regions.sido.length}] ${sd.name} · 구 ${i}/${t} ${nm}`));
      totalFail += fail;
      if (rows.length) {
        zip.file(`매각통계_${sd.name}_${periodTag()}.xlsx`, XLSX.write(toWorkbook(rows, kinds, sd.name), { type: "array", bookType: "xlsx" }));
        totalRows += rows.length;
      }
    }
    if (!totalRows) { setError("전국 수집 결과가 비었습니다 (WAF/IP 차단 가능)."); setDlBusy(false); setDlMsg(""); return; }
    setDlMsg("zip 생성 중…");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `매각통계_전국_${periodTag()}.zip`; a.click();
    URL.revokeObjectURL(url);
    setDlMsg(`완료 · 전국 ${totalRows}행 · ${regions.sido.length}개 시도 파일${totalFail ? ` (구 실패 ${totalFail})` : ""}`);
    setDlBusy(false);
  }

  // ── 사건번호 실익 미리보기 ──
  // 사건번호 하나로 그 재산의 감정가를 법원에서 받고, 그 시군구·용도 낙찰가율을 곱해
  // 예상낙찰가를 낸다. 시세 API가 없어도 되는 이유: 감정가를 법원이 이미 매겨놨다.
  async function runCaseLookup() {
    const no = caseNo.trim();
    if (!no) { setCErr("사건번호를 입력하세요 (예: 2024타경115858)"); return; }
    setCBusy(true); setCErr(""); setCData(null); setCCalc({});
    try {
      const r = await fetch("/api/court-case", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseNo: no }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `조회 실패 (${r.status})`);
      if (!data.lots?.length) {
        throw new Error("이 사건의 물건을 찾지 못했습니다. 사건번호를 확인해주세요. (기일이 취소·변경된 사건은 조회되지 않는 경우가 있습니다)");
      }
      // 낙찰가율은 '최근 1년'(지난달 기준 12개월)으로 고정
      const endYM = `${_lastE.getFullYear()}${_p2(_lastE.getMonth() + 1)}`;
      const startYM = shiftYM(endYM, -11);
      const lots = [];
      for (const lot of data.lots) {
        let rate = 0, matched = "-", exact = false;
        try {
          const list = await loadCourtSggList(lot.sidoCode);
          const codes = courtSggCodes(lot.sigungu, lot.sigunguCode, list);
          const rs = await fetch("/api/court-stats", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sidoCode: lot.sidoCode, sigunguCodes: codes, startYM, endYM }),
          });
          const sd = await rs.json();
          if (rs.ok) {
            const m = matchUsageRow(findRows(sd), lot.usage);
            rate = num(m.row?.dspslAmtRate); matched = m.matched; exact = m.exact;
          }
        } catch { /* 낙찰가율만 실패해도 감정가·최저가는 보여준다 */ }
        lots.push({ ...lot, rate, matched, exact, expected: lot.appraisal * rate / 100 });
      }
      // 인수권리 문장에 금액이 적혀 있으면 미리 채워둔다(사용자가 고칠 수 있게).
      const prefill = {};
      for (const lot of lots) {
        const amts = extractAmounts(lot.assumedRights);
        if (amts.length) prefill[lot.lotNo] = { assumed: String(Math.max(...amts)) };
      }
      setCCalc(prefill);
      setCData({ ...data, lots, period: `${ymLabel(startYM)}~${ymLabel(endYM)}` });
    } catch (e) { setCErr(String(e.message || e)); }
    finally { setCBusy(false); }
  }

  // ── 낙찰가율 역추적 ──
  // 외부 서비스가 "평균 낙찰가율 74%"만 주고 기간·산식을 안 밝힐 때, 그 값이 나오는
  // 구간을 거꾸로 찾는다. 월별 통계를 한 번 받아두고 모든 (시작월,종료월) 조합을 로컬 계산.
  async function runBacktrack() {
    const goal = Number(btGoal);
    if (!Number.isFinite(goal) || goal <= 0) { setBtErr("찾을 낙찰가율을 입력하세요 (예: 74)"); return; }
    setBtBusy(true); setBtErr(""); setBtData(null);
    try {
      const codes = btSgg ? (btSggOptions.find((g) => g.code === btSgg)?.codes || btSgg.split(",")) : [];
      const endYM = `${_lastE.getFullYear()}${_p2(_lastE.getMonth() + 1)}`;  // 지난달까지(이번달 미완성)
      const months = monthRange(shiftYM(endYM, -(Number(btYears) * 12 - 1)), endYM);
      const monthly = {};
      for (let i = 0; i < months.length; i += 12) {          // API가 한 번에 12개월까지 받는다
        const chunk = months.slice(i, i + 12);
        setBtMsg(`법원 통계 수집 중 ${Math.min(i + chunk.length, months.length)}/${months.length}개월…`);
        const r = await fetch("/api/court-stats", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sidoCode: btSido, sigunguCodes: codes, months: chunk }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
        for (const [m, rows] of Object.entries(data.monthly || {})) monthly[m] = bucketMonth(rows);
      }
      const sggName = btSgg ? btSggOptions.find((g) => g.code === btSgg)?.name : "";
      const label = `${sidoName(btSido)}${sggName ? ` ${sggName}` : " 전체"}`;
      setBtData({ monthly, endYM, label });
      setBtMsg(`${label} · ${months.length}개월 수집 완료 (${ymLabel(months[0])}~${ymLabel(endYM)}) · 용도·목표값은 재조회 없이 바로 바뀝니다`);
    } catch (e) { setBtErr(String(e.message || e)); setBtMsg(""); }
    finally { setBtBusy(false); }
  }

  function download() {
    if (!rawRows.length) return;
    let head, lines;
    if (known) {
      head = ["물건용도", "경매건수", "매각건수", "감정가(원)", "매각가(원)", "매각율", "매각가율"];
      lines = rawRows.map((r) => [r.lclDspslGdsLstUsgNm, num(r.auctnNum), num(r.dspslNum), num(r.aeeEvlGrsAmt), num(r.dspslGrsAmt), num(r.dspslRate), num(r.dspslAmtRate)]);
    } else {
      head = Object.keys(rawRows[0]);
      lines = rawRows.map((r) => head.map((k) => r[k]));
    }
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [head.map(esc).join(","), ...lines.map((l) => l.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tag = sido ? regions.sido.find((s) => s.code === sido)?.name : "전국";
    a.href = url; a.download = `매각통계_${tag}_${startY}${startM}_${endY}${endM}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const fbCols = !known && rawRows.length ? Object.keys(rawRows[0]) : [];

  return (
    <div className="wrap">
      <header className="head">
        <div className="kicker">채권관리 · 실익분석</div>
        <h1>법원경매 낙찰가율 조회</h1>
        <p className="sub">소재지·기간을 고르면 법원 매각통계의 용도별 매각가율(=낙찰가율)을 가져옵니다.</p>
      </header>
      <nav className="tabs">
        {TABS.filter((t) => t.key !== "tools" || showTools).map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""}
            onClick={() => { setTab(t.key); if (typeof window !== "undefined") window.location.hash = t.key === "stats" ? "" : t.key; }}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "stats" && (<>

      {/* ── 2차 MVP: 주소로 최근 6개월 낙찰가율 찾기 ── */}
      <section className="panel addr">
        <div className="addr-row">
          <input
            className="addr-in" value={addr} placeholder="주소 또는 등기고유번호 입력 (예: 서울 강남구 / 1146-1996-072481)"
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddrSearch(); }}
          />
          <button className="go" onClick={onAddrSearch} disabled={aBusy}>{aBusy ? "조회 중…" : "낙찰가율 조회"}</button>
        </div>
        <div className="addr-hint">도로명·지번·등기부 소재지·등기고유번호 인식 · 통계는 소속 시군구 기준 · 6개월/1년/3년 가중평균</div>

        {aErr && (
          <div className="addr-fallback">
            <div className="status err">오류: {aErr}</div>
            <div className="fb-controls">
              <select value={aSido} onChange={(e) => { setASido(e.target.value); setASgg(""); }}>
                <option value="">시도 선택</option>
                {regions.sido.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
              <select value={aSgg} onChange={(e) => setASgg(e.target.value)} disabled={!aSido}>
                <option value="">{aSido ? "구/군 선택" : "—"}</option>
                {(regions.sigungu[aSido] || []).map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
              </select>
              <button className="go" onClick={onManualLookup} disabled={aBusy || !aSgg}>조회</button>
            </div>
          </div>
        )}

        {aCells && (
          <div className="addr-result">
            <div className="ar-head">
              <div className="ar-loc">{aMsg} · 평균 낙찰가율</div>
              <label className="ar-use">
                <span>용도</span>
                <select value={aUse} onChange={(e) => setAUse(e.target.value)}>
                  {aUseList.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
            </div>
            <div className="ar-cards">
              {aCells.map((c) => (
                <div key={c.name} className={`ar-card ${c.band}`}>
                  <div className="ac-term">{c.name} 가중평균</div>
                  <div className="ac-rate">{c.rate == null ? "-" : c.rate.toFixed(1)}<small>%</small>{c.bad ? <span className="ac-warn"> ⚠</span> : null}</div>
                  <div className="ac-meta">{c.label}</div>
                  <div className="ac-cnt">경매 {c.auc.toLocaleString()} · 매각 {c.sold.toLocaleString()}건</div>
                  <div className="ac-basis">매각가 {fmtEok(c.sale)}억 ÷ 감정가 {fmtEok(c.evl)}억</div>
                </div>
              ))}
            </div>
            <div className="ar-note">※ 매각가율 = 구간 매각가합 ÷ 감정가합 × 100 (기간 가중평균) · 최소단위 시군구 · 이번달 제외</div>
          </div>
        )}
      </section>

      </>)}

      {tab === "case" && (<>
      <div className="section-div">사건번호로 실익 미리보기</div>

      <section className="panel addr">
        <div className="addr-row">
          <input
            className="addr-in" value={caseNo} placeholder="사건번호 입력 (예: 2024타경115858)"
            onChange={(e) => setCaseNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !cBusy) runCaseLookup(); }}
          />
          <button className="go" onClick={runCaseLookup} disabled={cBusy}>{cBusy ? "조회 중…" : "실익 조회"}</button>
        </div>
        <div className="addr-hint">감정평가액 · 청구금액 · 최선순위 설정일자 · 인수권리를 법원 매각물건명세서에서 가져옵니다</div>

        {cErr && <div className="status err">{cErr}</div>}

        {cData && (
          <div className="addr-result">
            <div className="ar-head">
              <div className="ar-loc">
                {cData.caseNo} · {cData.court} {cData.dept}
                {cData.tel ? ` · ${cData.tel}` : ""}
                {` · 매물 ${cData.lots.length}건 / 목적물 ${cData.objectCount}건`}
              </div>
            </div>

            {/* 이해관계인 — 권리 구조 */}
            {cData.caseInfo?.partyCount > 0 && (
              <div className="parties">
                <div className="pt-head">이해관계인 {cData.caseInfo.partyCount}명</div>
                <div className="pt-chips">
                  {cData.caseInfo.parties.map((p) => (
                    <span key={p.type} className={`pt-chip${TAX_PARTY.has(p.type) ? " tax" : ""}`}>
                      {p.type} <b>{p.count}</b>
                    </span>
                  ))}
                </div>
                {cData.caseInfo.parties.some((p) => TAX_PARTY.has(p.type)) && (
                  <div className="pt-warn">
                    교부권자·압류권자는 조세채권입니다. 당해세는 근저당보다 먼저 배당돼 실익을 직접 깎습니다
                    — 금액은 법원이 공개하지 않으니 배당요구 내역을 따로 확인하세요.
                  </div>
                )}
                {cData.caseInfo.relatedCases.length > 0 && (
                  <div className="pt-rel">
                    관련사건 {cData.caseInfo.relatedCases.map((r) => `${r.court} ${r.caseNo}${r.kind ? ` (${r.kind})` : ""}`).join(" · ")}
                  </div>
                )}
                {cData.caseInfo.relatedCases.some((r) => r.insolvency) && (
                  <div className="pt-warn">
                    채무자에게 회생·파산 사건이 걸려 있습니다. 절차가 지연되거나 경매가 중지될 수 있습니다.
                  </div>
                )}
                {(cData.caseInfo.appealed || cData.caseInfo.suspended) && (
                  <div className="pt-warn">
                    {cData.caseInfo.appealed ? "항고됨" : ""}
                    {cData.caseInfo.appealed && cData.caseInfo.suspended ? " / " : ""}
                    {cData.caseInfo.suspended ? "집행정지" : ""}
                    {cData.caseInfo.suspendReason ? ` — ${cData.caseInfo.suspendReason}` : ""} · 매각이 지연됩니다.
                  </div>
                )}
                <div className="pt-note">※ 이름은 법원이 마스킹해서 제공합니다(안OO). 구성과 인원만 확인할 수 있습니다.</div>
              </div>
            )}

            {/* 사건 정보 — 매물 공통 */}
            {cData.lots.find((l) => l.caseName) && (
              <div className="case-info">
                <dl>
                  <dt>사건명</dt><dd>{cData.lots.find((l) => l.caseName).caseName}</dd>
                  {cData.lots.find((l) => l.receiptDate) && <><dt>접수일</dt><dd>{ymdLabel(cData.lots.find((l) => l.receiptDate).receiptDate)}</dd></>}
                  {cData.lots.find((l) => l.startDate) && <><dt>개시결정</dt><dd>{ymdLabel(cData.lots.find((l) => l.startDate).startDate)}</dd></>}
                  {cData.lots.find((l) => l.demandDeadline) && <><dt>배당요구종기</dt><dd>{ymdLabel(cData.lots.find((l) => l.demandDeadline).demandDeadline)}</dd></>}
                  {cData.lots.find((l) => l.claimAmount > 0) && <><dt>청구금액</dt><dd>{fmtEok(cData.lots.find((l) => l.claimAmount > 0).claimAmount)}억</dd></>}
                  {cData.lots.find((l) => l.specWriteDate) && <><dt>명세서 작성</dt><dd>{ymdLabel(cData.lots.find((l) => l.specWriteDate).specWriteDate)}</dd></>}
                </dl>
              </div>
            )}

            {cData.lots.map((lot) => {
              const o = lot.objects[0] || {};
              const band = lot.rate >= 100 ? "hi" : lot.rate >= 80 ? "mid" : lot.rate > 0 ? "lo" : "na";
              const vsMin = lot.minPrice ? (lot.expected / lot.minPrice - 1) * 100 : null;
              return (
                <div key={lot.lotNo} className={`lot ${band}`}>
                  <div className="lot-addr">
                    {cData.lots.length > 1 && <b>매물 {lot.lotNo} · </b>}
                    {lot.sido} {lot.sigungu} {lot.dong} {o.jibun} {o.building} {o.unit}
                    {lot.objects.length > 1 && <span className="lot-more"> 외 {lot.objects.length - 1}건</span>}
                  </div>
                  <div className="lot-meta">
                    {lot.usage} · {fmtInt(lot.areaSum)}㎡ · 유찰 {lot.failCount}회
                    {lot.saleDate ? ` · 매각기일 ${lot.saleDate.slice(0, 4)}.${lot.saleDate.slice(4, 6)}.${lot.saleDate.slice(6)}` : ""}
                  </div>
                  <div className="lot-nums">
                    <div><span>감정가</span><b>{fmtEok(lot.appraisal)}억</b></div>
                    <div><span>최저가</span><b>{fmtEok(lot.minPrice)}억</b></div>
                    <div><span>낙찰가율</span><b>{lot.rate ? `${lot.rate.toFixed(1)}%` : "-"}</b></div>
                    <div className="hero"><span>예상낙찰가</span><b>{lot.rate ? `${fmtEok(lot.expected)}억` : "-"}</b></div>
                  </div>
                  <div className="lot-basis">
                    {lot.rate
                      ? `${lot.sigungu} · ${lot.matched}${lot.exact ? "" : " (용도 매칭 실패 → 전체 적용)"} · ${cData.period} 기준`
                      : "낙찰가율을 가져오지 못했습니다"}
                    {vsMin != null && lot.rate ? ` · 최저가 대비 ${vsMin >= 0 ? "+" : ""}${vsMin.toFixed(0)}%` : ""}
                  </div>

                  {lot.detailReady === false && (
                    <div className="lot-warn">
                      매각물건명세서가 아직 공개되지 않았습니다 — 선순위 설정일자·인수권리·청구금액을 가져올 수 없습니다.
                      명세서는 매각기일이 가까워야 공개되므로{lot.saleDate ? ` (기일 ${ymdLabel(lot.saleDate)})` : ""} 기일 임박 후 다시 조회하세요.
                    </div>
                  )}

                  {/* 매각물건명세서 — 선순위 판단의 근거 */}
                  {(lot.seniorDate || lot.claimAmount > 0 || lot.demandDeadline) && (
                    <div className="lot-rights">
                      <div className="lr-title">
                        매각물건명세서
                        {lot.specWriteDate ? ` · 작성 ${ymdLabel(lot.specWriteDate)}` : ""}
                        {lot.caseName ? ` · ${lot.caseName}` : ""}
                      </div>
                      <dl>
                        {lot.seniorDate && <><dt>최선순위 설정</dt><dd>{lot.seniorDate}</dd></>}
                        {lot.claimAmount > 0 && <><dt>청구금액</dt><dd>{fmtEok(lot.claimAmount)}억 <span className="lr-sub">(경매 신청 채권자)</span></dd></>}
                        {lot.demandDeadline && <><dt>배당요구종기</dt><dd>{ymdLabel(lot.demandDeadline)}</dd></>}
                        {lot.surfaceRight && <><dt>법정지상권</dt><dd>{lot.surfaceRight}</dd></>}
                      </dl>
                      {lot.seniorDate && (
                        <div className="lr-hint">※ 이 날짜보다 먼저 전입한 임차인은 대항력이 있어 낙찰자가 인수합니다.</div>
                      )}
                    </div>
                  )}

                  {lot.assumedRights && (
                    <div className="lot-danger">
                      <b>인수권리 있음</b> — 매각으로 소멸하지 않는 권리입니다. 낙찰자가 떠안습니다.
                      <div className="ld-body">{lot.assumedRights}</div>
                    </div>
                  )}

                  {lot.schedule?.length > 1 && (
                    <div className="lot-sched">
                      저감 이력 {lot.schedule.length}회 · {lot.schedule.map((x) => fmtEok(x.minPrice)).join(" → ")}억
                    </div>
                  )}

                  {lot.specRemark && (
                    <details className="lot-remark">
                      <summary>명세서 비고</summary>
                      <pre>{lot.specRemark}</pre>
                    </details>
                  )}

                  {/* ── 실익 판단 ── */}
                  {(() => {
                    const c = cCalc[lot.lotNo] || {};
                    const b = benefitOf({
                      expected: lot.expected, assumed: c.assumed,
                      cost: c.cost, senior: c.senior, claim: c.claim,
                    });
                    const eok = (v) => (v / 1e8);
                    const field = (key, label, hint) => (
                      <label className="bf-in">
                        <span>{label}{hint ? <i>{hint}</i> : null}</span>
                        <input type="number" min="0" step="1000000" placeholder="0"
                          value={c[key] ?? ""} onChange={(e) => setCalcField(lot.lotNo, key, e.target.value)} />
                      </label>
                    );
                    return (
                      <div className="benefit">
                        <div className="bf-head">실익 판단 <i>단위: 원 — 등기부·집행비용은 직접 입력</i></div>
                        <div className="bf-inputs">
                          {field("claim", "우리 채권액")}
                          {field("senior", "선순위채권 합계", "등기부")}
                          {field("assumed", "인수권리 금액", lot.assumedRights ? "자동" : null)}
                          {field("cost", "집행비용")}
                        </div>
                        <div className="bf-flow">
                          <div><span>예상낙찰가</span><b>{fmtEok(b.E)}억</b></div>
                          <div className="minus"><span>− 인수권리</span><b>{fmtEok(b.A)}억</b></div>
                          <div className="minus"><span>− 집행비용</span><b>{fmtEok(b.C)}억</b></div>
                          <div className="eq"><span>= 배당재원</span><b>{fmtEok(b.pool)}억</b></div>
                          <div className="minus"><span>− 선순위채권</span><b>{fmtEok(b.S)}억</b></div>
                          <div className="eq final"><span>= 우리 배당가능액</span><b>{fmtEok(b.ours)}억</b></div>
                        </div>
                        <div className={`bf-verdict v-${b.verdict}`}>
                          <b>{VERDICT_LABEL[b.verdict]}</b>
                          {b.K > 0 && b.verdict !== "unknown" && (
                            <span> · 채권 {fmtEok(b.K)}억 중 {fmtEok(b.recovered)}억 회수
                              {b.rate != null ? ` (${b.rate.toFixed(0)}%)` : ""}
                              {b.ours > b.K ? ` · 배당가능액 ${fmtEok(b.ours)}억 중 초과분은 후순위 몫` : ""}</span>
                          )}
                          {b.verdict === "needclaim" && <span> · 배당재원은 {fmtEok(b.ours)}억까지 내려옵니다</span>}
                        </div>
                        {lot.failCount >= 3 && (
                          <div className="bf-caution">유찰 {lot.failCount}회 물건이라 예상낙찰가 자체가 불확실합니다. 위 판정은 참고용입니다.</div>
                        )}
                      </div>
                    );
                  })()}

                  {/* 현황조사서 임차인 — 대항력 자동 판정 */}
                  {cData.survey && (cData.survey.tenants.length > 0 || cData.survey.possessions.length > 0) && (
                    <div className="tenants">
                      <div className="tn-head">
                        현황조사서
                        {cData.survey.receivedDate ? ` · 접수 ${ymdLabel(cData.survey.receivedDate)}` : ""}
                        {` · 임차인 ${cData.survey.tenants.length}명`}
                      </div>
                      {cData.survey.tenants.length > 0 ? (
                        <table className="tn-table">
                          <thead><tr><th className="left">전입일</th><th className="left">임차부분</th><th className="left">보증금</th><th className="left">확정일자</th><th className="left">대항력</th></tr></thead>
                          <tbody>
                            {cData.survey.tenants.map((t, i) => {
                              const o = opposability(t.moveIn, lot.seniorDate);
                              return (
                                <tr key={i}>
                                  <td className="left">{t.moveIn || "-"}</td>
                                  <td className="left">{t.part || "-"}</td>
                                  <td className="left">{t.deposit || "미상"}</td>
                                  <td className="left">{t.fixedDate || "-"}</td>
                                  <td className="left">
                                    {!o.known ? <span className="tn-na">판단불가</span>
                                      : o.assume ? <span className="tn-bad">인수 — 최선순위보다 앞섬</span>
                                        : <span className="tn-ok">소멸</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <div className="tn-none">전입세대 등재된 임차인이 없습니다.</div>
                      )}
                      {cData.survey.tenants.some((t) => opposability(t.moveIn, lot.seniorDate).assume) && (
                        <div className="tn-warn">
                          최선순위 설정일자({lot.seniorDate})보다 먼저 전입한 임차인이 있습니다.
                          배당에서 보증금을 다 못 받으면 낙찰자가 인수하므로 그만큼 낙찰가가 낮아집니다.
                        </div>
                      )}
                      {cData.survey.possessions.map((p) => (
                        <div key={p.objectSeq} className="tn-note">
                          {cData.survey.possessions.length > 1 ? `[목적물 ${p.objectSeq}] ` : ""}{p.note}
                        </div>
                      ))}
                      {cData.survey.possessionSummary && <div className="tn-note">{cData.survey.possessionSummary}</div>}
                    </div>
                  )}

                  {lot.appraisalNotes?.length > 0 && (
                    <details className="lot-remark">
                      <summary>감정평가 요점 {lot.appraisalNotes.length}건</summary>
                      <ul className="lr-objs">
                        {lot.appraisalNotes.map((t, i) => <li key={i}>{t}</li>)}
                      </ul>
                    </details>
                  )}

                  {lot.objectAppraisals?.length > 1 && (
                    <details className="lot-remark">
                      <summary>목적물별 감정평가액 {lot.objectAppraisals.length}건</summary>
                      <ul className="lr-objs">
                        {lot.objectAppraisals.map((o) => (
                          <li key={o.seq}>
                            #{o.seq} {o.dong} {o.jibun} {o.building} {o.area} {o.landCategory} — <b>{fmtEok(o.appraisal)}억</b>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {lot.usageMix?.length > 1 && <div className="lot-warn">용도가 섞여 있습니다 — {lot.usageMix.join(", ")}. 대표 용도로 계산했습니다.</div>}
                  {lot.failCount >= 3 && <div className="lot-warn">⚠ 유찰 {lot.failCount}회 — 평균 낙찰가율로는 예측이 맞지 않습니다. 유찰이 반복되는 물건은 별도 사유(유치권·대항력 임차인 등)를 확인하세요.</div>}
                  {lot.specialCond && <div className="lot-warn">⚠ 특수조건 있음 (코드 {lot.specialCond}) — 매각물건명세서 확인 필요</div>}
                </div>
              );
            })}

            {cData.lots.length > 1 && (
              <div className="lot-total">
                사건 합계 · 감정가 {fmtEok(cData.lots.reduce((s, l) => s + l.appraisal, 0))}억
                → 예상낙찰가 {fmtEok(cData.lots.reduce((s, l) => s + l.expected, 0))}억
              </div>
            )}
            <div className="ar-note">※ 예상낙찰가 = 법원 감정가 × 해당 시군구·용도 매각가율(최근 1년 금액가중). 최선순위 설정일자·인수권리는 매각물건명세서에서 가져온 값이며, 임차인 개별 현황과 집행비용은 반영되지 않습니다.</div>
          </div>
        )}
      </section>

      </>)}

      {tab === "stats" && (<>
      <div className="section-div">상세 통계 (지역·기간 직접 선택)</div>

      <section className="panel controls">
        <label><span>기간 시작</span>
          <div className="ym">
            <select value={startY} onChange={(e) => setStartY(e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
            <select value={startM} onChange={(e) => setStartM(e.target.value)}>{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
        </label>
        <label><span>기간 종료</span>
          <div className="ym">
            <select value={endY} onChange={(e) => setEndY(e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
            <select value={endM} onChange={(e) => setEndM(e.target.value)}>{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
        </label>
        <label><span>시도(소재지)</span>
          <select value={sido} onChange={(e) => setSido(e.target.value)}>
            <option value="">전국</option>
            {regions.sido.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label><span>시군구</span>
          <select value={sigungu} onChange={(e) => setSigungu(e.target.value)} disabled={!sido}>
            <option value="">{sido ? (sgList === null ? "불러오는 중…" : "전체") : "—"}</option>
            {sigunguOptions.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </label>
        <button className="go" onClick={run} disabled={busy}>{busy ? "조회 중…" : "조회"}</button>
        <button className="go alt" onClick={downloadExcel} disabled={dlBusy || busy}>{dlBusy ? "수집 중…" : (sido ? "엑셀 받기(구별)" : "전국 엑셀(zip)")}</button>
      </section>

      <div className="presets">
        <span>기간 빠른 선택</span>
        <button onClick={() => presetMonths(3)}>최근 3개월</button>
        <button onClick={() => presetMonths(6)}>최근 6개월</button>
        <button onClick={() => presetMonths(12)}>최근 12개월</button>
        <button onClick={presetThisYear}>올해</button>
      </div>

      {dlMsg && <div className="status">{dlMsg}</div>}

      {(status || error) && <div className={`status ${error ? "err" : ""}`}>{error ? `오류: ${error}` : status}</div>}

      {rawRows.length > 0 && (
        <>
          {summary && (
            <section className="stats">
              <div className="stat hero">
                <div className="sl">전체 매각가율</div>
                <div className="sv">{summary.amtRate.toFixed(1)}<small>%</small></div>
                <div className="sc">{regionLabel} · {startY}.{startM}–{endY}.{endM}</div>
              </div>
              <div className="stat"><div className="sl">매각율</div><div className="sv">{summary.rate.toFixed(1)}<small>%</small></div></div>
              <div className="stat"><div className="sl">경매건수</div><div className="sv">{summary.auctn.toLocaleString()}<small>건</small></div></div>
              <div className="stat"><div className="sl">매각건수</div><div className="sv">{summary.dspsl.toLocaleString()}<small>건</small></div></div>
            </section>
          )}

          <div className="toolbar">
            {integ && (
              <span className={`badge ${integ.bad ? "warn" : "ok"}`}>
                정합성 {integ.total - integ.bad}/{integ.total}행 일치{integ.bad ? ` · ${integ.bad}행 불일치` : ""}
              </span>
            )}
            <button className="csv" onClick={download}>CSV 내려받기</button>
          </div>

          <section className="panel tablewrap">
            {known ? (
              <table className="fixed">
                <colgroup>{SCHEMA.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
                <thead><tr>{SCHEMA.map((c) => (
                  <th key={c.key} className={`${c.type === "text" ? "left" : "num"} ${c.emph ? "on" : ""}`}>
                    {c.label}{c.unit ? <i>({c.unit})</i> : ""}
                  </th>
                ))}</tr></thead>
                <tbody>
                  {model.map((m, i) => {
                    const r = m.r;
                    const ok = checkRow(r);
                    const rowCls = m.kind === "total" ? "grandtotal" : m.kind === "subtotal" ? "subtot" : m.kind === "detail" ? "ingroup" : "cat";
                    return (
                      <tr key={i} className={`${rowCls} ${ok ? "" : "bad"}`}>
                        {SCHEMA.map((c) => {
                          if (c.type === "text") {
                            let label = r[c.key];
                            if (m.kind === "subtotal") label = m.group ? `${m.group} 소계` : "소계";
                            return <td key={c.key} className={`left ${m.kind === "detail" ? "indent" : ""}`} title={label}>{label}</td>;
                          }
                          return (
                            <td key={c.key} className={`num ${c.emph ? "ratecol" : ""}`}>
                              {c.emph ? <RateBar v={r[c.key]} bad={!ok} /> : fmtCell(c.type, r[c.key])}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table><thead><tr>{fbCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{rawRows.map((r, i) => <tr key={i}>{fbCols.map((c) => <td key={c} className="num">{String(r[c] ?? "")}</td>)}</tr>)}</tbody>
              </table>
            )}
          </section>
          <p className="foot">감정가·매각가는 억원 단위(원 단위는 CSV에 그대로). 매각가율=매각가÷감정가, 매각율=매각건수÷경매건수. 막대의 세로선은 감정가 회수 100% 기준. ⚠는 원본 합계와 1%p 이상 어긋난 행.</p>
        </>
      )}

      {resp && !rawRows.length && !error && (
        <section className="panel"><div className="status">표 행이 없습니다. 응답 원본:</div>
          <pre className="raw">{JSON.stringify(resp, null, 2).slice(0, 2000)}</pre></section>
      )}

      </>)}

      {tab === "tools" && (<>
      <div className="section-div">낙찰가율 역추적 (기간·산식 거꾸로 찾기)</div>

      <section className="panel controls bt">
        <label><span>시도</span>
          <select value={btSido} onChange={(e) => setBtSido(e.target.value)}>
            {regions.sido.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label><span>시군구</span>
          <select value={btSgg} onChange={(e) => setBtSgg(e.target.value)} disabled={!btSido}>
            <option value="">전체</option>
            {btSggOptions.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </label>
        <label><span>대상 용도</span>
          <select value={btTarget} onChange={(e) => setBtTarget(e.target.value)} disabled={!btData}>
            {btUseList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label><span>찾을 낙찰가율(%)</span>
          <input className="bt-num" type="number" step="0.1" value={btGoal}
            onChange={(e) => setBtGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !btBusy) runBacktrack(); }} />
        </label>
        <label><span>허용오차</span>
          <select value={btTol} onChange={(e) => setBtTol(e.target.value)}>
            <option value="0.3">±0.3%p</option><option value="0.5">±0.5%p</option><option value="1">±1.0%p</option>
          </select>
        </label>
        <label><span>탐색범위</span>
          <select value={btYears} onChange={(e) => setBtYears(e.target.value)}>
            <option value="3">최근 3년</option><option value="5">최근 5년</option><option value="10">최근 10년</option>
          </select>
        </label>
        <button className="go" onClick={runBacktrack} disabled={btBusy}>{btBusy ? "탐색 중…" : "역추적"}</button>
      </section>

      {(btMsg || btErr) && <div className={`status ${btErr ? "err" : ""}`}>{btErr || btMsg}</div>}

      {btHits && (
        <section className="panel">
          <div className="toolbar">
            <span className={`badge ${btHits.length ? "ok" : "warn"}`}>
              {btData.label} · {btTarget} · {btGoal}% ±{btTol}%p → {btHits.length}개 구간
            </span>
          </div>
          {btHits.length ? (
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th className="left">산식</th><th className="left">기간</th><th>개월</th>
                  <th>낙찰가율<i>%</i></th><th>매각건수<i>건</i></th><th>감정가<i>억</i></th><th>매각가<i>억</i></th>
                </tr></thead>
                <tbody>
                  {btHits.slice(0, 40).map((h, i) => (
                    <tr key={i} className={h.natural ? "cat" : ""}>
                      <td className="left">{h.method === "weighted" ? "금액가중" : "대분류 단순평균"}</td>
                      <td className="left">{ymLabel(h.start)} ~ {ymLabel(h.end)}{h.natural ? " ★" : ""}</td>
                      <td className="num">{h.months}</td>
                      <td className="num">{h.rate.toFixed(1)}</td>
                      <td className="num">{fmtInt(h.sold)}</td>
                      <td className="num">{fmtEok(h.aee)}</td>
                      <td className="num">{fmtEok(h.amt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {btHits.length > 40 && <p className="foot">일치 구간 {btHits.length}개 중 상위 40개만 표시.</p>}
              <p className="foot">★ = 3·6·12·18·24·36·60개월 같은 흔히 쓰는 기간. 여러 구간이 걸리면 그것만으로는 기간이 특정되지 않으니, 다른 지역 값이나 매각건수로 교차확인해야 합니다.</p>
            </div>
          ) : (
            <>
              <div className="status">일치하는 구간이 없습니다. 참고로 실제 값은 이렇습니다:</div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th className="left">종료월</th>{[3, 6, 12, 24, 36].map((L) => <th key={L}>{L}개월</th>)}</tr></thead>
                  <tbody>
                    {(btGrid || []).map((row) => (
                      <tr key={row.end}>
                        <td className="left">{ymLabel(row.end)}</td>
                        {row.cells.map((c) => (
                          <td key={c.months} className="num">{c.rate == null ? "-" : `${c.rate.toFixed(1)}%`}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="foot">찾는 값이 이 범위 밖이면 그 서비스는 다른 산식(사건별 단순평균, 시세 대비 등)이나 다른 집계 범위를 쓰는 것입니다.</p>
            </>
          )}
        </section>
      )}

      </>)}

      <footer className="foot">출처: 대한민국 법원 법원경매정보 · 매각통계(selectRletCortDspslStats)</footer>
    </div>
  );
}
