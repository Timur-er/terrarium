/** WebSocket client for the world server: keeps a local World object in sync from snapshot + deltas. */
import type { ServerMsg, ClientCmd, WorldSnapshot, PlayerPublic, Market, Vote } from './sim/protocol'
import type { World, Character } from './sim/types'
import type { ExperimentResult } from './sim/experiment'
import type { RegionView } from './sim/region'

export interface NetEvents {
  onUpdate: (world: World, speed: number, brain: string) => void
  onToast: (text: string, icon?: string) => void
  onAnswer: (charId: string, text: string) => void
  onRelations: (links: { a: string; b: string; v: number; family: boolean; debt: number }[]) => void
  onExperiment: (result: ExperimentResult) => void
  onPlayers: (you: PlayerPublic, players: PlayerPublic[]) => void
  onMarkets: (markets: Market[]) => void
  onRegion: (view: RegionView) => void
  onVote: (vote: Vote | null, you: number | null, serverNow: number) => void
  onClose: () => void
}

export class WorldClient {
  ws: WebSocket | null = null
  world: World | null = null
  byId = new Map<string, Character>()
  systemTwo = false
  private whisperWaiters: ((r: { accepted: boolean; text: string }) => void)[] = []

  url: string
  events: NetEvents
  constructor(url: string, events: NetEvents) { this.url = url; this.events = events }

  connect(timeoutMs = 2500): Promise<World> {
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error('server is not responding')) } }, timeoutMs)
      ws.onmessage = ev => {
        const msg = JSON.parse(String(ev.data)) as ServerMsg
        if (msg.type === 'snapshot') {
          this.world = this.fromSnapshot(msg.world)
          this.systemTwo = msg.systemTwo
          if (msg.region) this.events.onRegion(msg.region)
          if (!settled) { settled = true; clearTimeout(timer); resolve(this.world) }
          this.events.onUpdate(this.world, msg.speed, msg.brain)
          return
        }
        if (!this.world) return
        this.apply(msg)
      }
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('could not connect')) } }
      ws.onclose = () => { this.ws = null; this.events.onClose() }
    })
  }

  close() { this.ws?.close(); this.ws = null }

  send(cmd: ClientCmd) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd)) }

  whisper(charId: string, whisperId: string, targetId?: string): Promise<{ accepted: boolean; text: string }> {
    return new Promise(resolve => { this.whisperWaiters.push(resolve); this.send({ cmd: 'whisper', charId, whisperId, targetId }) })
  }

  private fromSnapshot(s: WorldSnapshot): World {
    const w = { ...s, stock: s.stock ?? { food: 40, parts: 20 }, partsPrice: s.partsPrice ?? 3, rng: Math.random, brainQueue: [], dirty: [] } as World
    this.byId = new Map(w.chars.map(c => [c.id, c]))
    return w
  }

  private apply(msg: ServerMsg) {
    const w = this.world!
    switch (msg.type) {
      case 'tick': {
        for (const nc of msg.newChars ?? []) if (!this.byId.has(nc.id)) { w.chars.push(nc); this.byId.set(nc.id, nc) }
        for (const s of msg.chars) {
          const c = this.byId.get(s.id)
          if (!c) continue
          c.prev = s.prev; c.pos = s.pos; c.activity = s.activity; c.mood = s.mood; c.needs = s.needs
          c.money = s.money; c.food = s.food; c.alive = s.alive; c.left = s.left; c.sick = s.sick; c.drunk = s.drunk
          if (c.path.length !== s.pathLen) c.path = s.pathLen ? new Array(s.pathLen).fill(s.pos) : []
        }
        w.t = msg.t
        for (const e of msg.log) if (!w.log.length || e.id > w.log[w.log.length - 1].id) w.log.push(e)
        if (w.log.length > 800) w.log.splice(0, 200)
        w.logSeq = w.log.length ? w.log[w.log.length - 1].id + 1 : w.logSeq
        w.events = msg.events; w.stats = msg.stats; w.cooldowns = msg.cooldowns; w.foodPrice = msg.foodPrice
        if (msg.stock) { w.stock = msg.stock; w.partsPrice = msg.partsPrice ?? w.partsPrice }
        if (msg.chronicle) w.chronicle = msg.chronicle
        if (msg.map) { w.tiles = msg.map.tiles; w.buildings = msg.map.buildings; w.places = msg.map.places; w.dirty = [0] }
        w.mapVersion = msg.mapVersion
        if (msg.region) this.events.onRegion(msg.region)
        this.events.onUpdate(w, msg.speed, msg.brain)
        break
      }
      case 'char': {
        const c = this.byId.get(msg.char.id)
        if (c) Object.assign(c, msg.char); else { w.chars.push(msg.char); this.byId.set(msg.char.id, msg.char) }
        this.events.onUpdate(w, -1, '')
        break
      }
      case 'whisper': { const r = this.whisperWaiters.shift(); r?.({ accepted: msg.accepted, text: msg.text }); break }
      case 'relations': this.events.onRelations(msg.links); break
      case 'answer': this.events.onAnswer(msg.charId, msg.text); break
      case 'toast': this.events.onToast(msg.text, msg.icon); break
      case 'experiment': this.events.onExperiment(msg.result); break
      case 'players': this.events.onPlayers(msg.you, msg.players); break
      case 'markets': this.events.onMarkets(msg.markets); break
      case 'vote': this.events.onVote(msg.vote, msg.you, msg.now); break
    }
  }
}
