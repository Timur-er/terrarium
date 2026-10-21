import { useEffect, useMemo, useRef, useState } from 'react'
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force'
import { useStore } from '../store'
import { roleLabel } from '../sim/text'

interface N extends SimulationNodeDatum { id: string; name: string; color: string; role: string; family: string; deg: number }
interface L extends SimulationLinkDatum<N> { v: number; family: boolean; debt: number }

export function RelationsGraph() {
  const open = useStore(s => s.graphOpen)
  const setOpen = useStore(s => s.setGraphOpen)
  const world = useStore(s => s.world)
  const select = useStore(s => s.select)
  const focus = useStore(s => s.focus)
  const mode = useStore(s => s.mode)
  const graphLinks = useStore(s => s.graphLinks)
  const requestRelations = useStore(s => s.requestRelations)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<N[]>([])
  const [links, setLinks] = useState<L[]>([])
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => { if (open && mode === 'remote') requestRelations() }, [open, mode, requestRelations])
  const data = useMemo(() => {
    if (!open) return { nodes: [] as N[], links: [] as L[] }
    const people = world.chars.filter(c => c.alive && !c.left)
    const ns: N[] = people.map(c => ({ id: c.id, name: c.name.nom, color: '#' + c.color.toString(16).padStart(6, '0'), role: roleLabel(c), family: c.family, deg: 0 }))
    const ls: L[] = []
    if (mode === 'remote' && graphLinks) {
      for (const l of graphLinks) { if (!ns.some(n => n.id === l.a) || !ns.some(n => n.id === l.b)) continue; ls.push({ source: l.a, target: l.b, v: l.v, family: l.family, debt: l.debt }); ns.find(n => n.id === l.a)!.deg++; ns.find(n => n.id === l.b)!.deg++ }
      return { nodes: ns, links: ls }
    }
    const seen = new Set<string>()
    for (const a of people) for (const b of people) {
      if (a.id >= b.id) continue
      const ra = a.relations[b.id], rb = b.relations[a.id]
      if (!ra || !rb) continue
      const v = (ra.liking + rb.liking) / 2
      const fam = ra.family
      const debt = ra.debt || rb.debt
      if (fam || Math.abs(v) > 0.28 || debt) {
        const k = a.id + b.id
        if (seen.has(k)) continue
        seen.add(k)
        ls.push({ source: a.id, target: b.id, v, family: fam, debt })
        ns.find(n => n.id === a.id)!.deg++; ns.find(n => n.id === b.id)!.deg++
      }
    }
    return { nodes: ns, links: ls }
  }, [open, world, mode, graphLinks])

  useEffect(() => {
    if (!open) return
    const el = wrapRef.current
    const w = el?.clientWidth ?? 800, h = el?.clientHeight ?? 560
    const ns = data.nodes.map(n => ({ ...n }))
    const ls = data.links.map(l => ({ ...l }))
    const sim = forceSimulation<N>(ns)
      .force('link', forceLink<N, L>(ls).id(d => d.id).distance(l => l.family ? 54 : l.v > 0 ? 105 : 150).strength(l => l.family ? 0.8 : 0.3))
      .force('charge', forceManyBody().strength(-240).distanceMax(260))
      .force('center', forceCenter(w / 2, h / 2))
      .force('x', forceX(w / 2).strength(0.05))
      .force('y', forceY(h / 2).strength(0.08))
      .force('collide', forceCollide(26))
      .stop()
    sim.tick(200)
    const pad = 40
    for (const n of ns) { n.x = Math.max(pad, Math.min(w - pad, n.x ?? w / 2)); n.y = Math.max(pad, Math.min(h - pad, n.y ?? h / 2)) }
    setNodes([...ns]); setLinks([...ls])
    sim.alpha(0.15).alphaDecay(0.03).on('tick', () => { setNodes([...ns]); setLinks([...ls]) }).restart()
    return () => { sim.stop() }
  }, [open, data])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const hi = hover ? new Set(links.filter(l => (l.source as N).id === hover || (l.target as N).id === hover).flatMap(l => [(l.source as N).id, (l.target as N).id])) : null

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Colony relations</h2>
          <p>teal threads — liking, red — enmity, amber — family, dashed — debt</p>
          <button className="x" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="graph-wrap" ref={wrapRef}>
          <svg className="graph-svg">
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            {links.map((l, i) => {
              const s = l.source as N, t = l.target as N
              if (s.x === undefined || t.x === undefined) return null
              const dim = hi && !(hi.has(s.id) && hi.has(t.id) && (s.id === hover || t.id === hover))
              const color = l.family ? '#ffd98a' : l.v > 0 ? '#7fd4c1' : '#ff5a36'
              return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={color} strokeWidth={l.family ? 1.4 : 0.8 + Math.abs(l.v) * 2.2} strokeOpacity={dim ? 0.08 : l.family ? 0.55 : 0.35 + Math.abs(l.v) * 0.5} strokeDasharray={l.debt ? '4 3' : undefined} />
            })}
            {nodes.map(n => {
              if (n.x === undefined) return null
              const dim = hi && !hi.has(n.id) && n.id !== hover
              const r = 7 + Math.min(8, n.deg * 1.2)
              return (
                <g key={n.id} className="gnode" transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.25 : 1}
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                  onClick={() => { select(n.id); focus(n.id); setOpen(false) }}>
                  <circle r={r} fill={n.color} filter={hover === n.id ? 'url(#glow)' : undefined} style={{ filter: 'sepia(1) saturate(1.6) hue-rotate(-12deg)' }} />
                  <text y={r + 12} textAnchor="middle">{n.name}</text>
                  {hover === n.id && <text y={r + 24} textAnchor="middle" style={{ fill: 'var(--ink-3)', fontSize: 10 }}>{n.role}</text>}
                </g>
              )
            })}
          </svg>
          <div className="graph-legend">
            <span><i style={{ background: '#7fd4c1' }} />liking</span>
            <span><i style={{ background: '#ff5a36' }} />enmity</span>
            <span><i style={{ background: '#ffd98a' }} />family</span>
            <span><i style={{ background: 'repeating-linear-gradient(90deg,#ffd98a 0 4px,transparent 4px 7px)' }} />debt</span>
            <span style={{ marginLeft: 10 }}>{nodeById.size} residents · {links.length} links</span>
          </div>
        </div>
      </div>
    </div>
  )
}
