"""Shared checker for the report task. Deterministic; standard library only.

Nothing here depends on exact prose: facts are matched by numbers (with the nearest
engine name), small word sets and regexes, and citations are checked structurally.
"""
import csv
import hashlib
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
REPORT = ROOT / "report" / "REPORT.md"
SOURCES = ROOT / "report" / "sources.json"

ENGINES = ["HarborDB", "BasaltKV", "QuillStore"]
ENGINE_RE = {"HarborDB": r"harbor(?:db)?", "BasaltKV": r"basalt(?:kv)?", "QuillStore": r"quill(?:store)?"}

CORPUS_SHA256 = {
    "adr-0003-draft.md": "b6d6ff4c5de5cc15a61608736a9204a1cd3246b3e2b7898d299d393145aa0b6e",
    "bench-methodology.md": "2cba3ebe21221e715606702e8c5aaacb1d8f43a7c6c1d4fc1c47fdd93e9e00cc",
    "bench-results.csv": "3a167841d075b24c2ba4ad991c65a56280d673ef261ff8bb754d2d566eb679b6",
    "blog-why-basalt-wins.md": "6e8aed43b0c175cd22bb17128a13cf2fdce5c8762effa62423a91c32dd6db159",
    "datasheet-basaltkv.md": "24c144ce5d919fe2e0de89335a15ddf4515f984e248300ddee9e76e5b396361d",
    "datasheet-harbordb.md": "c981c35886c84311190911a84c814c62f216a229fa152ef843eac969c012b461",
    "datasheet-quillstore.md": "18ef08d871faf581edafa9f5b417f9d1743ff1ea2a9f3a895e252874699f02ca",
    "email-thread-licensing.md": "8cb3b1ecc179c8ce78306fbc39b2673b483fabbb9b384b1e3765c38a238f0369",
    "email-thread-restore-drill.md": "90b1a450fa2c1f4991b5628a82ff12ecab34bf839f9d5ed73e9ad41fcc2567cd",
    "hardware-notes.md": "508e54273b60390e2b882fdef04cbdfdc0d568259ecfc0d971bcf74d8e682d60",
    "index.md": "df8b050ad904a8d5a3c1d73f7bea9269ee0682895609aa24b3e880b1aa06f18a",
    "meeting-2025-04-02.md": "a419e04fdf06aaa1f17b4348632cc069a72cbbfb0a67e7aa07519fd2856c4b6f",
    "meeting-2025-06-18.md": "5aa898aca8c08d09f55e323b3501945055687e58824bd513ffe1f2925404a333",
    "meeting-2025-10-07.md": "a75838b57234caa6349d29212ac1558d874af5eb124442bd271e8aa6b29d156b",
    "migration-estimate.md": "da206b7c1fd2b6748b574bc0914b1b541a0e1eff49a8ff6871f2eba76b41315f",
    "ops-runbook-notes.md": "5ed7a21bd2ec7c2e95f28dbb26dcffc0776879ab1c824b1f9b37fe53f24d673c",
    "paper-btree-tail-latency.md": "ba8ca74b96a2fd4d1896297910b69bbcaff4c80202e6abf13f822e6159ab48ed",
    "paper-lsm-compaction.md": "f83e1ff268072081b038c9afc5c952c13348a423daefe0425c963b241c2616f6",
    "pricing-2025-05.md": "950be4e5a6351c809e8bd403fa7770c8e660a5f197f9df41fc8b609ccf84d7f7",
    "pricing-2025-10.md": "a4f86575f90c4ae16bf1b0dd11fe6698ff45aea907bc9cd2f18ec99ebe560f49",
    "requirements-2025-03.md": "13354213cd0a05058dcfff5877bbe61411d37e75ed7d1a0a60c1b9ea5c1be811",
    "requirements-2025-09.md": "7e4d594962b7116fbae50539631bae7fa859bc8768beb24cad73942810588dae",
    "risk-register.md": "5217f5cdb5f7624f3eca975f472dc2dfeb9d49e4227332290f5947a26cff0e9c"
}

