import { create } from 'zustand'
import { playCard, whisper as doWhisper } from './sim/engine'
import { createRegion, tickRegion, domeOf, regionView, sendCaravan, type Region, type RegionView } from './sim/region'
import { DECK } from './sim/cards'
import { setBrain, HeuristicBrain, RandomBrain, RemoteBrain } from './sim/brain'
import { WorldClient } from './net'
import { runExperiment as runExperimentLocal, type ExperimentSpec, type ExperimentResult } from './sim/experiment'
import type { PlayerPublic, Market, Vote } from './sim/protocol'
import type { World, LogKind } from './sim/types'

export type Speed = 0 | 1 | 3 | 10 | 30
export const SPEED_MS: Record<Speed, number> = { 0: 0, 1: 500, 3: 160, 10: 50, 30: 16 }

export type BrainKind = 'heuristic' | 'random' | 'remote'

export type WorldMode = 'local' | 'remote'

export interface AppState {
  mode: WorldMode
  net: WorldClient | null
  serverUrl: string
  systemTwo: boolean
  connecting: boolean
  connect: () => Promise<void>
  disconnect: () => void
  answers: Record<string, string>
  askWhy: (charId: string, question?: string) => void
  graphLinks: { a: string; b: string; v: number; family: boolean; debt: number }[] | null
  requestRelations: () => void
  player: PlayerPublic | null
  players: PlayerPublic[]
  markets: Market[]
  /** the running audience vote for the dome you watch, with the clock offset to the server */
  vote: Vote | null
  myVote: number | null
  clockOffset: number
  castVote: (option: number) => void
  playersOpen: boolean
  setPlayersOpen: (v: boolean) => void
  adopt: (charId: string | null) => void
  bet: (marketId: string, option: number, stake: number) => void
  rename: (name: string) => void
  experimentOpen: boolean
  setExperimentOpen: (v: boolean) => void
  experimentRunning: boolean
  experimentResult: ExperimentResult | null
  runExperiment: (spec: ExperimentSpec) => void
  brainKind: BrainKind
  brainUrl: string
  setBrainKind: (k: BrainKind) => void
  setBrainUrl: (u: string) => void
  world: World
  /** local mode: the whole region; remote mode: null (the server owns it) */
  region: Region | null
  regionView: RegionView | null
  activeDome: string
  regionOpen: boolean
  setRegionOpen: (v: boolean) => void
  setDome: (id: string) => void
  /** ask a neighbouring dome to send its surplus here */
  caravan: (from: string) => void
  version: number
  speed: Speed
  prevSpeed: Speed
  selected: string | null
  filter: LogKind | 'all'
  graphOpen: boolean
  whisperOpen: boolean
  whisperFor: string | null
  pendingCard: string | null
  toast: { id: number; text: string; icon?: string } | null
  focusReq: { id: string; n: number } | null
  lastTickAt: number
  setSpeed: (s: Speed) => void
  togglePause: () => void
  select: (id: string | null) => void
  setFilter: (f: LogKind | 'all') => void
  setGraphOpen: (v: boolean) => void
  openWhisper: (id?: string | null) => void
  closeWhisper: () => void
  play: (cardId: string, targetId?: string) => void
  setPendingCard: (id: string | null) => void
  whisper: (charId: string, whisperId: string, targetId?: string) => { accepted: boolean; text: string } | Promise<{ accepted: boolean; text: string }>
  focus: (id: string) => void
  showToast: (text: string, icon?: string) => void
  reset: () => void
}

let toastSeq = 0

