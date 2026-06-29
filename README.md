# sellingpoint — 법원경매 낙찰가율 조회

법원 매각통계에서 소재지(시도·시군구)×기간별 **용도별 매각가율(=낙찰가율)** 을
가져오는 React+Vite 앱. Vercel 서버리스 프록시로 CORS/WAF 우회.

## 실행
```
npm install
vercel dev        # 로컬(내 한국 IP로 호출) — 가장 확실
# 또는: npm run build && vercel --prod   (icn1 서울 리전)
```

## API (서버리스 프록시)
- `api/court-stats.js` — selectRletCortDspslStats.on. 본문 {searchType:"02", adongSdCd, adongSggCd, startDate, endDate(YYYYMM)}. cortOfcCd는 소재지모드에서 무시되어 빈값 전송.
- `api/court-adong.js` — selectAdong.on. ty="2"+sidoCode → 법원이 쓰는 실제 시군구 코드 목록.

## 화면 (src/App.jsx)
- 기간(연/월) + **빠른선택(최근 3/6/12개월·올해)** + 시도 + 시군구(법원 코드 라이브) → 조회.
- 응답 행 자동 표 + 매각가율 컬럼 강조 + CSV 내려받기.

## 첫 조회 확인사항
- WAF/IP 차단 시 502 → vercel dev(집 IP) 또는 EC2(서울 IP)에서 호출.
- 컬럼명이 영문코드로 뜨면, 매각가율 컬럼 확인 후 한글 라벨링 예정.
