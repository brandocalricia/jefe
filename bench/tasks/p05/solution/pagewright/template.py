"""The template language (SPEC part B)."""

import re
from collections import ChainMap

from .errors import TemplateError
from .markdown import escape

MAX_INCLUDE_DEPTH = 10

_OPEN = re.compile(r"\{\{\{|\{\{|\{%")
_CLOSE = {"{{{": "}}}", "{{": "}}", "{%": "%}"}
_PATH = r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*"
_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_VAR = re.compile(_PATH + r"\Z")
_IF = re.compile(r"if +(?:(not) +)?(%s)\Z" % _PATH)
_FOR = re.compile(r"for +(%s) +in +(%s)\Z" % (_NAME, _PATH))
_INCLUDE = re.compile(r'include +"([^"]+)"\Z')
_KNOWN = ("if", "for", "include", "else", "endif", "endfor")


def _tokenize(src, name):
    tokens = []
    pos = 0
    line = 1
    while pos < len(src):
        m = _OPEN.search(src, pos)
        if not m:
            tokens.append(("text", src[pos:], line))
            break
        text = src[pos:m.start()]
        if text:
            tokens.append(("text", text, line))
        line += text.count("\n")
        eol = src.find("\n", m.end())
        eol = len(src) if eol == -1 else eol
        end = src.find(_CLOSE[m.group()], m.end(), eol)
        if end == -1:
            raise TemplateError("%s:%d: unterminated tag" % (name, line))
        kind = {"{{{": "raw", "{{": "var", "{%": "tag"}[m.group()]
        tokens.append((kind, src[m.end():end].strip(), line))
        pos = end + len(_CLOSE[m.group()])
    return tokens


def _parse(src, name):
    root = []
    cur = root
    stack = []  # (node, parent list)
    for kind, value, line in _tokenize(src, name):
        if kind == "text":
            cur.append(("text", value))
        elif kind in ("var", "raw"):
            if not _VAR.match(value):
                raise TemplateError("%s:%d: invalid expression" % (name, line))
            cur.append((kind, value, line))
        else:
            word = value.split()[0] if value else ""
            if word not in _KNOWN:
                raise TemplateError('%s:%d: unknown tag "%s"' % (name, line, word))
            if word in ("else", "endif", "endfor"):
                if value != word:
                    raise TemplateError('%s:%d: invalid "%s" tag' % (name, line, word))
                want = "for" if word == "endfor" else "if"
                top = stack[-1][0] if stack else None
                if top is None or top["kind"] != want or (word == "else" and top["in_else"]):
                    raise TemplateError('%s:%d: unexpected "%s"' % (name, line, word))
                if word == "else":
                    top["in_else"] = True
                    cur = top["else"]
                else:
                    cur = stack.pop()[1]
            elif word == "include":
                m = _INCLUDE.match(value)
                if not m:
                    raise TemplateError('%s:%d: invalid "include" tag' % (name, line))
                cur.append(("include", m.group(1), line))
            else:
                m = (_IF if word == "if" else _FOR).match(value)
                if not m:
                    raise TemplateError('%s:%d: invalid "%s" tag' % (name, line, word))
                node = {"kind": word, "line": line, "body": [], "else": [], "in_else": False}
                if word == "if":
                    node["negate"], node["path"] = bool(m.group(1)), m.group(2)
                else:
                    node["var"], node["path"] = m.group(1), m.group(2)
                cur.append(("block", node))
                stack.append((node, cur))
                cur = node["body"]
    if stack:
        node = stack[-1][0]
        raise TemplateError('%s:%d: unclosed "%s" block' % (name, node["line"], node["kind"]))
    return root


def _lookup(path, scope, name, line):
    parts = path.split(".")
    missing = TemplateError('%s:%d: unknown variable "%s"' % (name, line, path))
    if parts[0] not in scope:
        raise missing
    cur = scope[parts[0]]
    for part in parts[1:]:
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            raise missing
    return cur


def _text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _run(nodes, scope, env, name, depth, out):
    for node in nodes:
        kind = node[0]
        if kind == "text":
            out.append(node[1])
        elif kind in ("var", "raw"):
            text = _text(_lookup(node[1], scope, name, node[2]))
            out.append(escape(text) if kind == "var" else text)
        elif kind == "include":
            if depth + 1 > MAX_INCLUDE_DEPTH:
                raise TemplateError("%s:%d: includes nested too deeply" % (name, node[2]))
            if node[1] not in env:
                raise TemplateError('%s:%d: unknown include "%s"' % (name, node[2], node[1]))
            _run(_parse(env[node[1]], node[1]), scope, env, node[1], depth + 1, out)
        else:
            block = node[1]
            value = _lookup(block["path"], scope, name, block["line"])
            if block["kind"] == "if":
                branch = block["body"] if bool(value) != block["negate"] else block["else"]
                _run(branch, scope, env, name, depth, out)
            else:
                if not isinstance(value, (list, tuple)):
                    raise TemplateError('%s:%d: "%s" is not a list' % (name, block["line"], block["path"]))
                for i, item in enumerate(value):
                    loop = {"index": i + 1, "first": i == 0, "last": i == len(value) - 1}
                    inner = scope.new_child({block["var"]: item, "loop": loop})
                    _run(block["body"], inner, env, name, depth, out)


def render(source, context, includes=None, name="template"):
    nodes = _parse(source, name)
    out = []
    _run(nodes, ChainMap({}, context), includes or {}, name, 0, out)
    return "".join(out)
