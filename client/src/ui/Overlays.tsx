import { useState } from 'react'
import { useStore } from '../store'

export function Toast() {
  const toast = useStore(s => s.toast)
  if (!toast) return null
  return <div className="toast" key={toast.id}>{toast.icon && <span style={{ fontSize: 20 }}>{toast.icon}</span>}{toast.text}</div>
}

export function EventStrip() {
  const world = useStore(s => s.world)
  useStore(s => s.version)
  if (!world.events.length) return null
  return (
    <div className="event-strip">
      {world.events.map(e => {
        const total = e.id === 'drought' ? 1440 * 3 : e.id === 'plague' ? 1440 * 2 : e.id === 'wolves' ? 600 : e.id === 'feast' ? 240 : 90
        const left = Math.max(0, e.until - world.t)
        return <div className="event-chip" key={e.id}><span>{e.icon}</span><span>{e.name}</span><span className="bar"><i style={{ width: `${(left / total) * 100}%` }} /></span></div>
      })}
    </div>
  )
}

export function Intro() {
  const [open, setOpen] = useState(true)
  const setSpeed = useStore(s => s.setSpeed)
  if (!open) return null
  return (
    <div className="intro">
      <div className="intro-card">
        <h1>Terr<em>a</em>rium</h1>
        <div className="sub">tracking station 07 · dome «Terrarium»</div>
        <div className="boot"><span>link to the dome established</span><span>colonists in view: 40+</span><span>non-interference protocol: partially disabled</span><span>observer mode active</span></div>
        <p>Nobody here is waiting for your orders. Forty colonists under the dome work, quarrel, gossip, fall in love and hold grudges. You are an observer with a deck of events and the right to whisper.</p>
        <div className="rules">
          <div className="rule"><b>Watch</b><span>Click a colonist to see their thoughts, their memory and who they are at odds with.</span></div>
          <div className="rule"><b>Deal</b><span>A fire, a rumor, a storm, a festival. The dome answers — not always the way you expect.</span></div>
          <div className="rule"><b>Whisper</b><span>Put a goal into one head. Whether it takes depends on character.</span></div>
        </div>
        <button className="go" onClick={() => { setOpen(false); setSpeed(1) }}>enter</button>
      </div>
    </div>
  )
}
