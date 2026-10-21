import { useStore } from '../store'
import { DECK } from '../sim/cards'
import { CARD_COST } from '../sim/protocol'

const TONES: Record<string, string> = {
  fire: 'rgba(255,120,40,0.45)', gold: 'rgba(240,200,80,0.45)', cold: 'rgba(120,170,220,0.4)', warm: 'rgba(143,184,119,0.45)', dark: 'rgba(120,100,160,0.4)', rumor: 'rgba(181,146,212,0.45)',
}

export function EventDeck() {
  const world = useStore(s => s.world)
  useStore(s => s.version)
  const play = useStore(s => s.play)
  const pendingCard = useStore(s => s.pendingCard)
  const setPendingCard = useStore(s => s.setPendingCard)
  const selected = useStore(s => s.selected)
  const player = useStore(s => s.player)
  const n = DECK.length

  return (
    <div className="deck">
      <div className="deck-label">event deck — deal something to the colony</div>
      {pendingCard && <div className="targeting-hint">Pick a colonist on the map <button onClick={() => setPendingCard(null)}>cancel</button></div>}
      <div className="deck-hand">
        {DECK.map((card, i) => {
          const cd = world.cooldowns[card.id]
          const cooling = cd !== undefined && cd > world.t
          const angle = (i - (n - 1) / 2) * 3.2
          const lift = Math.abs(i - (n - 1) / 2) * 4
          const onClick = () => {
            if (cooling) return
            if (card.needsTarget) {
              if (pendingCard === card.id) { setPendingCard(null); return }
              if (selected) { play(card.id, selected); return }
              setPendingCard(card.id); return
            }
            play(card.id)
          }
          const minutes = cooling ? cd - world.t : 0
          const cdLabel = minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`
          return (
            <div
              key={card.id}
              className={`card ${cooling ? 'cooling' : ''} ${pendingCard === card.id ? 'armed' : ''} ${card.needsTarget ? 'needs-target' : ''}`}
              style={{ transform: `rotate(${angle}deg) translateY(${lift}px)`, ['--tone' as string]: TONES[card.tone] }}
              onClick={onClick}
              title={card.needsTarget && selected ? `Apply to the selected resident` : undefined}
            >
              {cooling && <span className="cd">{cdLabel}</span>}
              {player && !cooling && <span className={`cost ${player.influence < (CARD_COST[card.id] ?? 3) ? 'poor' : ''}`}>◈{CARD_COST[card.id] ?? 3}</span>}
              <div className="icon">{card.icon}</div>
              <div className="name">{card.name}</div>
              <div className="desc">{card.desc}{card.needsTarget ? ' Needs a colonist.' : ''}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
