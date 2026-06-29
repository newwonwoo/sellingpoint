# sellingpoint — 법원경매 낙찰가율 조회

매각기일 기간을 입력하면 **행정구역(시도·시군구) × 용도별 낙찰가율**(매각가합 ÷ 감정가합)을
집계해 표로 보여주고 CSV로 내려받는 웹앱. 채권관리 실익분석용.

## 구조 (왜 이렇게 만들었나)

```
브라우저(React)  ──fetch──▶  /api/court-page (Vercel 서버리스)  ──▶  courtauction.go.kr JSON API
   │                              (CORS·WAF 우회 프록시, 1호출=1페이지)
   └─ 페이지 넘기기 + 집계 + CSV (클라이언트에서 처리 → 함수 타임아웃 회피)
```

- 브라우저에서 법원API를 직접 부르면 **CORS와 WAF로 막히므로**, 서버리스 함수가 대신 호출한다.
- 한 번 호출 = 한 페이지(40건)라 Vercel 함수 실행시간 제한을 넘기지 않는다.
- 페이지 넘기기·집계·CSV는 프론트가 담당(진행 중 부분결과도 표시).

## 파일

```
api/court-page.js   # 서버리스 프록시 (법원 한 페이지 받아오기)
src/aggregate.js    # 집계 로직 (시도×시군구×용도 낙찰가율) — 프론트와 공용
src/App.jsx         # 화면 + 페이지네이션 루프
src/main.jsx, styles.css, index.html
```

## 1) 로컬에서 먼저 작동 확인 (EC2/배포 전 필수)

```bash
npm install
npm i -g vercel        # 한 번만
vercel dev             # http://localhost:3000
```

`vercel dev`는 프론트와 `/api` 함수를 같이 띄우고, 법원 호출이 **내 PC의 IP(한국)** 로 나간다.
화면에서 매각기일 기간(예: 지난달)을 넣고 **조회** → 표가 채워지면 성공.

> 참고: `npm run dev`(순수 vite)로는 `/api`가 없어서 조회가 안 된다. 반드시 `vercel dev` 사용.

## 2) GitHub 레포에 올리기

```bash
git init
git add .
git commit -m "init: 법원경매 낙찰가율 조회 웹앱"
git branch -M main
git remote add origin https://github.com/newwonwoo/sellingpoint.git
git push -u origin main
```

## 3) Vercel 배포

1. vercel.com → Add New → Project → `newwonwoo/sellingpoint` import
2. Framework: **Vite** 자동 감지 / 빌드설정 그대로 두고 Deploy
3. 이후 `git push`만 하면 자동 재배포

## ⚠️ 알아둘 점 (IP 차단 가능성)

법원 사이트에 봇 차단(WAF)이 있다. **로컬 `vercel dev`(한국 IP)에서는 잘 되더라도, Vercel
배포본은 미국 데이터센터 IP라 차단될 수 있다.** 배포본에서 막히면:

- 1순위 대안: 같은 `api/court-page.js` 로직을 **EC2(서울 IP, 43.201.133.119)** 에 올려 프록시로 쓰고,
  프론트는 그 EC2 주소를 호출하도록 `fetch` 경로만 바꾼다.
- 호출 간격(`PAGE_DELAY`, 기본 1.2초)은 너무 줄이지 말 것. 두 달 1회 배치 용도면 충분히 안전.

## 다음 단계(예정)

- EC2 cron(격월) 적재 + 회사DB 연계
- 실익분석 회수율 보정계수(선순위·집행비용 차감) 반영
