import { useEffect } from 'react'
import { Scene } from './scene/Scene'
import { TopBar } from './ui/TopBar'
import { Chronicle } from './ui/Chronicle'
import { CharacterPanel } from './ui/CharacterPanel'
import { EventDeck } from './ui/EventDeck'
import { WhisperDialog } from './ui/WhisperDialog'
import { RelationsGraph } from './ui/RelationsGraph'
import { ExperimentDialog } from './ui/ExperimentDialog'
import { PlayersDialog } from './ui/PlayersDialog'
import { RegionDialog } from './ui/RegionDialog'
import { VotePanel } from './ui/VotePanel'
import { Toast, EventStrip, Intro } from './ui/Overlays'
import { useStore, startLoop } from './store'

export default function App() {
  useEffect(() => {
    startLoop()
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); useStore.getState().togglePause() }
      if (e.key === '1') useStore.getState().setSpeed(1)
      if (e.key === '2') useStore.getState().setSpeed(3)
      if (e.key === '3') useStore.getState().setSpeed(10)
      if (e.key === '4') useStore.getState().setSpeed(30)
      if (e.key === 'Escape') { useStore.getState().setPendingCard(null); useStore.getState().select(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="stage">
        <div className="scene-wrap">
          <Scene />
          <EventStrip />
          <VotePanel />
          <EventDeck />
        </div>
        <aside className="side">
          <CharacterPanel />
          <Chronicle />
        </aside>
      </div>
      <WhisperDialog />
      <RelationsGraph />
      <ExperimentDialog />
      <PlayersDialog />
      <RegionDialog />
      <Toast />
      <Intro />
      <div className="grain" />
    </div>
  )
}