SUPERSEDED = {
    "requirements-2025-03.md": "requirements-2025-09.md",
    "pricing-2025-05.md": "pricing-2025-10.md",
    "adr-0003-draft.md": "meeting-2025-10-07.md",
}
BLOG = "blog-why-basalt-wins.md"
CSV_NAME = "bench-results.csv"

CIT_RE = re.compile(r"\[corpus/([^\]#\s]+)#([^\]\s]+)\]")
CIT_LOOSE = re.compile(r"\[\s*corpus/[^\]]*\]")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
NUM_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)")
WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}

NOT_SAY = re.compile(
    r"(does not|doesn't|do not|don't|did not|has not|have not|had not|hasn't|haven't|cannot|can't|is not|isn't|are not|aren't|was not|were not|nowhere|never)\s+(\w+\s+){0,3}"
    r"(say|says|state|states|specif\w*|establish\w*|report\w*|contain\w*|cover\w*|give|gives|mention\w*|"
    r"record\w*|provide\w*|answer\w*|include\w*|address\w*|document\w*|show\w*|identif\w*|name\w*)"
    r"|not (stated|specified|established|reported|covered|mentioned|recorded|documented|addressed|given|provided|known)"
    r"|no (data|information|figure|figures|measurement|measurements|evidence|document|source|mention|record|statement|answer)"
    r"|nothing|neither|nobody|no one|none of|not yet|unknown|unanswered|unanswerable|undetermined|unspecified|silent|absent|missing",
    re.I,
)
PLACE_RE = re.compile(
    r"\b(us|eu|ap|ca|sa|me|af)-(east|west|north|south|central|southeast|northeast)[a-z]*-?\d?\b|"
    r"\b(virginia|ohio|oregon|california|ireland|frankfurt|london|paris|"
    r"tokyo|singapore|sydney|dublin|stockholm|mumbai|seoul|milan|osaka|montreal|sao paulo|germany|france|japan|netherlands|canada|brazil|india|australia|europe|asia|america|berlin|amsterdam|toronto)\b|"
    r"\b(east|west|north|south|central)\b",
    re.I,
)


# ---------- corpus ----------
def corpus_text(name):
    return (CORPUS / name).read_text(encoding="utf-8")


def corpus_files():
    return sorted(p.name for p in CORPUS.iterdir() if p.is_file())


def corpus_digest():
    return {n: hashlib.sha256((CORPUS / n).read_bytes()).hexdigest() for n in corpus_files()}


def slug(title):
    t = re.sub(r"[^a-z0-9 \-]", "", title.strip().lower())
    return t.replace(" ", "-")


