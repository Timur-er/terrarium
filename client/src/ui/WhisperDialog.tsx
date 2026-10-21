import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { WHISPERS } from '../sim/cards'
import { roleLabel } from '../sim/text'

export function WhisperDialog() {
  const open = useStore(s => s.whisperOpen)
  const close = useStore(s => s.closeWhisper)
  const whisperFor = useStore(s => s.whisperFor)
  const world = useStore(s => s.world)
  const whisper = useStore(s => s.whisper)
  const select = useStore(s => s.select)
  const [who, setWho] = useState<string | null>(null)
  const [what, setWhat] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [result, setResult] = useState<{ accepted: boolean; text: string; name: string } | null>(null)

  useEffect(() => { if (open) { setWho(whisperFor); setWhat(null); setTarget(null); setResult(null) } }, [open, whisperFor])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const people = useMemo(() => world.chars.filter(c => c.alive && !c.left).sort((a, b) => a.name.nom.localeCompare(b.name.nom, 'en')), [world, open])
  if (!open) return null
  const c = people.find(p => p.id === who)
  const def = WHISPERS.find(w => w.id === what)
  const t = people.find(p => p.id === target)
  const preview = def ? def.text.replace('{dat}', t?.name.dat ?? '…').replace('{ins}', t?.name.ins ?? '…').replace('{gen}', t?.name.gen ?? '…').replace('{acc}', t?.name.acc ?? '…') : null
  const ready = c && def && (!def.needsTarget || t)

  const send = async () => {
    if (!ready) return
    const r = await Promise.resolve(whisper(c!.id, def!.id, def!.needsTarget ? t!.id : undefined))
    setResult({ ...r, name: c!.name.nom })
    select(c!.id)
  }

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Whisper</h2>
          <p>The goal lands in the colonist's head. Whether it takes depends on character.</p>
          <button className="x" onClick={close}>×</button>
        </div>
        {result ? (
          <div className={`wh-result ${result.accepted ? 'yes' : 'no'}`}>
            {result.accepted ? `${result.name} takes the thought to heart: «${result.text}».` : `${result.name} brushes it off: «${result.text}» — not their style.`}
            <small>{result.accepted ? 'Watch the chronicle — this may take a while.' : 'The goal stayed, but half-heartedly. Try someone else.'}</small>
            <div style={{ marginTop: 18 }}><button className="sbtn amber" onClick={close}>Close</button></div>
          </div>
        ) : (
          <>
            <div className="modal-body">
              <div className="wh-grid" style={{ gridTemplateColumns: def?.needsTarget ? '1fr 1fr 1fr' : '1fr 1fr' }}>
                <div className="wh-col">
                  <h4>Who</h4>
                  <div className="wh-list">
                    {people.map(p => <button key={p.id} className={`wh-item ${who === p.id ? 'on' : ''}`} onClick={() => setWho(p.id)}><span className="ic" style={{ color: '#' + p.color.toString(16).padStart(6, '0') }}>●</span><span>{p.name.nom}<small>{roleLabel(p)}, {p.age}</small></span></button>)}
                  </div>
                </div>
                <div className="wh-col">
                  <h4>What</h4>
                  <div className="wh-list">
                    {WHISPERS.map(w => <button key={w.id} className={`wh-item ${what === w.id ? 'on' : ''}`} onClick={() => { setWhat(w.id); if (!w.needsTarget) setTarget(null) }}><span className="ic">{w.icon}</span><span>{w.text.replace(/\{\w+\}/, '…')}{w.needsTarget && <small>needs a second resident</small>}</span></button>)}
                  </div>
                </div>
                {def?.needsTarget && <div className="wh-col">
                  <h4>About whom</h4>
                  <div className="wh-list">
                    {people.filter(p => p.id !== who).map(p => <button key={p.id} className={`wh-item ${target === p.id ? 'on' : ''}`} onClick={() => setTarget(p.id)}><span className="ic" style={{ color: '#' + p.color.toString(16).padStart(6, '0') }}>●</span><span>{p.name.nom}<small>{roleLabel(p)}</small></span></button>)}
                  </div>
                </div>}
              </div>
            </div>
            <div className="wh-foot">
              <div className="wh-preview">{c ? <><b>{c.name.nom}</b>, {preview ? `you should ${preview}` : 'what are you thinking about?'}</> : 'Pick a colonist…'}</div>
              <button className="sbtn amber" disabled={!ready} style={{ opacity: ready ? 1 : 0.4 }} onClick={send}>[ whisper ]</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
