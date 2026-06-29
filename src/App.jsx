import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import regions from "./regions.json";

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
// 매각통계 위계: 대분류 코드(lclDspslGdsLstUsgCd)로 묶어 단일/세부/소계/전체 구분
// ⚠ 법원 응답엔 'header' 필드가 없음 → 반드시 대분류 코드로 그룹핑
const GRP_KEYS = ["lclDspslGdsLstUsgCd", "lclAuctnGdsUsgCd"];
function grpKey(r) {
  for (const k of GRP_KEYS) if (r[k] != null && r[k] !== "") return String(r[k]);
  return r.lclDspslGdsLstUsgNm || "";
}
function groupRows(rows) {
  const groups = [];
  for (const r of rows || []) {
    const k = grpKey(r);
    const last = groups[groups.length - 1];
    if (last && last.k === k) last.rows.push(r);
    else groups.push({ k, rows: [r] });
  }
  const out = [];
  for (const g of groups) {
    const multi = g.rows.length > 1;
    const leaves = g.rows.map((r) => r.lclDspslGdsLstUsgNm);
    const distinct = [...new Set(leaves)];
    // 그룹 라벨: 그룹 내 용도명이 같으면 그게 대분류명, 다르면 세부(겸용/소계/전체 제외) 합성
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
  // 1) 시도 (광주=시도 vs 경기 광주시 충돌 방지: 문자열 맨앞에서만 시도 인정)
  let sd = null;
  for (const [alias, code] of SIDO_ALIAS) { if (a.startsWith(alias)) { sd = code; break; } }
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

  useEffect(() => {
    setSigungu(""); setSgList(null);
    if (!sido) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/court-adong", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ty: "2", sidoCode: sido }),
        });
        const data = await r.json();
        const opts = toOptions(data);
        if (alive) setSgList(opts.length ? opts : regions.sigungu[sido] || []);
      } catch { if (alive) setSgList(regions.sigungu[sido] || []); }
    })();
    return () => { alive = false; };
  }, [sido]);

  const sigunguOptions = sgList ?? (sido ? regions.sigungu[sido] || [] : []);
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
        body: JSON.stringify({ sidoCode: sido, sigunguCode: sigungu, startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
      setResp(data);
      const n = findRows(data).length;
      setStatus(n ? `완료 · ${n}개 행 (${startY}.${startM} ~ ${endY}.${endM})` : "응답은 받았지만 표 행이 없습니다(아래 원본 확인).");
    } catch (e) { setError(String(e.message || e)); setStatus(""); }
    finally { setBusy(false); }
  }

  // --- 엑셀 수집 공통 헬퍼 ---
  const periodTag = () => `${startY}${startM}_${endY}${endM}`;
  async function fetchStatsRows(sdCode, sggCode) {
    const r = await fetch("/api/court-stats", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sidoCode: sdCode, sigunguCode: sggCode, startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    return findRows(data);
  }
  // 강원(42)/전북(45)은 법원이 신코드(51/52)를 쓸 수 있어 둘 다 시도해 맞는 코드 반환
  async function resolveSido(code) {
    const cands = code === "42" ? ["42", "51"] : code === "45" ? ["45", "52"] : [code];
    if (cands.length === 1) return code;
    for (const c of cands) { try { if ((await fetchStatsRows(c, "")).length) return c; } catch {} }
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
      const sgg = String(loc.sggCode).slice(-3);
      const calls = PERIODS.map(async (p) => {
        const { startYM, endYM, label } = rollWindow(p.months);
        const r = await fetch("/api/court-stats", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sidoCode: eff, sigunguCode: sgg, startYM, endYM }),
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
    const p = parseAddress(addr);
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
    const list = regions.sigungu[sd.code] || [];
    const targets = list.length ? list : [{ code: "", name: "(전체)" }];
    const rows = [], kinds = []; let fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      onProg && onProg(i + 1, targets.length, g.name || "(전체)");
      try {
        const raw = await fetchStatsRows(eff, g.code ? String(g.code).slice(-3) : "");
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
        const raw = await fetchStatsRows(eff, String(sigungu).slice(-3));
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

      {/* ── 2차 MVP: 주소로 최근 6개월 낙찰가율 찾기 ── */}
      <section className="panel addr">
        <div className="addr-row">
          <input
            className="addr-in" value={addr} placeholder="주소 입력 (예: 서울특별시 강남구 테헤란로 152)"
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onAddrSearch(); }}
          />
          <button className="go" onClick={onAddrSearch} disabled={aBusy}>{aBusy ? "조회 중…" : "낙찰가율 조회"}</button>
        </div>
        <div className="addr-hint">도로명·지번 모두 인식 · 통계는 소속 시군구 기준 · 최근 6개월 평균</div>

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

      <footer className="foot">출처: 대한민국 법원 법원경매정보 · 매각통계(selectRletCortDspslStats)</footer>
    </div>
  );
}