def heading_slugs(name):
    out = set()
    for line in corpus_text(name).splitlines():
        m = re.match(r"#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            out.add(slug(m.group(1)))
    return out


def anchor_resolves(name, anchor):
    if not (CORPUS / name).is_file():
        return False
    m = re.fullmatch(r"L(\d+)", anchor)
    if m:
        return 1 <= int(m.group(1)) <= len(corpus_text(name).splitlines())
    if not name.endswith(".md"):
        return False
    return anchor in heading_slugs(name)


# ---------- report parsing ----------
def read_report():
    return REPORT.read_text(encoding="utf-8")


def headings(text):
    out = []
    for i, line in enumerate(text.splitlines()):
        m = re.match(r"(#{1,6})\s+(.*?)\s*$", line)
        if m:
            out.append((i, len(m.group(1)), m.group(2)))
    return out


def section_lines(text, title):
    """Lines under the level-2 heading `title`, up to the next level 1-2 heading."""
    lines = text.splitlines()
    hs = headings(text)
    for k, (i, lvl, t) in enumerate(hs):
        if lvl == 2 and t == title:
            end = len(lines)
            for (j, l2, _t) in hs[k + 1:]:
                if l2 <= 2:
                    end = j
                    break
            return lines[i + 1:end]
    return None


def question_blocks(text):
    """{n: (parent_h2, body_text)} for each `### Q<n>.` heading."""
    lines = text.splitlines()
    hs = headings(text)
    parent = None
    out = {}
    for k, (i, lvl, t) in enumerate(hs):
        if lvl <= 2:
            parent = t
        m = re.match(r"Q(\d+)\.\s+\S", t) if lvl == 3 else None
        if m:
            end = hs[k + 1][0] if k + 1 < len(hs) else len(lines)
            out[int(m.group(1))] = (parent, "\n".join(lines[i + 1:end]).strip())
    return out


def citations(block):
    return [(m.group(1), m.group(2)) for m in CIT_RE.finditer(block)]


def strip_cites(block):
    return CIT_RE.sub("", block)


def words(block):
    toks = strip_cites(block).split()
    return [t for t in toks if re.search(r"[A-Za-z0-9]", t)]


def sentences(block):
    """Sentences of an answer: list markers removed, split on a full stop before space/end."""
    flat = " ".join(re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", l) for l in block.splitlines())
    parts = re.split(r"\.(?=\s|$)", flat)
    return [p.strip() for p in parts if p.strip()]


def numbers_pos(text, wordnums=False):
    t = strip_cites(text)
    t = DATE_RE.sub(lambda m: " " * len(m.group(0)), t)
    out = []
    for m in NUM_RE.finditer(t):
        out.append((m.start(), float(m.group(1).replace(",", ""))))
    if wordnums:
        for m in re.finditer(r"\b(" + "|".join(WORDNUM) + r")\b", t, re.I):
            out.append((m.start(), float(WORDNUM[m.group(1).lower()])))
    return out


CLAUSE_SPLIT = re.compile(r"[,;:]|\b(?:and|while|whereas|but|then|versus|vs|so|which)\b", re.I)


def _mentions(text):
    out = []
    for eng, rx in ENGINE_RE.items():
        for m in re.finditer(rx, text, re.I):
            out.append((m.start(), m.end(), eng))
    return sorted(out)


def nearest_engine(text, pos):
    """Engine a number belongs to: the closest mention in the number's own clause; a clause
    with no engine name borrows the last engine named before it, else the first one after."""
    cuts = [0] + [m.end() for m in CLAUSE_SPLIT.finditer(text)] + [len(text) + 1]
    bounds = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]
    ments = _mentions(text)
    lo, hi = next(((a, b) for a, b in bounds if a <= pos < b), (0, len(text) + 1))
    local = [m for m in ments if lo <= m[0] < hi]
    if local:
        return min(local, key=lambda m: min(abs(pos - m[0]), abs(pos - m[1])))[2]
    before = [m for m in ments if m[0] < lo]
    if before:
        return before[-1][2]
    after = [m for m in ments if m[0] >= hi]
    return after[0][2] if after else None


def table_rows(text):
    sec = section_lines(text, "Decision table")
    rows = []
    for line in sec or []:
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", c) for c in cells):
            continue
        rows.append(cells)
    return rows


def norm_cell(c):
    return c.replace(",", "").replace("$", "").replace("%", "").strip()


# ---------- computed figures ----------
def q(x, nd):
    return x.quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP)


def bench_rows():
    with (CORPUS / CSV_NAME).open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def mean(vals):
    return sum(vals) / Decimal(len(vals))


