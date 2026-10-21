import { useState } from 'react'
import { useStore } from '../store'
import { thoughts, traitWords, moodWords, relationWord, relationTone, roleLabel, statusEmoji, needWords, clock } from '../sim/text'
import { buildState } from '../sim/state'

export function CharacterPanel() {
  const world = useStore(s => s.world)
  useStore(s => s.version)
  const selected = useStore(s => s.selected)
  const select = useStore(s => s.select)
  const focus = useStore(s => s.focus)
  const openWhisper = useStore(s => s.openWhisper)
  const askWhy = useStore(s => s.askWhy)
  const answers = useStore(s => s.answers)
  const mode = useStore(s => s.mode)
  const systemTwo = useStore(s => s.systemTwo)
  const player = useStore(s => s.player)
  const players = useStore(s => s.players)
  const adopt = useStore(s => s.adopt)
  const [tab, setTab] = useState<'mind' | 'memory' | 'diary' | 'brain'>('mind')
  const c = world.chars.find(x => x.id === selected)
  if (!c) return (
    <div className="empty-side">
      <b>no one selected</b>
      Click a colonist to intercept their thoughts. Deal an event from the deck below. Or whisper someone a goal.
    </div>
  )
  const home = world.buildings.find(b => b.id === c.home)
  const rels = Object.entries(c.relations)
    .map(([id, r]) => ({ id, r, o: world.chars.find(x => x.id === id)! }))
    .filter(x => x.o && x.o.alive && !x.o.left)
    .sort((a, b) => (Math.abs(b.r.liking) + (b.r.debt ? 0.5 : 0) + (b.r.family ? 0.2 : 0)) - (Math.abs(a.r.liking) + (a.r.debt ? 0.5 : 0) + (a.r.family ? 0.2 : 0)))
    .slice(0, 7)
  const colorHex = '#' + c.color.toString(16).padStart(6, '0')
  const mw = moodWords(c)
  const moodClass = (w: string) => /angry|furious/.test(w) ? 'hot' : /joyful|cheerful/.test(w) ? 'good' : ''
  const mems = [...c.longMemory, ...c.memory].sort((a, b) => b.t - a.t).slice(0, 10)
  const state = c.left ? 'left the colony' : !c.alive ? 'dead' : c.activity.label

  return (
    <div className="char">
      <div className="char-head">
        <div className="avatar" style={{ background: `linear-gradient(160deg, ${colorHex}, #0e120f)`, color: '#f2e8cc' }}>
          {c.name.nom[0]}
          <span className="st">{statusEmoji(c)}</span>
        </div>
        <div>
          <div className="char-name">{c.name.nom}</div>
          <div className="char-meta"><span style={{ color: 'var(--ink-3)' }}>subject {c.id.replace('c', '').padStart(2, '0')} // </span><b>{roleLabel(c)}</b>, {c.age} · {home ? home.name.toLowerCase() : 'no module'}{c.money < 3 ? ' · broke' : ''}</div>
          <div className="char-act">{state}{c.activity.with && c.alive ? '' : ''}</div>
        </div>
        <button className="char-close" onClick={() => select(null)} title="Close">×</button>
      </div>
      <div className="char-actions">
        <button className="sbtn" onClick={() => focus(c.id)}>[ find ]</button>
        <button className="sbtn amber" onClick={() => openWhisper(c.id)}>[ whisper ]</button>
        {mode === 'remote' && player && (player.ward === c.id
          ? <button className="sbtn" onClick={() => adopt(null)}>[ release ward ]</button>
          : !players.some(p => p.ward === c.id) && <button className="sbtn" onClick={() => adopt(c.id)}>[ take as ward ]</button>)}
      </div>
      {players.some(p => p.ward === c.id) && <div className="ward-badge">ward of player {players.find(p => p.ward === c.id)!.name}{player?.ward === c.id ? ' (you)' : ''}</div>}
      <div className="chips" style={{ padding: '0 14px 6px' }}>
        {(['mind', 'memory', 'diary', 'brain'] as const).map(t => <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t === 'mind' ? 'thoughts' : t === 'memory' ? 'memory' : t === 'diary' ? 'diary' : 'brain'}</button>)}
      </div>
      {tab === 'mind' && <>
        <div className="sec">
          <div className="sec-title"><span>Thoughts</span><span>{needWords(c).length ? '' : 'needs nothing'}</span></div>
          <div className="thoughts">{thoughts(world, c).map((t, i) => <p key={i}>{t}</p>)}</div>
        </div>
        <div className="sec">
          <div className="sec-title"><span>Character & mood</span></div>
          <div className="words">
            {traitWords(c).map(w => <span className="word" key={w}>{w}</span>)}
            {mw.map(w => <span className={`word mood ${moodClass(w)}`} key={w}>{w}</span>)}
          </div>
        </div>
        <div className="sec">
          <div className="sec-title"><span>Relations</span><span>{Object.keys(c.relations).length} acquaintances</span></div>
          <div className="rels">
            {rels.map(({ id, r, o }) => (
              <div className={`rel ${relationTone(r)}`} key={id} onClick={() => select(id)}>
                <div>
                  <b>{o.name.nom}</b> <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>· {roleLabel(o)}</span>
                  <div className="meter"><i className={r.liking < 0 ? 'neg' : ''} style={{ width: `${Math.abs(r.liking) * 50}%`, transform: r.liking < 0 ? 'translateX(-100%)' : 'none' }} /></div>
                </div>
                <span className="tag">{relationWord(r, o)}</span>
              </div>
            ))}
          </div>
        </div>
        {c.goals.length > 0 && <div className="sec">
          <div className="sec-title"><span>Goals</span></div>
          <div className="goals">
            {c.goals.slice().sort((a, b) => b.priority - a.priority).map(g => <div key={g.id + g.text} className={`goal ${g.source === 'player' ? 'player' : ''}`}><span className="src">{g.source === 'player' ? 'whisper' : g.source === 'LLM' ? 'thought' : 'own'}</span>{g.text}{g.priority < 0.3 ? <span className="src"> · half-hearted</span> : null}</div>)}
          </div>
        </div>}
      </>}
      {tab === 'memory' && <div className="sec">
        <div className="sec-title"><span>Remembers</span><span>{c.longMemory.length} for good</span></div>
        <ul className="mem" style={{ padding: 0, margin: 0 }}>
          {mems.map((m, i) => <li key={i} className={m.source === 'told' ? 'heard' : ''}>{m.text}{m.source === 'told' ? ' — so they say' : ''}</li>)}
          {mems.length === 0 && <li>Nothing remembered yet.</li>}
        </ul>
        {c.beliefs.length > 0 && <>
          <div className="sec-title" style={{ marginTop: 14 }}><span>Believes</span></div>
          <ul className="mem" style={{ padding: 0, margin: 0 }}>
            {c.beliefs.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 6).map((b, i) => <li key={i}>{b.claim} <span style={{ color: 'var(--ink-3)' }}>({b.confidence > 0.7 ? 'sure' : b.confidence > 0.45 ? 'likely true' : 'doubtful'})</span></li>)}
          </ul>
        </>}
      </div>}
      {tab === 'brain' && <div className="sec">
        <div className="sec-title"><span>What the brain reads</span><span>{c.lastDecision ? c.lastDecision.brain : 'no decision yet'}</span></div>
        <pre className="state">{buildState(world, c)}</pre>
        {c.lastDecision && <>
          <div className="sec-title" style={{ marginTop: 14 }}><span>Last decision</span><span>{clock(c.lastDecision.t)}</span></div>
          <div className="decision">
            {c.lastDecision.probs.slice(0, 6).map(p => <div key={p.label} className={`dec-row ${p.label === c.lastDecision!.chosen ? 'chosen' : ''}`}><span>{p.label}</span><i style={{ width: `${Math.round(p.p * 100)}%` }} /><b>{Math.round(p.p * 100)}%</b></div>)}
          </div>
          <div className="words" style={{ marginTop: 8 }}>
            <span className="word">despair {c.lastDecision.desperate}/3</span>
            <span className={`word ${c.lastDecision.important > 0.85 ? 'mood hot' : ''}`}>key moment {Math.round(c.lastDecision.important * 100)}%</span>
            <span className="word">fear of consequences {Math.round(c.lastDecision.fear * 100)}%</span>
          </div>
        </>}
      </div>}
      {tab === 'diary' && <div className="sec">
        <div className="sec-title"><span>Diary</span><span>written at midnight</span></div>
        <div className="diary">
          {c.diary.slice().reverse().map(d => <p key={d.day}><span className="d">sol {d.day}</span>{d.text}</p>)}
          {c.diary.length === 0 && <p style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>The first entry appears when the day ends.</p>}
        </div>
        <div className="sec-title" style={{ marginTop: 14 }}><span>Ask</span><span>{mode === 'remote' ? (systemTwo ? 'System Two' : 'no key on the server') : 'needs server'}</span></div>
        <div className="char-actions" style={{ padding: 0 }}>
          <button className="sbtn" onClick={() => askWhy(c.id)}>[ ask why ]</button>
          <button className="sbtn" onClick={() => askWhy(c.id, 'What worries you most right now?')}>[ what worries you? ]</button>
        </div>
        {answers[c.id] && <div className="thoughts" style={{ marginTop: 10 }}><p>{answers[c.id]}</p></div>}
      </div>}
    </div>
  )
}
