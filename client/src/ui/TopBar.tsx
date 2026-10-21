import { useStore, type Speed } from '../store'
import { clock, dayOf, timeOfDayWord } from '../sim/text'

const SPEEDS: { s: Speed; label: string; title: string }[] = [
  { s: 1, label: '▶', title: 'Normal pace' },
  { s: 3, label: '▶▶', title: 'Faster' },
  { s: 10, label: '▶▶▶', title: 'Very fast' },
  { s: 30, label: '»»', title: 'Fast-forward' },
]

export function TopBar() {
  const world = useStore(s => s.world)
  useStore(s => s.version)
  const speed = useStore(s => s.speed)
  const setSpeed = useStore(s => s.setSpeed)
  const togglePause = useStore(s => s.togglePause)
  const setGraphOpen = useStore(s => s.setGraphOpen)
  const setRegionOpen = useStore(s => s.setRegionOpen)
  const openWhisper = useStore(s => s.openWhisper)
  const brainKind = useStore(s => s.brainKind)
  const setBrainKind = useStore(s => s.setBrainKind)
  const mode = useStore(s => s.mode)
  const connecting = useStore(s => s.connecting)
  const connect = useStore(s => s.connect)
  const disconnect = useStore(s => s.disconnect)
  const setExperimentOpen = useStore(s => s.setExperimentOpen)
  const setPlayersOpen = useStore(s => s.setPlayersOpen)
  const player = useStore(s => s.player)
  const cycleBrain = () => setBrainKind(brainKind === 'heuristic' ? 'random' : brainKind === 'random' ? 'remote' : 'heuristic')

  const people = world.chars.filter(c => c.alive && !c.left)
  const n = people.length || 1
  const joy = people.filter(c => c.mood.joy > 0.45).length / n
  const anger = people.filter(c => c.mood.anger > 0.35).length / n
  const fear = people.filter(c => c.mood.fear > 0.35).length / n
  const shame = people.filter(c => c.mood.shame > 0.3).length / n

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-title">Terr<em>a</em>rium</div>
        <div className="brand-sub">tracking station 07</div>
      </div>
      <div className="clock">
        <span>sol</span><b>{String(dayOf(world.t)).padStart(2, '0')}</b>
        <b>{clock(world.t)}</b>
        <span className="tod">{timeOfDayWord(world.t)}</span>
      </div>
      <div className="speed">
        <button className={`pause ${speed === 0 ? 'on' : ''}`} onClick={togglePause} title="Pause (space)">⏸</button>
        {SPEEDS.map(x => <button key={x.s} className={speed === x.s ? 'on' : ''} onClick={() => setSpeed(x.s)} title={x.title}>{x.label}</button>)}
      </div>
      <div className="spacer" />
      <div className="pulse" title={`joy ${Math.round(joy * 100)}% · anger ${Math.round(anger * 100)}% · fear ${Math.round(fear * 100)}% · shame ${Math.round(shame * 100)}%`}>
        <span>mood</span>
        <div className="pulse-bar">
          <i className="joy" style={{ width: `${joy * 100}%` }} />
          <i className="anger" style={{ width: `${anger * 100}%` }} />
          <i className="fear" style={{ width: `${fear * 100}%` }} />
          <i className="shame" style={{ width: `${shame * 100}%` }} />
        </div>
      </div>
      <div className="stat" title="Residents"><b>{people.length}</b>res.</div>
      <div className="stat" title="Living modules"><b>{world.buildings.filter(b => b.type === 'house' && !b.site).length}</b>modules</div>
      <div className="stat" title="Quarrels since start"><b>{world.stats.conflicts}</b>quarrels</div>
      <div className="stat" title="Rumors passed on"><b>{world.stats.rumors}</b>rumors</div>
      <button className="tbtn" onClick={() => (mode === 'remote' ? disconnect() : connect())} title="Where the world lives: in this tab or on the server (ws://localhost:8787)">{connecting ? 'world: …' : mode === 'remote' ? 'world: server' : 'world: local'}</button>
      <button className="tbtn" onClick={cycleBrain} title="Which brain makes the decisions: heuristic, dice or a remote service">brain: {brainKind === 'heuristic' ? 'heuristic' : brainKind === 'random' ? 'dice' : 'service'}</button>
      <button className="tbtn" onClick={() => setRegionOpen(true)} title="Region map: neighbouring domes, roads, who is on the road">[ dome: {world.domeName} ]</button>
      <button className="tbtn" onClick={() => setGraphOpen(true)}>[ relations ]</button>
      <button className="tbtn" onClick={() => setExperimentOpen(true)} title="Fork the world: two branches, compared after N sols">[ experiment ]</button>
      <button className="tbtn" onClick={() => setPlayersOpen(true)} title="Players, wards and bets">{player ? `◈ ${player.influence} · ${player.name}` : '[ players ]'}</button>
      <button className="tbtn amber" onClick={() => openWhisper()}>[ whisper ]</button>
    </header>
  )
}