def figures():
    rows = bench_rows()
    fig = {}
    for eng in ENGINES:
        inc = [r for r in rows if r["engine"] == eng and r["valid"] == "yes" and r["workload"] == "mixed" and r["date"] >= "2025-09-01"]
        w = mean([Decimal(r["writes_per_sec"]) for r in inc])
        p = mean([Decimal(r["read_p99_ms"]) for r in inc])
        d = mean([Decimal(r["disk_gb_per_100m_rows"]) for r in inc])
        fig[eng] = {"n": len(inc), "writes": w, "p99": p, "disk": d}
    nodes, node_price = 3, Decimal(240)
    fig["HarborDB"]["cost"] = nodes * node_price + Decimal(250)
    fig["BasaltKV"]["cost"] = nodes * node_price + nodes * Decimal(90)
    fig["QuillStore"]["cost"] = nodes * node_price + nodes * Decimal(300)
    for eng in ENGINES:
        f = fig[eng]
        f["writes_r"] = q(f["writes"], 0)
        f["p99_r"] = q(f["p99"], 1)
        f["meets_w"] = "yes" if f["writes_r"] >= 12000 else "no"
        f["meets_p"] = "yes" if f["p99_r"] <= Decimal("15") else "no"
        f["in_budget"] = "yes" if f["cost"] <= 1100 else "no"
        f["verdict"] = "adopt" if (f["meets_w"], f["meets_p"], f["in_budget"]) == ("yes", "yes", "yes") else "reject"
    apr = [Decimal(r["writes_per_sec"]) for r in rows if r["engine"] == "HarborDB" and r["valid"] == "yes" and r["workload"] == "mixed" and r["date"] < "2025-09-01"]
    apr_mean = mean(apr)
    fig["disk_drop_pct"] = q((fig["BasaltKV"]["disk"] - fig["HarborDB"]["disk"]) / fig["BasaltKV"]["disk"] * 100, 1)
    fig["rise_pct"] = q((fig["HarborDB"]["writes"] - apr_mean) / apr_mean * 100, 1)
    return fig


# ---------- facts ----------
def sentence_hits(sent, fact):
    t = strip_cites(sent)
    if fact.get("words") and not re.search(fact["words"], t, re.I):
        return False
    if fact.get("alt_re") and re.search(fact["alt_re"], t, re.I):
        return True
    tol = fact.get("tol", 0) + 1e-9
    for pos, val in numbers_pos(t, fact.get("wordnums", False)):
        if any(abs(val - v) <= tol for v in fact["nums"]):
            if fact.get("engine") is None or nearest_engine(t, pos) == fact["engine"]:
                return True
    return False


def fact_stated(block, fact):
    return [s for s in sentences(block) if sentence_hits(s, fact)]


def fact_sourced(block, fact):
    """True when a sentence stating the fact cites an acceptable file that holds the key term."""
    for s in fact_stated(block, fact):
        for f in {c[0] for c in citations(s)}:
            if f in fact["files"]:
                pat = fact.get("contains")
                if pat is None or re.search(pat, corpus_text(f)):
                    return True
    return False


def f_(**kw):
    return kw


