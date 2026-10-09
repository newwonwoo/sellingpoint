/** GET /api/court-search-single-status — requestId로 단건 전용 workflow 상태 확인 */
export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  const requestId = String(req.query?.requestId || '').trim();
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  if (!/^[0-9a-f-]{36}$/.test(requestId)) {
    return res.status(400).json({ error: '올바른 단건 요청 식별자가 필요합니다.' });
  }

  const messages = {
    '조회 의존성 설치': '단건 조회용 브라우저와 캡차 인식기를 준비하고 있습니다.',
    '누적 캡차 모델 불러오기': '검증된 누적 캡차 모델을 불러오고 있습니다.',
    '단건 JSON 입력 준비': '입력한 사건정보를 JSON 조회 요청으로 준비하고 있습니다.',
    '단건 사건검색': '법원 접속 → 캡차 처리 → 사건 결과 확인을 진행하고 있습니다.',
    '단건 새 실행환경 재조회': '새 실행환경과 공인 IP에서 단건 조회를 다시 시도하고 있습니다.',
    '단건 최종 JSON 결과 확정': '조회 결과를 화면 표시용 JSON으로 확정하고 있습니다.',
    '단건 JSON 결과 공개': '확정된 단건 결과를 웹앱에 전달하고 있습니다.',
    '공식 캡차 학습': '결과 확정 후 통과 캡차를 누적 학습하고 있습니다.',
    '다음 실행용 누적 캡차 모델 저장': '다음 조회가 사용할 캡차 모델을 저장하고 있습니다.',
  };

  try {
    const params = new URLSearchParams({ branch: BRANCH, event: 'workflow_dispatch', per_page: '30' });
    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search_single.yml/runs?${params}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
    );
    if (!runsRes.ok) return res.status(502).json({ error: '단건 실행 목록 조회 실패' });
    const runs = (await runsRes.json()).workflow_runs || [];
    const run = runs.find((item) => item.display_title === `단건조회-${requestId}`);
    if (!run) {
      return res.status(200).json({
        status: 'waiting', conclusion: null, requestId,
        message: '단건 Actions 실행을 기다리는 중입니다.',
      });
    }

    let currentStep = '';
    let stageMessage = '';
    let activeJobs = [];
    const jobsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=30`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
    );
    if (jobsRes.ok) {
      const jobs = (await jobsRes.json()).jobs || [];
      activeJobs = jobs.filter((job) => job.status === 'in_progress').map((job) => job.name);
      const job = jobs.find((item) => item.status === 'in_progress') || jobs.at(-1);
      currentStep = job?.steps?.find((step) => step.status === 'in_progress')?.name
        || (run.status === 'completed' ? '완료' : '실행 준비');
      stageMessage = messages[currentStep] || '';
    }

    let resultReady = false;
    try {
      const artifactsRes = await fetch(
        `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (artifactsRes.ok) {
        const artifacts = (await artifactsRes.json()).artifacts || [];
        resultReady = artifacts.some((item) => item.name === 'court-search-single-result' && !item.expired);
      }
    } catch {
      // 결과 준비 여부 조회 실패가 실행 상태 조회를 막지는 않는다.
    }

    return res.status(200).json({
      status: run.status,
      conclusion: run.conclusion,
      requestId,
      runId: run.id,
      runUrl: run.html_url,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      currentStep,
      stageMessage,
      activeJobs,
      resultReady,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
