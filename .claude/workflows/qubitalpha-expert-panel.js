export const meta = {
  name: 'qubitalpha-expert-panel',
  description: 'Re-runnable 5-persona expert panel (quantum scientist, Toly, Lily, CoinDesk, CoinGecko) that critiques the CURRENT shipped artifact and returns a plan + the next ship-first. Refresh the "current truth" each cycle via args.',
  whenToUse: 'Run once per ~2-week build cycle (or whenever a milestone artifact lands) to pressure-test QubitAlpha for credibility, Solana-soundness, physics-rigor, distribution, and virality, then pick the next single milestone.',
  phases: [
    { title: 'Panel', detail: '5 expert personas critique the current artifact concurrently' },
    { title: 'Synthesize', detail: 'merge into positioning, try-it product, milestone, roadmap, and the next ship-first' },
  ],
}

// ---------------------------------------------------------------------------
// HOW TO RE-RUN EACH CYCLE
//   Workflow({ name: 'qubitalpha-expert-panel', args: { truth: `...`, milestone: `...` } })
// Pass a fresh `truth` block describing exactly what EXISTS vs. NOT-built-yet,
// plus any live links (devnet program id, explorer txs, hosted URL). The panel
// reasons against this block, so keeping it honest each cycle is what keeps the
// panel honest. If args is omitted, the DEFAULT_TRUTH below is used.
// ---------------------------------------------------------------------------

const DEFAULT_TRUTH = `
QUBITALPHA — current truth (refresh this every cycle; do not overclaim beyond it):
- Build-in-public project by a SOLO PHYSICS STUDENT. Small scope on purpose.
- One narrow claim: (1) read niche research + news, (2) turn it into PAPER-TRADE signals, (3) put Solana in the control loop via an on-chain devnet "policy_controller" Anchor program that approves/rejects paper trades before the portfolio mutates. No real funds custodied.
- EXISTS today: Python agent (arXiv/RSS ingestion, Jupiter + CoinGecko price fetchers, Groq LLM scoring, signal generation + validation), SQLite persistence, FastAPI status API (/health /policy /pnl /signal/latest /signal/history /trades), Anchor policy_controller (daily BUY caps, per-trade caps, monotonic trade_seq, halt/resume, TradeSubmitted event), static API-backed dashboard, fail-closed devnet policy submission via a TypeScript Anchor command bridge.
- NOT built yet: native anchorpy integration, x402 paid API routes, hosted production dashboard, Monte-Carlo ensemble / signal-entropy, on-chain reason_hash attestation.
- "Qubit"/quantum framing is CURRENTLY JUST A NAME — no quantum computing in the project.
- LIVE LINKS: <none yet — fill in devnet program id + explorer tx links once deployed>.
- Goal: VERY interesting, VERY catchy, let people actually TRY it, while staying credible (claims map to code).
`

const truth = (args && typeof args === 'object' && args.truth) ? args.truth
            : (typeof args === 'string' && args.trim()) ? args
            : DEFAULT_TRUTH

const milestone = (args && typeof args === 'object' && args.milestone)
  ? `\nTHIS CYCLE'S SHIPPED ARTIFACT (critique THIS, not a plan):\n${args.milestone}\n`
  : `\n(No specific shipped artifact was passed this cycle — critique the project state as-is and recommend the next ship-first.)\n`

const CONTEXT = truth + milestone

phase('Panel')

