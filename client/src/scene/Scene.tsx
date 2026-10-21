import { useEffect, useRef } from 'react'
import { useStore, SPEED_MS } from '../store'
import { Renderer } from './renderer'
import { roleLabel } from '../sim/text'

export function Scene() {
  const hostRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const rendRef = useRef<Renderer | null>(null)
  const world = useStore(s => s.world)
  const selected = useStore(s => s.selected)
  const focusReq = useStore(s => s.focusReq)
  const pendingCard = useStore(s => s.pendingCard)
  const regionView = useStore(s => s.regionView)

  useEffect(() => {
    const host = hostRef.current!
    const r = new Renderer(host, world, {
      onSelect: id => useStore.getState().select(id),
      onHover: (id, x, y) => {
        const tip = tipRef.current!
        if (!id) { tip.classList.remove('on'); return }
        const c = world.chars.find(z => z.id === id)
        if (!c) return
        tip.innerHTML = `<b>${c.name.nom}</b><span>${roleLabel(c)}, ${c.age} · ${c.activity.label}</span>`
        tip.style.transform = `translate(${x}px, ${y - 30}px) translate(-50%, -100%)`
        tip.classList.add('on')
      },
    }, () => { const s = useStore.getState(); return { lastTickAt: s.lastTickAt, tickMs: SPEED_MS[s.speed] || 500 } })
    rendRef.current = r
    ;(window as unknown as { __renderer: Renderer }).__renderer = r
    r.setRegion(useStore.getState().regionView)
    r.init()
    return () => { r.destroy(); rendRef.current = null }
  }, [world])

  useEffect(() => { if (rendRef.current) rendRef.current.selected = selected }, [selected])
  useEffect(() => { if (focusReq && rendRef.current) rendRef.current.focusOn(focusReq.id) }, [focusReq])
  useEffect(() => { rendRef.current?.setRegion(regionView) }, [regionView])

  return (
    <div className={`scene ${pendingCard ? 'targeting' : ''}`}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="scene-vignette" />
      <div className="scene-frame" />
      <div ref={tipRef} className="hover-tip" />
      <div className="map-controls">
        <button title="Zoom in" onClick={() => rendRef.current?.zoomBy(1.3)}>+</button>
        <button title="Zoom out" onClick={() => rendRef.current?.zoomBy(1 / 1.3)}>−</button>
        <button title="Whole colony" onClick={() => rendRef.current?.fitView()}>⌂</button>
        <button title="Rotate (or right mouse button)" onClick={() => rendRef.current?.rotateBy(Math.PI / 8)}>↻</button>
        <button title="Rotate" onClick={() => rendRef.current?.rotateBy(-Math.PI / 8)}>↺</button>
        <button title="Style: mosaic / colony" onClick={() => { const r = rendRef.current; if (r) r.setMosaic(!r.mosaicOn) }}>▦</button>
      </div>
    </div>
  )
}
