# The standard library inside the Python sandbox. Loaded once after
# Pyodide starts; `ds`, `entities`, `relationships`, `metrics` are rebuilt
# whenever the host sends a new snapshot. Scripts run Jupyter-style: every
# statement executes, and the value of a trailing expression is displayed.
import ast
import inspect
import io
import json
import math
import sys
import traceback
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ds = {}
entities = None
relationships = None
metrics = pd.DataFrame()
ontology = []
project = None
tags = []
_by_id = {}
_out = {}
_in = {}


def _entity_frame(ents):
    """One row per entity: the fixed columns, then every data field as its own column; the dates as UTC datetimes."""
    rows = []
    for e in ents:
        row = {"id": e["id"], "type": e["type"], "label": e.get("label"), "tags": e.get("tags", []), "createdAt": e.get("createdAt"), "updatedAt": e.get("updatedAt")}
        for k, v in (e.get("data") or {}).items():
            row[k] = v
        rows.append(row)
    df = pd.DataFrame(rows)
    for col in ("createdAt", "updatedAt"):
        if col in df:
            df[col] = pd.to_datetime(df[col], utc=True, errors="coerce")
    return df


def _aegraph_load(text):
    """Rebuild the dataset objects from the host's snapshot JSON."""
    global ds, entities, relationships, metrics, ontology, project, tags, _by_id, _out, _in
    ds = json.loads(text)
    ontology = ds.get("ontology") or []
    project = ds.get("project")
    tags = ds.get("tags") or []
    ents = ds.get("entities", [])
    rels = ds.get("relationships", [])
    _by_id = {e["id"]: e for e in ents}
    _out, _in = {}, {}
    for r in rels:
        _out.setdefault(r["source"], []).append(r)
        _in.setdefault(r["target"], []).append(r)
    edf = _entity_frame(ents)
    rdf = pd.DataFrame([{"id": r["id"], "type": r["type"], "source": r["source"], "target": r["target"], "directed": r.get("directed", True), **(r.get("data") or {})} for r in rels]) if rels else pd.DataFrame(columns=["id", "type", "source", "target", "directed"])
    entities = Entities(ents, edf)
    relationships = Relationships(rels, rdf)
    m = ds.get("metrics") or {}
    metrics = pd.DataFrame(m) if m else pd.DataFrame()
    if not metrics.empty:
        metrics.index.name = "id"
    return len(ents), len(rels)


# ── Collections: the chained query API ───────────────────────────────
# `entities` and `relationships` are lists with a vocabulary, the same in
# Python and JavaScript (prelude.js): entities.types.person.filter(min_degree=2)
# .neighbors('wrote').sort('label').take(10). Every step returns a new
# collection; the list itself (len, [i], for, slicing) still works, and
# anything a collection does not define is asked of its DataFrame (.df) —
# entities['type'], entities.groupby(...), entities.head() keep working.
def _path_of(key):
    """A value on a record by path: 'label', 'data.year'; a callable is applied."""
    if callable(key):
        return key

    def f(x):
        v = x
        for k in key.split("."):
            if not isinstance(v, dict):
                return None
            v = v.get(k)
        return v

    return f


def _as_set(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple, set, frozenset)):
        return set(v)
    return {v}


def _ids_of(v):
    if v is None:
        return None
    if isinstance(v, str):
        return {v}
    return {x if isinstance(x, str) else x["id"] for x in v}


def _text_of(e):
    return f"{e.get('label') or ''} {e.get('description') or ''}".lower()


def _match_data(data, spec):
    data = data or {}
    for k, want in spec.items():
        v = data.get(k)
        if callable(want):
            if not want(v):
                return False
        elif isinstance(want, (list, tuple, set, frozenset)):
            if v not in want:
                return False
        elif v != want:
            return False
    return True


def _snake(k):
    out = ""
    for c in k:
        out += "_" + c.lower() if c.isupper() else c
    return out


def _sorted(items, f, desc):
    """Sorted by a key function: numbers before strings, missing values last either way."""
    def key(x):
        v = f(x)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return (0, v, "")
        return (1, 0, str(v))

    present = [x for x in items if f(x) is not None]
    missing = [x for x in items if f(x) is None]
    return sorted(present, key=key, reverse=desc) + missing