const PERSONAS = [
  {
    key: 'quantum',
    label: 'panel:quantum-senior',
    prompt: `You are a SENIOR EXPERIMENTAL QUANTUM PHYSICIST in the mold of John Martinis. Rigorous, anti-hype, but you want this physics student to ship something cool AND true.

${CONTEXT}

RIGOR GATE — answer: Does the physics/uncertainty framing map to real math, and is the "Qubit" name honestly disclaimed or honestly earned this cycle? Address: (1) is the quantum framing a credibility landmine right now, and the honest path (drop it, disclaim it as aesthetic, or earn it via real Monte-Carlo "superposition of signals" uncertainty quantification); (2) the physics hook that makes a scientist nod AND is catchy without lying; (3) the one scientifically credible feature to ship next. Veto injected-noise Monte Carlo, fake qiskit theater, and any quantum-advantage/quantum-alpha implication. Be concrete.`,
  },
  {
    key: 'toly',
    label: 'panel:toly-solana',
    prompt: `You are ANATOLY "TOLY" YAKOVENKO, co-founder of Solana. You think in throughput, composability, real on-chain primitives, and whether Solana is load-bearing or just a logo.

${CONTEXT}

SOLANA-SOUNDNESS GATE — answer: Is Solana load-bearing this cycle, and is the chain interaction robust enough to demo live? Address: (1) is the policy_controller a real, defensible use of Solana or decorative — how to make the chain the source of truth (on-chain reasoning attestation / reason_hash, verifiable trade log, x402 micropayments, oracle price stamping, state compression); (2) the single most impressive tractable Solana-native thing to ship next; (3) the path from current state to a live, explorer-verifiable devnet demo. Veto decorative chain usage and fragile bridges that break on stage. Be concrete.`,
  },
  {
    key: 'lily',
    label: 'panel:lily-foundation',
    prompt: `You are LILY LIU, President of the Solana Foundation. You think ecosystem narrative, developer onboarding, grants, hackathons (Colosseum), community, and distribution for a small project.

${CONTEXT}

DISTRIBUTION & GENERALIZABILITY GATE — answer: Is this a forkable primitive / amplifiable onboarding story, and is there a real explorer link before any grant/newsletter ask? Address: (1) the ecosystem narrative that makes QubitAlpha matter (verifiable agent guardrails / "agents that can't rug because policy is on-chain"); (2) concrete distribution moves for a solo student (which hackathon, what a grant-worthy milestone looks like, newsletter/community paths); (3) how to make the "try it" + contributor funnel welcoming. Veto pitching before on-chain proof exists. Be concrete and actionable for a solo builder.`,
  },
  {
    key: 'coindesk',
    label: 'panel:coindesk-journalist',
    prompt: `You are a SENIOR COINDESK JOURNALIST covering crypto x AI. Skeptical, allergic to vaporware "AI trading agent" pitches, hunting for the one true narrative hook.

${CONTEXT}

CREDIBILITY GATE — answer: Is there ANY claim here not backed by code or a live link? Address: (1) the actual headline/story (2-3 candidate headlines that are true today or true after one concrete shippable milestone); (2) the credibility traps — what reads as a red flag ("autonomous trading", ambiguous P&L, undefined "quantum") and how to frame to stay credible (build-in-public, paper-trade-only, on-chain guardrails as the real story); (3) the one demo/artifact that would make this genuinely newsworthy. Veto overclaim and unverified "deployed on Solana" language. Be sharp and honest.`,
  },
  {
    key: 'coingecko',
    label: 'panel:coingecko-marketing',
    prompt: `You are a GROWTH/MARKETING LEAD at CoinGecko. Virality, catchy hooks, low-friction "try it" funnels, shareable artifacts, community campaigns — NO token (credible build-in-public student project).

${CONTEXT}

HOOK & FUNNEL GATE — answer: Can a stranger try this in 60 seconds, and what's the one self-posting shareable artifact this cycle? Address: (1) catchy positioning — a one-liner, a tagline, and 3 punchy hooks (lean into the on-chain-veto + physics aesthetic, honestly); (2) the "try it in 60s" funnel ranked by virality-per-effort (hosted read-only dashboard, daily signal card, watch-the-agent feed, one-click devnet demo); (3) a concrete 2-week growth campaign for a solo student with ~0 followers. Veto leaderboards-too-early, big-bang launches, and infra over-build. Be punchy and concrete.`,
  },
]

const PERSPECTIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['persona', 'gate_verdict', 'headline_take', 'opportunities', 'concrete_features', 'pushback', 'catchy_hooks', 'ship_first'],
  properties: {
    persona: { type: 'string' },
    gate_verdict: { type: 'string', enum: ['pass', 'pass_with_fixes', 'block'], description: 'This gate verdict for promoting the current artifact' },
    headline_take: { type: 'string', description: 'Core verdict in 2-3 sentences' },
    opportunities: { type: 'array', items: { type: 'string' }, description: '3-5 specific opportunities' },
    concrete_features: { type: 'array', items: { type: 'string' }, description: 'Tractable features a solo student could build' },
    pushback: { type: 'array', items: { type: 'string' }, description: 'Honest risks / red flags / things to NOT do' },
    catchy_hooks: { type: 'array', items: { type: 'string' }, description: 'Catchy phrasings, taglines, or narrative hooks' },
    ship_first: { type: 'string', description: 'The ONE thing to ship next from this persona view' },
  },
}

const panel = (await parallel(PERSONAS.map(p => () =>
  agent(p.prompt, { label: p.label, phase: 'Panel', schema: PERSPECTIVE_SCHEMA })
))).filter(Boolean)

phase('Synthesize')

const blocked = panel.filter(p => p.gate_verdict === 'block').map(p => p.persona)

const SYNTH_PROMPT = `You are the project lead synthesizing an expert panel into one actionable plan for QubitAlpha (a solo physics student's build-in-public Solana devnet project).

${CONTEXT}

Panel perspectives (JSON), each with a gate_verdict (pass / pass_with_fixes / block):
${JSON.stringify(panel, null, 2)}

${blocked.length ? `GATES BLOCKING PROMOTION THIS CYCLE: ${blocked.join('; ')}. Lead with what must be fixed before any public promotion.` : 'No gate blocked promotion — but call out any pass_with_fixes conditions before greenlighting outreach.'}

Produce a tight, exciting, HONEST markdown plan with these sections:
## Gate Summary (which gates passed / blocked, and the blocking fixes)
## The Repositioning (tagline; honest resolution of the "quantum" name; 3 sharpest hooks)
## The "Try It" Product (3-4 try-it surfaces ranked by virality-per-effort, specific about what each shows)
## What Makes Solana Essential (1-2 load-bearing features, not decorative)
## The Shippable Milestone (next 2 weeks) (the one newsworthy + tractable-solo artifact, with concrete acceptance criteria)
## Roadmap (3 phases mapped to the current-truth block; flag anything that would overclaim)
## Next Ship-First (the single highest-leverage thing to build before re-running this panel)

Rules: every recommendation must map to something a solo student can build; never imply paper-trading is real money or that NOT-built-yet pieces already work; a persona may only greenlight promoting things that already have a live link or running code.`

const plan = await agent(SYNTH_PROMPT, { label: 'synthesize:plan', phase: 'Synthesize' })

return { gates: panel.map(p => ({ persona: p.persona, verdict: p.gate_verdict })), blocked, panel, plan }
