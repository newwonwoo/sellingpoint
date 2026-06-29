# sellingpoint — 법원경매 낙찰가율 조회

법원 매각통계에서 소재지(시도·시군구)×기간별 용도별 매각가율(=낙찰가율)을 가져오는 React+Vite 앱.

## 실행
```
npm install
vercel dev        # 로컬(한국 IP) — WAF 안전. 엑셀 대량수집도 이걸로.
```

## 기능
- 조회: 시도·시군구·기간 선택 → 용도별 매각가율 표(한글 라벨·정합성 체크·CSV).
- **엑셀 받기(구별)**: 시도 선택 시 그 시도의 구 전체를 순회해 xlsx 1개. 특정 구만 고르면 그 구만.
- **전국 엑셀(zip)**: 시도 미선택 시 17개 시도를 전부 순회 → 시도별 xlsx를 zip 하나로(탭 아닌 파일별). 강원/전북은 신코드(51/52) 자동 보정.
  특정 구를 고른 경우 그 구만. 파일명 `매각통계_{시도}_{startYM}_{endYM}.xlsx`.
- 기간 빠른 선택(최근 3/6/12개월·올해).

## API
- `api/court-stats.js` — selectRletCortDspslStats.on. adongSggCd는 **뒤 3자리**만 전송(법정동 11680 강남구 → "680").
- `api/court-adong.js` — selectAdong.on. 시군구 목록.

## 비고
- 시군구 코드 규칙: 법정동 5자리에서 앞 2자리 떼고 뒤 3자리. cortOfcCd는 소재지모드에서 무시되어 빈값.
- 컬럼: lclDspslGdsLstUsgNm=물건용도, dspslAmtRate=매각가율, dspslRate=매각율, aeeEvlGrsAmt=감정가, dspslGrsAmt=매각가.
