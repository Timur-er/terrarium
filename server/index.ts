/**
 * Terrarium world server: one process per region, authoritative.
 * The engine is the same TypeScript module the client used as a mock; clients are viewers and command senders.
 * The region is several domes on one planet: every dome is a full world, people travel between them by road.
 * Each client watches one dome at a time and receives that dome's snapshot and deltas, plus a compact region view.
 *
 *   npx tsx server/index.ts            (from the repo root)
 *   PORT=8787 BRAIN=remote BRAIN_URL=http://localhost:8765/decide SPEED=1 DOMES=4   (without DOMES the seed picks 3–5 domes)
 */
import { WebSocketServer, WebSocket } from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { playCard, whisper } from '../client/src/sim/engine.ts'
import { createRegion, tickRegion, regionView, serializeRegion, deserializeRegion, findChar, sendCaravan, type Region, type RegionSave } from '../client/src/sim/region.ts'
import { setBrain, getBrain, HeuristicBrain, RandomBrain, RemoteBrain } from '../client/src/sim/brain.ts'
import { dayOf } from '../client/src/sim/text.ts'
import type { World, Character } from '../client/src/sim/types.ts'
import { summarize, type ServerMsg, type ClientCmd, type WorldSnapshot, type CharSummary } from '../client/src/sim/protocol.ts'
import { SystemTwo } from './reflect.ts'
import { runExperiment } from '../client/src/sim/experiment.ts'
import { Players, type Player } from './players.ts'
import { Votes } from './votes.ts'
import { CARD_COST, WHISPER_COST, CARAVAN_COST } from '../client/src/sim/protocol.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(here, 'data', 'region.json')
const PORT = Number(process.env.PORT ?? 8787)
const DOMES = process.env.DOMES ? Math.max(1, Math.min(8, Number(process.env.DOMES))) : undefined
const SPEED_MS: Record<number, number> = { 0: 0, 1: 500, 3: 160, 10: 50, 30: 16 }

// ───────────────────────── region ─────────────────────────

function load(): Region {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8')) as RegionSave
    const r = deserializeRegion(raw)
    console.log(`region loaded from ${DATA}: ${r.domes.map(w => `${w.domeName} (${w.chars.filter(c => !c.left).length})`).join(', ')}, sol ${dayOf(r.domes[0].t)}`)
    return r
  } catch {
    const r = createRegion(Math.floor(Math.random() * 100000), DOMES)
    console.log(`new region: ${r.domes.map(w => `${w.domeName} (${w.chars.length})`).join(', ')}`)
    return r
  }
}
function save(r: Region) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(DATA, JSON.stringify(serializeRegion(r)))
}
const snapshot = (w: World): WorldSnapshot => { const { rng: _r, brainQueue: _q, ...rest } = w; return rest }

let region = load()
let speed = Number(process.env.SPEED ?? 1)
let brainKind: 'heuristic' | 'random' | 'remote' = (process.env.BRAIN as typeof brainKind) ?? 'heuristic'
const BRAIN_URL = process.env.BRAIN_URL ?? 'http://localhost:8765/decide'
function applyBrain() {
  setBrain(brainKind === 'random' ? new RandomBrain(region.domes[0].rng) : brainKind === 'remote' ? new RemoteBrain(BRAIN_URL) : new HeuristicBrain())
}
applyBrain()
const systemTwo = new SystemTwo()
const players = new Players()
const votes = new Votes()
const domeById = (id: string) => region.domes.find(w => w.domeId === id) ?? region.domes[0]
/** A character anywhere in the region (for wards and standings). */
const anyChar = (id: string | null) => (id ? findChar(region, id)?.char : undefined)

// ───────────────────────── clients ─────────────────────────

interface Client { ws: WebSocket; dome: string; lastLog: number; watch: string | null; mapVersion: number; knownChars: Set<string>; player: Player | null; chronicleN: number }
const clients = new Set<Client>()
const send = (c: Client, m: ServerMsg) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)) }
const broadcast = (m: ServerMsg) => { for (const c of clients) send(c, m) }
const worldOf = (c: Client) => domeById(c.dome)
const observed = (w: World) => [...clients].some(c => c.dome === w.domeId)