export const useStore = create<AppState>((set, get) => ({
  brainKind: 'heuristic',
  brainUrl: (() => { try { return localStorage.getItem('brainUrl') || 'http://localhost:8765/decide' } catch { return 'http://localhost:8765/decide' } })(),
  setBrainKind: k => { const st = get(); if (st.mode === 'remote') { st.net?.send({ cmd: 'brain', kind: k }); set({ brainKind: k }); return } setBrain(k === 'random' ? new RandomBrain(st.world.rng) : k === 'remote' ? new RemoteBrain(st.brainUrl) : new HeuristicBrain()); set({ brainKind: k }); st.showToast(k === 'heuristic' ? 'brain: heuristic' : k === 'random' ? 'brain: dice' : 'brain: remote service', '🧠') },
  setBrainUrl: u => { try { localStorage.setItem('brainUrl', u) } catch { /* noop */ } set({ brainUrl: u }); if (get().brainKind === 'remote') setBrain(new RemoteBrain(u)) },
  mode: 'local',
  net: null,
  serverUrl: (() => { try { return localStorage.getItem('serverUrl') || 'ws://localhost:8787' } catch { return 'ws://localhost:8787' } })(),
  systemTwo: false,
  connecting: false,
  answers: {},
  graphLinks: null,
  connect: async () => {
    const st = get()
    if (st.net) return
    set({ connecting: true })
    const net = new WorldClient(st.serverUrl, {
      onUpdate: (world, speed, brain) => {
        const s = get()
        const patch: Partial<AppState> = { world, version: s.version + 1, lastTickAt: performance.now() }
        if (speed >= 0) patch.speed = speed as Speed
        if (brain === 'heuristic' || brain === 'random' || brain === 'remote') patch.brainKind = brain
        set(patch)
      },
      onToast: (text, icon) => get().showToast(text, icon),
      onAnswer: (charId, text) => set(s => ({ answers: { ...s.answers, [charId]: text } })),
      onRelations: links => set({ graphLinks: links }),
      onExperiment: result => set({ experimentResult: result, experimentRunning: false }),
      onPlayers: (you, players) => set({ player: you, players }),
      onMarkets: markets => set({ markets }),
      onRegion: view => set({ regionView: view, activeDome: view.active }),
      onVote: (vote, you, now) => set({ vote, myVote: you, clockOffset: now - Date.now() }),
      onClose: () => { if (get().net) { set({ net: null, mode: 'local', connecting: false }); get().showToast('connection to the server lost, the world is local again', '⚠️') } },
    })
    try {
      const world = await net.connect()
      set({ net, mode: 'remote', world, selected: null, version: get().version + 1, systemTwo: net.systemTwo, connecting: false })
      let token = '', name = ''
      try { token = localStorage.getItem('playerToken') || ''; name = localStorage.getItem('playerName') || '' } catch { /* noop */ }
      if (!token) { token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); try { localStorage.setItem('playerToken', token) } catch { /* noop */ } }
      net.send({ cmd: 'hello', token, name })
      get().showToast('world on the server', '📡')
    } catch (e) {
      set({ connecting: false })
      get().showToast(`server: ${(e as Error).message}`, '⚠️')
    }
  },
  disconnect: () => { const st = get(); st.net?.close(); set({ net: null, mode: 'local', graphLinks: null, player: null, players: [], markets: [], vote: null, myVote: null }); st.showToast('world is local', '🫙') },
  player: null,
  players: [],
  markets: [],
  playersOpen: false,
  setPlayersOpen: v => set({ playersOpen: v }),
  adopt: charId => { const st = get(); if (st.mode !== 'remote') { st.showToast('wards only work with the server', '📡'); return } st.net?.send({ cmd: 'adopt', charId }) },
  bet: (marketId, option, stake) => get().net?.send({ cmd: 'bet', marketId, option, stake }),
  rename: name => { get().net?.send({ cmd: 'rename', name }); try { localStorage.setItem('playerName', name) } catch { /* noop */ } },
  askWhy: (charId, question) => { const st = get(); if (st.mode !== 'remote' || !st.net) { st.showToast('questions only work with the server', '📡'); return } set(s => ({ answers: { ...s.answers, [charId]: '…' } })); st.net.send({ cmd: 'ask', charId, question }) },
  requestRelations: () => { const st = get(); if (st.mode === 'remote') st.net?.send({ cmd: 'relations' }) },
  experimentOpen: false,
  setExperimentOpen: v => set({ experimentOpen: v }),
  experimentRunning: false,
  experimentResult: null,
  runExperiment: spec => {
    const st = get()
    set({ experimentRunning: true, experimentResult: null })
    if (st.mode === 'remote') { st.net?.send({ cmd: 'experiment', spec }); return }
    setTimeout(() => {
      try { const result = runExperimentLocal(get().world, spec); set({ experimentResult: result, experimentRunning: false }) }
      catch (e) { set({ experimentRunning: false }); get().showToast(`experiment failed: ${(e as Error).message}`, '⚠️') }
    }, 30)
  },
  ...(() => { const region = createRegion(Math.floor(Math.random() * 100000)); return { region, world: region.domes[0], regionView: regionView(region, region.domes[0].domeId), activeDome: region.domes[0].domeId } })(),
  regionOpen: false,
  setRegionOpen: v => set({ regionOpen: v }),
  vote: null,
  myVote: null,
  clockOffset: 0,
  castVote: option => { const st = get(); if (st.mode !== 'remote' || !st.vote) return; st.net?.send({ cmd: 'vote', voteId: st.vote.id, option }); set({ myVote: option }) },
  caravan: from => {
    const st = get()
    if (st.mode === 'remote') { st.net?.send({ cmd: 'caravan', from }); return }
    if (!st.region) return
    const err = sendCaravan(st.region, from, st.activeDome)
    st.showToast(err || 'caravan sent', '📦')
    set({ version: st.version + 1, regionView: regionView(st.region, st.activeDome) })
  },
  setDome: id => {
    const st = get()
    if (st.activeDome === id) return
    if (st.mode === 'remote') { st.net?.send({ cmd: 'dome', id }); set({ selected: null, graphLinks: null }); return }
    if (!st.region) return
    const world = domeOf(st.region, id) as World | undefined
    if (!world) { st.showToast('only a construction site there yet: the expedition is on its way', '◍'); return }
    set({ world, activeDome: id, selected: null, regionView: regionView(st.region, id), version: st.version + 1 })
    st.showToast(`dome ${world.domeName}`, '◍')
  },
  version: 0,
  speed: 1,
  prevSpeed: 1,
  selected: null,
  filter: 'all',
  graphOpen: false,
  whisperOpen: false,
  whisperFor: null,
  pendingCard: null,
  toast: null,
  focusReq: null,
  lastTickAt: performance.now(),
  setSpeed: s => { const st = get(); if (st.mode === 'remote') st.net?.send({ cmd: 'speed', value: s }); set(x => ({ speed: s, prevSpeed: s === 0 ? x.speed : s })) },
  togglePause: () => { const st = get(); const next = st.speed === 0 ? (st.prevSpeed || 1) : 0; if (st.mode === 'remote') st.net?.send({ cmd: 'speed', value: next }); set(x => ({ speed: next as Speed, prevSpeed: x.speed === 0 ? x.prevSpeed : x.speed })) },
  select: id => {
    const st = get()
    if (id && st.pendingCard) {
      const card = DECK.find(c => c.id === st.pendingCard)
      if (card?.needsTarget) { st.play(st.pendingCard, id); set({ pendingCard: null }); return }
    }
    set({ selected: id })
    if (st.mode === 'remote') st.net?.send({ cmd: 'watch', id })
  },
  setFilter: f => set({ filter: f }),
  setGraphOpen: v => set({ graphOpen: v }),
  openWhisper: id => set(st => ({ whisperOpen: true, whisperFor: id === undefined ? st.selected : id })),
  closeWhisper: () => set({ whisperOpen: false }),
  play: (cardId, targetId) => {
    const st = get()
    const card = DECK.find(c => c.id === cardId)!
    if (st.mode === 'remote') { st.net?.send({ cmd: 'card', id: cardId, target: targetId }); return }
    const res = playCard(st.world, cardId, targetId)
    set({ version: st.version + 1 })
    st.showToast(res, card.icon)
  },
  setPendingCard: id => set({ pendingCard: id }),
  whisper: (charId, whisperId, targetId) => {
    const st = get()
    if (st.mode === 'remote' && st.net) return st.net.whisper(charId, whisperId, targetId)
    const r = doWhisper(st.world, charId, whisperId, targetId)
    set({ version: st.version + 1 })
    return r
  },
  focus: id => set(st => ({ focusReq: { id, n: (st.focusReq?.n ?? 0) + 1 } })),
  showToast: (text, icon) => {
    const id = ++toastSeq
    set({ toast: { id, text, icon } })
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }) }, 3200)
  },
  reset: () => { const st = get(); if (st.mode === 'remote') { st.net?.send({ cmd: 'reset' }); return } const region = createRegion(Math.floor(Math.random() * 100000)); set({ region, world: region.domes[0], activeDome: region.domes[0].domeId, regionView: regionView(region, region.domes[0].domeId), selected: null, version: 0 }) },
}))

