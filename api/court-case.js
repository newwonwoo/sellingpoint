// 사건번호로 그 사건의 경매물건을 가져온다.
// [무엇] searchControllerMain.on 에 csNo(사건번호)만 넣으면 그 사건의 물건 목록이 온다.
//        법원코드(cortOfcCd)는 없어도 되고, "2024타경115858" 형식 그대로 받는다.
// [왜]   실익분석은 '그 재산'이 대상이다. 감정가·최저가·유찰횟수·면적이 여기서 다 나오므로
//        시세 API 없이도 예상낙찰가를 낼 수 있다. (감정가 × 그 시군구·용도 낙찰가율)
// [⚠ 기일 범위를 반드시 같이 보낸다]
//   csNo 만 보내면 서버가 '공고 게시 중인 임박 기일'로 범위를 좁혀버려 사건이 멀쩡히 있는데도
//   0건이 온다. 실측: 매각기일까지 D-10 이내는 조회되고 D-16 이상은 안 됐다(법원마다 편차).
//   bidBgngYmd~bidEndYmd 를 넓게 주면 그 범위 안에 기일이 있는 사건은 전부 잡힌다.
//   검증: 0건이던 4개 사건(2021타경103946 등)이 전부 조회되고, 되던 사건들도 결과 동일.
// [한계] 과거 기일만 있는 사건(종결·취하)은 어떤 범위로도 0건이다. 진행 중 사건만 조회된다.

const BASE = "https://www.courtauction.go.kr";
const SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on";
const DETAIL_PATH = "/pgj/pgj15B/selectAuctnCsSrchRslt.on";   // 사건상세 (매각물건명세서 항목 포함)
const SURVEY_PATH = "/pgj/pgj15B/selectCurstExmndc.on";       // 현황조사서 (임차인 전입일·점유관계)
const PARTY_PATH  = "/pgj/pgj15A/selectAuctnCsSrchRslt.on";   // 사건내역 (이해관계인·관련사건·항고)
const SEED_PATH = "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml";

// 검색 본문 템플릿(필드 ~60개). 부분만 보내면 서버가 거절하므로 전체를 보낸다.
const SEARCH_INFO_TEMPLATE = {
  rletDspslSpcCondCd: "", bidDvsCd: "000331", mvprpRletDvsCd: "00031R",
  cortAuctnSrchCondCd: "0004601", rprsAdongSdCd: "", rprsAdongSggCd: "",
  rprsAdongEmdCd: "", rdnmSdCd: "", rdnmSggCd: "", rdnmNo: "",
  mvprpDspslPlcAdongSdCd: "", mvprpDspslPlcAdongSggCd: "", mvprpDspslPlcAdongEmdCd: "",
  rdDspslPlcAdongSdCd: "", rdDspslPlcAdongSggCd: "", rdDspslPlcAdongEmdCd: "",
  cortOfcCd: "", jdbnCd: "", execrOfcDvsCd: "",
  lclDspslGdsLstUsgCd: "", mclDspslGdsLstUsgCd: "", sclDspslGdsLstUsgCd: "",
  cortAuctnMbrsId: "", aeeEvlAmtMin: "", aeeEvlAmtMax: "",
  lwsDspslPrcRateMin: "", lwsDspslPrcRateMax: "", flbdNcntMin: "", flbdNcntMax: "",
  objctArDtsMin: "", objctArDtsMax: "", mvprpArtclKndCd: "", mvprpArtclNm: "",
  mvprpAtchmPlcTypCd: "", notifyLoc: "off", lafjOrderBy: "", pgmId: "PGJ151F01",
  csNo: "", cortStDvs: "1", statNum: 1, bidBgngYmd: "", bidEndYmd: "",
  dspslDxdyYmd: "", fstDspslHm: "", scndDspslHm: "", thrdDspslHm: "", fothDspslHm: "",
  dspslPlcNm: "", lwsDspslPrcMin: "", lwsDspslPrcMax: "", grbxTypCd: "", gdsVendNm: "",
  fuelKndCd: "", carMdyrMax: "", carMdyrMin: "", carMdlNm: "", sideDvsCd: "",
};

