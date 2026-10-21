import { useMemo, useRef, useEffect } from 'react'
import { useStore } from '../store'
import { clock, dayOf, KIND_LABEL } from '../sim/text'
import type { LogKind } from '../sim/types'

const KIND_COLOR: Record<LogKind, string> = {
  conflict: 'var(--hot)', kindness: 'var(--cold)', rumor: 'var(--ink-2)', trade: 'var(--ink-3)', life: 'var(--mute)', player: 'var(--ink-bright)', world: 'var(--ink)', love: 'var(--rose)',
}
const FILTERS: { id: LogKind | 'all'; label: string }[] = [
  { id: 'all', label: 'all' }, { id: 'conflict', label: 'quarrels' }, { id: 'kindness', label: 'kindness' }, { id: 'rumor', label: 'rumors' }, { id: 'love', label: 'hearts' }, { id: 'player', label: 'player' },
]

export function Chronicle() {
  const world = useStore(s => s.world)
  useStore(s => s.version)
  const filter = useStore(s => s.filter)
  const setFilter = useStore(s => s.setFilter)
  const select = useStore(s => s.select)
  const selected = useStore(s => s.selected)
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
    let list = world.log
    if (filter !== 'all') list = list.filter(e => e.kind === filter)
    else list = list.filter(e => e.weight >= 0.1)
    if (selected) list = list.filter(e => e.actors.includes(selected) || e.kind === 'world' || e.kind === 'player')
    return list.slice(-120).reverse()
  }, [world.log.length, filter, selected, world.logSeq])

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0 }, [filter, selected])

  let lastDay = -1
  return (
    <section className="chronicle">
      <div className="panel-head">
        <div className="panel-title">Chronicle<small>{selected ? 'only with this colonist' : `${world.log.length} entries`}</small></div>
      </div>
      <div className="chips">
        {FILTERS.map(f => <button key={f.id} className={`chip ${filter === f.id ? 'on' : ''}`} style={{ color: filter === f.id ? undefined : undefined }} onClick={() => setFilter(f.id)}>{f.id !== 'all' && <i style={{ background: KIND_COLOR[f.id as LogKind] }} />}{f.label}</button>)}
      </div>
      <div className="chronicle-list" ref={listRef}>
        {entries.map(e => {
          const d = dayOf(e.t)
          const sep = d !== lastDay
          lastDay = d
          const w = e.weight >= 0.8 ? 'w3' : e.weight >= 0.45 ? 'w2' : e.weight >= 0.25 ? 'w1' : 'w0'
          return (
            <div key={e.id}>
              {sep && <div className="day-sep">sol {String(d).padStart(2, '0')}</div>}
              {sep && world.chronicle.find(ch => ch.day === d) && <div className="day-story"><b>{world.chronicle.find(ch => ch.day === d)!.title}</b>{world.chronicle.find(ch => ch.day === d)!.text}</div>}
              <div className={`entry ${w}`} style={{ ['--k' as string]: KIND_COLOR[e.kind] }} onClick={() => e.actors[0] && select(e.actors[0])}>
                <time>{clock(e.t)}</time>
                <div>
                  <p>{e.text}</p>
                  {e.weight >= 0.45 && <span className="k">{KIND_LABEL[e.kind]}</span>}
                </div>
              </div>
            </div>
          )
        })}
        {entries.length === 0 && <div className="empty-side" style={{ border: 0 }}>no signal. quiet for now.</div>}
      </div>
    </section>
  )
}
