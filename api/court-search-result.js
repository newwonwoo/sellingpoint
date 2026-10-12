/**
 * GET /api/court-search-result
 * - scope=completed: 현재까지 끝난 20건 묶음을 서버에서 합쳐 반환
 * - scope=all: 완결된 전체 파일을 검증해 반환하고, 없으면 모든 묶음을 합쳐 반환
 * - artifactId: 기존 단일 묶음 다운로드 호환
 */

import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DOWNLOAD_CONCURRENCY = 5;

function githubHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

async function fetchAllPages(url, key, token) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}per_page=${PAGE_SIZE}&page=${page}`, {
      headers: githubHeaders(token),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${key} 조회 실패 (${response.status})`);
    }
    const pageItems = (await response.json())[key] || [];
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return items;
  }
  throw new Error(`GitHub ${key} 목록이 너무 많아 안전하게 처리할 수 없습니다.`);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function downloadArtifactXlsx(artifact, token) {
  const response = await fetch(artifact.archive_download_url, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`${artifact.name} 다운로드 실패 (${response.status})`);
  }
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const filenames = Object.keys(zip.files).filter((name) => !zip.files[name].dir && name.toLowerCase().endsWith('.xlsx'));
  const outputName = filenames.find((name) => name === 'output.xlsx' || name.endsWith('/output.xlsx')) || filenames[0];
  if (!outputName) throw new Error(`${artifact.name} 안에 결과 엑셀 파일이 없습니다.`);
  return zip.files[outputName].async('nodebuffer');
}

function workbookRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
}

function rowCount(buffer) {
  return Math.max(0, workbookRows(buffer).length - 1);
}

function parsePartialArtifact(artifact) {
  const match = artifact.name.match(/^court-search-partial-(?:r(\d+)-)?(\d+)-(\d+)$/);
  if (!match || artifact.expired) return null;
  const revision = Number(match[1] || 0);
  const start = Number(match[2]);
  const end = Number(match[3]);
  return { ...artifact, revision, start, end, count: end - start + 1 };
}

function uniqueSortedPartials(artifacts) {
  const byRange = new Map();
  for (const artifact of artifacts) {
    const partial = parsePartialArtifact(artifact);
    if (!partial) continue;
    const key = `${partial.start}-${partial.end}`;
    const previous = byRange.get(key);
    if (!previous || partial.revision > previous.revision
      || (partial.revision === previous.revision
        && new Date(partial.created_at) > new Date(previous.created_at))) {
      byRange.set(key, partial);
    }
  }
  return [...byRange.values()].sort((a, b) => a.start - b.start);
}

function hasCompleteCoverage(partials, expectedTotal) {
  if (!expectedTotal || !partials.length) return false;
  let nextStart = 1;
  for (const partial of partials) {
    if (partial.start !== nextStart) return false;
    nextStart = partial.end + 1;
  }
  return nextStart - 1 === expectedTotal;
}

async function expectedCaseCount(repo, runId, token) {
  const jobs = await fetchAllPages(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`,
    'jobs',
    token,
  );
  return jobs.reduce((maximum, job) => {
    const match = String(job.name || '').match(/^사건 (\d+)-(\d+) 조회$/);
    const fullMatch = String(job.name || '').match(/^전체 (\d+)건 조회$/);
    if (match) return Math.max(maximum, Number(match[2]));
    return fullMatch ? Math.max(maximum, Number(fullMatch[1])) : maximum;
  }, 0);
}

async function mergePartialArtifacts(partials, token) {
  const buffers = await mapWithConcurrency(partials, DOWNLOAD_CONCURRENCY, (artifact) => (
    downloadArtifactXlsx(artifact, token)
  ));
  let header = null;
  const dataRows = [];

  buffers.forEach((buffer, index) => {
    const rows = workbookRows(buffer);
    if (!rows.length) throw new Error(`${partials[index].name} 결과가 비어 있습니다.`);
    const currentHeader = rows[0].map((value) => String(value));
    if (!header) header = currentHeader;
    if (JSON.stringify(header) !== JSON.stringify(currentHeader)) {
      throw new Error(`${partials[index].name}의 열 구성이 다른 결과와 일치하지 않습니다.`);
    }
    const currentRows = rows.slice(1);
    if (currentRows.length !== partials[index].count) {
      throw new Error(`${partials[index].name} 행 수가 ${currentRows.length}/${partials[index].count}건으로 일치하지 않습니다.`);
    }
    dataRows.push(...currentRows);
  });

  const allRows = [header, ...dataRows];
  const worksheet = XLSX.utils.aoa_to_sheet(allRows);
  worksheet['!cols'] = header.map((_, column) => ({
    wch: Math.min(50, Math.max(10, ...allRows.map((row) => String(row[column] ?? '').length))),
  }));
  worksheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(header.length - 1)}${dataRows.length + 1}` };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '조회결과');
  return {
    output: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true })),
    count: dataRows.length,
  };
}

