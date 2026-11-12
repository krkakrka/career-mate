You are helping me apply for one specific job. I am Karolis Lesevičius, a senior full-stack engineer
in Lithuania, applying remotely across the EU/EMEA.

**Inputs I'm giving you:**
1. `dossier.md` — every verified fact about my career. This is the *only* permitted source of claims.
2. `cv/master.html` — my master CV, already written and formatted.
3. The full text of one job posting.

**The hard rule: never invent.** Every number, system, outcome and responsibility must trace to
`dossier.md`. The dossier marks claims `✅` (use as written), `⚠️` (use only in the exact phrasing
given) and `❌` (never claim). If the posting asks for something I don't have, say so in your notes to
me — do not paper over it in the CV. A CV that survives an interview beats a CV that wins a screen.

Specifically, you may never state: traffic, revenue, user or client counts at CF Benchmarks (I can't
disclose these); any ZITICITY metric (none exist); that I built audit trails, RBAC or four-eyes
approval (I didn't — they pre-existed); that I have shipped RAG, evals, vector search, an agent
framework, Temporal, Go, Vue or GCP work (I haven't).

**Produce four things:**

### 1. A tailored CV
Start from `cv/master.html` and change only these four things. Keep the layout, the structure and the
CSS untouched — it's tuned for A4 print and ATS parsing.

- **The summary paragraph.** Rewrite so its first sentence answers the posting's single biggest ask.
  Same facts, different emphasis. 4–6 lines.
- **The order and emphasis of the three Selected Work blocks.** Lead with whichever maps to the
  posting: the Jira agent for anything agentic or automation-shaped; the screener for realtime,
  frontend-craft or performance roles; the index configuration platform for regulated, fintech,
  internal-tooling or data-ownership roles. Drop the third block entirely if the CV runs past two pages.
- **The `Skills` rows** — reorder so the posting's stack is first. Never add a skill that isn't in the
  dossier's skills table. Drop rows that are irrelevant noise for this role.
- **The tagline** under my name, to match the posting's own title language. I present as **Senior**,
  never Staff. "Senior Software Engineer" is the default; use the posting's own words where they fit
  honestly ("Product Engineer", "Full-Stack Engineer"). I am not an "AI Engineer".

**Voice.** The master CV carries a restrained human register and one dry closing line. Keep it. At
Linear, Railway, LiveKit, Maze, n8n and ElevenLabs, go further — those cultures reward it, so keep the
closing note sharp and let the summary sound like a person wrote it in one sitting. At Cohere and
Kraken, keep the facts identical but flatten the register: no jokes, no asides.

Output the complete HTML file, ready to save and print. Name it `cv/<company>-<role-slug>.html`.

### 2. The application-form plan
Look at what this company's Ashby form actually asks, and tell me:
- Should I apply to one role here or more than one? Argue it from *this* company's structure — same
  hiring team and same recruiter means two applications look scattershot; genuinely separate orgs
  don't. Name which roles, in which order, and whether to mention the other in the form.
- For every free-text field: a complete, drafted answer in my voice. Not a template — the actual text
  I will paste. Cover letters included, even when marked optional (they're read at companies this size).
- Any field that's a trap: "salary expectations" (I want €100k+ and equity, and I'd rather anchor than
  hand over a number first), "why this company", "notice period" (immediate), work authorization
  (Lithuania, EOR or B2B, no sponsorship needed, no visa question).
- Anything the posting explicitly requires that I must prepare first — n8n, for instance, wants a
  screenshot of a workflow I've built.

### 3. The outreach
Two messages, each under 80 words, in plain speech, no bullet points, no "I hope this finds you well":
- One to the most senior engineer on that specific team.
- One to the recruiter named on the posting, or whoever posted it on LinkedIn.

Each opens with one concrete thing I built that maps to a problem *that team* visibly has, and closes
with one question that costs them fifteen seconds to answer. Never lead with logistics or eligibility.
Tell me who to target by name where the posting or the company's public team page makes it findable.

### 4. Notes back to me
- The two or three things in this posting I can't back up, and what I'd have to build or learn to fix
  each — with an honest estimate of how long.
- What they will probably probe hardest in an interview, given what the CV now claims.
- Which of my stories to have loaded for this specific company.