// 기일 검색 범위 — 오늘부터 10년. 넓혀도 결과가 늘지 않고(실측) 좁히면 사건을 놓친다.
function bidRange() {
  const d = new Date();
  const ymd = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
  const end = new Date(d.getFullYear() + 10, d.getMonth(), d.getDate());
  return { bidBgngYmd: ymd(d), bidEndYmd: ymd(end) };
}

function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Origin: BASE,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// "2024 타경 115858", "2024타경115858", "2024-115858" → "2024타경115858"
export function normalizeCaseNo(raw) {
  const s = String(raw || "").replace(/\s/g, "");
  const m = /^(\d{4})(?:타경|-)?(\d{1,6})$/.exec(s);
  return m ? `${m[1]}타경${m[2]}` : null;
}

const n = (v) => { const k = Number(v); return Number.isFinite(k) ? k : 0; };

// ⚠ 응답 한 줄 = '목적물' 이지 경매 단위가 아니다.
//   감정가·최저가·유찰횟수는 '매물(maemulSer)' 단위라 목적물마다 같은 값이 반복된다.
//   그대로 더하면 2018타경6939는 34줄 × 77.88억 = 2,647억이 나온다(실제 77.88억).
//   그래서 매물로 묶고, 금액은 매물에서 한 번만, 면적은 목적물 합으로 만든다.
function groupByLot(rows) {
  const lots = new Map();
  for (const x of rows) {
    const key = String(x.maemulSer ?? "1");
    let lot = lots.get(key);
    if (!lot) {
      lot = {
        lotNo: key,
        courtCode: x.boCd || "",           // 사건상세 조회에 필요
        usageCount: {},
        sido: x.hjguSido || "", sigungu: x.hjguSigu || "", dong: x.hjguDong || "",
        sidoCode: x.daepyoSidoCd || "", sigunguCode: x.daepyoSiguCd || "",
        appraisal: n(x.gamevalAmt),        // 감정가 (매물 단위)
        minPrice: n(x.minmaePrice),        // 최저매각가격 (매물 단위)
        minRate: n(x.notifyMinmaePriceRate1),
        failCount: n(x.yuchalCnt),         // 유찰횟수 (매물 단위)
        saleDate: x.maeGiil || "",
        place: x.maePlace || "",
        specialCond: x.spJogCd || "",
        note: x.mulBigo || "",
        areaSum: 0,
        objects: [],
      };
      lots.set(key, lot);
    }
    const usage = x.dspslUsgNm || "";
    if (usage) lot.usageCount[usage] = (lot.usageCount[usage] || 0) + 1;
    const area = n(x.maxArea);
    lot.areaSum += area;
    lot.objects.push({
      seq: String(x.mokmulSer ?? ""),
      jibun: x.maejibun || x.daepyoLotno || "",
      building: x.buldNm || "",
      unit: x.buldList || "",
      usage, area,
    });
  }
  // 대표 용도: 목적물이 여러 종류면 가장 많은 것 (낙찰가율 매칭에 쓴다)
  return [...lots.values()].map((lot) => {
    const ranked = Object.entries(lot.usageCount).sort((a, b) => b[1] - a[1]);
    const { usageCount, ...rest } = lot;
    return { ...rest, usage: ranked[0]?.[0] || "", usageMix: ranked.map(([k, v]) => `${k}(${v})`) };
  });
}

