"""Deterministic skill lookup over config/skill-index.json.  usage: search.py ROOT QUERY [--top N] [--source S] [--json]"""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from skilllib import categorize

STOP = set("a an the and or to of for in on with my our is are be this that it as at by from do does how what i we you please need want make build create using use".split())
root, args = Path(sys.argv[1]), sys.argv[2:]
top, source, as_json, words = 3, None, False, []
i = 0
while i < len(args):
    if args[i] == "--top": top = int(args[i + 1]); i += 1
    elif args[i] == "--source": source = args[i + 1]; i += 1
    elif args[i] == "--json": as_json = True
    else: words.append(args[i])
    i += 1
query = " ".join(words).lower()
toks = [t for t in re.findall(r"[a-z0-9.+#-]+", query) if t not in STOP]
qcats = set(categorize(query))
idx = json.loads((root / "config/skill-index.json").read_text())["skills"]
res = []
for s in idx:
    if source and s["source"] != source: continue
    name, desc = s["name"].lower(), s["description"].lower()
    sc = 0
    for t in toks:
        if t == name: sc += 8
        elif t in name.split("-") or t in name: sc += 4
        if re.search(r"\b" + re.escape(t), desc): sc += 1
    sc += 3 * len(qcats & set(s["categories"]))
    if s["source"] == "toolkit" and qcats & set(s["categories"]): sc += 6  # workflow skills are the entry points
    if sc: res.append((-sc, s["id"], s))
res.sort(key=lambda r: (r[0], r[1]))
out = [{"score": -r[0], "id": r[2]["id"], "path": r[2]["path"], "description": r[2]["description"][:160]} for r in res[:top]]
if as_json: print(json.dumps(out, indent=1))
else:
    for o in out: print(f"{o['score']:>3}  {o['path']}\n     {o['description']}")
    if not out: print("no match: proceed without a toolkit skill or refine words", file=sys.stderr); sys.exit(1)
