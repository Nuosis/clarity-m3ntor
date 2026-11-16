// USER-AUTHORIZED — Marcus, November 15, 2026: one complete interview,
// local CONTEXT.md, non-sensitive sharing, A2A setup, and categorical plus 1–10 ratings for all four areas.
export const dimensions = ['process', 'observability', 'measurement', 'agency'];
export const categoricalScale = [
  { category: 'Unknown', meaning: 'The findings do not provide enough evidence to establish the practice.' },
  { category: 'Ad hoc', meaning: 'The practice depends on individual effort or memory, without a repeatable approach.' },
  { category: 'Repeatable', meaning: 'The practice is documented or consistently established across ordinary cases.' },
  { category: 'Measured', meaning: 'The practice is actively tracked with documented measures and recorded results.' },
  { category: 'Improving', meaning: 'Recorded measurements demonstrate improvement while maintaining the intended outcome.' },
];
export const scale = [
  { label: '1–2', meaning: 'Little established evidence for the assessed business-linked area.' },
  { label: '3–4', meaning: 'Partial business-linked practice or coverage, with substantial gaps or dependence on individual effort.' },
  { label: '5–6', meaning: 'Useful, repeatable business-linked practice across part of the business, with material gaps.' },
  { label: '7–8', meaning: 'Broad, reliable business-linked practice supported by current execution evidence.' },
  { label: '9–10', meaning: 'Comprehensive, measured business effectiveness with demonstrated improvement in the assessed area.' },
];
// USER-AUTHORIZED — Marcus, November 16, 2026: POMA concerns the owner's
// business; discover sources and calculate supported sales/total-human-hours first.
const businessPoma = `Assess the owner's BUSINESS and the agent's access, use and action within it, not general agent abilities. Process describes how the business actually does work, its trigger/steps/handoffs/intended outcome/completion, and whether the agent can access and actually uses those flows; distinguish the process, documentation, access and utilization. Observability describes current BUSINESS STATE accessible through relevant software and local/remote documents, directly through MCP/CLI/API or through an existing integration server. Establish source/account identity, coverage, freshness and correlations; configured integration does not prove all data available, and a central store is not required. Measurement concerns business-process efficiency/effectiveness, depends on understood Process and observed state, and ties intended outcomes to metric definitions, time/cost/input denominators where applicable, source records, period, results and coverage. Distinguish documented active scoring from a first on-demand calculation; missing P/O dependencies limit evidence rather than proving absence. Agency depends on POM plus business goals, policies/direction and durable action infrastructure/productivity loop: knowing WHAT to do, WHEN and HOW in THIS business. Trace actual event-, time- or otherwise-triggered work through execution and completion receipts without the owner requesting every action. Mere ability, installed tools/schedulers, confidence and user-requested successes alone do not prove triggered agency.`;
const productivityDiscovery = `Make every effort to calculate sales divided by TOTAL human hours worked from available evidence before asking the owner for a number. Discover financial/sales and human working-hours records through memory, relevant session tool calls/results and established tools or integration routes. Align reporting period and business scope; retain sources/dates, currency, sales/hour definitions, people/work covered and exclusions. Do not substitute AI tokens/hours or a single person's hours for unknown total human hours. A supported partial estimate must label assumptions and coverage; do not fabricate missing hours or mix periods. Ask only for the specific missing input after source discovery is insufficient. If calculation remains impossible, accept the owner's verbal description and why they feel that way, labelled as perception. A first productivity calculation does not establish ongoing business-process Measurement. Keep detailed financial/working-hours inputs local and report only a separately prepared non-sensitive synthesis.`;
export const steps = [
  { id: 'connection', title: 'Coaching connection', short: 'Connect', question: `Use this current harness, where the owner started the bootstrap and asked to connect to Clarity M3NT0R. Reuse the local clarity_m3ntor MCP and confirm coaching context can be retrieved and results saved. Do not introduce a separate journey to choose or connect another harness.` },
  { id: 'business', title: 'Your business world', short: 'Business context', question: `What do you know about the owner and their business: industry, service area, products/services, location, goals and work? Distinguish service coverage from location, the owner's business from customers' systems, and facts/sources from unknowns. Where does business work arrive, get organized and reach completion? Use existing context, memory and accessible documentation.` },
  { id: 'access', title: 'Business information access', short: 'Business access', question: `Itemize the business's email/communications, documents on local filesystems and remote stores, customer/calendar/task/project, financial/working-hours and operational sources. Discover established direct MCP/CLI/API/script routes and existing integration servers amalgamating data. Record source/account identity, business-state coverage, freshness, correlations and gaps; do not infer completeness from configured integration or require a central store. For each source distinguish known, configured, confirmed readable, inaccessible and unknown. Discover the owner's preferred read AND send email routes through memory, relevant prior calls/results and installed methods. Perform a small authorized read; record mailbox scope/evidence locally. Sending configuration/history is separate from current reading and from provider acceptance/sent-folder/delivery proof; do not send a test message merely for discovery. Keep private source records local.` },
  { id: 'recurring', title: 'Skills and recurring work', short: 'Recurring work', question: `Itemize available business/process skills and established repeatable work. For each task or automation record business purpose, event/time/other trigger, lifecycle status, executor, persistence and actual completion evidence. Separate configured capability from demonstrated operation. Distinguish the event/work productivity-improvement loop from the separate weekly POMA reassessment. Collect actual owner feedback using the exact question: How has the agent so far been the most useful? Do not synthesize an owner answer; use the outstanding-question mechanism if needed.` },
  { id: 'agency', title: 'Agency and constraints', short: 'Agency', question: `Given the Process, Observability and Measurement findings, how do you independently carry THIS business's work forward? Establish WHAT to do, WHEN and HOW from business goals, commitments, priorities, policies/direction and relevant state/measures. Inspect the durable action infrastructure and productivity loop. Trace actual work initiated by event, time or other triggers WITHOUT the owner initiating each action, through execution, persistence and completion receipts. Distinguish triggered agency from permission, tool/scheduler availability, confidence or successful user-requested actions. Explain evidenced gaps in direction, business understanding, access and execution; do not invent authority or constraints.` },
  { id: 'processes', title: 'Processes', short: 'Processes', question: `How does the owner's business actually do its work? Discover relevant flows such as acquisition, delivery, support or billing from documents AND execution artifacts. Record purpose, trigger, steps/handoffs, intended outcome, owner and completion criteria/evidence. Distinguish the existing business process, whether it is documented, whether you can access it and whether you actually use it. A procedure alone does not prove adoption/utilization; a missing document does not prove an absent process. Distinguish single observed cases, repeated practice and instructions, and keep customer processes separate.` },
  { id: 'observability', title: 'Observability', short: 'Observability', question: `For the identified business flows, can you see the current BUSINESS STATE needed to understand progress, changes and exceptions? Identify relevant software and local/remote documents, direct MCP/CLI/API routes or existing integration servers, source/account identities, accessible stages/records, freshness, correlations and gaps. Check actual data coverage rather than treating configured integration as complete access. Agent execution logs alone do not establish business visibility; a central store is not required.` },
  { id: 'measurement', title: 'Measurement', short: 'Measurement', question: `For each business process, what efficiency/effectiveness measures are documented and actively scored? Relate the intended outcome, metric definition, time/cost/input denominator where applicable, sources, period, result and coverage. Measurement depends on understood Process and observed business state; missing dependencies limit evidence rather than establishing absent measures. Activity counts, transaction states or agent ratings alone do not establish business-process effectiveness. Separately attempt the requested on-demand productivity calculation: ${productivityDiscovery}` },
  { id: 'bridge', title: 'Coach communication', short: 'A2A stream', question: `Confirm this installation is registered with Clarity (node register.mjs reports registered or signed_in) and that a2a_status shows the A2A stream ready, so M3NT0R can communicate with this agent. Record the registered agent handle, the stream state and any failure exactly as reported; do not invent credentials or connectivity.` },
  { id: 'assessment', title: 'Business POMA assessment', short: 'Assessment', question: `Using the factual findings, give BOTH a category (Unknown, Ad hoc, Repeatable, Measured, Improving) AND an independent integer 1–10 rating with rationale, sources, coverage and uncertainty for each area. ${businessPoma} Use the draft scales as guidance, not a conversion formula. Missing evidence is not proof that a business practice is absent; preserve lifecycle status. Complete factual discovery before rating and keep detailed evidence local.` },
];
export function promptFor(a) {
  const prior = Object.entries(a.answers || {}).map(([key, value]) => `${key}:\n${value.text}`).join('\n\n');
  return `Complete this initial business POMA interview as one continuous assignment in the current ${a.harness} harness, where the owner asked to connect to Clarity M3NT0R. Reuse this connection rather than introducing a separate harness-selection journey. The owner authorized local context persistence, bridge setup and categorical plus 1–10 ratings for all four business-linked areas.

LOCAL BUSINESS CONTEXT
Create and maintain ${a.contextPath}. Preserve useful existing context, source references, business process/access/utilization findings, state coverage, active measures, supported productivity inputs/results, triggered agency evidence, lifecycle status and uncertainty. Keep credentials/tokens/private keys in their established storage.

SHARING BOUNDARY
Detailed owner-business context and sensitive information stay local. Save substantive findings locally and prepare a separate non-sensitive Coach report. Exclude private message contents, customer/person identifiers, financial/working-hours details, internal host/account identifiers, credentials and private paths from progress answers and shared reports. Use useful business-level synthesis; review the shareable report for sensitivity. CONTEXT.md, raw transcripts and journals are not attachments.

WORKING METHOD
Use existing context, memory, skills and established authorized routes; inspect relevant prior tool calls/results and perform the scoped reads needed for these findings. Preserve facts/observations versus history/interpretation/unknown, owner versus customer systems and draft/paused/active/completed status. Do not establish new business practices or fabricate measures during the interview. Perform the requested source-supported productivity calculation while distinguishing it from established active scoring. Continue independent work when one source or owner input is missing. Publish non-sensitive findings progressively, save detailed local context and prepare the final report before declaring completion.

INTERVIEW
${steps.map((s, i) => `${i + 1}. ${s.title}\n${s.question}`).join('\n\n')}

DRAFT 1–10 SCALE
${scale.map(s => `${s.label}: ${s.meaning}`).join('\n')}

CATEGORICAL SCALE
${categoricalScale.map(s => `${s.category}: ${s.meaning}`).join('\n')}

PREVIOUS SAVED FINDINGS (retain provenance; distinguish business change from newly discovered evidence)
${prior || 'None yet.'}`;
}

export function ratingPromptFor(a) {
  return `Correct the existing business POMA assessment using its recorded findings. This rating-only correction is separate from reassess_poma, which refreshes current business evidence. Keep BOTH categorical and integer 1–10 ratings; assign each independently. Retain numeric scores unless recorded evidence warrants a change and explain it. Do not repeat the interview, perform new business-data reads or invent operational measurements for this correction. Treat recorded source-supported productivity separately from established ongoing scoring. Missing scope/dependencies remain uncertainty, not proof of absence. Provide a non-sensitive rationale for each area; existing save pathways update local context, report and dated JSON.

BUSINESS POMA
${businessPoma}

CATEGORIES
${categoricalScale.map(s => `${s.category}: ${s.meaning}`).join('\n')}

EXISTING RATINGS
${JSON.stringify(a.ratings)}

RECORDED FINDINGS
${Object.entries(a.answers).map(([key,value]) => `${key}:\n${value.text}`).join('\n\n')}`;
}