// 사건상세 — 매각물건명세서의 핵심 3항목이 여기 들어 있다.
//   tprtyRnkHypthcStngDts : 최선순위 설정일자 (이보다 먼저 전입한 임차인은 낙찰자가 인수)
//   ndstrcRghCtt          : 매각으로 소멸하지 않는 권리 = 인수권리 (보증금 인수 등)
//   sprfcExstcDts         : 법정지상권 성립 여지
// 청구금액(clmAmt)·배당요구종기·목적물별 감정평가액·기일 저감이력도 같이 온다.
// ⚠ 응답에 사진 base64(csPicLst)가 들어 있어 용량이 크다. 필요한 필드만 골라 쓴다.
async function fetchDetail(cookie, csNo, courtCode, lotNo) {
  try {
    const r = await fetch(BASE + DETAIL_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ154M03.xml",
        "SC-Userid": "SYSTEM",
        "SC-Pgmid": "PGJ154M03",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_srchGdsDtlSrch: {
          csNo, cortOfcCd: courtCode, dspslGdsSeq: String(lotNo),
          pgmId: "PGJ15BF01", srchInfo: {},
        },
      }),
    });
    if (r.status !== 200) return null;
    const d = (await r.json())?.data?.dma_result;
    // ⚠ 매각물건명세서가 아직 공개되지 않은 사건은 dma_result 가 빈 객체로 온다.
    //   명세서는 매각기일이 가까워야 공개된다(실측: 기일 D-16 공개 / D-18 미공개).
    //   이때 선순위·청구금액을 조용히 비우지 말고 "아직 공개 전"임을 알려야 한다.
    if (!d || !d.dspslGdsDxdyInfo) return { detailReady: false };
    const b = d.csBaseInfo || {};
    const g = d.dspslGdsDxdyInfo || {};
    return {
      detailReady: true,
      caseName: b.csNm || "",                       // 부동산강제경매 / 임의경매
      receiptDate: b.csRcptYmd || "",
      startDate: b.csCmdcYmd || "",
      claimAmount: n(b.clmAmt),                     // 청구금액 (경매 신청 채권자)
      appraisalExact: n(g.aeeEvlAmt),               // 감정평가액 (원 단위)
      firstMinPrice: n(g.fstPbancLwsDspslPrc),
      seniorDate: g.tprtyRnkHypthcStngDts || "",    // 최선순위 설정일자
      assumedRights: g.ndstrcRghCtt || "",          // 인수권리
      surfaceRight: g.sprfcExstcDts || "",          // 법정지상권
      specRemark: g.gdsSpcfcRmk || "",              // 매각물건명세서 비고
      lotRemark: g.dspslGdsRmk || "",
      specWriteDate: g.gdsSpcfcWrtYmd || "",        // 명세서 작성일(정보 기준일)
      demandDeadline: d.dstrtDemnInfo?.[0]?.dstrtDemnLstprdYmd || "",  // 배당요구종기
      objectAppraisals: (d.gdsDspslObjctLst || []).map((o) => ({
        seq: o.dspslObjctSeq, sigungu: o.adongSggNm || "", dong: o.adongEmdNm || "",
        jibun: o.rprsLtnoAddr || "", building: o.bldNm || "",
        area: o.objctArDts || "", landCategory: o.ldcgDts || "",
        appraisal: n(o.aeeEvlAmt),
      })),
      // 감정평가 요점 (위치·교통·이용상황·도로·용도지역 등). 항목코드의 라벨표가 공개돼 있지
      // 않아 문장만 순서대로 담는다 — 문장 자체가 무엇에 대한 설명인지 스스로 밝힌다.
      appraisalNotes: (d.aeeWevlMnpntLst || [])
        .map((x) => String(x.aeeWevlMnpntCtt || "").trim())
        .filter((x) => x && x !== "없음."),
      schedule: (d.gdsDspslDxdyLst || []).map((x) => ({
        date: x.dxdyYmd || "", kind: x.auctnDxdyKndCd || "",
        minPrice: n(x.tsLwsDspslPrc), soldPrice: n(x.dspslAmt),
      })).filter((x) => x.minPrice > 0),
    };
  } catch { return null; }
}