function sendOutput(req, res, { output, filename, runId, count, source }) {
  if (String(req.query?.download || '') === '1') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(output.length));
    res.setHeader('X-Court-Search-Count', String(count));
    res.setHeader('X-Court-Search-Source', source);
    return res.status(200).send(output);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    filename,
    content: output.toString('base64'),
    size: output.length,
    count,
    runId,
    source,
  });
}

export default async function handler(req, res) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';

  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });

  try {
    const runId = String(req.query?.runId || '').trim();
    const artifactId = String(req.query?.artifactId || '').trim();
    const scope = String(req.query?.scope || 'all').trim();
    if (!/^\d+$/.test(runId)) return res.status(400).json({ error: '결과를 받을 runId가 필요합니다.' });
    if (artifactId && !/^\d+$/.test(artifactId)) return res.status(400).json({ error: '올바른 artifactId가 필요합니다.' });
    if (!['all', 'completed'].includes(scope)) return res.status(400).json({ error: '올바른 다운로드 범위가 필요합니다.' });

    const artifacts = await fetchAllPages(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`,
      'artifacts',
      token,
    );

    if (artifactId) {
      const artifact = artifacts.find((item) => String(item.id) === artifactId
        && item.name.startsWith('court-search-partial-') && !item.expired);
      if (!artifact) return res.status(404).json({ error: '이 실행에서 해당 중간 결과 파일을 찾을 수 없습니다.' });
      const output = await downloadArtifactXlsx(artifact, token);
      const partial = parsePartialArtifact(artifact);
      return sendOutput(req, res, {
        output,
        filename: `court-search-${String(partial.start).padStart(4, '0')}-${String(partial.end).padStart(4, '0')}.xlsx`,
        runId,
        count: rowCount(output),
        source: 'single-partial',
      });
    }

    const partials = uniqueSortedPartials(artifacts);
    if (scope === 'completed') {
      if (!partials.length) return res.status(404).json({ error: '아직 다운로드할 완료 결과가 없습니다.' });
      const merged = await mergePartialArtifacts(partials, token);
      return sendOutput(req, res, {
        ...merged,
        filename: `court-search-completed-${String(merged.count).padStart(4, '0')}.xlsx`,
        runId,
        source: 'merged-partials',
      });
    }

    const expectedTotal = await expectedCaseCount(repo, runId, token);
    if (!expectedTotal) return res.status(409).json({ error: '전체 조회 건수를 아직 확인할 수 없습니다.' });

    const fullArtifact = artifacts.find((item) => item.name === 'court-search-result-retry' && !item.expired)
      || artifacts.find((item) => item.name === 'court-search-result' && !item.expired);
    if (fullArtifact) {
      const output = await downloadArtifactXlsx(fullArtifact, token);
      const count = rowCount(output);
      if (count === expectedTotal) {
        return sendOutput(req, res, {
          output,
          filename: `court-search-${runId}.xlsx`,
          runId,
          count,
          source: 'verified-final',
        });
      }
    }

    if (!hasCompleteCoverage(partials, expectedTotal)) {
      const completedCount = partials.reduce((sum, partial) => sum + partial.count, 0);
      return res.status(409).json({
        error: `전체 결과가 아직 완성되지 않았습니다. 현재 ${completedCount}/${expectedTotal}건입니다.`,
      });
    }

    const merged = await mergePartialArtifacts(partials, token);
    if (merged.count !== expectedTotal) {
      return res.status(409).json({ error: `병합 결과가 ${merged.count}/${expectedTotal}건으로 일치하지 않습니다.` });
    }
    return sendOutput(req, res, {
      ...merged,
      filename: `court-search-${runId}.xlsx`,
      runId,
      source: 'recovered-full',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
