import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { DECK, WHISPERS } from '../sim/cards'
import { diffBranches, diffPeople, type Intervention } from '../sim/experiment'
import { roleLabel } from '../sim/text'

const HORIZONS = [1, 3, 7]

export function ExperimentDialog() {
  const open = useStore(s => s.experimentOpen)
  const setOpen = useStore(s => s.setExperimentOpen)
  const world = useStore(s => s.world)
  const selected = useStore(s => s.selected)
  const run = useStore(s => s.runExperiment)
  const running = useStore(s => s.experimentRunning)
  const result = useStore(s => s.experimentResult)
  const select = useStore(s => s.select)
  const [days, setDays] = useState(3)
  const [card, setCard] = useState<string | null>('fire')
  const [whisper, setWhisper] = useState<string | null>(null)
  const [who, setWho] = useState<string | null>(null)

  useEffect(() => { if (open) setWho(selected) }, [open, selected])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const people = useMemo(() => world.chars.filter(c => c.alive && !c.left).sort((a, b) => a.name.nom.localeCompare(b.name.nom, 'en')), [world, open])
  if (!open) return null
  const cardDef = DECK.find(c => c.id === card)
  const whisperDef = WHISPERS.find(w => w.id === whisper)
  const needsPerson = (cardDef?.needsTarget ?? false) || !!whisperDef
  const personOk = !needsPerson || !!who
  const person = people.find(p => p.id === who)

  const start = () => {
    const interventions: Intervention[] = []
    if (cardDef) interventions.push({ kind: 'card', id: cardDef.id, targetId: cardDef.needsTarget ? who ?? undefined : undefined })
    if (whisperDef && who) interventions.push({ kind: 'whisper', id: whisperDef.id, charId: who, targetId: whisperDef.needsTarget ? people.find(p => p.id !== who)?.id : undefined })
    run({ days, branches: [{ name: 'no intervention', interventions: [] }, { name: describe(), interventions }] })
  }
  const describe = () => [cardDef ? cardDef.name.toLowerCase() : '', whisperDef ? `whisper «${whisperDef.text.replace(/\{\w+\}/, '…')}»` : ''].filter(Boolean).join(' + ') || 'no intervention'

  const a = result?.branches[0], b = result?.branches[1]
  const statDiff = a && b ? diffBranches(a, b) : []
  const fates = a && b ? diffPeople(a, b).slice(0, 8) : []

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Experiment</h2>
          <p>A copy of the world, two branches on the same dice. The main world is untouched.</p>
          <button className="x" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="modal-body">
          <div className="exp-setup">
            <div className="exp-col">
              <h4>Horizon</h4>
              <div className="chips" style={{ padding: 0 }}>{HORIZONS.map(h => <button key={h} className={`chip ${days === h ? 'on' : ''}`} onClick={() => setDays(h)}>{h} {h === 1 ? 'sol' : 'sols'}</button>)}</div>
              <h4 style={{ marginTop: 14 }}>Event in branch B</h4>
              <div className="chips" style={{ padding: 0 }}>
                <button className={`chip ${card === null ? 'on' : ''}`} onClick={() => setCard(null)}>none</button>
                {DECK.map(c => <button key={c.id} className={`chip ${card === c.id ? 'on' : ''}`} onClick={() => setCard(c.id)}>{c.icon} {c.name.toLowerCase()}</button>)}
              </div>
              <h4 style={{ marginTop: 14 }}>Whisper in branch B</h4>
              <div className="chips" style={{ padding: 0 }}>
                <button className={`chip ${whisper === null ? 'on' : ''}`} onClick={() => setWhisper(null)}>none</button>
                {WHISPERS.map(w => <button key={w.id} className={`chip ${whisper === w.id ? 'on' : ''}`} onClick={() => setWhisper(w.id)}>{w.icon} {w.text.replace(/\{\w+\}/, '…')}</button>)}
              </div>
            </div>
            <div className="exp-col">
              <h4>Who {needsPerson ? '' : '(not needed)'}</h4>
              <div className="wh-list" style={{ maxHeight: 260, opacity: needsPerson ? 1 : 0.4 }}>
                {people.map(p => <button key={p.id} className={`wh-item ${who === p.id ? 'on' : ''}`} onClick={() => setWho(p.id)}><span className="ic" style={{ color: '#' + p.color.toString(16).padStart(6, '0') }}>●</span><span>{p.name.nom}<small>{roleLabel(p)}, {p.age}</small></span></button>)}
              </div>
            </div>
          </div>
          <div className="wh-foot">
            <div className="wh-preview"><b>A</b>: do nothing · <b>B</b>: {describe()}{person && needsPerson ? ` → ${person.name.nom}` : ''} · after {days} {days === 1 ? 'sol' : 'sols'}</div>
            <button className="sbtn amber" disabled={!personOk || running} style={{ opacity: personOk && !running ? 1 : 0.4 }} onClick={start}>{running ? '[ computing… ]' : '[ run ]'}</button>
          </div>
          {result && a && b && (
            <div className="exp-result">
              <div className="exp-grid">
                {[a, b].map((br, i) => (
                  <div className="exp-branch" key={i}>
                    <h4>{i === 0 ? 'A' : 'B'} // {br.name}</h4>
                    <div className="exp-stats">
                      <span><b>{br.population}</b> res.</span><span><b>{br.stats.conflicts}</b> quarrels</span><span><b>{br.stats.kindness}</b> kindness</span><span><b>{br.stats.rumors}</b> rumors</span><span><b>{br.stats.thefts}</b> thefts</span><span><b>{br.stats.weddings}</b> weddings</span><span><b>{br.buildings}</b> modules</span>
                    </div>
                    <ul className="mem" style={{ padding: 0, margin: 0 }}>
                      {br.headlines.slice(0, 8).map((h, k) => <li key={k}><span className="d" style={{ color: 'var(--ink-3)', marginRight: 6 }}>sol {h.day}</span>{h.text}</li>)}
                      {br.headlines.length === 0 && <li>Nothing loud.</li>}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="exp-diff">
                <h4>// What changed in branch B</h4>
                {statDiff.length > 0 && <div className="words" style={{ marginBottom: 10 }}>{statDiff.map(s => <span className="word" key={s}>{s}</span>)}</div>}
                {fates.length === 0 && <p style={{ color: 'var(--ink-3)' }}>Fates did not diverge. The world absorbed the intervention.</p>}
                <div className="rels">
                  {fates.map(f => <div className="rel neutral" key={f.id} onClick={() => { select(f.id); setOpen(false) }}><div><b>{f.name}</b> <span style={{ color: 'var(--ink-2)', fontSize: 12 }}>· {f.text}</span></div></div>)}
                </div>
                <p style={{ color: 'var(--mute)', fontSize: 11, marginTop: 8 }}>computed in {result.ms} ms · brain in the fork: heuristic</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