function sendSnapshot(c: Client) {
  const world = worldOf(c)
  send(c, { type: 'snapshot', world: snapshot(world), speed, brain: getBrain().kind, systemTwo: systemTwo.enabled, region: regionView(region, world.domeId) })
  c.lastLog = world.logSeq
  c.mapVersion = world.mapVersion
  c.knownChars = new Set(world.chars.map(x => x.id))
  c.chronicleN = world.chronicle.length
}

let lastBroadcast = 0
function broadcastTick(force = false) {
  const now = Date.now()
  if (!force && now - lastBroadcast < 50) return
  lastBroadcast = now
  const summaries = new Map<string, CharSummary[]>()
  for (const c of clients) {
    const world = worldOf(c)
    let chars = summaries.get(world.domeId)
    if (!chars) { chars = world.chars.map(summarize); summaries.set(world.domeId, chars) }
    const log = world.log.filter(e => e.id >= c.lastLog)
    c.lastLog = world.logSeq
    const newChars = world.chars.filter(x => !c.knownChars.has(x.id))
    for (const x of newChars) c.knownChars.add(x.id)
    const msg: ServerMsg = {
      type: 'tick', t: world.t, speed, brain: getBrain().kind, chars, log, events: world.events, stats: world.stats, cooldowns: world.cooldowns,
      foodPrice: world.foodPrice, stock: world.stock, partsPrice: world.partsPrice, mapVersion: world.mapVersion, region: regionView(region, world.domeId),
    }
    if (newChars.length) msg.newChars = newChars
    if (c.mapVersion !== world.mapVersion) { msg.map = { tiles: world.tiles, buildings: world.buildings, places: world.places }; c.mapVersion = world.mapVersion }
    if (world.chronicle.length !== c.chronicleN) { msg.chronicle = world.chronicle; c.chronicleN = world.chronicle.length }
    send(c, msg)
    if (c.watch) { const ch = world.chars.find(x => x.id === c.watch); if (ch) send(c, { type: 'char', char: ch }) }
  }
}

// ───────────────────────── loop ─────────────────────────

let timer: NodeJS.Timeout | null = null
function applyLoop() {
  if (timer) clearInterval(timer)
  timer = null
  if (speed === 0) return
  timer = setInterval(() => {
    const dayBefore = dayOf(region.domes[0].t)
    tickRegion(region)
    const t = region.domes[0].t
    // System Two reflects only over domes somebody is watching: the others live on the cheap
    if (dayOf(t) !== dayBefore) for (const w of region.domes) if (observed(w)) systemTwo.scheduleDay(w, dayBefore, m => broadcastTo(w, m))
    players.onTick(region.domes[0])
    for (const w of region.domes) {
      if (players.maybeMorning(w).length && observed(w)) { broadcastMarkets(); broadcastTo(w, { type: 'toast', text: `morning bets are open: ${w.domeName}`, icon: '🎲' }) }
      const resolved = players.resolve(w)
      if (resolved.length) { for (const r of resolved) broadcastTo(w, { type: 'toast', text: r, icon: '🎲' }); broadcastMarkets(); broadcastPlayers() }
    }
    for (const w of region.domes) { const v = votes.maybeOpen(w, [...clients].filter(c => c.dome === w.domeId && c.player).length); if (v) { sendVote(w.domeId); broadcastTo(w, { type: 'toast', text: 'the audience is choosing an event: vote at the top', icon: '🗳️' }) } }
    for (const n of region.news.splice(0)) { const w = domeById(n.dome); broadcastTo(w, { type: 'toast', text: n.text, icon: n.icon }) }
    if (t % 60 === 0) broadcastPlayers()
    broadcastTick()
  }, SPEED_MS[speed] ?? 500)
}
applyLoop()
setInterval(() => { save(region); players.save() }, 60_000)
setInterval(() => { for (const c of clients) if (c.watch) broadcastTick(true) }, 250)
// votes close on the wall clock, even while the world is paused
setInterval(() => {
  const closed = votes.resolve(region.domes, pid => { const p = players.byId(pid); if (p) p.influence = Math.min(99, p.influence + 1) })
  for (const v of closed) {
    const w = domeById(v.dome)
    for (const c of clients) if (c.dome === v.dome) send(c, { type: 'vote', vote: v, you: null, now: Date.now() })
    broadcastTo(w, { type: 'toast', text: `vote: ${v.text}`, icon: '🗳️' })
    setTimeout(() => { for (const c of clients) if (c.dome === v.dome) send(c, { type: 'vote', vote: votes.current(v.dome), you: null, now: Date.now() }) }, 6000)
    broadcastPlayers(); broadcastTick(true)
  }
}, 1000)
/** The running vote of a dome to everyone watching it, each with their own ballot. */
function sendVote(dome: string) { const v = votes.current(dome); for (const c of clients) if (c.dome === dome) send(c, { type: 'vote', vote: v, you: c.player ? votes.myVote(dome, c.player.id) : null, now: Date.now() }) }