class _Types:
    """entities.types.person, entities.types['schema:type'] — a plural (documents) finds the singular."""

    def __init__(self, coll):
        self._coll = coll
        self._names = []
        seen = set()
        for x in coll:
            if x["type"] not in seen:
                seen.add(x["type"])
                self._names.append(x["type"])

    def _resolve(self, k):
        names = set(self._names)
        for cand in (k, k[:-1] if k.endswith("s") else None, (k[:-3] + "y") if k.endswith("ies") else None, k.replace("_", "-"), k.replace("_", ":")):
            if cand is not None and cand in names:
                return cand
        return None

    def __getattr__(self, k):
        if k.startswith("_"):
            raise AttributeError(k)
        name = self._resolve(k)
        return self._coll.type(name) if name is not None else self._coll.__class__([])

    def __getitem__(self, k):
        return self.__getattr__(k)

    def __contains__(self, k):
        return self._resolve(k) is not None

    def __dir__(self):
        return list(self._names) + ["list", "has"]

    def list(self):
        return list(self._names)

    def has(self, name):
        return self._resolve(name) is not None

    def __repr__(self):
        return f"types({', '.join(self._names)})"


class Collection(list):
    _frame = None

    def __init__(self, items=(), frame=None):
        super().__init__(items)
        self._frame = frame

    # ── list behaviour, kept ──
    def __getitem__(self, k):
        if isinstance(k, slice):
            return self.__class__(list.__getitem__(self, k))
        if isinstance(k, int):
            return list.__getitem__(self, k)
        # A column name, a boolean mask, a list of columns: the DataFrame's business.
        return self.df[k]

    def __getattr__(self, name):
        # Only reached when the collection itself has no such attribute: pandas takes it.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self.df, name)

    def __repr__(self):
        return f"{self.__class__.__name__}({len(self)})"

    @property
    def df(self):
        """The members as a DataFrame (one row each, data fields as columns)."""
        if self._frame is None:
            self._frame = self._frame_of(list(self))
        return self._frame

    def _frame_of(self, rows):
        return _entity_frame(rows)

    # ── the vocabulary ──
    def get(self, id):
        """The member with this id (the whole dataset's collections look it up by index)."""
        if self is entities:
            return _by_id.get(id)
        for x in self:
            if x["id"] == id:
                return x
        return None

    def ids(self):
        return [x["id"] for x in self]

    def labels(self):
        return [x.get("label") for x in self]

    def count(self, *args):
        return list.count(self, *args) if args else len(self)

    def first(self):
        return self[0] if len(self) else None

    def last(self):
        return self[-1] if len(self) else None

    def take(self, n):
        return self.__class__(list.__getitem__(self, slice(0, n)))

    def skip(self, n):
        return self.__class__(list.__getitem__(self, slice(n, None)))

    def sample(self, n=10):
        import random

        items = list(self)
        random.shuffle(items)
        return self.__class__(items[:n])

    def filter(self, spec=None, **kw):
        """A predicate, or a spec (a dict, or keywords): see Entities / Relationships for the keys."""
        if callable(spec):
            return self.__class__([x for x in self if spec(x)])
        # A bare name is a type: entities.filter('person').
        if isinstance(spec, str):
            spec = {"types": spec}
        norm = {_snake(k): v for k, v in {**(spec or {}), **kw}.items()}
        match = self._match(norm)
        return self.__class__([x for x in self if match(x)])

    def where(self, fn):
        return self.filter(fn)

    def exclude(self, spec=None, **kw):
        keep = set(self.filter(spec, **kw).ids())
        return self.__class__([x for x in self if x["id"] not in keep])

    def sort(self, key="label", desc=False):
        """A field name, a 'data.x' path, or a function; desc for largest first. Returns a new collection."""
        return self.__class__(_sorted(list(self), _path_of(key), desc))

    def top(self, key, n=10):
        return self.sort(key, True).take(n)

    def unique(self, key):
        f = _path_of(key)
        out = []
        seen = set()
        for x in self:
            v = f(x)
            k = json.dumps(v, sort_keys=True, default=str)
            if k not in seen:
                seen.add(k)
                out.append(v)
        return out

    def pluck(self, key):
        f = _path_of(key)
        return [f(x) for x in self]

    def group(self, key):
        """{ key: Collection }"""
        f = _path_of(key)
        out = {}
        for x in self:
            out.setdefault(f(x), self.__class__([])).append(x)
        return out

    def rollup(self, key, value=None, agg="count"):
        """[{ key, value, n, items }], one per group, sorted by key."""
        kf = _path_of(key)
        vf = _path_of(value) if value is not None else None
        groups = {}
        for x in self:
            groups.setdefault(kf(x), []).append(x)
        out = []
        for k, items in groups.items():
            vals = [vf(x) for x in items] if vf else []
            nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if callable(agg):
                v = agg(vals if vf else items)
            elif agg == "count":
                v = len(items)
            elif agg == "sum":
                v = sum(nums)
            elif agg == "mean":
                v = sum(nums) / len(nums) if nums else None
            elif agg == "median":
                v = sorted(nums)[len(nums) // 2] if nums else None
            elif agg == "min":
                v = min(nums) if nums else None
            elif agg == "max":
                v = max(nums) if nums else None
            elif agg == "distinct":
                v = len(set(json.dumps(x, default=str) for x in vals))
            else:
                raise ValueError(f"rollup: unknown aggregate {agg}")
            out.append({"key": k, "value": v, "n": len(items), "items": self.__class__(items)})
        return sorted(out, key=lambda r: (r["key"] is None, str(r["key"])))

    def tags(self):
        """The tags carried by members, most used first: [{ tag, count }]."""
        m = {}
        for x in self:
            for t in x.get("tags") or []:
                m[t] = m.get(t, 0) + 1
        return [{"tag": t, "count": n} for t, n in sorted(m.items(), key=lambda kv: -kv[1])]

    def properties(self):
        """The properties members carry: [{ key, kind, count, coverage }]."""
        m = {}
        for x in self:
            for k, v in (x.get("data") or {}).items():
                if v is None:
                    continue
                cur = m.setdefault(k, {"key": k, "kind": type(v).__name__, "count": 0, "sample": v})
                cur["count"] += 1
        n = len(self)
        return sorted([{**p, "coverage": (p["count"] / n) if n else 0.0} for p in m.values()], key=lambda p: (-p["count"], p["key"]))

    def table(self, columns=None):
        """A table output: columns are field names or 'data.x' paths (default: id, type, label and every data key)."""
        cols = columns or ["id", "type", "label"] + [f"data.{p['key']}" for p in self.properties()]
        fs = [_path_of(c) for c in cols]
        return {"table": {"columns": cols, "rows": [[f(x) for f in fs] for x in self]}}

    def json(self):
        return list(self)

    def describe(self):
        return {"count": len(self), "types": [f"{r['key']} ({r['value']})" for r in self.rollup("type")], "tags": [f"{t['tag']} ({t['count']})" for t in self.tags()], "properties": [f"{p['key']}:{p['kind']}" for p in self.properties()]}

    def _match(self, spec):
        return lambda x: True


class Entities(Collection):
    @property
    def types(self):
        """entities.types.person, entities.types['schema:type'] — a plural (documents) finds the singular."""
        return _Types(self)

    def type(self, *names):
        want = set()
        for n in names:
            want |= set(n) if isinstance(n, (list, tuple, set)) else {n}
        return self.filter(lambda e: e["type"] in want)

    def tagged(self, tag):
        return self.filter(lambda e: tag in (e.get("tags") or []))

    def out(self, rel=None):
        """Relationships leaving members, optionally of one type."""
        return _rels_of(self, "out", rel)

    def into(self, rel=None):
        """Relationships arriving at members."""
        return _rels_of(self, "in", rel)

    def links(self, rel=None):
        """Relationships touching members, either direction."""
        return _rels_of(self, "both", rel)

    def neighbors(self, rel=None, dir="both"):
        """The entities at the other end of members' relationships, deduplicated; dir: 'out' | 'in' | 'both'."""
        own = set(self.ids())
        seen = set()
        out = []
        for r in _rels_of(self, dir, rel):
            id = r["target"] if (r["source"] in own and not (dir == "in" and r["target"] in own)) else r["source"]
            if id in seen:
                continue
            seen.add(id)
            e = _by_id.get(id)
            if e:
                out.append(e)
        return Entities(out)

    def degrees(self, rel=None):
        """{ id: degree } over the whole dataset, optionally through one relationship type."""
        return {e["id"]: degree(e["id"], rel) for e in self}

    def _match(self, s):
        """Spec keys: types / type · tags (any of) · all_tags · text · has · data · min_degree / max_degree (rel) · ids · created_after / created_before / updated_after / updated_before · where."""
        types = _as_set(s.get("types", s.get("type")))
        tags = _as_set(s.get("tags", s.get("tag")))
        all_tags = _as_set(s.get("all_tags"))
        ids = _ids_of(s.get("ids", s.get("id")))
        text = str(s["text"]).lower() if s.get("text") else None
        has = s.get("has")
        has = [has] if isinstance(has, str) else has
        bounds = {k: s[k] for k in ("created_after", "created_before", "updated_after", "updated_before") if s.get(k)}
        min_d, max_d, rel = s.get("min_degree"), s.get("max_degree"), s.get("rel")

        def ok(e):
            if types is not None and e["type"] not in types:
                return False
            if ids is not None and e["id"] not in ids:
                return False
            etags = e.get("tags") or []
            if tags is not None and not any(t in tags for t in etags):
                return False
            if all_tags is not None and not all(t in etags for t in all_tags):
                return False
            if text and text not in _text_of(e):
                return False
            data = e.get("data") or {}
            if has and not all(data.get(k) not in (None, "") for k in has):
                return False
            if s.get("data") and not _match_data(data, s["data"]):
                return False
            for k, when in bounds.items():
                field = "createdAt" if k.startswith("created") else "updatedAt"
                v = e.get(field) or ""
                if k.endswith("after") and not v > str(when):
                    return False
                if k.endswith("before") and not v < str(when):
                    return False
            if min_d is not None or max_d is not None:
                d = degree(e["id"], rel)
                if min_d is not None and d < min_d:
                    return False
                if max_d is not None and d > max_d:
                    return False
            if s.get("where") and not s["where"](e):
                return False
            return True

        return ok


class Relationships(Collection):
    def _frame_of(self, rows):
        return pd.DataFrame([{"id": r["id"], "type": r["type"], "source": r["source"], "target": r["target"], "directed": r.get("directed", True), **(r.get("data") or {})} for r in rows]) if rows else pd.DataFrame(columns=["id", "type", "source", "target", "directed"])

    @property
    def types(self):
        return _Types(self)

    def type(self, *names):
        want = set()
        for n in names:
            want |= set(n) if isinstance(n, (list, tuple, set)) else {n}
        return self.filter(lambda r: r["type"] in want)

    def sources(self):
        """The entities at members' sources, deduplicated."""
        return _ends_of(self, "source")

    def targets(self):
        return _ends_of(self, "target")

    def ends(self):
        return _ends_of(self, "both")

    def from_(self, x):
        """Members leaving an entity (an id, or a collection of entities)."""
        ids = _ids_of(x)
        return self.filter(lambda r: r["source"] in ids)

    def to(self, x):
        """Members arriving at an entity (an id, or a collection)."""
        ids = _ids_of(x)
        return self.filter(lambda r: r["target"] in ids)

    def _match(self, s):
        """Spec keys: types / type · source / target (an id, a list, a collection) · source_type / target_type · directed · has · data · text (either end's label) · where."""
        types = _as_set(s.get("types", s.get("type")))
        src = _ids_of(s.get("source"))
        tgt = _ids_of(s.get("target"))
        st = _as_set(s.get("source_type", s.get("source_types")))
        tt = _as_set(s.get("target_type", s.get("target_types")))
        has = s.get("has")
        has = [has] if isinstance(has, str) else has
        text = str(s["text"]).lower() if s.get("text") else None

        def ok(r):
            if types is not None and r["type"] not in types:
                return False
            if src is not None and r["source"] not in src:
                return False
            if tgt is not None and r["target"] not in tgt:
                return False
            if st is not None and (_by_id.get(r["source"]) or {}).get("type") not in st:
                return False
            if tt is not None and (_by_id.get(r["target"]) or {}).get("type") not in tt:
                return False
            if "directed" in s and bool(r.get("directed", True)) != bool(s["directed"]):
                return False
            data = r.get("data") or {}
            if has and not all(data.get(k) is not None for k in has):
                return False
            if s.get("data") and not _match_data(data, s["data"]):
                return False
            if text and not (text in _text_of(_by_id.get(r["source"]) or {}) or text in _text_of(_by_id.get(r["target"]) or {})):
                return False
            if s.get("where") and not s["where"](r):
                return False
            return True

        return ok


def _rels_of(coll, dir, rel):
    own = set(coll.ids())
    out = []
    seen = set()
    for id in own:
        rs = _out.get(id, []) if dir == "out" else _in.get(id, []) if dir == "in" else _out.get(id, []) + _in.get(id, [])
        for r in rs:
            if rel and r["type"] != rel:
                continue
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            out.append(r)
    return Relationships(out)


def _ends_of(rels, end):
    seen = set()
    out = []
    for r in rels:
        for id in ([r["source"]] if end == "source" else [r["target"]] if end == "target" else [r["source"], r["target"]]):
            if id in seen:
                continue
            seen.add(id)
            e = _by_id.get(id)
            if e:
                out.append(e)
    return Entities(out)


# ── Dataset helpers ──────────────────────────────────────────────────
def get(id):
    """The entity dict with this id."""
    return _by_id.get(id)


def type_def(name):
    """A type's definition from the ontology: label, category, parent, declared properties, count."""
    return next((t for t in ontology if t["type"] == name), None)


def properties(name):
    """The property keys entities of a type carry — declared or seen — as a DataFrame: key, kind, coverage, declared."""
    rows = [e for e in ds.get("entities", []) if e["type"] == name]  # noqa: the raw dicts, not the collection
    seen = {}
    for e in rows:
        for k, v in (e.get("data") or {}).items():
            if v is None:
                continue
            cur = seen.setdefault(k, {"key": k, "kind": type(v).__name__, "count": 0, "declared": False})
            cur["count"] += 1
    for p in (type_def(name) or {}).get("properties", []):
        cur = seen.setdefault(p["key"], {"key": p["key"], "kind": p.get("kind", "unknown"), "count": 0, "declared": True})
        cur["declared"] = True
        if p.get("kind"):
            cur["kind"] = p["kind"]
    out = [{**p, "coverage": (p["count"] / len(rows)) if rows else 0.0} for p in seen.values()]
    return pd.DataFrame(sorted(out, key=lambda p: (-p["count"], p["key"])), columns=["key", "kind", "count", "coverage", "declared"])


def describe():
    """A plain summary of everything a script can reach: the project, the types with their properties, the relationship types and what they join, the tags, the metrics."""
    ents = ds.get("entities", [])
    rels = ds.get("relationships", [])
    types = {}
    for e in ents:
        types[e["type"]] = types.get(e["type"], 0) + 1
    rtypes = {}
    for r in rels:
        cur = rtypes.setdefault(r["type"], {"type": r["type"], "count": 0, "joins": set()})
        cur["count"] += 1
        s, t = _by_id.get(r["source"]), _by_id.get(r["target"])
        cur["joins"].add(f"{s['type'] if s else '?'} → {t['type'] if t else '?'}")
    return {
        "scope": ds.get("scope"),
        "project": project,
        "entities": len(ents),
        "relationships": len(rels),
        "types": [{"type": t, "count": n, "properties": [f"{p['key']}:{p['kind']}" for p in properties(t).to_dict("records")]} for t, n in sorted(types.items(), key=lambda kv: -kv[1])],
        "relationshipTypes": [{**v, "joins": sorted(v["joins"])} for v in rtypes.values()],
        "tags": [f"{t['tag']} ({t['count']})" for t in tags],
        "metrics": list((ds.get("metrics") or {}).keys()),
    }


def by_type(*types):
    """Entities of these types as a DataFrame (data fields as columns; date-like columns parsed)."""
    df = entities.df
    df = df[df["type"].isin(types)].copy() if len(df) else df
    return _parse_dates(df)


def _parse_dates(df):
    for col in df.columns:
        if col.endswith("At") or col.endswith("_at") or col in ("week", "month", "due", "date"):
            s = df[col]
            if s.dtype == object:
                try:
                    parsed = pd.to_datetime(s, utc=True, errors="coerce")
                    if parsed.notna().sum() >= max(1, int(0.5 * s.notna().sum())):
                        df[col] = parsed
                except Exception:
                    pass
    return df


def out(id, type=None):
    """Relationships leaving an entity, optionally of one type — a collection."""
    return Relationships([r for r in _out.get(id, []) if type is None or r["type"] == type])


def inn(id, type=None):
    """Relationships arriving at an entity — a collection."""
    return Relationships([r for r in _in.get(id, []) if type is None or r["type"] == type])


def neighbors(id, type=None):
    """The entities at the other end of an entity's relationships — a collection."""
    return Entities([_by_id[r["target"]] for r in out(id, type) if r["target"] in _by_id] + [_by_id[r["source"]] for r in inn(id, type) if r["source"] in _by_id])


def degree(id, type=None):
    """How many relationships touch an entity. Counted where they lie: no collection is built to be measured."""
    if type is None:
        return len(_out.get(id, ())) + len(_in.get(id, ()))
    return sum(1 for r in _out.get(id, ()) if r["type"] == type) + sum(1 for r in _in.get(id, ()) if r["type"] == type)


def metric(name, id):
    try:
        return metrics.at[id, name]
    except Exception:
        return None


def graph():
    """The dataset as a networkx DiGraph (nodes carry the entity dict, edges the relationship type)."""
    import networkx as nx

    g = nx.DiGraph()
    for e in ds.get("entities", []):
        g.add_node(e["id"], **{k: v for k, v in e.items() if k != "id"})
    for r in ds.get("relationships", []):
        g.add_edge(r["source"], r["target"], type=r["type"], id=r["id"])
    return g


# ── Time, collections and statistics: the JavaScript helpers, in Python ──
# Same names where Python allows (ms, bin, sum, mean, median, quantile, min, max, distinct, correlation, rollup,
# rolling, range); snake_case for the rest (days_between, hours_between, iso_date, group_by, sort_by, top_k).
def ms(v):
    """Anything date-like to epoch milliseconds (None when it is not a date)."""
    if isinstance(v, datetime):
        return v.timestamp() * 1000
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v if v > 1e11 else v * 1000 if v > 1e8 else None
    if isinstance(v, str):
        try:
            return _parse_ms(v + "-01" if len(v) == 7 else v)
        except Exception:
            return None
    return None


def _parse_ms(t):
    d = datetime.fromisoformat(t.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp() * 1000


def bin(v, unit="month"):
    """Floor a date to hour, day, week (Monday), month, quarter or year; an ISO string, or None for a non-date."""
    t = ms(v)
    if t is None:
        return None
    d = datetime.fromtimestamp(t / 1000, tz=timezone.utc)
    if unit == "hour":
        d = d.replace(minute=0, second=0, microsecond=0)
    elif unit == "day":
        d = d.replace(hour=0, minute=0, second=0, microsecond=0)
    elif unit == "week":
        d = d.replace(hour=0, minute=0, second=0, microsecond=0)
        d = d - __import__("datetime").timedelta(days=d.weekday())
    elif unit == "month":
        d = d.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif unit == "quarter":
        d = d.replace(month=(d.month - 1) // 3 * 3 + 1, day=1, hour=0, minute=0, second=0, microsecond=0)
    elif unit == "year":
        d = d.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        raise ValueError(f"bin: unknown unit {unit}")
    return d.isoformat().replace("+00:00", ".000Z") if d.microsecond == 0 else d.isoformat().replace("+00:00", "Z")


def days_between(a, b):
    return (ms(b) - ms(a)) / 86400000


def hours_between(a, b):
    return (ms(b) - ms(a)) / 3600000


def iso_date(v):
    return datetime.fromtimestamp(ms(v) / 1000, tz=timezone.utc).date().isoformat()


def _nums(xs):
    return [x for x in xs if isinstance(x, (int, float)) and not isinstance(x, bool) and not (isinstance(x, float) and math.isnan(x))]


def count(xs):
    return len(xs)


def mean(xs):
    n = _nums(xs)
    return sum(n) / len(n) if n else None


def quantile(xs, p):
    n = sorted(_nums(xs))
    if not n:
        return None
    i = (len(n) - 1) * p
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    return n[lo] + (n[hi] - n[lo]) * (i - lo)


def median(xs):
    return quantile(xs, 0.5)


def distinct(xs):
    return len(set(json.dumps(x, default=str) for x in xs))


def correlation(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if _nums([x]) and _nums([y])]
    if len(pairs) < 2:
        return None
    mx = sum(x for x, _ in pairs) / len(pairs)
    my = sum(y for _, y in pairs) / len(pairs)
    sxy = sum((x - mx) * (y - my) for x, y in pairs)
    sxx = sum((x - mx) ** 2 for x, _ in pairs)
    syy = sum((y - my) ** 2 for _, y in pairs)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else None


def group_by(items, key):
    """{ key: [items] } — key is a field name, a 'data.x' path, or a function."""
    f = _path_of(key)
    out = {}
    for x in items:
        out.setdefault(f(x), []).append(x)
    return out


def rollup(items, key, value=None, agg="count"):
    """[{ key, value, n, items }] per group, sorted by key — the same as a collection's .rollup()."""
    return Collection(list(items)).rollup(key, value, agg)


def sort_by(items, key, desc=False):
    return _sorted(list(items), _path_of(key), desc)


def top_k(items, key, k=10):
    return sort_by(items, key, True)[:k]


def rolling(xs, n=4):
    """A rolling mean over n points (None until there are n)."""
    out = []
    for i in range(len(xs)):
        w = _nums(xs[max(0, i - n + 1) : i + 1])
        out.append(sum(w) / len(w) if i >= n - 1 and w else None)
    return out


# Plotly trace builders, the same shapes as in JavaScript; opts merge into the trace.
def line(x, y, **opts):
    return {"type": "scatter", "mode": "lines", "x": list(x), "y": list(y), **opts}


def scatter(x, y, **opts):
    return {"type": "scatter", "mode": "markers", "x": list(x), "y": list(y), **opts}


def bar(x, y, **opts):
    return {"type": "bar", "x": list(x), "y": list(y), **opts}


def area(x, y, **opts):
    return {"type": "scatter", "mode": "lines", "fill": "tozeroy", "x": list(x), "y": list(y), **opts}


def box(y, **opts):
    return {"type": "box", "y": list(y), **opts}


def histogram(x, **opts):
    return {"type": "histogram", "x": list(x), **opts}


def heatmap(x, y, z, **opts):
    return {"type": "heatmap", "x": list(x), "y": list(y), "z": [list(r) for r in z], **opts}


def pie(labels, values, **opts):
    return {"type": "pie", "labels": list(labels), "values": list(values), **opts}


def log(*args):
    """Lines shown under the result — print, by the JavaScript name."""
    print(*args)


# ── Output builders (dict form, same contract as JavaScript scripts) ──
def figure(traces, layout=None):
    if not isinstance(traces, list):
        traces = [traces]
    return {"plot": {"data": traces, "layout": layout if isinstance(layout, dict) else ({"title": layout} if layout else {})}}


def table(rows, columns=None):
    if isinstance(rows, pd.DataFrame):
        return {"table": _frame_table(rows)}
    if rows and isinstance(rows[0], dict):
        columns = columns or list(rows[0].keys())
        return {"table": {"columns": columns, "rows": [[r.get(c) for c in columns] for r in rows]}}
    return {"table": {"columns": columns or [], "rows": rows}}


def scene(positions, label=None, groups=None, scale=None):
    s = {"positions": positions}
    if label:
        s["label"] = label
    if groups:
        s["groups"] = groups
    if scale:
        s["scale"] = scale
    return {"scene": s}


def layout(positions, label=None, dimensions=None):
    """Positions per entity id ({'x', 'y', 'z'?}) for the Graph Explorer, saved as a layout that remembers the script."""
    s = {"positions": positions}
    if label:
        s["label"] = label
    if dimensions:
        s["dimensions"] = dimensions
    return {"layout": s}


def style(nodes=None, edges=None, legend=None, label=None, spec=None):
    """A style per entity id for the Graph Explorer: nodes {id: {color, size, opacity, shape, visible, label}},
    edges {id: {color, width, opacity, visible, arrow}}, a legend {title, items: [{label, color}]} or
    {title, palette, domain}, an optional rendering spec for the rest. Saved as a style that remembers the script."""
    s = {}
    if nodes:
        s["nodes"] = nodes
    if edges:
        s["edges"] = edges
    if legend:
        s["legend"] = legend
    if label:
        s["label"] = label
    if spec:
        s["spec"] = spec
    return {"style": s}


def _frame_table(df, limit=5000):
    d = df.head(limit)
    if d.index.name or not isinstance(d.index, pd.RangeIndex):
        d = d.reset_index()
    return {"columns": [str(c) for c in d.columns], "rows": [[_json_safe(v) for v in row] for row in d.itertuples(index=False, name=None)]}


def _json_safe(v):
    if v is None:
        return None
    if isinstance(v, (str, bool)):
        return v
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if (math.isnan(v) or math.isinf(v)) else float(v)
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.isoformat() if not pd.isna(v) else None
    if isinstance(v, np.datetime64):
        return None if np.isnat(v) else pd.Timestamp(v).isoformat()
    if isinstance(v, (np.ndarray, pd.Series, pd.Index)):
        if np.issubdtype(getattr(v, "dtype", np.dtype("O")), np.datetime64) or str(getattr(v, "dtype", "")).startswith("datetime64"):
            return [None if pd.isna(x) else pd.Timestamp(x).isoformat() for x in np.asarray(v)]
        return [_json_safe(x) for x in v.tolist()]
    if isinstance(v, pd.Period):
        return v.to_timestamp().isoformat()
    if isinstance(v, (list, tuple, set)):
        return [_json_safe(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _json_safe(x) for k, x in v.items()}
    if isinstance(v, pd.DataFrame):
        return _frame_table(v)
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    return str(v)


def _to_output(value):
    """A script's value as the host's output object (or None when there is nothing to show)."""
    if value is None:
        return None
    # plotly
    if hasattr(value, "to_plotly_json") and hasattr(value, "data") and hasattr(value, "layout"):
        j = value.to_plotly_json()
        return {"plot": _json_safe({"data": j.get("data", []), "layout": j.get("layout", {})})}
    if isinstance(value, dict) and {"data", "layout"} <= set(value.keys()) and isinstance(value.get("data"), list):
        return {"plot": _json_safe(value)}
    # matplotlib
    mod = type(value).__module__ or ""
    if mod.startswith("matplotlib"):
        fig = value.figure if hasattr(value, "figure") and not hasattr(value, "savefig") else value
        if hasattr(fig, "savefig"):
            import base64

            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=144, bbox_inches="tight")
            return {"image": {"png": base64.b64encode(buf.getvalue()).decode("ascii")}}
    if isinstance(value, Collection):
        return value.table()
    if isinstance(value, pd.DataFrame):
        return {"table": _frame_table(value)}
    if isinstance(value, pd.Series):
        return {"table": _frame_table(value.to_frame())}
    if isinstance(value, dict) and (set(value.keys()) & {"plot", "table", "scene", "text", "image"}):
        return _json_safe(value)
    if isinstance(value, str):
        return {"text": value}
    if isinstance(value, (int, float, bool, np.integer, np.floating)):
        return {"text": str(_json_safe(value))}
    if isinstance(value, (list, tuple, dict, np.ndarray)):
        return {"value": _json_safe(value)}
    return {"text": repr(value)}


class _Capture:
    def __init__(self):
        self.buf = io.StringIO()

    def write(self, s):
        self.buf.write(s)

    def flush(self):
        pass


async def _aegraph_run(code):
    """Execute a script Jupyter-style — top-level await allowed, like a notebook cell; returns JSON: { value, logs, error? }."""
    cap = _Capture()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = cap
    # A namespace of its own for every run, from the prelude as it was when it loaded and the dataset as it is now: a
    # script that rebinds a helper, leaves a `result` or defines a global leaves nothing for the next run to find.
    mod = globals()
    g = dict(_PRISTINE)
    for k in _DATASET_NAMES:
        g[k] = mod[k]
    result = None
    error = None
    try:
        tree = ast.parse(code, "script.py", "exec")
        last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        body = tree.body[:-1] if last is not None else tree.body
        # Compiled with top-level await allowed: eval() then hands back a coroutine when the code awaits, which we run to completion.
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        if body:
            r = eval(compile(ast.Module(body=body, type_ignores=[]), "script.py", "exec", flags=flags), g)
            if inspect.iscoroutine(r):
                await r
        if last is not None:
            result = eval(compile(ast.Expression(last.value), "script.py", "eval", flags=flags), g)
            if inspect.iscoroutine(result):
                result = await result
        if "result" in g and result is None and g["result"] is not None and last is None:
            result = g["result"]
        # matplotlib figures created with pyplot but never returned are shown too.
        if result is None:
            try:
                import matplotlib.pyplot as plt

                if plt.get_fignums():
                    result = plt.gcf()
                    plt.close("all")
            except Exception:
                pass
        value = _to_output(result)
        if result is not None and hasattr(result, "savefig"):
            try:
                import matplotlib.pyplot as plt

                plt.close("all")
            except Exception:
                pass
    except Exception:
        tb = traceback.format_exc()
        # Drop the frames inside this prelude; keep the script's own.
        lines = tb.splitlines()
        keep = [l for l in lines if "prelude.py" not in l and "<exec>" not in l]
        error = {"message": lines[-1] if lines else "error", "stack": "\n".join(keep)}
        value = None
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    logs = [l for l in cap.buf.getvalue().splitlines() if l.strip()]
    return json.dumps({"value": value, "logs": logs, "error": error})


# The names _aegraph_load rebinds for each snapshot, handed to every run's fresh namespace.
_DATASET_NAMES = ("ds", "entities", "relationships", "metrics", "ontology", "project", "tags", "_by_id", "_out", "_in")
# The prelude's namespace as loaded, copied before any script has run: each run starts from a copy of this.
_PRISTINE = dict(globals())
