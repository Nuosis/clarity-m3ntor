const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const name = harness => harness === 'codex' ? 'Codex' : harness === 'claude' ? 'Claude Code' : harness === 'coach' ? 'Clarity Coach' : 'Connection';
const rings = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="21"/><circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="7"/></svg>';
let state, current, harnesses = {}, currentId = localStorage.getItem('clarity-coach-assessment');
let followLive = true, welcomeInitialized = false, seenSignature = '';
document.documentElement.dataset.theme = localStorage.getItem('clarity-coach-theme') || 'dark';
$('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('clarity-coach-theme',theme); };
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true,6000); }
function selectedAssessments() {
  if (!current) return [];
  return current.cohortId ? state.assessments.filter(a => a.cohortId === current.cohortId) : [current];
}
function selectAssessment(id) { currentId = id; localStorage.setItem('clarity-coach-assessment',id); seenSignature = ''; render(); }
function render() {
  current = state.assessments.find(a => a.id === currentId);
  if (!current) { current = state.assessments.find(a => a.consent) || state.assessments.find(a => a.connectedAt) || state.assessments[0]; currentId = current?.id; }
  const assessments = selectedAssessments();
  const running = assessments.some(a => a.run?.status === 'running' || a.automatic);
  const reportReady = current?.interviewVersion === 2 ? !!current.shareableReport : !!current?.answers.assessment;
  $('#draft-badge').textContent = current?.status === 'submitted' ? 'SUBMITTED FOR COACHING' : 'DRAFT ASSESSMENT';
  const picker = $('#assessment-picker'); picker.hidden = state.assessments.length < 1;
  picker.innerHTML = state.assessments.map(a => `<option value="${a.id}" ${a.id === currentId ? 'selected' : ''}>${a.status === 'submitted' ? 'Submitted' : 'Draft'} · ${name(a.harness)} · ${new Date(a.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</option>`).join('');
  picker.onchange = () => selectAssessment(picker.value);
  $('#pom-cards').innerHTML = [['process','P','Process','Defined business practices'],['observability','O','Observability','Visibility into execution'],['measurement','M','Measurement','Documented, active scoring'],['agency','A','Agency','Knowing what, when & how to act']].map(([key,letter,title,description]) => {
    const rating = current?.ratings?.[key];
    const numeric = Number.isInteger(rating?.score);
    return `<article class="pom-card"><div class="pom-top"><span>${title}</span><span class="dimension-letter">${letter}</span></div><div class="category ${rating ? '' : 'pending'}">${numeric ? `${rating.score}<span class="score-denominator">/10</span>` : esc(rating?.category || 'Not rated')}</div>${numeric && rating?.category ? `<div class="category-label">${esc(rating.category)}</div>` : ''}<p class="pom-description">${description}</p>${rating ? `<details class="pom-rationale"><summary>Why this rating</summary><p>${esc(rating.rationale)}</p></details>` : ''}</article>`;
  }).join('');
  const active = assessments.find(a => a.run?.status === 'running') || current;
  const workTitles = {interview:'Building your business context and POM + Agency report',connection:'Connecting your local agent',business:'Understanding your business world',processes:'Establishing your process picture',observability:'Understanding what your agent can observe',measurement:'Identifying your active measurements',assessment:'Assessing Process, Observability & Measurement'};
  let title = 'Getting to know your business', detail = 'Connect your local agent to get started.';
  if (active?.run?.status === 'running' || active?.automatic) { title = workTitles[active.run?.stage] || 'Starting your business assessment'; detail = `${name(active.harness)} · ${active.run?.detail || 'Starting…'}`; }
  else if (reportReady) { title = current.submission?.status === 'submitted' ? 'Your report is with your coach' : current.submission?.status === 'delivery_uncertain' ? 'Report delivery needs attention' : current.submission?.status === 'sending' ? 'Sending your report' : 'Your POM + Agency report is ready'; detail = current.submission ? submissionText() : 'Review your assessment and share it for follow-up questions and recommendations.'; }
  else if (current?.consent && ['error','stopped','interrupted'].includes(current.run?.status)) { title = 'Your agent needs attention'; detail = current.run.output || current.run.detail; }
  else if (current?.connectedAt) { title = 'Ready to continue your business assessment'; detail = 'Connect to let Coach take the conversation forward automatically.'; }
  $('#work-title').textContent = title; $('#work-detail').textContent = detail;
  $('#work-indicator').classList.toggle('running',running);
  $('#work-actions').innerHTML = running ? '<button id="pause" class="secondary">Pause</button>' : reportReady ? '<button id="review-report" class="primary">Review report <span>↗</span></button>' : current?.consent ? '<button id="resume" class="secondary">Resume conversation</button>' : '<button id="begin" class="secondary">Connect your agent <span>↗</span></button>';
  if ($('#pause')) $('#pause').onclick = async () => { try { await Promise.all(assessments.filter(a => a.automatic || a.run?.status === 'running').map(a => api(`/api/assessments/${a.id}/stop`,{}))); await refresh(); } catch(e) { toast(e.message); } };
  if ($('#resume')) $('#resume').onclick = async () => { try { await api(`/api/assessments/${current.id}/resume`,{}); await refresh(); } catch(e) { toast(e.message); } };
  if ($('#begin')) $('#begin').onclick = openWelcome;
  if ($('#review-report')) $('#review-report').onclick = openReport;
  $('#stream-status').textContent = running ? 'Live conversation' : reportReady ? 'Assessment complete' : current?.consent ? 'Conversation paused' : 'Ready when you are';
  $('#stream-status').classList.toggle('live',running);
  $('#conversation-caption').textContent = `Clarity Coach & ${assessments.length ? assessments.map(a => name(a.harness)).join(' + ') : 'your local agents'}`;
  renderConversation(assessments,running);
  renderFollowups();
  $('#scale-list').innerHTML = (state.categoricalScale || []).map(item => `<div class="scale-item"><strong>${esc(item.category)}</strong>${esc(item.meaning)}</div>`).join('') + state.scale.map(item => `<div class="scale-item"><strong>${esc(item.label || item.category)}</strong>${esc(item.meaning)}</div>`).join('');
  $('#save-status').textContent = current?.context ? 'CONTEXT.md saved locally' : current ? 'Saved on this device' : 'Local workspace';
  if (!welcomeInitialized) {
    welcomeInitialized = true; $('#workspace').value = current?.cwd || state.defaultCwd;
    if (!state.assessments.some(a => a.consent)) openWelcome();
  }
}
function renderConversation(assessments,running) {
  const events = assessments.flatMap(a => (a.events || []).map(item => ({...item,harness:a.harness,assessmentId:a.id}))).sort((a,b) => a.at.localeCompare(b.at));
  const signature = JSON.stringify([events,running]); if (signature === seenSignature) return; seenSignature = signature;
  const conversation = $('#conversation'); const previousTop = conversation.scrollTop;
  conversation.innerHTML = !events.length ? `<div class="empty-conversation">${rings}<p>A conversation about your business.</p><span>It begins with your local agent.</span></div>` : events.map(item => {
    const stage = state.steps.find(s => s.id === item.stage)?.short || '';
    if (item.kind === 'activity') return `<div class="activity"><span>${esc(item.text)}</span><span class="activity-harness">${name(item.role)}</span></div>`;
    const avatar = item.role === 'coach' ? rings : item.role === 'codex' ? '⌘' : item.role === 'claude' ? '✳' : '·';
    return `<article class="message ${item.role === 'coach' ? 'coach' : item.role === 'system' ? 'system' : 'agent'}"><div class="avatar ${item.role}">${avatar}</div><div><div class="message-topline"><span class="message-name">${esc(name(item.role))}</span>${stage ? `<span class="message-stage">${esc(stage)}</span>` : ''}<time datetime="${esc(item.at)}">${new Date(item.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><div class="message-text">${esc(item.text)}</div></div></article>`;
  }).join('');
  if (running) conversation.insertAdjacentHTML('beforeend','<div class="typing-indicator"><i></i><i></i><i></i><span>Your agent is working</span></div>');
  if (followLive) conversation.scrollTop = conversation.scrollHeight; else conversation.scrollTop = previousTop;
}
$('#conversation').addEventListener('scroll',() => { const el = $('#conversation'); followLive = el.scrollHeight - el.scrollTop - el.clientHeight < 70; $('#jump-live').hidden = followLive; });
$('#jump-live').onclick = () => { followLive = true; $('#conversation').scrollTop = $('#conversation').scrollHeight; $('#jump-live').hidden = true; };
function openWelcome() { $('#welcome-error').hidden = true; if (!$('#welcome-dialog').open) $('#welcome-dialog').showModal(); }
$('#connections').onclick = openWelcome;
$('#close-welcome').onclick = () => $('#welcome-dialog').close();
$('#consent-connect').onclick = async () => {
  const button = $('#consent-connect'); const harnesses = [...document.querySelectorAll('input[name="harness"]:checked')].map(input => input.value);
  button.disabled = true; button.textContent = 'Connecting…'; $('#welcome-error').hidden = true;
  try {
    const result = await api('/api/onboard',{consent:true,harnesses,cwd:$('#workspace').value});
    currentId = result.assessments[0].id; localStorage.setItem('clarity-coach-assessment',currentId); followLive = true; $('#welcome-dialog').close(); await refresh();
  } catch(e) { $('#welcome-error').textContent = e.message; $('#welcome-error').hidden = false; }
  finally { button.disabled = false; button.innerHTML = 'Connect & get started <span>→</span>'; }
};
function submissionText() {
  const s = current?.submission;
  if (s?.status === 'submitted') return `Submitted to ${current?.submission?.recipient || state.coach?.name || 'Coach'}. Awaiting a coaching response.`;
  if (s?.status === 'sending') return 'Sending your report. A submission is in progress.';
  return s?.detail || '';
}
function renderFollowups() {
  const panel = $('#followup-panel'); panel.hidden = !current?.followups?.length;
  if (panel.hidden) return;
  panel.innerHTML = `<div class="eyebrow">${esc(state.coach?.name || 'Coach')}</div><h2>From your coach</h2>${current.followups.map(item => `<div class="followup-item"><span class="badge">${esc(item.kind)}</span><span class="followup-source">${esc(item.from || state.coach?.name || 'Coach')}</span><p>${esc(item.text)}</p></div>`).join('')}`;
}
function openReport() {
  $('#coach-recipient').textContent = state.coach?.name || 'Coach';
  $('#report-badge').textContent = current.status === 'submitted' ? 'SUBMITTED' : 'DRAFT';
  const report = current.shareableReport;
  const intro = report ? `<p class="report-privacy">Only the non-sensitive report below will be shared. Detailed CONTEXT.md and the local conversation remain on this device.</p><p class="report-summary">${esc(report.summary)}</p>` : '<p class="report-privacy">Historical report. Prepare the expanded interview to create a non-sensitive report with both categories and 1–10 ratings for all four areas.</p>';
  const sections = report ? Object.entries(report.sections).map(([key,text]) => ({title:state.steps.find(s => s.id === key)?.title || key,text})) : state.steps.filter(s => s.id !== 'connection').map(step => ({title:step.title,text:current.answers[step.id]?.text || 'Not answered in this historical interview'}));
  $('#report-body').innerHTML = intro + sections.map(section => `<section class="report-section"><h3>${esc(section.title)}</h3><p>${esc(section.text)}</p></section>`).join('');
  $('#confirm-submit').disabled = !!current.submission || !report;
  $('#confirm-submit').textContent = current.submission ? current.submission.status === 'submitted' ? 'Submitted' : 'Delivery pending confirmation' : report ? 'Share non-sensitive report ↗' : 'Expanded interview needed';
  $('#report-dialog').showModal();
}
$('#close-report').onclick = () => $('#report-dialog').close();
$('#confirm-submit').onclick = async () => {
  const button = $('#confirm-submit'); button.disabled = true; button.textContent = 'Submitting…';
  try { await api(`/api/assessments/${currentId}/submit`,{}); await refresh(); $('#report-dialog').close(); toast(submissionText()); }
  catch(e) { toast(e.message); button.disabled = false; button.textContent = 'Submit report ↗'; }
};
async function refresh() { state = await api('/api/state'); render(); }
await refresh();
try {
  harnesses = await api('/api/harnesses');
  for (const key of ['codex','claude']) {
    $(`#${key}-status`).textContent = harnesses[key]?.label || 'Unavailable';
    const input = $(`input[name="harness"][value="${key}"]`); input.disabled = !harnesses[key]?.signedIn;
    if (input.disabled) input.checked = false;
  }
} catch(e) { toast(e.message); }
const stream = new EventSource('/api/events');
stream.onmessage = message => { const {assessment} = JSON.parse(message.data); const i = state.assessments.findIndex(a => a.id === assessment.id); if (i >= 0) state.assessments[i] = assessment; else state.assessments.unshift(assessment); render(); };
stream.onopen = () => { $('#service-status').innerHTML = '<i></i> Local'; void refresh().catch(() => {}); };
stream.onerror = () => { $('#service-status').textContent = 'Reconnecting'; $('#save-status').textContent = 'Reconnecting to local service'; };
