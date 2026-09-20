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
const APPRAISAL_PATH = "/pgj/pgj15B/selectAeeWevlInfo.on";    // 감정평가서 (가격시점·평가사)
const SEED_PATH = "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml";
const PAGE_SIZE = 40;    // 사이트와 동일
const MAX_PAGES = 10;    // 목적물 400건. 한 사건이 이보다 클 일은 없다(상한이 없으면 무한루프 위험)

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
// ⚠ 같은 규칙이 src/caseNo.js 에도 있다(엑셀 업로드에서 쓴다). 서버리스 함수를 자기완결로
//   두려고 일부러 공유하지 않았다. 규칙을 고치면 두 곳을 같이 고칠 것 — 여기가 최종 판정이다.
export function normalizeCaseNo(raw) {
  const s = String(raw || "").replace(/\s/g, "");
  const m = /^(\d{4})(?:타경|-)?(\d{1,6})$/.exec(s);
  if (!m) return null;
  // 앞 4자리는 접수 연도다. 검사하지 않으면 사업자번호 "1234567890" 이
  // "1234타경567890" 으로 통과해 법원에 무의미한 조회를 날린다.
  const y = Number(m[1]);
  if (y < 1990 || y > new Date().getFullYear() + 1) return null;
  return `${m[1]}타경${m[2]}`;
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
    // 경매신청자 = 채권자 중 가장 먼저 등재된 사람(intrpsSeq 최소). 청구금액이 이 사람 몫이다.
    const creditors = (d.dlt_rletCsIntrpsLst || [])
      .filter((p) => p.auctnIntrpsDvsNm === "채권자")
      .sort((a, b) => n(a.intrpsSeq) - n(b.intrpsSeq));
    const applicant = creditors[0]
      ? { name: creditors[0].intrpsNm || "", seq: n(creditors[0].intrpsSeq) }
      : null;
    // ⚠ 이름이 마스킹("안OO")이라 동일인 판정을 할 수 없다. 채권자 3명·임차인 5명이면
    //   우연히 같은 마스킹이 나올 수 있다. 단정하지 말고 '확인 필요' 힌트로만 넘긴다.
    //   (청구금액이 인수권리 문장의 보증금과 일치하면 화면에서 근거를 덧붙인다)
    const applicantNameInTenants = !!applicant && (d.dlt_rletCsIntrpsLst || []).some(
      (p) => p.intrpsNm === applicant.name && /임차/.test(p.auctnIntrpsDvsNm || ""),
    );
    return {
      applicant,
      applicantNameInTenants,
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

// 감정평가서 — 가격시점이 핵심이다.
// 감정가는 '그 시점' 시세다. 매각기일까지 몇 년 지났으면 예상낙찰가가 그만큼 빗나간다.
// (실측: 2023타경109238은 가격시점 2023.07.14인데 매각기일이 2026.10.01 — 3년 차이)
async function fetchAppraisal(cookie, csNo, courtCode) {
  try {
    const r = await fetch(BASE + APPRAISAL_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BP03.xml",
        "SC-Userid": "SYSTEM",
        "SC-Pgmid": "PGJ15BP03",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_srchAeeWevl: {
          cortOfcCd: courtCode, csNo, ordTsCnt: "1",
          pgmId: "PGJ15BP03", srchInfo: {},
        },
      }),
    });
    if (r.status !== 200) return null;
    const a = (await r.json())?.data?.dma_ordTsIndvdAeeWevlInf;
    if (!a || !a.dspslPrcCrtrYmd) return null;
    return {
      priceBaseDate: a.dspslPrcCrtrYmd || "",   // 가격시점 (감정가 기준일)
      surveyDate: a.exmnYmd || "",
      writeDate: a.wrtYmd || "",
      appraiser: a.aeeEvlExamrNm || "",
      reportNo: a.aeeWevlNo || "",
    };
  } catch { return null; }
}

