import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { clock, dayOf } from '../sim/text'

export function PlayersDialog() {
  const open = useStore(s => s.playersOpen)
  const setOpen = useStore(s => s.setPlayersOpen)
  const me = useStore(s => s.player)
  const players = useStore(s => s.players)
  const markets = useStore(s => s.markets)
  const world = useStore(s => s.world)
  const mode = useStore(s => s.mode)
  const bet = useStore(s => s.bet)
  const rename = useStore(s => s.rename)
  const select = useStore(s => s.select)
  const [name, setName] = useState('')
  const [stake, setStake] = useState(2)

  useEffect(() => { if (open) setName(me?.name ?? '') }, [open, me?.name])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])
  if (!open) return null

  const ward = (id: string | null) => world.chars.find(c => c.id === id)
  const sorted = players.slice().sort((a, b) => b.standing - a.standing || b.influence - a.influence)
  const here = markets.filter(m => !m.dome || m.dome === world.domeId)
  const openMarkets = here.filter(m => !m.resolved)
  const closedMarkets = here.filter(m => m.resolved).slice(-4).reverse()

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Players & bets</h2>
          <p>{mode === 'remote' ? 'shared aquarium: one world, many observers' : 'needs server: press «world: local» at the top'}</p>
          <button className="x" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="modal-body">
          <div className="exp-setup">
            <div className="exp-col">
              <h4>You</h4>
              {me ? (
                <div className="me">
                  <div className="me-row">
                    <input id="player-name" className="tinput" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim() && name !== me.name) rename(name) }} maxLength={24} placeholder="your name" />
                    <button className="sbtn" disabled={!name.trim() || name === me.name} onClick={() => rename(name)}>[ ok ]</button>
                  </div>
                  <div className="exp-stats" style={{ marginTop: 10 }}>
                    <span><b>◈ {me.influence}</b> influence</span>
                    <span>ward: <b>{ward(me.ward)?.name.nom ?? 'none'}</b></span>
                    <span>standing: <b>{me.standing}</b></span>
                    <span>guessed: <b>{me.correct}/{me.bets}</b></span>
                  </div>
                  <p style={{ color: 'var(--ink-3)', fontSize: 11.5, marginTop: 8 }}>Influence trickles in for presence, one per game hour. Cards cost 3 to 8, a whisper to a stranger 2, a whisper to your ward is free and lands harder. Take a ward with the button on their card; the table scores the ward's standing: friends, trust, credits, debtors.</p>
                </div>
              ) : <p style={{ color: 'var(--ink-3)' }}>Connect to the server to get a name and influence.</p>}
              <h4 style={{ marginTop: 16 }}>Ward table</h4>
              <div className="rels">
                {sorted.map((p, i) => {
                  const w = ward(p.ward)
                  return (
                    <div className={`rel ${p.id === me?.id ? 'family' : 'neutral'}`} key={p.id} onClick={() => { if (w) { select(w.id); setOpen(false) } }}>
                      <div><b>{i + 1}. {p.name}</b>{!p.online && <span style={{ color: 'var(--mute)', fontSize: 11 }}> · offline</span>}<span style={{ color: 'var(--ink-3)', fontSize: 12 }}> · {w ? `ward: ${w.name.nom}` : 'no ward'} · ◈ {p.influence} · guessed {p.correct}/{p.bets}</span></div>
                      <span className="tag">{p.standing}</span>
                    </div>
                  )
                })}
                {sorted.length === 0 && <p style={{ color: 'var(--ink-3)' }}>Nobody yet.</p>}
              </div>
            </div>
            <div className="exp-col">
              <h4>Bets: {world.domeName}, sol {String(dayOf(world.t)).padStart(2, '0')} <span style={{ color: 'var(--mute)' }}>· stake</span> {[1, 2, 3, 5].map(v => <button key={v} className={`chip ${stake === v ? 'on' : ''}`} onClick={() => setStake(v)}>{v}</button>)}</h4>
              {openMarkets.length === 0 && <p style={{ color: 'var(--ink-3)' }}>New questions appear at 06:00.</p>}
              {openMarkets.map(m => {
                const mine = m.bets.find(b => b.playerId === me?.id)
                return (
                  <div className="market" key={m.id}>
                    <div className="market-q">{m.question} <span>until {clock(m.resolveT)} · ×{m.odds}</span></div>
                    <div className="chips" style={{ padding: 0 }}>
                      {m.options.map((o, i) => <button key={i} className={`chip ${mine?.option === i ? 'on' : ''}`} disabled={!!mine || !me} onClick={() => bet(m.id, i, stake)}>{o}{m.bets.filter(b => b.option === i).length ? ` · ${m.bets.filter(b => b.option === i).length}` : ''}</button>)}
                    </div>
                    {mine && <div style={{ color: 'var(--ink-3)', fontSize: 11 }}>your bet: {m.options[mine.option]}, {mine.stake} ◈</div>}
                  </div>
                )
              })}
              {closedMarkets.length > 0 && <>
                <h4 style={{ marginTop: 14 }}>Resolved</h4>
                <ul className="mem" style={{ padding: 0, margin: 0 }}>
                  {closedMarkets.map(m => { const mine = m.bets.find(b => b.playerId === me?.id); return <li key={m.id} className={mine && mine.option !== m.resolved!.answer ? 'heard' : ''}>{m.question} — <b>{m.resolved!.text}</b>{mine ? (mine.option === m.resolved!.answer ? ' · you guessed' : ' · missed') : ''}</li> })}
                </ul>
              </>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
