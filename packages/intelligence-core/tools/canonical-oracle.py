#!/usr/bin/env python3
"""Independent oracle of the canonical JSON profile (B05 S047, C01).

Reads test/fixtures/canonical-interop.json (cases with `valueJson`), serializes each value the way the platform profile
specifies (keys in code-point order, no whitespace, UTF-8, non-ASCII kept) and writes `canonical` and `sha256` back.
Run once to seal the digests before the platform code is compared with them:  python tools/canonical-oracle.py --seal
Without --seal it only checks that the sealed digests are what this oracle computes.
"""
import hashlib
import json
import pathlib
import sys

path = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "canonical-interop.json"
doc = json.loads(path.read_text(encoding="utf-8"))
bad = 0
for case in doc["agree"]:
    value = json.loads(case["valueJson"])
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if "--seal" in sys.argv:
        case["canonical"] = text
        case["sha256"] = digest
    elif case.get("canonical") != text or case.get("sha256") != digest:
        bad += 1
        print("MISMATCH", case["id"])
if "--seal" in sys.argv:
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
sys.exit(1 if bad else 0)