// ───────────── loop ─────────────
let timer: ReturnType<typeof setInterval> | null = null
let currentSpeed: Speed = -1 as Speed
let lastFlush = 0

function applyLoop() {
  const st = useStore.getState()
  const s: Speed = st.mode === 'remote' ? 0 : st.speed
  if (s === currentSpeed) return
  currentSpeed = s
  if (timer) clearInterval(timer)
  timer = null
  if (s === 0) return
  timer = setInterval(() => {
    const st = useStore.getState()
    if (!st.region) return
    tickRegion(st.region)
    const now = performance.now()
    useStore.setState({ lastTickAt: now })
    if (st.region.news.length) { for (const n of st.region.news.splice(0)) if (n.dome === st.activeDome) st.showToast(n.text, n.icon) }
    if (now - lastFlush > 100) { lastFlush = now; useStore.setState({ version: st.version + 1, regionView: regionView(st.region, st.activeDome) }) }
  }, SPEED_MS[s])
}

let started = false
export function startLoop() {
  ;(window as unknown as { __store: typeof useStore }).__store = useStore
  ;(window as unknown as { __advance: (n: number) => void }).__advance = (n: number) => { const st = useStore.getState(); if (!st.region) return; for (let i = 0; i < n; i++) tickRegion(st.region); useStore.setState({ version: st.version + 1, lastTickAt: performance.now(), regionView: regionView(st.region, st.activeDome) }) }
  if (started) return
  started = true
  applyLoop()
  useStore.subscribe(applyLoop)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (timer) clearInterval(timer) })
  import.meta.hot.accept(() => { window.location.reload() })
}
