// Mini-moteur de requêtes Gmail (port de legacy-apps-script/gmail-filter-manager/02_Query.gs).
import { normalizeFilterText_ } from './gfm-text.js';

function parseGmailQuery_(text) {
  const tokens = tokenizeQuery_(String(text || ""));
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === "OR") {
      next();
      const right = parseAnd();
      left = { type: "or", children: [left, right] };
    }
    return left;
  }

  function parseAnd() {
    const children = [];
    while (peek() && peek().type !== "OR" && peek().type !== "RPAREN" && peek().type !== "RBRACE") {
      children.push(parseUnary());
    }
    if (children.length === 0) return { type: "empty" };
    if (children.length === 1) return children[0];
    return { type: "and", children: children };
  }

  function parseUnary() {
    const t = peek();
    if (t.type === "NOT") {
      next();
      return { type: "not", child: parseUnary() };
    }
    return parsePrimary(null);
  }

  function parsePrimary(field) {
    const t = next();
    if (!t) return { type: "empty" };

    if (t.type === "LPAREN") {
      const inner = parseOr();
      if (peek() && peek().type === "RPAREN") next();
      return field ? applyField_(inner, field) : inner;
    }

    if (t.type === "LBRACE") {
      // {a b c} = a OR b OR c
      const children = [];
      while (peek() && peek().type !== "RBRACE") {
        if (peek().type === "OR") { next(); continue; }
        children.push(parseUnary());
      }
      if (peek()) next();
      const node = children.length === 1 ? children[0] : { type: "or", children: children };
      return field ? applyField_(node, field) : node;
    }

    if (t.type === "FIELD") {
      return parsePrimary(t.value);
    }

    if (t.type === "PHRASE" || t.type === "WORD") {
      return { type: "leaf", field: field || "", text: t.value, quoted: t.type === "PHRASE" };
    }

    return { type: "empty" };
  }

  return parseOr();
}

function applyField_(node, field) {
  if (!node) return node;
  if (node.type === "leaf") {
    if (!node.field) node.field = field;
    return node;
  }
  if (node.children) node.children.forEach(function(c) { applyField_(c, field); });
  if (node.child) applyField_(node.child, field);
  return node;
}

function tokenizeQuery_(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  const FIELDS = { from: 1, to: 1, subject: 1, cc: 1, bcc: 1, list: 1, deliveredto: 1, label: 1, filename: 1 };

  while (i < n) {
    const c = s[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(") { out.push({ type: "LPAREN" }); i++; continue; }
    if (c === ")") { out.push({ type: "RPAREN" }); i++; continue; }
    if (c === "{") { out.push({ type: "LBRACE" }); i++; continue; }
    if (c === "}") { out.push({ type: "RBRACE" }); i++; continue; }
    if (c === "-" && i + 1 < n && s[i + 1] !== " ") { out.push({ type: "NOT" }); i++; continue; }

    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j++;
      out.push({ type: "PHRASE", value: s.substring(i + 1, j) });
      i = j + 1;
      continue;
    }

    // mot / champ
    let j = i;
    while (j < n && !/[\s(){}"]/.test(s[j])) j++;
    let word = s.substring(i, j);
    i = j;

    if (word === "OR" || word === "|") { out.push({ type: "OR" }); continue; }
    if (word === "AND") { continue; }

    const m = word.match(/^([a-zA-Z]+):(.*)$/);
    if (m && FIELDS[m[1].toLowerCase()]) {
      out.push({ type: "FIELD", value: m[1].toLowerCase() });
      if (m[2]) {
        if (m[2][0] === '"') {
          // from:"x y" → la phrase suit ; on remet le reste dans le flux
          i -= m[2].length;
        } else {
          out.push({ type: "WORD", value: m[2] });
        }
      }
      continue;
    }

    out.push({ type: "WORD", value: word });
  }
  return out;
}

function evalQuery_(node, mail) {
  if (!node || node.type === "empty") return { matched: true, hits: [] };

  switch (node.type) {
    case "leaf": {
      const ok = leafMatches_(node, mail);
      return { matched: ok, hits: ok ? [node] : [] };
    }
    case "not": {
      const r = evalQuery_(node.child, mail);
      return { matched: !r.matched, hits: [] };
    }
    case "and": {
      let hits = [];
      for (let i = 0; i < node.children.length; i++) {
        const r = evalQuery_(node.children[i], mail);
        if (!r.matched) return { matched: false, hits: [] };
        hits = hits.concat(r.hits);
      }
      return { matched: true, hits: hits };
    }
    case "or": {
      let hits = [];
      let any = false;
      for (let i = 0; i < node.children.length; i++) {
        const r = evalQuery_(node.children[i], mail);
        if (r.matched) { any = true; hits = hits.concat(r.hits); }
      }
      return { matched: any, hits: hits };
    }
  }
  return { matched: false, hits: [] };
}

function leafMatches_(leaf, mail) {
  const needle = normalizeFilterText_(leaf.text);
  if (!needle) return true;

  switch (leaf.field) {
    case "from":
      return mail.fromText.indexOf(needle) >= 0 || mail.fromEmail.indexOf(needle) >= 0;
    case "to":
    case "cc":
    case "bcc":
    case "deliveredto":
      return mail.toText.indexOf(needle) >= 0;
    case "subject":
      return containsWholeWords_(mail.subject, needle);
    case "list":
      return mail.fromText.indexOf(needle) >= 0 || mail.toText.indexOf(needle) >= 0;
    default:
      return containsWholeWords_(mail.searchableText, needle);
  }
}

/** Correspondance "mots entiers" (comme Gmail), sur texte normalisé. */
function containsWholeWords_(haystack, needle) {
  if (!needle) return true;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re;
  try {
    re = new RegExp("(^|[^\\p{L}\\p{N}])" + esc + "($|[^\\p{L}\\p{N}])", "u");
  } catch (e) {
    return haystack.indexOf(needle) >= 0;
  }
  return re.test(haystack);
}

function collectLeaves_(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === "leaf") { out.push(node); return out; }
  if (node.type === "not") return out; // une exclusion n'est pas un déclencheur
  (node.children || []).forEach(function(c) { collectLeaves_(c, out); });
  return out;
}

function describeLeaf_(leaf) {
  const txt = leaf.quoted ? '"' + leaf.text + '"' : leaf.text;
  return leaf.field ? leaf.field + ":" + txt : txt;
}

export {
  parseGmailQuery_,
  applyField_,
  tokenizeQuery_,
  evalQuery_,
  leafMatches_,
  containsWholeWords_,
  collectLeaves_,
  describeLeaf_
};
