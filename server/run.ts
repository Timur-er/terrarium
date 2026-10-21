/**
 * Headless run for experiments and the lab report: simulate N sols with the chosen brain, write a report.
 *
 *   npx --prefix server tsx server/run.ts --sols 3 --brain remote --brain-url http://localhost:8765/decide --domes 1 --out report
 *
 * Writes <out>/report.md (summary, chronicle, sample decisions), log.txt (every event), decisions.jsonl,
 * diaries.md, brain-calls.json (the brain service's call log with Jev probabilities) and stats.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegion, tickRegion } from '../client/src/sim/region.ts'
import { setBrain, HeuristicBrain, RandomBrain, RemoteBrain, remoteInFlight } from '../client/src/sim/brain.ts'
import { dayOf, clock } from '../client/src/sim/text.ts'
import type { World } from '../client/src/sim/types.ts'
import { SystemTwo } from './reflect.ts'

// .env from the repo root (existing variables win)
const here = path.dirname(fileURLToPath(import.meta.url))
for (const p of [path.join(here, '..', '.env'), path.join(here, '.env')]) {
  if (!fs.existsSync(p)) continue
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def }
const SOLS = Number(arg('sols', '3'))
const DOMES = Number(arg('domes', '1'))
const BRAIN = arg('brain', process.env.BRAIN ?? 'remote')
const BRAIN_URL = arg('brain-url', process.env.BRAIN_URL ?? 'http://localhost:8765/decide')
const SEED = Number(arg('seed', String(Math.floor(Math.random() * 100000))))
const OUT = path.resolve(arg('out', `report/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`))
fs.mkdirSync(OUT, { recursive: true })

const region = createRegion(SEED, DOMES)
setBrain(BRAIN === 'random' ? new RandomBrain(region.domes[0].rng) : BRAIN === 'remote' ? new RemoteBrain(BRAIN_URL, 0.35, 15000) : new HeuristicBrain())
const systemTwo = new SystemTwo()
const w: World = region.domes[0]
const serviceBase = BRAIN_URL.replace(/\/decide\/?$/, '')

async function probe() {
  if (BRAIN !== 'remote') return null
  try { const r = await fetch(`${serviceBase}/health`); return (await r.json()) as { backend: string } } catch { return null }
}
const health = await probe()
const usage0 = (health as { usage?: { calls: number; input_tokens: number; output_tokens: number } } | null)?.usage
if (BRAIN === 'remote' && !health) { console.error(`the brain service is not responding at ${serviceBase}. Start it: BRAIN_BACKEND=jev brain/.venv/bin/uvicorn brain.server:app --port 8765`); process.exit(1) }
console.log(`seed ${SEED}, domes ${region.domes.length}, residents ${w.chars.length}, brain ${BRAIN}${health ? ` (${health.backend})` : ''}, System Two ${systemTwo.enabled ? 'on' : 'off'}, ${SOLS} sols.`)

const t0 = Date.now()
const startDay = dayOf(w.t)
let lastReport = Date.now()
const diaries: { day: number; name: string; text: string }[] = []
const allDecisions: World['decisions'] = []
let recorded = 0
while (dayOf(w.t) < startDay + SOLS) {
  const dayBefore = dayOf(w.t)
  tickRegion(region)
  // let remote decisions land: the engine keeps people "in thought" until the answer arrives
  if (BRAIN === 'remote') {
    await new Promise(r => setImmediate(r))
    let waited = 0
    while (remoteInFlight > 0 && waited < 20000) { await new Promise(r => setTimeout(r, 5)); waited += 5 }
  }
  // the engine keeps only the last 400 decisions; keep them all for the report
  if (w.decisions.length < recorded) recorded = Math.max(0, recorded - 100)
  while (recorded < w.decisions.length) allDecisions.push(w.decisions[recorded++])
  if (dayOf(w.t) !== dayBefore) {
    if (systemTwo.enabled) { systemTwo.scheduleDay(w, dayBefore, () => {}); await systemTwo.idle() }
    for (const c of w.chars) { const d = c.diary[c.diary.length - 1]; if (d && d.day === dayBefore) diaries.push({ day: dayBefore, name: c.name.nom, text: d.text }) }
    console.log(`sol ${dayBefore} done: ${w.chars.filter(c => c.alive && !c.left).length} residents, quarrels ${w.stats.conflicts}, kindness ${w.stats.kindness}, rumors ${w.stats.rumors}, log entries ${w.log.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
  if (Date.now() - lastReport > 15000) { lastReport = Date.now(); console.log(`  … ${clock(w.t)}, decisions ${allDecisions.length}`) }
}
const elapsed = (Date.now() - t0) / 1000

// ───────── report ─────────
let calls: unknown[] = []
let healthEnd: Record<string, unknown> | null = null
if (BRAIN === 'remote') {
  try { calls = (await (await fetch(`${serviceBase}/log?limit=2000`)).json()) as unknown[] } catch { /* none */ }
  try { healthEnd = (await (await fetch(`${serviceBase}/health`)).json()) as Record<string, unknown> } catch { /* none */ }
}
const people = w.chars.filter(c => c.alive && !c.left)
const usage1 = (healthEnd as { usage?: { calls: number; input_tokens: number; output_tokens: number } } | null)?.usage
const runCalls = usage0 && usage1 ? usage1.calls - usage0.calls : calls.length
const runTokens = usage0 && usage1 ? { input: usage1.input_tokens - usage0.input_tokens, output: usage1.output_tokens - usage0.output_tokens } : null
const stats = { seed: SEED, sols: SOLS, domes: region.domes.length, brain: health?.backend ?? BRAIN, systemTwo: systemTwo.enabled, elapsedSeconds: Math.round(elapsed), population: people.length, decisions: allDecisions.length, brainCalls: runCalls, tokens: runTokens, callLogEntries: calls.length, service: healthEnd, world: w.stats, chronicleEntries: w.chronicle.length, logEntries: w.log.length }
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2))
fs.writeFileSync(path.join(OUT, 'log.txt'), w.log.map(e => `[sol ${dayOf(e.t)} ${clock(e.t)}] (${e.kind}) ${e.text}`).join('\n'))
fs.writeFileSync(path.join(OUT, 'decisions.jsonl'), allDecisions.map(d => JSON.stringify({ sol: dayOf(d.t), time: clock(d.t), char: w.chars.find(c => c.id === d.charId)?.name.nom, chosen: d.chosen, state: d.state })).join('\n'))
if (calls.length) fs.writeFileSync(path.join(OUT, 'brain-calls.json'), JSON.stringify(calls, null, 1))
fs.writeFileSync(path.join(OUT, 'diaries.md'), diaries.map(d => `## Sol ${d.day} · ${d.name}\n\n${d.text}\n`).join('\n'))

