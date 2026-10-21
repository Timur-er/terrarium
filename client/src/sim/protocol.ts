/** Messages between the world server and the client. Shared by both sides. */
import type { World, Character, LogEntry, ActiveEvent, WorldStats, Building, TileKind, Vec, Activity, Mood, Needs } from './types'
import type { ExperimentSpec, ExperimentResult } from './experiment'
import type { RegionView } from './region'

/** A player as everyone sees them. */
export interface PlayerPublic { id: string; name: string; influence: number; ward: string | null; correct: number; bets: number; online: boolean; standing: number }

/** A prediction market: a question about the day, options, bets, resolution. */
export interface Market {
  id: string
  day: number
  question: string
  options: string[]
  optionIds?: (string | null)[]
  createdT: number
  resolveT: number
  odds: number
  bets: { playerId: string; option: number; stake: number }[]
  resolved?: { answer: number; text: string }
  /** which dome the question is about */
  dome?: string
}

/** An audience vote on the next event card for a dome. */
export interface Vote {
  id: string
  dome: string
  question: string
  options: { id: string; icon: string; label: string; targetId?: string; votes: number }[]
  /** server clock, ms */
  endsAt: number
  result?: { winner: number; text: string }
}

export const CARD_COST: Record<string, number> = { fire: 8, gold: 5, stranger: 5, rumor: 3, drought: 7, feast: 6, plague: 8, tax: 4, wolves: 5, harvest: 5, letter: 3 }
export const WHISPER_COST = 2
export const CARAVAN_COST = 3
export const VOTE_SECONDS = 75

/** Everything the client needs to start: the world without functions. */
export type WorldSnapshot = Omit<World, 'rng' | 'brainQueue'>

/** Per-tick summary of one character: enough to draw and to show the short card. */
export interface CharSummary {
  id: string
  pos: Vec
  prev: Vec
  pathLen: number
  activity: Activity
  mood: Mood
  needs: Needs
  money: number
  food: number
  alive: boolean
  left: boolean
  sick: boolean
  drunk: number
  goalsN: number
}

export type ServerMsg =
  | { type: 'snapshot'; world: WorldSnapshot; speed: number; brain: string; systemTwo: boolean; region?: RegionView }
  | {
      type: 'tick'
      t: number
      speed: number
      brain: string
      chars: CharSummary[]
      newChars?: Character[]
      log: LogEntry[]
      events: ActiveEvent[]
      stats: WorldStats
      cooldowns: Record<string, number>
      foodPrice: number
      stock?: { food: number; parts: number }
      partsPrice?: number
      mapVersion: number
      chronicle?: World['chronicle']
      region?: RegionView
      map?: { tiles: TileKind[]; buildings: Building[]; places: Record<string, Vec[]> }
    }
  | { type: 'char'; char: Character }
  | { type: 'relations'; links: { a: string; b: string; v: number; family: boolean; debt: number }[] }
  | { type: 'whisper'; charId: string; accepted: boolean; text: string }
  | { type: 'answer'; charId: string; text: string }
  | { type: 'toast'; text: string; icon?: string }
  | { type: 'experiment'; result: ExperimentResult }
  | { type: 'players'; you: PlayerPublic; players: PlayerPublic[] }
  | { type: 'markets'; markets: Market[] }
  | { type: 'vote'; vote: Vote | null; you: number | null; now: number }

export type ClientCmd =
  | { cmd: 'speed'; value: number }
  | { cmd: 'card'; id: string; target?: string }
  | { cmd: 'whisper'; charId: string; whisperId: string; targetId?: string }
  | { cmd: 'watch'; id: string | null }
  | { cmd: 'relations' }
  | { cmd: 'ask'; charId: string; question?: string }
  | { cmd: 'brain'; kind: 'heuristic' | 'random' | 'remote' }
  | { cmd: 'reset' }
  | { cmd: 'dome'; id: string }
  | { cmd: 'caravan'; from: string }
  | { cmd: 'vote'; voteId: string; option: number }
  | { cmd: 'experiment'; spec: ExperimentSpec }
  | { cmd: 'hello'; name: string; token: string }
  | { cmd: 'rename'; name: string }
  | { cmd: 'adopt'; charId: string | null }
  | { cmd: 'bet'; marketId: string; option: number; stake: number }

export function summarize(c: Character): CharSummary {
  return {
    id: c.id, pos: c.pos, prev: c.prev, pathLen: c.path.length, activity: c.activity, mood: c.mood, needs: c.needs,
    money: c.money, food: c.food, alive: c.alive, left: c.left, sick: c.sick, drunk: c.drunk, goalsN: c.goals.length,
  }
}
