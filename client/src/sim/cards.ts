export interface EventCard {
  id: string
  name: string
  icon: string
  desc: string
  cooldown: number // game minutes
  needsTarget?: boolean
  tone: 'fire' | 'gold' | 'cold' | 'warm' | 'dark' | 'rumor'
}

export const DECK: EventCard[] = [
  { id: 'fire', name: 'Fire', icon: '🔥', desc: 'A random module catches fire. Neighbours run to put it out — or to watch.', cooldown: 600, tone: 'fire' },
  { id: 'gold', name: 'Windfall', icon: '💰', desc: 'Someone finds a container of credits. Envy will not be long in coming.', cooldown: 360, tone: 'gold' },
  { id: 'stranger', name: 'Stranger', icon: '🧳', desc: 'A person with no past walks in through the airlock. Nobody trusts them.', cooldown: 720, tone: 'dark' },
  { id: 'rumor', name: 'Rumor', icon: '🗣️', desc: 'Start a rumor about the chosen colonist.', cooldown: 180, needsTarget: true, tone: 'rumor' },
  { id: 'drought', name: 'Hydroponics Failure', icon: '🥀', desc: 'The beds die for three days. Rations get dearer, hunger grows faster.', cooldown: 1440, tone: 'fire' },
  { id: 'feast', name: 'Festival', icon: '🎉', desc: 'Everyone to the plaza. Joy, drink and old scores.', cooldown: 720, tone: 'warm' },
  { id: 'plague', name: 'Infection', icon: '🦠', desc: 'Several colonists fall ill. The medic is in demand.', cooldown: 1440, tone: 'cold' },
  { id: 'tax', name: 'Levy', icon: '📋', desc: 'The administrator collects a levy. Whoever cannot pay will be remembered.', cooldown: 720, tone: 'dark' },
  { id: 'wolves', name: 'Storm', icon: '🌪️', desc: 'A dust storm outside. The dome hums, fear drives people into their modules.', cooldown: 480, tone: 'cold' },
  { id: 'harvest', name: 'Harvest', icon: '🌾', desc: 'The hydroponics yield a harvest. Food aplenty, prices fall.', cooldown: 1440, tone: 'warm' },
  { id: 'letter', name: 'Message', icon: '📡', desc: 'The chosen colonist gets a message from Earth. Everyone will learn what it says.', cooldown: 360, needsTarget: true, tone: 'rumor' },
]

export interface WhisperDef {
  id: string
  text: string // with {target} placeholders ({dat}/{ins}/{gen}/{acc} all become the plain name)
  needsTarget?: boolean
  icon: string
}

export const WHISPERS: WhisperDef[] = [
  { id: 'revenge', text: 'get even with {dat}', needsTarget: true, icon: '🗡️' },
  { id: 'reconcile', text: 'make peace with {ins}', needsTarget: true, icon: '🕊️' },
  { id: 'court', text: "win {gen}'s heart", needsTarget: true, icon: '🌹' },
  { id: 'steal', text: 'rob {acc}', needsTarget: true, icon: '🤫' },
  { id: 'report', text: 'report {acc} to the patrol', needsTarget: true, icon: '📣' },
  { id: 'elder', text: 'become the administrator', icon: '👑' },
  { id: 'leave', text: 'leave the colony', icon: '🛤️' },
  { id: 'rich', text: 'get rich at any cost', icon: '🪙' },
  { id: 'help', text: 'help anyone in trouble', icon: '🤲' },
  { id: 'house', text: 'build your own module', icon: '🏠' },
  { id: 'found', text: 'found a new dome', icon: '◍' },
]

export const RUMOR_TEMPLATES: ((nom: string, gen: string, acc: string, m: boolean) => string)[] = [
  (nom, _g, _a, _m) => `${nom} went to the reactor at night with a container`,
  (nom, _g, _a, _m) => `${nom} hid other people's credits in the ventilation`,
  (nom, _g, _a, _m) => `${nom} saw the fire and never called for help`,
  (nom, _g, _a, _m) => `${nom} said things about the administrator not worth repeating`,
  (nom, _g, _a, m) => `${nom} promised to marry back on Earth, and ${m ? 'he' : 'she'} keeps quiet about it here`,
]