const sample = w.chars.filter(c => c.lastDecision).slice(0, 6).map(c => {
  const d = c.lastDecision!
  return `### ${c.name.nom} (${d.brain}), sol ${dayOf(d.t)} ${clock(d.t)}\n\n${d.state.split('\n').slice(0, 6).join('\n')}\n…\n\nOptions and probabilities: ${d.probs.map(p => `${p.label} ${(p.p * 100).toFixed(0)}%`).join(', ')}. Chosen: **${d.chosen}**. Desperation ${d.desperate.toFixed(2)}, importance ${d.important.toFixed(2)}, fear ${d.fear.toFixed(2)}.`
})
const loud = w.log.filter(e => e.weight >= 0.6).slice(-40)
const report = `# Terrarium: a ${SOLS}-sol run

Seed ${SEED}, domes ${region.domes.length}, brain **${stats.brain}**, System Two ${systemTwo.enabled ? 'on' : 'off (template diaries)'}, ${Math.round(elapsed)} s of real time.

## Summary

| metric | value |
|---|---|
| residents at the end | ${people.length} |
| character decisions | ${allDecisions.length} |
| brain calls (this run) | ${runCalls || '—'} |
| brain latency p50 / max, ms | ${(healthEnd as { latency_ms?: { p50: number; max: number } } | null)?.latency_ms ? `${(healthEnd as { latency_ms: { p50: number; max: number } }).latency_ms.p50} / ${(healthEnd as { latency_ms: { p50: number; max: number } }).latency_ms.max}` : '—'} |
| Jev tokens for this run (input / output) | ${runTokens ? `${runTokens.input} / ${runTokens.output}` : '—'} |
| quarrels / kind deeds / rumors / thefts / weddings / built | ${w.stats.conflicts} / ${w.stats.kindness} / ${w.stats.rumors} / ${w.stats.thefts} / ${w.stats.weddings} / ${w.stats.built} |

## Chronicle

${w.chronicle.map(c => `### Sol ${c.day}: ${c.title}\n\n${c.text}\n`).join('\n') || '_the chronicle is empty_'}

## Loud events

${loud.map(e => `- [sol ${dayOf(e.t)} ${clock(e.t)}] ${e.text}`).join('\n')}

## Sample decisions (the last decision of six residents)

${sample.join('\n\n')}

## Files

- \`log.txt\` — every world event, \`decisions.jsonl\` — every decision with its state, \`diaries.md\` — diaries by day,
- \`brain-calls.json\` — the brain service's call log: state, questions, answers with probabilities and confidence,
- \`stats.json\` — the summary.
`
fs.writeFileSync(path.join(OUT, 'report.md'), report)
console.log(`done: ${OUT}/report.md`)
process.exit(0)
