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
const PAGE_SIZE = 40;    // 사이트와 동일. ⚠ 1 같은 작은 값을 주면 서버가 0건으로 돌려준다.
const MAX_PAGES = 10;    // 목적물 400건. 한 사건이 이보다 클 일은 없다(상한이 없으면 무한루프 위험)

// ── 조회되는 사건과 안 되는 사건 ──────────────────────────────
// [핵심] searchControllerMain.on 은 '지금 매각 진행 중인 물건 목록'이지 사건 아카이브가 아니다.
//   그래서 조회되는 조건은 딱 하나다 — "앞으로 잡힌 매각기일이 있는 부동산 매물이 이 사건에 있다".
//   종결된 사건은 기일 범위를 어떻게 줘도 안 나온다.
//   실측(2016타경5000, 종국 2016.07.26): 오늘~+10년 0건 / 2016년 0건 / 2006~2036 0건 /
//   종국 직전 한 달 0건 / 법원코드까지 지정해도 0건.
//
// [그래서] 0건이 왔을 때 "사건번호를 확인하세요"라고 하면 대개 틀린 말이다. 사건은 멀쩡히 있고
//   종결됐을 뿐인 경우가 많다. 사건내역 API(pgj15A)는 종결 사건도 돌려주므로 이걸로 사유를 가른다.
//   판정 기준은 법원 화면 로직 그대로다 — ultmtDvsCd 가 "000"이면 미종국, 아니면 종국.
//
//   유형은 src/caseModel.js 의 NOT_FOUND_LABEL 과 같다:
//     closed 종결 / not_realty 부동산 아님 / suspended 집행정지 / appealed 항고 /
//     no_appraisal 감정가 미공개 / absent 번호 없음(여기서만 입력을 의심한다)
//
// ⚠ 사건내역은 법원코드가 필수다(빈 값·부분 값 모두 안 받는다). 검색이 실패해 법원을 모르므로
//   전 법원을 훑는다. 실측 최악 1.6초(51곳 전부), 보통 0.3~1초(먼저 걸리면 조기 종료).
//
// 법원코드 목록 — 매각기일별 검색에 cortOfcCd 를 넣어 B000200~B000799 를 훑어 얻었다(51곳).
// ⚠ '지금 진행 물건이 있는 법원'만 잡힌다. 물건이 하나도 없는 지원은 빠질 수 있다.
//    다시 만들려면 같은 방법으로 코드 범위를 훑으면 된다(pageSize 는 반드시 40).
const COURT_CODES = [
  "B000210", "B000211", "B000212", "B000213", "B000214", "B000215",
  "B000240", "B000241",
  "B000250", "B000251", "B000252", "B000253", "B000254",
  "B000260", "B000261", "B000262", "B000263", "B000264",
  "B000270", "B000271", "B000272",
  "B000280", "B000281", "B000282", "B000283", "B000284", "B000285",
  "B000310", "B000311", "B000312", "B000313", "B000315", "B000317", "B000320",
  "B000410", "B000411", "B000412", "B000414",
  "B000420", "B000421", "B000423", "B000424", "B000431",
  "B000510", "B000511", "B000513", "B000514",
  "B000520", "B000521", "B000523",
  "B000530",
];
const PROBE_BATCH = 10;   // 한 번에 10곳씩. 51곳을 한꺼번에 던지면 법원 서버가 막는다.

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

// 사건내역 원본. 종결 사건도 돌려준다 — 검색과 다른 점이 이것이다.
async function caseDetail(cookie, csNo, courtCode) {
  try {
    const r = await fetch(BASE + PARTY_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15AF01.xml",
        "SC-Userid": "SYSTEM", "SC-Pgmid": "PGJ15AF01", Cookie: cookie,
      },
      body: JSON.stringify({ dma_srchCsDtlInf: { csNo, cortOfcCd: courtCode, pgmId: "PGJ15AF01", srchInfo: {} } }),
    });
    if (r.status !== 200) return null;
    const d = (await r.json())?.data;
    return d?.dma_csBasInf ? d : null;
  } catch { return null; }
}

