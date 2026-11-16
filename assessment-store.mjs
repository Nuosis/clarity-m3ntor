import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { categoricalScale, dimensions } from './questions.mjs';
import { validateRatings } from './coach-report.mjs';
import { businessDate, serializeBusinessWrites, appendJournalInWrite } from './business-journal.mjs';

async function load(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

async function writePrivate(file, content) {
  try { if (await readFile(file, 'utf8') === content) return { saved: true, path: file, reused: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { saved: true, path: file, reused: false };
}
const writeJson = (file, value) => writePrivate(file, JSON.stringify(value, null, 2) + '\n');

export function reconcileReassessmentContext(current, proposed) {
  const sections = /<!-- clarity_m3ntor:poma:([0-9a-f-]{36}):start -->[\s\S]*?<!-- clarity_m3ntor:poma:\1:end -->/gi;
  const latest = new Map([...current.matchAll(sections)].map(match => [match[1].toLowerCase(), match[0]]));
  const retained = new Set();
  // Keep the caller's general-context updates, with current service-managed
  // sections replacing stale copies or being restored when absent.
  let merged = proposed.replace(sections, (section, id) => {
    const key = id.toLowerCase();
    if (!latest.has(key)) return section;
    if (retained.has(key)) return '';
    retained.add(key);
    return latest.get(key);
  });
  for (const [id, section] of latest) if (!retained.has(id)) merged += `${merged && !merged.endsWith('\n') ? '\n' : ''}\n${section}\n`;
  return merged;
}

export function savePomaReassessment(cwd, input, { assessmentId, harness } = {}) {
  if (typeof input.revision_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.revision_id)) throw new Error('Provide the reassessment revision_id UUID supplied with the task.');
  validateRatings(input.ratings);
  for (const field of ['context_update', 'journal_entry', 'coaching_summary']) if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`Provide ${field}.`);
  for (const field of ['evidence', 'coverage', 'uncertainty', 'comparison', 'productivity']) if (!Object.hasOwn(input, field)) throw new Error(`Provide ${field}; state evidence gaps explicitly when unknown.`);
  if (input.status !== undefined && (typeof input.status !== 'string' || !input.status.trim())) throw new Error('Provide a lifecycle status string, or omit it for draft.');
  const revisionId = input.revision_id.toLowerCase();
  return serializeBusinessWrites(cwd, async () => {
    const root = path.join(cwd, '.clarity_coach');
    const receiptPath = path.join(root, 'reassessments', `${revisionId}.json`);
    let receipt = { revisionId, saved: false, localOnly: true, submitted: false, receiptPath, artifacts: {} };
    try {
      const previous = await load(receiptPath, null);
      const assessedAt = previous?.assessedAt || new Date().toISOString();
      const timeZone = previous?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const date = previous?.date || businessDate(new Date(assessedAt));
      receipt = { ...receipt, assessedAt, date, timeZone, assessmentId: previous?.assessmentId || assessmentId || 'local' };
      receipt.artifacts = {
        assessment: { saved: false, path: path.join(root, 'assessment', `${date}.json`) },
        context: { saved: false, path: path.join(root, 'CONTEXT.md') },
        journal: { saved: false, path: path.join(root, 'journal', `${date}.json`) },
        summary: { saved: false, path: path.join(root, 'reports', `${revisionId}.md`) },
      };
      await writeJson(receiptPath, receipt);
      const checkpoint = async (kind, result) => {
        receipt.artifacts[kind] = result;
        await writeJson(receiptPath, receipt);
      };
      const assessmentPath = path.join(root, 'assessment', `${date}.json`);
      const daily = await load(assessmentPath, { schema: 'clarity_coach.poma_assessments@1', date, timeZone, assessments: [] });
      if (!Array.isArray(daily.assessments)) throw new Error('The existing daily assessment schema has no assessments list; it was preserved.');
      const index = daily.assessments.findIndex(item => item.revisionId === revisionId);
      // USER-AUTHORIZED — Marcus, November 16, 2026: preserve prior revisions;
      // same-ID reconciliation updates only this tool's own reassessment.
      if (index >= 0 && daily.assessments[index].persistence !== 'save_poma_reassessment') throw new Error('This revision ID already belongs to a prior assessment. The existing revision was preserved.');
      const revision = {
        assessmentId: receipt.assessmentId, revisionId, assessedAt, status: input.status || 'draft',
        ...(input.harness || harness ? { harness: input.harness || harness } : {}),
        persistence: 'save_poma_reassessment',
        scale: { minimum: 1, maximum: 10, categories: structuredClone(categoricalScale) },
        ratings: Object.fromEntries(dimensions.map(key => [key, { category: input.ratings[key].category, score: input.ratings[key].score, rationale: input.ratings[key].rationale }])),
        evidence: input.evidence, coverage: input.coverage, uncertainty: input.uncertainty,
        comparison: input.comparison, productivity: input.productivity,
        summary: input.coaching_summary,
      };
      if (index < 0) daily.assessments.push(revision); else daily.assessments[index] = revision;
      await checkpoint('assessment', await writeJson(assessmentPath, daily));
      const contextPath = path.join(root, 'CONTEXT.md');
      let context = '';
      try { context = await readFile(contextPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const start = `<!-- clarity_m3ntor:poma:${revisionId}:start -->`;
      const end = `<!-- clarity_m3ntor:poma:${revisionId}:end -->`;
      const section = `${start}\n## Business POMA reassessment — ${assessedAt}\n\nStatus: ${revision.status}\n\n${input.context_update.trim()}\n${end}`;
      const first = context.indexOf(start), last = first < 0 ? -1 : context.indexOf(end, first + start.length);
      const updated = first >= 0 && last >= 0 ? context.slice(0, first) + section + context.slice(last + end.length) : context + `${context && !context.endsWith('\n') ? '\n' : ''}\n${section}\n`;
      await checkpoint('context', await writePrivate(contextPath, updated));
      const journal = await appendJournalInWrite(cwd, { date, kind: 'poma_reassessment', source: 'local_harness', content: input.journal_entry, metadata: { revisionId } }, new Date(assessedAt), `poma_reassessment:${revisionId}`);
      await checkpoint('journal', { saved: true, path: journal.path, entryId: journal.entry.id, reused: journal.reused });
      await checkpoint('summary', { ...await writePrivate(path.join(root, 'reports', `${revisionId}.md`), `Status: draft coaching summary; saved locally, not submitted.\n\n${input.coaching_summary}`), status: 'draft' });
      receipt.saved = true;
      await writeJson(receiptPath, receipt);
    } catch (error) {
      receipt.saved = ['assessment', 'context', 'journal', 'summary'].every(kind => receipt.artifacts[kind]?.saved === true);
      receipt.error = error.message;
      try { await writeJson(receiptPath, receipt); } catch (receiptError) { receipt.receiptError = receiptError.message; }
    }
    return receipt;
  });
}