// 현황조사서 — 집행관이 현장에 나가 조사한 점유관계와 임차인 명세.
// 매각물건명세서의 '최선순위 설정일자'와 여기 '전입일'을 비교하면 대항력 판정이 된다.
//   전입일 < 최선순위  → 대항력 있음 = 낙찰자 인수
//   전입일 ≥ 최선순위  → 대항력 없음 = 매각으로 소멸
// ⚠ 사건 단위라 dspslGdsSeq 를 받지 않는다. 임차인은 objctSeq(목적물)로 묶인다.
async function fetchSurvey(cookie, csNo, courtCode) {
  try {
    const r = await fetch(BASE + SURVEY_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BP01.xml",
        "SC-Userid": "SYSTEM",
        "SC-Pgmid": "PGJ15BP01",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_srchCurstExmn: {
          csNo, cortOfcCd: courtCode, dspslGdsSeq: "1",
          pgmId: "PGJ15BP01", srchInfo: {},
        },
      }),
    });
    if (r.status !== 200) return null;
    const d = (await r.json())?.data;
    if (!d) return null;
    const m = d.dma_curstExmnMngInf || {};
    const strip = (v) => String(v || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return {
      surveyDate: strip(m.exmnDtDts),
      receivedDate: m.exmndcRcptnYmd || "",
      possessionSummary: strip(`${m.fstmLstPossRltnDts || ""}${m.scntmLstPossRltnDts || ""}`),
      // 목적물별 점유관계 설명
      possessions: (d.dlt_ordTsRlet || []).map((x) => ({
        objectSeq: x.dspslObjctSeq,
        tenantCount: n(x.lesCnt),
        note: strip(x.gdsPossCtt),
      })).filter((x) => x.note || x.tenantCount),
      // 임차인 명세
      tenants: (d.dlt_ordTsLserLtn || []).map((x) => ({
        objectSeq: x.objctSeq,
        name: x.intrpsNm || "",
        moveIn: String(x.mvinDtlCtt || "").trim(),        // 전입일
        part: x.lesPartCtt || "",                          // 임차부분
        deposit: x.lesDposDts || "",                       // 보증금
        rent: x.mmrntAmtDts || "",                         // 차임
        fixedDate: x.rgstryCrtcpCfmtnCtt || "",            // 확정일자
        remark: strip(x.lesDtsRmk),
      })),
    };
  } catch { return null; }
}