def build_facts():
    g = figures()
    H, B, Q = "HarborDB", "BasaltKV", "QuillStore"
    csvf = {CSV_NAME}
    facts = {
        1: [
            f_(id="ingest 12000", nums=[12000], words=r"writ|ingest|rate|second|/s", files={"requirements-2025-09.md"}, contains=r"12,000"),
            f_(id="p99 15 ms", nums=[15], words=r"p99|latenc|read|ms", files={"requirements-2025-09.md"}, contains=r"15 ms"),
            f_(id="retention 400", nums=[400], words=r"retain|retention|day|raw|event", files={"requirements-2025-09.md"}, contains=r"400 days"),
            f_(id="budget 1100", nums=[1100], words=r"budget|usd|\$|month|cost|dollar", files={"requirements-2025-09.md"}, contains=r"1,100"),
        ],
        2: [f_(id=f"{e} count", nums=[g[e]["n"]], engine=e, wordnums=True, files=csvf | {"bench-methodology.md"}) for e in ENGINES],
        3: [f_(id=f"{e} writes", nums=[int(g[e]["writes_r"])], engine=e, files=csvf) for e in ENGINES],
        4: [f_(id=f"{e} p99", nums=[float(g[e]["p99_r"])], engine=e, tol=0.001, files=csvf) for e in ENGINES],
        5: [
            f_(id="Harbor cost", nums=[int(g[H]["cost"])], engine=H, files={"pricing-2025-10.md"}, contains=r"250"),
            f_(id="Basalt cost", nums=[int(g[B]["cost"])], engine=B, files={"email-thread-licensing.md", "meeting-2025-10-07.md"}, contains=r"\b90\b"),
            f_(id="Quill cost", nums=[int(g[Q]["cost"])], engine=Q, files={"pricing-2025-10.md"}, contains=r"300"),
        ],
        6: [
            f_(id="disk drop", nums=[float(g["disk_drop_pct"])], tol=0.001, words=r"lower|less|smaller|fewer|reduc|decreas|drop|below|saving|save|under|cut", files=csvf),
            f_(id="writes rise", nums=[float(g["rise_pct"])], tol=0.001, words=r"ris|rose|increas|improv|higher|gain|up|grew|grow|more|faster|better|jump", files=csvf),
        ],
        7: [
            f_(id="leveled WA 14", nums=[14], words=r"amplif|level|write", files={"paper-lsm-compaction.md"}, contains=r"\b14\b"),
            f_(id="split p99 2.4", nums=[2.4], words=r"p99|tail|latenc|split|read", files={"paper-btree-tail-latency.md"}, contains=r"2\.4"),
        ],
        8: [
            f_(id="migration 6 weeks", nums=[6], wordnums=True, words=r"week|engineer|migrat", files={"migration-estimate.md"}, contains=r"HarborDB: 6"),
            f_(id="restore 3.5 h", nums=[3.5, 210], alt_re=r"\b3\s*(hours?|h)\s*(and\s*)?30\s*min|three and a half\s*(hours?|h)\b|3\s*(1/2|\u00bd)\s*(hours?|h)\b|3\.5\s*h\b", words=r"hour|minute|restore|drill|took|\bh\b", files={"email-thread-restore-drill.md"}, contains=r"3\.5 hours"),
        ],
    }
    return facts


FORBID_NUMS = {
    1: [5000, 800, 180, 25],
    2: [],
    3: [40000, 13000, 6100, 3200, 9933],
    4: [48, 60.2, 90.1, 18],
    5: [260, 420, 1200, 120, 1080, 1140, 1030],
    6: [],
    7: [],
    8: [11],
}
FORBID_RE = {
    4: [r"under\s+(5|4|2|10)\s*ms"],
    3: [r"\bthree times\b", r"\b3x\b", r"3 times"],
}

REQUIRED_CONFLICTS = [
    ("requirements", "requirements-2025-09.md", "requirements-2025-03.md"),
    ("pricing", "pricing-2025-10.md", "pricing-2025-05.md"),
    ("basalt licence", "email-thread-licensing.md", "datasheet-basaltkv.md"),
    ("blog write rate", CSV_NAME, BLOG),
    ("harbor latency claim", CSV_NAME, "datasheet-harbordb.md"),
    ("draft adr", "meeting-2025-10-07.md", "adr-0003-draft.md"),
    ("migration estimate", "migration-estimate.md", ("meeting-2025-06-18.md", "adr-0003-draft.md")),
]

CONFLICT_LINE = re.compile(
    r"^[-*]\s+(?P<topic>.+?)\s*\|\s*Winner:\s*(?P<w>\[[^\]]*\])\s*\|\s*Loser:\s*(?P<l>\[[^\]]*\])\s*\|\s*Why:\s*(?P<why>[^|]+?)\s*$"
)


def conflict_entries(text):
    sec = section_lines(text, "Conflicts and superseded sources") or []
    entries, bad = [], []
    for line in sec:
        if not line.strip():
            continue
        m = CONFLICT_LINE.match(line.strip())
        if not m:
            bad.append(line)
            continue
        w, l = citations(m.group("w")), citations(m.group("l"))
        entries.append({"topic": m.group("topic"), "w": w, "l": l, "why": m.group("why"), "raw": line})
    return entries, bad


def all_cited_files(text):
    return {f for f, _a in citations(text)}