// ── 검색에 안 잡히는 사건의 감정가 ────────────────────────────
// 사건내역의 dlt_dspslGdsDspslObjctLst 에 매물별 감정가가 들어 있다. 이게 검색보다 넓다.
//   실측(서울중앙 미종국 부동산 13건): 감정가 있고 검색됨 6 / 감정가 있는데 검색 0건 7.
//   절반 넘게가 '감정은 끝났는데 아직 공고 전'이라 검색에만 안 잡히던 것이다.
// ⚠ 종국된 사건은 이 데이터셋도 0건이다(종국 26건 전부 0건 — 종국 10일 지난 건도 0건).
//   즉 이 경로로 살릴 수 있는 건 '미종국 + 감정평가 완료' 사건이다. 종결 사건은 못 살린다.
// ⚠ 여기엔 면적·유찰횟수가 없고 매각물건명세서도 안 열린다. 없는 값을 0으로 채우면
//   "유찰 0회"처럼 읽혀 거짓말이 되므로 null 로 두고 화면에서 '-'로 표시한다.
// ⚠ 용도는 3단계 코드(20000/20100/20104)로만 온다. 코드→이름 표를 만들어 보려고
//   검색 결과와 짝지어 332건을 수확했는데 20104 하나가 아파트·다세대·오피스텔·상가에
//   모두 걸릴 만큼 충돌이 심했다. 억지로 매핑하면 엉뚱한 낙찰가율이 붙으므로 쓰지 않고,
//   용도를 비워 '전체' 낙찰가율로 떨어뜨린 뒤 화면·엑셀에 그 사실을 표시한다.
// ⚠ 여기도 '한 줄 = 목적물'이다. 매물에 목적물이 3개면 같은 감정가가 3줄 반복된다.
//   그대로 매물로 세면 2026타경100137이 10.7억짜리 매물 3건(=32억)으로 보인다. 실제로 그렇게 났다.
//   검색 경로에서 maemulSer 로 묶은 것과 같은 이유로 dspslGdsSeq 로 묶는다.
function lotsFromCase(d) {
  const rows = (d?.dlt_dspslGdsDspslObjctLst || []).filter((g) => n(g.aeeEvlAmt) > 0);
  const objs = d?.dlt_rletCsDspslObjctLst || [];
  const bySeq = new Map();
  for (const g of rows) {
    const key = String(g.dspslGdsSeq ?? "1");
    if (!bySeq.has(key)) bySeq.set(key, { head: g, seqs: [] });
    if (g.dspslObjctSeq != null) bySeq.get(key).seqs.push(String(g.dspslObjctSeq));
  }
  return [...bySeq.values()].map(({ head: g, seqs }) => {
    const mine = objs.filter((o) => seqs.includes(String(o.dspslObjctSeq)));
    const use = mine.length ? mine : objs;
    return {
      lotNo: String(g.dspslGdsSeq ?? "1"),
      courtCode: g.cortOfcCd || "",
      sido: g.adongSdNm || "", sigungu: g.adongSggNm || "", dong: g.adongEmdNm || "",
      sidoCode: g.rprsAdongSdCd || "", sigunguCode: g.rprsAdongSggCd || "",
      appraisal: n(g.aeeEvlAmt),
      minPrice: n(g.fstPbancLwsDspslPrc) || null,   // 공고 전이면 최저가도 없다
      minRate: 0,
      failCount: null,               // 사건내역엔 유찰횟수가 없다. 0으로 채우지 않는다.
      areaSum: null,                 // 면적도 없다.
      saleDate: g.dspslDxdyYmd || "",
      place: "", specialCond: "",
      note: g.dspslGdsRmk || "",
      usage: "", usageMix: [],       // 용도코드는 신뢰할 수 없어 비운다(→ 전체 낙찰가율)
      usageCode: [g.lclDspslGdsLstUsgCd, g.mclDspslGdsLstUsgCd, g.sclDspslGdsLstUsgCd].filter(Boolean).join("/"),
      objects: use.map((o) => ({
        seq: String(o.dspslObjctSeq ?? ""),
        jibun: o.rprsLtnoAddr || "", building: o.bldNm || "",
        unit: o.bldDtlDts || "", usage: o.auctnLstNm || "", area: 0,
      })),
    };
  });
}

