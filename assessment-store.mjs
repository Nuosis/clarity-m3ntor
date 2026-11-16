import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { categoricalScale } from './questions.mjs';
import { validateRatings } from './coach-report.mjs';

export async function savePomaAssessment(a) {
  validateRatings(a.ratings);
  const assessedAt = new Date(a.completedAt);
  if (Number.isNaN(assessedAt.getTime())) throw new Error('A completed assessment date is required.');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(assessedAt);
  const directory = path.join(a.cwd, '.clarity_coach', 'assessment');
  const file = path.join(directory, `${date}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let daily = { schema: 'clarity_coach.poma_assessments@1', date, timeZone, assessments: [] };
  try { daily = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const result = {
    assessmentId: a.id,
    revisionId: a.shareableReport?.revisionId,
    assessedAt: assessedAt.toISOString(),
    status: a.status,
    harness: a.harness,
    scale: { minimum: 1, maximum: 10, categories: structuredClone(categoricalScale) },
    ratings: structuredClone(a.ratings),
    summary: a.shareableReport?.summary || '',
    sections: structuredClone(a.shareableReport?.sections || {}),
  };
  const existing = daily.assessments.findIndex(item => item.assessmentId === result.assessmentId && item.revisionId === result.revisionId);
  if (existing < 0) daily.assessments.push(result); else daily.assessments[existing] = result;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(daily, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  return { path: file, date, timeZone, localOnly: true };
}
