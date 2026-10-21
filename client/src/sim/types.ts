import type { NameForms, RoleId } from './names'

export interface Vec { x: number; y: number }

// 0 grass, 1 path, 2 water, 3 tree, 4 field, 5 building, 6 bridge, 7 cobble, 8 well, 9 ash
export type TileKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type BuildingType =
  | 'house' | 'market' | 'tavern' | 'forge' | 'church' | 'guard' | 'school' | 'mill' | 'bakery'

export interface Building {
  id: string
  type: BuildingType
  name: string
  x: number; y: number; w: number; h: number
  door: Vec
  owners: string[]
  family?: string
  open?: [number, number]
  burned?: boolean
  site?: boolean
  progress?: number
  builders?: string[]
  reason?: 'wedding' | 'settle' | 'rebuild' | 'whisper'
}

export interface Traits {
  trust: number; generosity: number; temper: number; honesty: number; sociability: number; courage: number
}
export interface Mood { joy: number; anger: number; fear: number; shame: number }
export interface Needs { hunger: number; sleep: number; money: number; safety: number; social: number; esteem: number }

export interface Relation {
  trust: number; liking: number; fear: number; debt: number; lastContact: number; family: boolean
}

export interface Memory {
  t: number
  text: string
  weight: number
  /** 'seen' — witnessed first-hand; 'told' — heard from someone */
  source: 'seen' | 'told'
  about: string[]
  culprit?: string
  hops?: number
}

/** goal source: 'self' — the character's own; 'LLM' — System Two; 'player' — a whisper from orbit */
export interface Goal { id: string; text: string; priority: number; source: 'self' | 'LLM' | 'player'; target?: string }
export interface Belief { claim: string; confidence: number; about?: string }

export type ActivityKind =
  | 'idle' | 'walk' | 'sleep' | 'work' | 'eat' | 'talk' | 'quarrel' | 'drink' | 'pray'
  | 'play' | 'rest' | 'sick' | 'think' | 'steal' | 'fight' | 'help' | 'court' | 'watch' | 'leave' | 'build'

export interface Activity {
  kind: ActivityKind
  label: string
  until: number
  place: string | null
  with?: string
}

export interface Character {
  id: string
  name: NameForms
  age: number
  role: RoleId
  home: string
  family: string
  familyName: string
  traits: Traits
  mood: Mood
  needs: Needs
  money: number
  food: number
  pos: Vec
  prev: Vec
  path: Vec[]
  activity: Activity
  memory: Memory[]
  longMemory: Memory[]
  relations: Record<string, Relation>
  goals: Goal[]
  beliefs: Belief[]
  diary: { day: number; text: string }[]
  alive: boolean
  sick: boolean
  drunk: number
  color: number
  seed: number
  arrivedDay: number
  intent: { kind: ActivityKind; label: string; duration: number; place: string | null; with?: string } | null
  left: boolean
  starving: number
  lastDecision?: DecisionRecord
  /** a trader away from home: where to go back and when */
  visit?: { home: string; building: string; returnAt: number; cargo?: { food: number; parts: number } }
  /** a stand-in left behind in the dome someone departed from */
  ghost?: boolean
}

export interface DecisionRecord {
  t: number
  state: string
  chosen: string
  probs: { label: string; p: number }[]
  desperate: number
  important: number
  fear: number
  brain: string
}

export type LogKind = 'conflict' | 'kindness' | 'rumor' | 'trade' | 'life' | 'player' | 'world' | 'love'

export interface LogEntry {
  id: number
  t: number
  text: string
  weight: number
  actors: string[]
  kind: LogKind
  place?: string
}

export interface ActiveEvent { id: string; name: string; icon: string; until: number }

export interface WorldStats {
  conflicts: number; kindness: number; rumors: number; thefts: number; built: number; weddings: number
}

export interface World {
  seed: number
  w: number; h: number
  tiles: TileKind[]
  buildings: Building[]
  places: Record<string, Vec[]>
  chars: Character[]
  t: number
  log: LogEntry[]
  logSeq: number
  events: ActiveEvent[]
  cooldowns: Record<string, number>
  foodPrice: number
  /** the dome warehouse: rations and spare parts; prices follow the stock */
  stock: { food: number; parts: number }
  partsPrice: number
  stats: WorldStats
  chronicle: { day: number; title: string; text: string }[]
  rng: () => number
  nextId: number
  mapVersion: number
  dirty: number[]
  /** dome id; prefixes character and building ids so they stay unique across a region */
  domeId: string
  domeName: string
  brainQueue: PendingDecision[]
  timers: WorldTimer[]
  decisions: { t: number; charId: string; chosen: string; state: string }[]
}

export interface PendingDecision { charId: string; apply: () => void }

/** Data-only delayed effects so the world stays serialisable and forkable. */
export interface WorldTimer { at: number; action: 'foodPrice' | 'cure'; value?: number; ids?: string[] }