/** A message for the clients watching one dome. */
function broadcastTo(w: World, m: ServerMsg) { for (const c of clients) if (c.dome === w.domeId) send(c, m) }
function broadcastPlayers() {
  const list = players.list(anyChar)
  for (const c of clients) if (c.player) send(c, { type: 'players', you: players.publicOf(anyChar, c.player), players: list })
}
function broadcastMarkets() { broadcast({ type: 'markets', markets: players.openMarkets() }) }
function charge(c: Client, cost: number, what: string): boolean {
  if (!c.player) { send(c, { type: 'toast', text: 'introduce yourself first', icon: '👤' }); return false }
  if (cost > 0 && c.player.influence < cost) { send(c, { type: 'toast', text: `${what}: needs ${cost} influence, you have ${c.player.influence}`, icon: '◈' }); return false }
  c.player.influence -= cost
  return true
}

// ───────────────────────── commands ─────────────────────────

function handle(c: Client, cmd: ClientCmd) {
  const world = worldOf(c)
  switch (cmd.cmd) {
    case 'speed': speed = [0, 1, 3, 10, 30].includes(cmd.value) ? cmd.value : 1; applyLoop(); broadcastTick(true); break
    case 'caravan': { if (!c.player) { send(c, { type: 'toast', text: 'introduce yourself first', icon: '👤' }); break } if (c.player.influence < CARAVAN_COST) { send(c, { type: 'toast', text: `caravan: needs ${CARAVAN_COST} influence`, icon: '◈' }); break } const err = sendCaravan(region, cmd.from, c.dome); if (err) send(c, { type: 'toast', text: err, icon: '📦' }); else { c.player.influence -= CARAVAN_COST; broadcastPlayers(); broadcastTick(true) } break }
    case 'dome': { if (!region.domes.some(w => w.domeId === cmd.id) || c.dome === cmd.id) break; c.dome = cmd.id; c.watch = null; sendSnapshot(c); send(c, { type: 'vote', vote: votes.current(c.dome), you: c.player ? votes.myVote(c.dome, c.player.id) : null, now: Date.now() }); break }
    case 'vote': { if (!c.player) { send(c, { type: 'toast', text: 'introduce yourself first', icon: '👤' }); break } const v = votes.current(c.dome); if (!v || v.id !== cmd.voteId) break; const err = votes.cast(c.dome, c.player.id, cmd.option); if (err) send(c, { type: 'toast', text: err, icon: '🗳️' }); else sendVote(c.dome); break }
    case 'card': { const cost = CARD_COST[cmd.id] ?? 3; if (!charge(c, cost, 'card')) break; const text = playCard(world, cmd.id, cmd.target); broadcastTo(world, { type: 'toast', text: `${c.player!.name} (${world.domeName}): ${text}`, icon: '🃏' }); broadcastPlayers(); broadcastTick(true); break }
    case 'whisper': { const isWard = c.player?.ward === cmd.charId; if (!charge(c, isWard ? 0 : WHISPER_COST, 'whisper')) break; const r = whisper(world, cmd.charId, cmd.whisperId, cmd.targetId, isWard ? 0.15 : 0); send(c, { type: 'whisper', charId: cmd.charId, ...r }); broadcastPlayers(); broadcastTick(true); break }
    case 'watch': c.watch = cmd.id; if (cmd.id) { const ch = world.chars.find(x => x.id === cmd.id); if (ch) send(c, { type: 'char', char: ch }) } break
    case 'relations': {
      const links: { a: string; b: string; v: number; family: boolean; debt: number }[] = []
      const people = world.chars.filter(x => x.alive && !x.left)
      for (const a of people) for (const b of people) {
        if (a.id >= b.id) continue
        const ra = a.relations[b.id], rb = b.relations[a.id]
        if (!ra || !rb) continue
        const v = (ra.liking + rb.liking) / 2
        if (ra.family || Math.abs(v) > 0.28 || ra.debt || rb.debt) links.push({ a: a.id, b: b.id, v, family: ra.family, debt: ra.debt || rb.debt })
      }
      send(c, { type: 'relations', links })
      break
    }
    case 'ask': {
      const ch = world.chars.find(x => x.id === cmd.charId)
      if (!ch) break
      systemTwo.ask(world, ch, cmd.question).then(text => send(c, { type: 'answer', charId: ch.id, text })).catch(err => send(c, { type: 'answer', charId: ch.id, text: `(stays silent: ${String(err)})` }))
      break
    }
    case 'brain': brainKind = cmd.kind; applyBrain(); broadcast({ type: 'toast', text: `brain: ${brainKind}`, icon: '🧠' }); broadcastTick(true); break
    case 'experiment': {
      const days = Math.max(1, Math.min(14, Math.floor(cmd.spec.days || 3)))
      const branches = cmd.spec.branches.slice(0, 3)
      try { send(c, { type: 'experiment', result: runExperiment(world, { days, branches, seed: cmd.spec.seed }) }) }
      catch (e) { send(c, { type: 'toast', text: `experiment failed: ${String(e)}`, icon: '⚠️' }) }
      break
    }
    case 'hello': { c.player = players.hello(cmd.token, cmd.name.slice(0, 24)); broadcastPlayers(); send(c, { type: 'vote', vote: votes.current(c.dome), you: votes.myVote(c.dome, c.player.id), now: Date.now() }); if (!players.markets.some(m => m.day === dayOf(world.t) && m.dome === world.domeId)) players.createMorningMarkets(world); send(c, { type: 'markets', markets: players.openMarkets() }); break }
    case 'rename': { if (c.player && cmd.name.trim()) { c.player.name = cmd.name.trim().slice(0, 24); broadcastPlayers() } break }
    case 'adopt': {
      if (!c.player) break
      if (cmd.charId) {
        const owner = players.wardOwner(cmd.charId)
        if (owner && owner !== c.player) { send(c, { type: 'toast', text: `${owner.name} already looks after this colonist`, icon: '👤' }); break }
        const ch = world.chars.find(x => x.id === cmd.charId)
        if (!ch || !ch.alive || ch.left) break
        c.player.ward = cmd.charId
        broadcast({ type: 'toast', text: `${c.player.name} takes ${ch.name.nom} as a ward (${world.domeName})`, icon: '👤' })
      } else c.player.ward = null
      broadcastPlayers()
      break
    }
    case 'bet': { if (!c.player) break; const err = players.bet(c.player, cmd.marketId, cmd.option, cmd.stake); if (err) send(c, { type: 'toast', text: err, icon: '🎲' }); else { broadcastPlayers(); broadcastMarkets() } break }
    case 'reset': region = createRegion(Math.floor(Math.random() * 100000), DOMES); applyBrain(); for (const cl of clients) { cl.dome = region.domes[0].domeId; cl.watch = null; sendSnapshot(cl) } break
  }
}

// ───────────────────────── websocket ─────────────────────────

const wss = new WebSocketServer({ port: PORT })
wss.on('connection', ws => {
  const c: Client = { ws, dome: region.domes[0].domeId, lastLog: 0, watch: null, mapVersion: -1, knownChars: new Set(), player: null, chronicleN: 0 }
  clients.add(c)
  sendSnapshot(c)
  console.log(`client connected (${clients.size})`)
  ws.on('message', data => {
    try { handle(c, JSON.parse(String(data)) as ClientCmd) } catch (e) { console.warn('bad command', e) }
  })
  ws.on('close', () => { clients.delete(c); if (c.player && ![...clients].some(o => o.player === c.player)) c.player.online = false; broadcastPlayers(); console.log(`client disconnected (${clients.size})`) })
})
console.log(`region server: ws://localhost:${PORT}  domes ${region.domes.length}  speed ${speed}  brain ${getBrain().kind}  System Two: ${systemTwo.enabled ? 'on' : 'off (no key)'}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { save(region); players.save(); console.log('region saved'); process.exit(0) })

export type { Character }
