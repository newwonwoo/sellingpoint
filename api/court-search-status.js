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
    '20건 단위 작업 계획': '사건번호를 20건 단위로 나누고 있습니다.',
    '중간 결과 파일 확정': '완료된 묶음의 엑셀 파일을 만들고 있습니다.',
    '전체 결과 생성': '완료된 묶음 파일을 입력 순서대로 합치고 있습니다.',
    '전체 결과 엑셀 보관': '전체 결과를 웹앱에서 받을 수 있도록 보관하고 있습니다.',
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
    let activeJobs = [];
    try {
      const jobsRes = await fetch(
        `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=20`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (jobsRes.ok) {
        const jobs = (await jobsRes.json()).jobs || [];
        activeJobs = jobs
          .filter((job) => job.status === 'in_progress')
          .map((job) => job.name);
        const job = jobs.find((candidate) => candidate.status === 'in_progress') || jobs.at(-1);
        steps = (job?.steps || []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion }));
        const active = job?.steps?.find((step) => step.status === 'in_progress');
        currentStep = active?.name || (run.status === 'completed' ? '완료' : '실행 준비');
        stageMessage = STEP_MESSAGES[currentStep]
          || (currentStep.includes('사건검색') ? '법원 접속 → 캡차 처리 → 결과 파싱을 진행하고 있습니다.' : '')
          || (currentStep.includes('즉시 다운로드 공개') ? '완료된 묶음 파일을 다운로드 가능 상태로 공개하고 있습니다.' : '');
      }
    } catch {
      // 실행 상태 자체는 정상적으로 반환하고 단계 정보만 생략한다.
    }

    let partialResults = [];
    try {
      const artifactsRes = await fetch(
        `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (artifactsRes.ok) {
        const artifacts = (await artifactsRes.json()).artifacts || [];
        partialResults = artifacts.flatMap((artifact) => {
          const match = artifact.name.match(/^court-search-partial-(\d+)-(\d+)$/);
          if (!match || artifact.expired) return [];
          const start = Number(match[1]);
          const end = Number(match[2]);
          return [{
            artifactId: String(artifact.id),
            name: artifact.name,
            filename: `court-search-${String(start).padStart(4, '0')}-${String(end).padStart(4, '0')}.xlsx`,
            start,
            end,
            count: end - start + 1,
            size: artifact.size_in_bytes,
            createdAt: artifact.created_at,
          }];
        }).sort((a, b) => a.start - b.start);
      }
    } catch {
      // 중간 파일 목록 실패가 실행 상태 조회를 막지는 않는다.
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
      activeJobs,
      partialResults,
      completedCases: partialResults.reduce((sum, item) => sum + item.count, 0),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
