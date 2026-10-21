import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { VOTE_SECONDS } from '../sim/protocol'

/** The audience vote strip over the scene: options as chips, a burning fuse, the result for a few seconds after. */
export function VotePanel() {
  const vote = useStore(s => s.vote)
  const my = useStore(s => s.myVote)
  const cast = useStore(s => s.castVote)
  const offset = useStore(s => s.clockOffset)
  const player = useStore(s => s.player)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!vote) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t) }, [vote])
  if (!vote) return null
  const left = Math.max(0, vote.endsAt - (now + offset))
  const total = vote.options.reduce((s, o) => s + o.votes, 0)
  const done = !!vote.result
  return (
    <div className={`vote ${done ? 'done' : ''}`}>
      <div className="vote-head">
        <span className="vote-title">{done ? 'Viewers decided' : vote.question}</span>
        <span className="vote-meta">{done ? vote.result!.text : `${total} ${total === 1 ? 'vote' : 'votes'} · ${Math.ceil(left / 1000)} s`}</span>
      </div>
      {!done && <div className="vote-fuse"><i style={{ width: `${(left / (VOTE_SECONDS * 1000)) * 100}%` }} /></div>}
      {!done && (
        <div className="vote-options">
          {vote.options.map((o, i) => (
            <button key={o.id} className={`vote-opt ${my === i ? 'on' : ''}`} disabled={!player} onClick={() => cast(i)} title={!player ? 'introduce yourself to vote' : ''}>
              <span className="ic">{o.icon}</span><span>{o.label}</span><b>{o.votes}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