// 검색이 0건일 때 사유를 가른다. courtCode 를 알면 한 번, 모르면 전 법원을 훑는다.
async function diagnose(cookie, csNo, courtCode) {
  let d = null;
  if (courtCode) {
    d = await caseDetail(cookie, csNo, courtCode);
  } else {
    for (let i = 0; i < COURT_CODES.length && !d; i += PROBE_BATCH) {
      const hits = await Promise.all(
        COURT_CODES.slice(i, i + PROBE_BATCH).map((c) => caseDetail(cookie, csNo, c)),
      );
      d = hits.find(Boolean) || null;
    }
  }
  if (!d) return { reason: "absent" };
  const b = d.dma_csBasInf;
  const found = { courtCode: b.cortOfcCd || courtCode || "" };
  // 법원 화면 로직과 동일: ultmtDvsCd "000" = 미종국
  const closed = String(b.ultmtDvsCd || "000") !== "000";
  // ⚠ 자동차·선박 경매는 이 앱의 검색 조건(부동산)에 애초에 안 걸린다. 기일을 기다려도 안 나온다.
  //   구분은 사건명으로만 된다 — mvprpRletDvsCd 는 자동차 사건도 "00031R"(부동산)로 온다(실측).
  //   종국이면 '종결'이 더 실질적인 정보라 그쪽을 먼저 본다.
  // ⚠ '동산'을 그냥 넣으면 안 된다 — "부동산강제경매"가 통째로 걸린다(실제로 그렇게 났다).
  //   부동산 사건을 "부동산 사건 아님"이라고 안내하는 최악의 오분류였다. 사건명을 명시한다.
  const notRealty = /자동차|선박|항공기|건설기계|유체동산/.test(b.csNm || "");
  const suspended = SUSPENDED.has(String(b.auctnSuspStatCd || ""));
  const appealed = b.rletApalYn === "Y";
  // 감정가가 없는 이유를 '확실한 근거가 있는 것부터' 고른다.
  // 마지막 no_appraisal 은 "법원이 아직 감정가를 안 냈다"는 사실만 말한다 — 왜 안 냈는지는
  // 법원이 공개하지 않는다.
  // ⚠ '접수 직후라 감정 전'이 아니다. 표본 35건이 전부 개시 8~9개월 지난 사건이었다.
  //   기다리면 나온다고 단정하면 안 된다.
  const reason = closed ? "closed"
    : notRealty ? "not_realty"
      : suspended ? "suspended"
        : appealed ? "appealed"
          : "no_appraisal";
  return {
    ...found,
    reason,
    detail: d,
    court: b.cortOfcNm || "",
    dept: b.cortAuctnJdbnNm || "",
    caseName: b.csNm || "",
    receiptDate: b.csRcptYmd || "",
    startDate: b.csCmdcYmd || "",
    closedDate: b.csUltmtYmd || "",
    claimAmount: n(b.clmAmt),
    appealed: b.rletApalYn === "Y",
    suspended: SUSPENDED.has(String(b.auctnSuspStatCd || "")),
    suspendReason: b.csProgSuspRsn || "",
  };
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

    // 0건이면 왜 0건인지까지 알아내서 돌려준다. 여기서 끝내지 않으면 화면이
    // "사건번호를 확인하세요"라고만 하게 되는데, 대개 사건은 멀쩡하고 종결됐을 뿐이다.
    if (!uniq.length) {
      const { detail, ...d } = await diagnose(cookie, csNo, body.courtCode || "");
      // 검색엔 없어도 감정가가 있으면 그걸로 분석을 살린다. 실익 판단의 출발점이 감정가라서
      // 이게 있으면 '조회 실패'가 아니라 '자료가 덜 찬 조회 성공'이다.
      let lots = d.reason === "closed" ? [] : lotsFromCase(detail);

      // ── 중복경매(이중경매)면 감정가가 '모사건'에 있다 ──
      // 같은 부동산에 경매가 겹쳐 들어오면 감정평가는 먼저 들어온 사건(모사건)에서만 한다.
      // 자식 사건은 감정가가 통째로 비어 있고, 사건내역의 dlt_dpcnMrgTrnscsCsRlet 가 모사건을 가리킨다.
      // 실측: 감정가 없던 미종국 부동산 52건 중 2건이 중복경매였고 2건 다 모사건에서 회수됐다.
      //   2026타경100115 ← 2024타경124852 (반포자이, 49.6억)
      //   2026타경100137 ← 2024타경2099  (종로 효제동, 10.7억)
      // ⚠ 다른 사건번호의 값이므로 반드시 출처를 밝힌다. 조용히 갖다 쓰면 숫자를 믿을 수 없게 된다.
      let parentCase = "";
      if (!lots.length && d.reason !== "closed") {
        const mrg = (detail?.dlt_dpcnMrgTrnscsCsRlet || []).find((x) => x.userReltCsNo);
        if (mrg) {
          const pNo = normalizeCaseNo(mrg.userReltCsNo) || String(mrg.userReltCsNo).trim();
          const pDetail = await caseDetail(cookie, pNo, mrg.reltCortOfcCd || d.courtCode);
          const pLots = lotsFromCase(pDetail);
          if (pLots.length) { lots = pLots; parentCase = pNo; }
        }
      }

      if (lots.length) {
        const courtCode = lots[0].courtCode;
        const survey = await fetchSurvey(cookie, csNo, courtCode);
        const caseInfo = await fetchParties(cookie, csNo, courtCode);
        const appraisal = await fetchAppraisal(cookie, csNo, courtCode);
        for (const lot of lots) { lot.detailReady = false; delete lot.courtCode; }
        return res.status(200).json({
          caseNo: csNo, found: true,
          partial: true, partialReason: d.reason,   // 어디서 왔는지 화면이 밝혀야 한다
          parentCase,                                // 모사건에서 가져왔으면 그 사건번호
          court: d.court || "", dept: d.dept || "", tel: "",
          objectCount: lots.reduce((s, l) => s + l.objects.length, 0),
          courtConflict: false, survey, caseInfo, appraisal, lots,
          caseName: d.caseName, receiptDate: d.receiptDate, claimAmount: d.claimAmount,
        });
      }
      return res.status(200).json({ caseNo: csNo, found: false, lots: [], ...d });
    }

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
      found: true,
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