// 사건내역 — 이해관계인 구성과 관련사건. 권리 구조를 한눈에 보여준다.
//   dlt_rletCsIntrpsLst : 채권자·채무자겸소유자·임차인·가압류권자·압류권자·교부권자·배당요구권자
//     ⚠ 이름은 법원이 마스킹해서 준다("안OO"). 사람 특정은 안 되고 구성·인원만 쓴다.
//     교부권자·압류권자는 조세채권이라 최우선 배당으로 실익을 직접 깎는다.
//   dlt_rletReltCsLst   : 관련사건. 회생법원 사건이 걸려 있으면 절차가 지연·중지될 수 있다.
//   rletApalYn "Y"      : 항고됨 (매각 지연)
//   auctnSuspStatCd     : 경매정지상태코드. 01·02 만 '집행정지'다(화면 로직 확인).
const SUSPENDED = new Set(["01", "02"]);
async function fetchParties(cookie, csNo, courtCode) {
  try {
    const r = await fetch(BASE + PARTY_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15AF01.xml",
        "SC-Userid": "SYSTEM",
        "SC-Pgmid": "PGJ15AF01",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_srchCsDtlInf: { csNo, cortOfcCd: courtCode, pgmId: "PGJ15AF01", srchInfo: {} },
      }),
    });
    if (r.status !== 200) return null;
    const d = (await r.json())?.data;
    if (!d) return null;
    const b = d.dma_csBasInf || {};
    const groups = new Map();
    for (const p of d.dlt_rletCsIntrpsLst || []) {
      const t = p.auctnIntrpsDvsNm || "기타";
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(p.intrpsNm || "");
    }
    return {
      parties: [...groups.entries()].map(([type, names]) => ({ type, count: names.length, names })),
      partyCount: (d.dlt_rletCsIntrpsLst || []).length,
      relatedCases: (d.dlt_rletReltCsLst || []).map((x) => ({
        court: x.cortOfcNm || "",
        caseNo: x.userReltCsNo || "",
        kind: x.reltCsDvsNm || "",
        // 회생·파산이면 절차가 멈출 수 있어 따로 표시한다
        insolvency: /회생|파산/.test(`${x.cortOfcNm || ""}${x.userReltCsNo || ""}`),
      })),
      appealed: b.rletApalYn === "Y",
      suspended: SUSPENDED.has(String(b.auctnSuspStatCd || "")),
      suspendReason: b.csProgSuspRsn || "",
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  try {
    const raw = req.method === "POST" ? req.body : req.query;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const csNo = normalizeCaseNo(body.caseNo);
    if (!csNo) {
      return res.status(400).json({ error: "사건번호를 확인해주세요 (예: 2024타경115858)." });
    }

    // 1) 세션 시드 — 검색 화면을 먼저 열어 쿠키 확보(WAF 통과 확률↑)
    const seed = await fetch(BASE + SEED_PATH, { headers: browserHeaders() });
    const setCookies = typeof seed.headers.getSetCookie === "function" ? seed.headers.getSetCookie() : [];
    const cookie = ["mapGuide=Y", "pageCnt=40", "globalDebug=false",
      ...setCookies.map((c) => c.split(";")[0])].join("; ");

    const r = await fetch(BASE + SEARCH_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + SEED_PATH,
        submissionid: "mf_wfm_mainFrame_sbm_selectGdsDtlSrch",
        "SC-Userid": "SYSTEM",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_pageInfo: {
          pageNo: 1, pageSize: "40", bfPageNo: "", startRowNo: 1,
          totalCnt: "0", totalYn: "N", groupTotalCount: 0,
        },
        dma_srchGdsDtlSrchInfo: { ...SEARCH_INFO_TEMPLATE, csNo, ...bidRange() },
      }),
    });

    const text = await r.text();
    if (r.status !== 200) {
      return res.status(502).json({
        error: `법원 서버 응답 ${r.status}`,
        hint: "WAF/IP 차단일 수 있습니다. vercel dev(로컬) 또는 서울 IP에서 시도해보세요.",
        sample: text.slice(0, 300),
      });
    }
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(502).json({ error: "응답이 JSON이 아닙니다(차단 가능성).", sample: text.slice(0, 300) }); }

    const rows = data?.data?.dlt_srchResult || [];
    // 같은 줄이 중복으로 오는 경우가 있어 docid로 먼저 정리한다
    const seen = new Set();
    const uniq = [];
    for (const x of rows) {
      const key = x.docid || JSON.stringify([x.srnSaNo, x.maemulSer, x.mokmulSer]);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(x);
    }
    const head = uniq[0] || {};
    const lots = groupByLot(uniq);

    // 현황조사서·사건내역은 사건 단위라 한 번만 부른다.
    const courtCode = head.boCd || lots[0]?.courtCode;
    const survey = await fetchSurvey(cookie, csNo, courtCode);
    const caseInfo = await fetchParties(cookie, csNo, courtCode);

    // 매물마다 사건상세를 붙인다(선순위·청구금액·명세서 비고). 실패해도 기본 정보는 살린다.
    for (const lot of lots) {
      const detail = await fetchDetail(cookie, csNo, lot.courtCode, lot.lotNo);
      if (detail) {
        // 상세의 감정평가액이 원 단위로 정확하므로 그쪽을 쓴다
        if (detail.appraisalExact > 0) lot.appraisal = detail.appraisalExact;
        Object.assign(lot, detail);
      }
      delete lot.courtCode;
    }

    return res.status(200).json({
      caseNo: csNo,
      court: head.jiwonNm || "",
      dept: head.jpDeptNm || "",
      tel: head.tel || "",
      objectCount: uniq.length,
      survey,
      caseInfo,
      lots,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