// 검색 한 페이지. pageSize 40 고정(사이트와 동일). totalCnt 를 같이 돌려준다.
async function searchPage(cookie, csNo, pageNo, totalCnt) {
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
        pageNo,
        pageSize: String(PAGE_SIZE),
        bfPageNo: pageNo > 1 ? String(pageNo - 1) : "",
        startRowNo: (pageNo - 1) * PAGE_SIZE + 1,
        totalCnt: String(totalCnt),
        // ⚠ totalYn 이 "N" 이면 서버가 전체 건수를 세지 않고 보낸 값을 그대로 돌려준다.
        //   1페이지에서 "N" 을 보내면 totalCnt 가 0으로 돌아와 '다 받았다'고 착각한다
        //   (실측: 2018타경6939 를 pageSize 10으로 받으면 10줄에서 멈춤 — 34줄인데).
        //   항상 "Y" 로 물어봐야 1페이지 응답에 진짜 건수가 실려 온다.
        totalYn: "Y",
        groupTotalCount: 0,
      },
      dma_srchGdsDtlSrchInfo: { ...SEARCH_INFO_TEMPLATE, csNo, ...bidRange() },
    }),
  });
  const text = await r.text();
  if (r.status !== 200) {
    const e = new Error(`법원 서버 응답 ${r.status}`);
    e.status = r.status; e.sample = text.slice(0, 300);
    throw e;
  }
  let data;
  try { data = JSON.parse(text); }
  catch {
    const e = new Error("응답이 JSON이 아닙니다(차단 가능성).");
    e.parse = true; e.sample = text.slice(0, 300);
    throw e;
  }
  const d = data?.data || {};
  return { rows: d.dlt_srchResult || [], totalCnt: parseInt(d?.dma_pageInfo?.totalCnt ?? "0", 10) || 0 };
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

    // 2) 결과 전 페이지를 받는다.
    // ⚠ 1페이지(40줄)만 읽으면 목적물이 많은 사건이 조용히 잘린다. 2018타경6939이 34줄이라
    //   턱걸이로 안 걸렸을 뿐, 잘리면 감정가 합·면적·목적물 수가 전부 과소집계된다.
    //   totalCnt 를 보고 남은 페이지를 이어 받는다(상한 MAX_PAGES).
    let rows = [];
    let totalCnt = 0;
    try {
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const page = await searchPage(cookie, csNo, pageNo, totalCnt);
        totalCnt = page.totalCnt || totalCnt;
        rows = pageNo === 1 ? page.rows : rows.concat(page.rows);
        if (!page.rows.length || rows.length >= totalCnt) break;
      }
    } catch (e) {
      if (e.parse) return res.status(502).json({ error: e.message, sample: e.sample });
      if (e.status) {
        return res.status(502).json({
          error: e.message,
          hint: "WAF/IP 차단일 수 있습니다. vercel dev(로컬) 또는 서울 IP에서 시도해보세요.",
          sample: e.sample,
        });
      }
      throw e;
    }

    // 같은 줄이 중복으로 오는 경우가 있어 docid로 먼저 정리한다
    const seen = new Set();
    const uniq = [];
    for (const x of rows) {
      const key = x.docid || JSON.stringify([x.srnSaNo, x.maemulSer, x.mokmulSer]);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(x);
    }
    rows = null;
    const head = uniq[0] || {};
    // ⚠ 사건번호의 연도·일련번호는 법원별로 따로 돌아간다. 법원코드를 안 주고 검색하므로
    //   같은 번호가 두 법원에 있으면 두 사건이 섞여 온다. 합쳐서 계산하면 안 되니 알린다.
    //   (화면은 경고를 띄우고, 엑셀은 '특이사항'에 찍는다)
    const courtCodes = [...new Set(uniq.map((x) => String(x.boCd || "")).filter(Boolean))];
    const courtNames = [...new Set(uniq.map((x) => String(x.jiwonNm || "")).filter(Boolean))];
    const lots = groupByLot(uniq);

    // 현황조사서·사건내역은 사건 단위라 한 번만 부른다.
    const courtCode = head.boCd || lots[0]?.courtCode;
    const survey = await fetchSurvey(cookie, csNo, courtCode);
    const caseInfo = await fetchParties(cookie, csNo, courtCode);
    const appraisal = await fetchAppraisal(cookie, csNo, courtCode);

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
      court: courtNames.join(" / ") || "",
      dept: head.jpDeptNm || "",
      tel: head.tel || "",
      objectCount: uniq.length,
      courtConflict: courtCodes.length > 1,
      survey,
      caseInfo,
      appraisal,
      lots,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
