/**
 * GET /api/court-search-status
 * GitHub Actions 실행 상태 반환.
 * headSha가 있으면 해당 입력 커밋에서 시작한 실행만 찾는다.
 */

export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

const STEP_MESSAGES = {
  '체크아웃': '조회 코드를 실행 환경에 준비하고 있습니다.',
  'Python 설정': 'Python 실행 환경을 준비하고 있습니다.',
  '의존성 설치': 'Playwright와 캡차 인식 의존성을 설치하고 있습니다.',
  '입력 파일 확인': '업로드한 사건번호 파일의 형식을 확인하고 있습니다.',
  '사건검색 실행': '법원 사이트 접속, 법원 선택, 캡차 처리, 결과 표 파싱을 진행하고 있습니다.',
  '결과 파일 생성 확인': '조회 결과 엑셀의 사건명과 결과 행을 확인하고 있습니다.',
  '결과 엑셀 보관': '결과 파일을 웹앱에서 받을 수 있도록 보관하고 있습니다.',
  '완료 요약': '조회 마무리 작업을 진행하고 있습니다.',
};

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  }

  try {
    const querySha = String(req.query?.headSha || '').trim();
    const params = new URLSearchParams({ branch: BRANCH, event: 'workflow_dispatch', per_page: '20' });
    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search.yml/runs?${params}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!runsRes.ok) {
      return res.status(500).json({ error: '실행 목록 조회 실패' });
    }

    const data = await runsRes.json();
    const runs = data.workflow_runs || [];
    const run = querySha
      ? runs.find((candidate) => candidate.head_sha === querySha)
      : runs[0];

    if (!run) {
      return res.status(200).json({
        status: querySha ? 'waiting' : 'none',
        conclusion: null,
        headSha: querySha || null,
        message: querySha ? 'Actions 실행을 기다리는 중' : '실행 이력 없음',
      });
    }

    let currentStep = '';
    let stageMessage = '';
    let steps = [];
    try {
      const jobsRes = await fetch(
        `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=20`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (jobsRes.ok) {
        const jobs = (await jobsRes.json()).jobs || [];
        const job = jobs[0];
        steps = (job?.steps || []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion }));
        const active = job?.steps?.find((step) => step.status === 'in_progress');
        currentStep = active?.name || (run.status === 'completed' ? '완료' : '실행 준비');
        stageMessage = STEP_MESSAGES[currentStep] || '';
      }
    } catch {
      // 실행 상태 자체는 정상적으로 반환하고 단계 정보만 생략한다.
    }

    // status: queued | in_progress | completed
    // conclusion: success | failure | cancelled | null
    return res.status(200).json({
      status: run.status,
      conclusion: run.conclusion,
      runId: run.id,
      runUrl: run.html_url,
      headSha: run.head_sha,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      currentStep,
      stageMessage,
      steps,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
