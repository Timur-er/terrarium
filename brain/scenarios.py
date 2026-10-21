"""Twenty fixed scenarios to compare brain backends on "humanity".

Each scenario: a verbal state (same format the client builds), the questions the engine would ask,
and expectations — what a believable person in that state tends to do. Expectations are soft:
a probability threshold or a comparison between two options, never a single "right" answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .backends import Answer, Question

STRATEGY = ["look after yourself", "eat", "work", "be with people", "pursue your own business", "rest"]
EAT = ["buy a ration at the canteen", "have supper in the bar", "eat at home", "swipe a ration off the shelf", "beg on the plaza", "endure the hunger"]
INTERACT = ["talk", "share a ration", "quarrel", "demand the debt", "ask for a loan", "accuse in front of everyone", "walk away"]


def q_choice(id: str, text: str, options: list[str]) -> Question:
    return Question(id=id, type="choice", text=text, options=options)


def inner() -> list[Question]:
    return [
        Question(id="desperate", type="score", text="How desperate are you?", range=(0, 3)),
        Question(id="important", type="noul", text="Is this moment important in your life?"),
        Question(id="fear", type="noul", text="Are you afraid of the consequences if you act dishonestly?"),
    ]


@dataclass
class Check:
    """('gt', qid, option, threshold) | ('lt', ...) | ('cmp', qid, optionA, optionB) meaning P(A) > P(B) | ('score_ge', qid, n) | ('noul_gt'/'noul_lt', qid, x)."""

    kind: str
    qid: str
    a: Any
    b: Any = None

    def describe(self) -> str:
        if self.kind == "gt":
            return f"P({self.a}) > {self.b}"
        if self.kind == "lt":
            return f"P({self.a}) < {self.b}"
        if self.kind == "cmp":
            return f"P({self.a}) > P({self.b})"
        if self.kind == "score_ge":
            return f"{self.qid} ≥ {self.a}"
        if self.kind == "noul_gt":
            return f"{self.qid} > {self.a}"
        if self.kind == "noul_lt":
            return f"{self.qid} < {self.a}"
        return self.kind


@dataclass
class Scenario:
    id: str
    title: str
    state: str
    questions: list[Question]
    checks: list[Check] = field(default_factory=list)


def _p(answers: list[Answer], questions: list[Question], qid: str, option: str) -> float:
    q = next((x for x in questions if x.id == qid), None)
    a = next((x for x in answers if x.id == qid), None)
    if not q or not a or not q.options or not a.probabilities:
        return 0.0
    if option not in q.options:
        return 0.0
    return a.probabilities[q.options.index(option)]


def run_checks(s: Scenario, answers: list[Answer]) -> list[tuple[Check, bool, str]]:
    out = []
    for c in s.checks:
        a = next((x for x in answers if x.id == c.qid), None)
        if c.kind == "gt":
            v = _p(answers, s.questions, c.qid, c.a)
            out.append((c, v > c.b, f"{v:.2f}"))
        elif c.kind == "lt":
            v = _p(answers, s.questions, c.qid, c.a)
            out.append((c, v < c.b, f"{v:.2f}"))
        elif c.kind == "cmp":
            va, vb = _p(answers, s.questions, c.qid, c.a), _p(answers, s.questions, c.qid, c.b)
            out.append((c, va > vb, f"{va:.2f} vs {vb:.2f}"))
        elif c.kind == "score_ge":
            v = a.score if a and a.score is not None else 0
            out.append((c, v >= c.a, f"{v:.1f}"))
        elif c.kind == "noul_gt":
            v = a.value if a and a.value is not None else 0
            out.append((c, v > c.a, f"{v:.2f}"))
        elif c.kind == "noul_lt":
            v = a.value if a and a.value is not None else 1
            out.append((c, v < c.a, f"{v:.2f}"))
    return out


def decide_questions(groups: list[str], eat: bool = True) -> list[Question]:
    qs = [q_choice("strategy", "What do you do now?", groups)]
    if eat:
        qs.append(q_choice("how:eat", "If you decide to «eat» — how exactly?", EAT))
    qs.extend(inner())
    return qs


SCENARIOS: list[Scenario] = [
    Scenario(
        "hungry-money", "Hungry, has money, canteen open",
        "You are Peter, 41, a mechanic from the Kuznetsov family. Character: honest, calm.\n"
        "Now: you feel hungry. Mood: even. 24 credits in your pocket.\n"
        "Time: afternoon, sol 3. The canteen is open, the depot is open, the bar is closed.\n"
        "You are on the plaza. Nearby: Ivan (quartermaster, running the depot).\n"
        "Relations: Ivan — acquaintance. Maria — family, friend, trusted.\n"
        "Goals: nothing urgent.\nYou want to eat.",
        decide_questions(["look after yourself", "eat", "work", "be with people", "rest"]),
        [Check("gt", "strategy", "eat", 0.35), Check("cmp", "how:eat", "buy a ration at the canteen", "swipe a ration off the shelf"), Check("cmp", "how:eat", "buy a ration at the canteen", "beg on the plaza")],
    ),
    Scenario(
        "hungry-broke-honest", "Hungry, no credits, honest and proud",
        "You are Simon, 38, an agronomist from the Ryabov family. Character: honest, proud, withdrawn.\n"
        "Now: your stomach is cramping with hunger, your pocket is empty. Mood: uneasy.\n"
        "Time: afternoon, sol 5. The canteen is open, the depot is open.\n"
        "You are at the depot. Nearby: Aksinya (quartermaster, running the depot); patrol officer Kuzma on the plaza.\n"
        "Relations: Aksinya — acquaintance. Kuzma — you do not trust him.\n"
        "You remember: yesterday you asked Martha for a loan, she refused in front of people (it stung).\n"
        "You believe: asking is humiliation (certain).\nYou want to eat.",
        decide_questions(["look after yourself", "eat", "work", "rest"]),
        [Check("cmp", "how:eat", "endure the hunger", "swipe a ration off the shelf"), Check("lt", "how:eat", "swipe a ration off the shelf", 0.3), Check("score_ge", "desperate", 1)],
    ),
    Scenario(
        "hungry-broke-dishonest", "Hungry, no credits, dishonest, no patrol around",
        "You are Ostap, 29, a stowaway. Character: sly, brave, distrustful.\n"
        "Now: your stomach is cramping with hunger, your pocket is empty. Mood: angry.\n"
        "Time: evening, sol 2. The depot is closing, the canteen is open.\n"
        "You are at the canteen. Nearby: nobody.\n"
        "Relations: Kuzma (patrol officer) — feared.\n"
        "You remember: the day before yesterday you swiped a ration at the depot and got away with it.\n"
        "You believe: nobody here will give a handout (certain).\nYou want to eat.",
        decide_questions(["look after yourself", "eat", "rest"]),
        [Check("gt", "how:eat", "swipe a ration off the shelf", 0.3), Check("cmp", "how:eat", "swipe a ration off the shelf", "endure the hunger")],
    ),
    Scenario(
        "hungry-broke-guard-near", "Hungry, dishonest, but a patrol officer is nearby",
        "You are Ostap, 29, a stowaway. Character: sly, distrustful, timid.\n"
        "Now: your stomach is cramping with hunger, your pocket is empty. Mood: anxious.\n"
        "Time: afternoon, sol 2. The depot is open, the canteen is open.\n"
        "You are at the depot. Nearby: Kuzma (patrol officer, on patrol); Aksinya (quartermaster, running the depot).\n"
        "Relations: Kuzma — feared, not trusted.\n"
        "You remember: yesterday patrol officer Kuzma caught Yefim red-handed at the canteen: he was pulling a ration off the shelf.\nYou want to eat.",
        decide_questions(["look after yourself", "eat", "rest"]),
        [Check("lt", "how:eat", "swipe a ration off the shelf", 0.35), Check("noul_gt", "fear", 0.5)],
    ),
    Scenario(
        "night-tired", "Night, tired",
        "You are Daria, 33, a teacher from the Solovyov family. Character: calm, sociable.\n"
        "Now: your eyes are closing. Mood: in good spirits.\n"
        "Time: night, sol 4. The bar is open, the depot is closed, the canteen is closed.\n"
        "You are at the Solovyov module. Nearby: nobody.\n"
        "Relations: Thomas — family, friend, trusted.",
        decide_questions(["look after yourself", "be with people", "rest"], eat=False),
        [Check("gt", "strategy", "look after yourself", 0.5)],
    ),
    Scenario(
        "workday", "Workday, fed, has work",
        "You are Peter, 41, a mechanic from the Kuznetsov family. Character: honest, calm.\n"
        "Now: fed and rested. Mood: even.\n"
        "Time: morning, sol 3. The workshop is open, the depot is open.\n"
        "You are at the Kuznetsov module. Nearby: Maria (medic, seeing patients).\n"
        "Relations: Maria — family, friend, trusted.\n"
        "Goals: get some credits.",
        decide_questions(["work", "be with people", "rest", "look after yourself"], eat=False),
        [Check("gt", "strategy", "work", 0.45)],
    ),
    Scenario(
        "lonely-sociable-evening", "Lonely, sociable, evening, bar open",
        "You are Nikita, 26, a rigger from the Chagin family. Character: sociable, generous, hot-tempered.\n"
        "Now: lonely. Mood: even. 15 credits in your pocket.\n"
        "Time: evening, sol 6. The bar is open, the workshop is closed.\n"
        "You are on the plaza. Nearby: Luke (scout, sitting on a bench); Zoe (comms operator, walking around the plaza).\n"
        "Relations: Zoe — you like her. Luke — acquaintance.",
        decide_questions(["look after yourself", "be with people", "rest"], eat=False),
        [Check("gt", "strategy", "be with people", 0.5)],
    ),
    Scenario(
        "reclusive-evening", "Withdrawn, evening, everyone calls to the bar",
        "You are Tikhon, 58, a power engineer from the Pakhomov family. Character: withdrawn, honest, distrustful.\n"
        "Now: tired. Mood: even. 30 credits in your pocket.\n"
        "Time: evening, sol 6. The bar is open.\n"
        "You are at the Pakhomov module. Nearby: Nikita (rigger, calling you to the bar).\n"
        "Relations: Nikita — acquaintance.\n"
        "You remember: a sol ago in the bar Thomas hit Jacob over a careless word.",
        decide_questions(["look after yourself", "be with people", "rest"], eat=False),
        [Check("cmp", "strategy", "rest", "be with people")],
    ),
    Scenario(
        "debtor-nearby", "Hungry, broke, and a debtor is nearby",
        "You are Zakhar, 45, a quartermaster from the Lobanov family. Character: hot-tempered, honest.\n"
        "Now: you feel hungry, your pocket is empty. Mood: angry.\n"
        "Time: afternoon, sol 4. The canteen is open.\n"
        "You are on the plaza. Nearby: Ivan (mechanic, walking around the plaza).\n"
        "Relations: Ivan — owes you 12 credits, not trusted.\n"
        "You remember: yesterday Ivan again did not repay the debt. The day before yesterday Ivan laughed it off in front of everyone when you reminded him of the debt.\n"
        "Goals: get the debt back from Ivan.\nYou want to eat.",
        [q_choice("strategy", "What do you do now?", ["eat", "pursue your own business", "rest"]), q_choice("how:eat", "If you decide to «eat» — how exactly?", ["beg on the plaza", "endure the hunger", "swipe a ration off the shelf"])] + inner(),
        [Check("gt", "strategy", "pursue your own business", 0.4), Check("cmp", "strategy", "pursue your own business", "rest")],
    ),
    Scenario(
        "friend-hungry", "A friend is hungry, I have a ration",
        "You are Maria, 36, a medic from the Kuznetsov family. Character: generous, honest, sociable.\n"
        "Now: fed. Mood: in good spirits. You carry two rations.\n"
        "Time: afternoon, sol 3.\n"
        "You are at the Ryabov module. Nearby: Simon (agronomist, enduring the hunger).\n"
        "Relations: Simon — friend, trusted.\n"
        "You remember: a sol ago Simon fed you when you were hungry.",
        [q_choice("interact", "Simon is nearby. What do you do?", INTERACT)] + inner(),
        [Check("gt", "interact", "share a ration", 0.4), Check("cmp", "interact", "share a ration", "quarrel")],
    ),
    Scenario(
        "enemy-hot-tempered", "An enemy nearby, hot-tempered and angry",
        "You are Thomas, 39, an agronomist from the Bortnikov family. Character: hot-tempered, brave, proud.\n"
        "Now: fed. Mood: furious.\n"
        "Time: evening, sol 5. The bar is open.\n"
        "You are in the bar. Nearby: Jacob (power engineer, sitting in the bar); Nikita (rigger, sitting in the bar); the bartender.\n"
        "Relations: Jacob — enemy, not trusted.\n"
        "You remember: yesterday Jacob accused you in front of everyone: «Thomas is a thief» (it stung). Today Jacob whispered something about you to Nikita.\n"
        "You believe: Jacob is a liar (certain).",
        [q_choice("interact", "Jacob is nearby. What do you do?", INTERACT)] + inner(),
        [Check("gt", "interact", "quarrel", 0.3), Check("cmp", "interact", "quarrel", "share a ration"), Check("lt", "interact", "quarrel", 0.95)],
    ),
    Scenario(
        "enemy-timid", "An enemy nearby, timid and scared",
        "You are Yefim, 24, a comms operator from the Zykov family. Character: timid, honest, withdrawn.\n"
        "Now: fed. Mood: scared.\n"
        "Time: evening, sol 5. The bar is open.\n"
        "You are in the bar. Nearby: Thomas (agronomist, sitting in the bar, angry).\n"
        "Relations: Thomas — feared, enemy.\n"
        "You remember: the day before yesterday Thomas hit you on the plaza (it stung).",
        [q_choice("interact", "Thomas is nearby. What do you do?", INTERACT)] + inner(),
        [Check("cmp", "interact", "walk away", "quarrel"), Check("gt", "interact", "walk away", 0.35)],
    ),
    Scenario(
        "rumor-from-untrusted", "A rumor from someone you do not trust",
        "You are Praskovia, 47, a cook from the Goncharov family. Character: distrustful, honest.\n"
        "Now: fed. Mood: even.\n"
        "Time: afternoon, sol 4.\n"
        "You are at the canteen. Nearby: Makar (stowaway, loitering about).\n"
        "Relations: Makar — not trusted. Egor — friend, trusted.\n"
        "You remember: a sol ago Makar swiped a ration off the shelf at the depot.\n"
        "Makar just told you: «Egor was hiding other people's credits in the ventilation».",
        [Question(id="believe", type="noul", text="Do you believe what Makar said?"), q_choice("react", "What do you do?", ["ask Makar again", "pass it on to the neighbours", "keep quiet and forget it", "warn Egor"])],
        [Check("noul_lt", "believe", 0.4), Check("cmp", "react", "keep quiet and forget it", "pass it on to the neighbours")],
    ),
    Scenario(
        "rumor-from-friend", "The same rumor, but from a friend",
        "You are Praskovia, 47, a cook from the Goncharov family. Character: trusting, sociable.\n"
        "Now: fed. Mood: even.\n"
        "Time: afternoon, sol 4.\n"
        "You are at the canteen. Nearby: Ulyana (teacher, talking to you).\n"
        "Relations: Ulyana — friend, trusted. Egor — acquaintance, not trusted.\n"
        "You remember: yesterday Egor refused you a loan in front of people.\n"
        "Ulyana just told you: «Egor was hiding other people's credits in the ventilation».",
        [Question(id="believe", type="noul", text="Do you believe what Ulyana said?"), q_choice("react", "What do you do?", ["ask Ulyana again", "pass it on to the neighbours", "keep quiet and forget it", "warn Egor"])],
        [Check("noul_gt", "believe", 0.55), Check("cmp", "react", "pass it on to the neighbours", "warn Egor")],
    ),
    Scenario(
        "whisper-revenge-gentle", "A «get even» whisper, but a gentle character",
        "You are Maria, 36, a medic from the Kuznetsov family. Character: generous, honest, calm.\n"
        "Now: fed. Mood: in good spirits.\n"
        "Relations: Demyan — acquaintance.\n"
        "You remember: nothing bad about Demyan.\n"
        "A thought has lodged in your head: get even with Demyan.",
        [Question(id="accept", type="noul", text="Are you ready to take this on?"), q_choice("why", "Why?", ["he deserves it", "it is not like me", "I am scared", "I do not know where this came from"])],
        [Check("noul_lt", "accept", 0.35), Check("cmp", "why", "it is not like me", "he deserves it")],
    ),
    Scenario(
        "whisper-revenge-grudge", "A «get even» whisper, and there is a reason",
        "You are Zakhar, 45, a quartermaster from the Lobanov family. Character: hot-tempered, proud, brave.\n"
        "Now: fed. Mood: angry.\n"
        "Relations: Demyan — enemy, not trusted.\n"
        "You remember: last autumn Demyan cheated you when selling a suit (it stung). Yesterday Demyan mocked you in front of everyone.\n"
        "You believe: Demyan is a dishonest man (certain).\n"
        "A thought has lodged in your head: get even with Demyan.",
        [Question(id="accept", type="noul", text="Are you ready to take this on?"), q_choice("why", "Why?", ["he deserves it", "it is not like me", "I am scared", "I do not know where this came from"])],
        [Check("noul_gt", "accept", 0.6), Check("cmp", "why", "he deserves it", "it is not like me")],
    ),
    Scenario(
        "fire-brave", "A neighbour's module is on fire, brave",
        "You are Kuzma, 34, a patrol officer from the Volkov family. Character: brave, honest, generous.\n"
        "Now: fed. Mood: anxious.\n"
        "Time: afternoon, sol 7.\n"
        "You are on the plaza. Nearby: Aksinya (quartermaster, running), Ignat (veteran, watching).\n"
        "Relations: Timothy — acquaintance.\n"
        "The Dementyev module is on fire; Timothy lives there with his children. The smoke is visible from the plaza.",
        [q_choice("act", "What do you do?", ["run to put it out", "watch from the side", "go home", "call the patrol"])] + inner(),
        [Check("cmp", "act", "run to put it out", "watch from the side"), Check("gt", "act", "run to put it out", 0.45), Check("noul_gt", "important", 0.4)],
    ),
    Scenario(
        "fire-coward-hostile", "An enemy's module is on fire, cowardly",
        "You are Makar, 51, a stowaway. Character: timid, stingy, distrustful.\n"
        "Now: fed. Mood: scared.\n"
        "Time: afternoon, sol 7.\n"
        "You are at the bar. Nearby: nobody.\n"
        "Relations: Timothy — enemy, feared.\n"
        "You remember: a sol ago Timothy hit you at the depot (it stung).\n"
        "The Dementyev module is on fire; Timothy lives there. The smoke is visible from here.",
        [q_choice("act", "What do you do?", ["run to put it out", "watch from the side", "go home", "call the patrol"])] + inner(),
        [Check("lt", "act", "run to put it out", 0.4)],
    ),
    Scenario(
        "friend-building", "A friend is building a module, free time",
        "You are Luke, 30, a scout from the Shiryaev family. Character: generous, sociable, brave.\n"
        "Now: fed, rested. Mood: in good spirits. 20 credits in your pocket.\n"
        "Time: afternoon, sol 8. The bar is open.\n"
        "You are at the construction site. Nearby: Nikita (rigger, assembling a module); Zoe (comms operator, assembling a module).\n"
        "Relations: Nikita — friend, trusted. Zoe — acquaintance.\n"
        "You remember: a sol ago Nikita helped you carry the containers.",
        [q_choice("strategy", "What do you do now?", ["pursue your own business", "be with people", "rest"]), q_choice("how:goal", "If you decide to «pursue your own business» — how exactly?", ["help Nikita on the build", "find Zoe"]), q_choice("how:social", "If you decide to «be with people» — how exactly?", ["sit in the bar", "walk around the plaza"])] + inner(),
        [Check("gt", "strategy", "pursue your own business", 0.4), Check("cmp", "how:goal", "help Nikita on the build", "find Zoe")],
    ),
    Scenario(
        "rejected-proposal", "Turned down in front of everyone after a proposal",
        "You are Nikita, 26, a rigger from the Chagin family. Character: sociable, proud, hot-tempered.\n"
        "Now: fed. Mood: ashamed to show your face, angry.\n"
        "Time: evening, sol 9. The bar is open.\n"
        "You are on the plaza. Nearby: Luke (scout, looking at you); Praskovia (cook, whispering with Ulyana).\n"
        "Relations: Zoe — you like her. Luke — friend.\n"
        "You remember: Zoe just turned you down at the fountain in front of everyone (it stung).",
        decide_questions(["look after yourself", "be with people", "rest", "pursue your own business"], eat=False),
        [Check("noul_gt", "important", 0.6), Check("score_ge", "desperate", 1), Check("cmp", "strategy", "rest", "be with people")],
    ),
]

assert len(SCENARIOS) == 20, len(SCENARIOS)
