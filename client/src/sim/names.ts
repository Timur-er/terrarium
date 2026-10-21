export type Sex = 'm' | 'f'
/**
 * English names carry no cases, but the engine was written against Russian case forms,
 * so every form is the same string: `name.nom` is the name, `name.gen` is used where a possessive
 * would be built as `${name.gen}'s` by the text helpers.
 */
export interface NameForms {
  nom: string; gen: string; dat: string; acc: string; ins: string; sex: Sex
}

const m = (n: string): NameForms => ({ nom: n, gen: n, dat: n, acc: n, ins: n, sex: 'm' })
const f = (n: string): NameForms => ({ nom: n, gen: n, dat: n, acc: n, ins: n, sex: 'f' })

export const MALE: NameForms[] = [
  'Peter', 'Ivan', 'Simon', 'Thomas', 'Zachary', 'Egor', 'Matthew', 'Theo', 'Luke', 'Sava', 'Nikita', 'Gregory',
  'Jacob', 'Damian', 'Cosmo', 'Fyodor', 'Ephraim', 'Prokhor', 'Daniel', 'Ignat', 'Makar', 'Anton', 'Boris', 'Victor',
  'Oscar', 'Felix', 'Hugo', 'Milo', 'Arthur', 'Lev', 'Tobias', 'Elias', 'Ruben', 'Jonas', 'Casper', 'Emil',
].map(m)

export const FEMALE: NameForms[] = [
  'Marfa', 'Anna', 'Dasha', 'Olena', 'Pelageya', 'Christina', 'Agatha', 'Sophia', 'Ksenia', 'Irina', 'Natalia', 'Vera',
  'Polina', 'Zoya', 'Stesha', 'Glafira', 'Ustinya', 'Avdotya', 'Praskovya', 'Lukerya', 'Domna', 'Matryona', 'Eudoxia', 'Nadia',
  'Mira', 'Lina', 'Nora', 'Ada', 'Iris', 'Juno', 'Maya', 'Tess',
].map(f)

/** Family surnames; `gen` is kept for the engine (used as "the <gen> module" and similar). */
export const FAMILIES: { name: string; gen: string }[] = [
  'Kuznetsov', 'Miller', 'Goncharov', 'Ryabov', 'Solovey', 'Kraynov', 'Lobanov', 'Dementiev',
  'Zykov', 'Pakhomov', 'Shiryaev', 'Bortnikov', 'Chagin', 'Volkov', 'Novak', 'Sokolov',
].map(n => ({ name: n, gen: n }))

export type RoleId =
  | 'smith' | 'baker' | 'merchant' | 'guard' | 'teacher' | 'priest' | 'farmer'
  | 'innkeeper' | 'miller' | 'elder' | 'healer' | 'carpenter' | 'hunter'
  | 'weaver' | 'child' | 'old' | 'vagrant' | 'stranger'

export interface RoleDef { id: RoleId; m: string; f: string; icon: string; workplace: string | null; color: number }

export const ROLES: Record<RoleId, RoleDef> = {
  smith: { id: 'smith', m: 'mechanic', f: 'mechanic', icon: '🔧', workplace: 'forge', color: 0x8c5a3c },
  baker: { id: 'baker', m: 'cook', f: 'cook', icon: '🍲', workplace: 'bakery', color: 0xd9b36b },
  merchant: { id: 'merchant', m: 'quartermaster', f: 'quartermaster', icon: '📦', workplace: 'market', color: 0x7c4f8c },
  guard: { id: 'guard', m: 'patrol officer', f: 'patrol officer', icon: '🛡️', workplace: 'guard', color: 0x4f6e8c },
  teacher: { id: 'teacher', m: 'teacher', f: 'teacher', icon: '📖', workplace: 'school', color: 0x5f8c7a },
  priest: { id: 'priest', m: 'chaplain', f: 'chaplain', icon: '🕯️', workplace: 'church', color: 0x2f2f3a },
  farmer: { id: 'farmer', m: 'agronomist', f: 'agronomist', icon: '🌱', workplace: 'fields', color: 0x7f9a4a },
  innkeeper: { id: 'innkeeper', m: 'bartender', f: 'bartender', icon: '🍸', workplace: 'tavern', color: 0xa86b3c },
  miller: { id: 'miller', m: 'power engineer', f: 'power engineer', icon: '⚡', workplace: 'mill', color: 0xb8a98a },
  elder: { id: 'elder', m: 'administrator', f: 'administrator', icon: '📋', workplace: 'square', color: 0x9a7a2f },
  healer: { id: 'healer', m: 'medic', f: 'medic', icon: '💊', workplace: 'forest', color: 0x4a7a5a },
  carpenter: { id: 'carpenter', m: 'rigger', f: 'rigger', icon: '🔩', workplace: 'square', color: 0xa8763c },
  hunter: { id: 'hunter', m: 'scout', f: 'scout', icon: '🔭', workplace: 'forest', color: 0x5a6a3a },
  weaver: { id: 'weaver', m: 'comms operator', f: 'comms operator', icon: '📡', workplace: 'home', color: 0xc07a8a },
  child: { id: 'child', m: 'boy', f: 'girl', icon: '🪁', workplace: 'school', color: 0xe0c48a },
  old: { id: 'old', m: 'veteran', f: 'veteran', icon: '🪑', workplace: 'square', color: 0x9a9a9a },
  vagrant: { id: 'vagrant', m: 'stowaway', f: 'stowaway', icon: '👣', workplace: 'square', color: 0x6a6a5a },
  stranger: { id: 'stranger', m: 'newcomer', f: 'newcomer', icon: '🧳', workplace: 'tavern', color: 0x3a5a7a },
}
