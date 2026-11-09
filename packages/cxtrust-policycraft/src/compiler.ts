// PolicyCraft — deterministic natural-language → Policy compiler.
//
// AUTHORING-TIME ONLY. This module is pure string-to-structure: it parses a
// restricted plain-English grammar into core `Policy` artifacts. Nothing here
// is ever evaluated as code (no eval, no Function, no dynamic import); the
// compiled artifacts are what the runtime engine (core compilePolicy /
// evaluateAction) executes on the decision path.
//
// Grammar: one rule per paragraph (blank-line-separated) or per line.
//   IF <cond> (AND|OR <cond>)* (THEN|->) <action> (,|AND <action>)*
// WHEN is accepted for IF; '->' for THEN. AND and OR must not mix at the
// same level within one rule.

import type { EnforcementAction } from '@cxtrust/core/src/schema.ts';
import type { Policy, PolicyCondition, PolicyRule } from '@cxtrust/core/src/policy.ts';

// ---------- public result types ----------

export interface CompileError {
  line: number;
  message: string;
}

export type CompileResult =
  | { ok: true; policy: Policy; warnings: string[] }
  | { ok: false; errors: CompileError[] };

export interface CompileOptions {
  policyId?: string;
  name?: string;
  version?: number;
  failMode?: 'OPEN' | 'CLOSED' | 'RESTRICTED';
}

// ---------- field alias table (alias → dot-path into PolicyEvalContext) ----------

const FIELD_ALIASES: ReadonlyArray<{ alias: string; path: string }> = [
  { alias: 'synthetic voice probability', path: 'syntheticVoiceProbability' },
  { alias: 'identity confidence', path: 'participant.identityConfidence' },
  { alias: 'risk score', path: 'risk.overall' },
  { alias: 'overall risk', path: 'risk.overall' },
  { alias: 'requested action', path: 'requestedAction' },
  { alias: 'amount', path: 'amount' },
  { alias: 'transaction amount', path: 'amount' },
  { alias: 'agent type', path: 'participant.kind' },
  { alias: 'participant kind', path: 'participant.kind' },
  { alias: 'classification', path: 'classification' },
  { alias: 'participant type', path: 'classification' },
  { alias: 'prompt injection', path: 'promptInjectionDetected' },
  { alias: 'data class', path: 'dataClass' },
  { alias: 'data classification', path: 'dataClass' },
  { alias: 'tool', path: 'tool' },
  { alias: 'intent', path: 'intent' },
  { alias: 'passport verified', path: 'participant.passportVerified' },
  { alias: 'agent id', path: 'agent.agentId' },
  { alias: 'agent', path: 'agent.agentId' },
];

const ALIAS_TO_PATH = new Map<string, string>(FIELD_ALIASES.map(f => [f.alias, f.path]));

/** Longest aliases first so 'agent id' wins over 'agent', 'risk score' over
 *  any shorter prefix, 'data classification' over 'data class'. */
const SORTED_ALIASES = [...FIELD_ALIASES.map(f => f.alias)].sort((a, b) => b.length - a.length);

/** Matches an alias at the start of a (trimmed) segment: case-insensitive,
 *  word separators may be spaces, underscores, or hyphens. */
const ALIAS_MATCHERS: Array<{ alias: string; path: string; re: RegExp }> = SORTED_ALIASES.map(alias => ({
  alias,
  path: ALIAS_TO_PATH.get(alias)!,
  re: new RegExp(
    '^' + alias.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+') + '(?![A-Za-z0-9])',
    'i',
  ),
}));

// ---------- operator table (earliest position wins; longer phrase on ties) ----------

interface OpSpec {
  phrase: string;
  /** 'ne_exists' is a pre-op handled specially in parseCondition. */
  op: PolicyCondition['op'] | 'ne_exists';
  symbol: string;
  wordBoundary: boolean; // phrase-based (words) vs symbol-based
}

const OPERATORS: OpSpec[] = [
  { phrase: 'is greater than or equal to', op: 'gte', symbol: '>=', wordBoundary: true },
  { phrase: 'is less than or equal to', op: 'lte', symbol: '<=', wordBoundary: true },
  { phrase: 'greater than or equal to', op: 'gte', symbol: '>=', wordBoundary: true },
  { phrase: 'less than or equal to', op: 'lte', symbol: '<=', wordBoundary: true },
  { phrase: 'is not one of', op: 'in', symbol: 'not in', wordBoundary: true },
  { phrase: 'is greater than', op: 'gt', symbol: '>', wordBoundary: true },
  { phrase: 'is less than', op: 'lt', symbol: '<', wordBoundary: true },
  { phrase: 'is at least', op: 'gte', symbol: '>=', wordBoundary: true },
  { phrase: 'is at most', op: 'lte', symbol: '<=', wordBoundary: true },
  { phrase: 'is one of', op: 'in', symbol: 'is one of', wordBoundary: true },
  { phrase: 'greater than', op: 'gt', symbol: '>', wordBoundary: true },
  { phrase: 'less than', op: 'lt', symbol: '<', wordBoundary: true },
  { phrase: 'at least', op: 'gte', symbol: '>=', wordBoundary: true },
  { phrase: 'at most', op: 'lte', symbol: '<=', wordBoundary: true },
  { phrase: 'is not', op: 'ne', symbol: '!=', wordBoundary: true },
  { phrase: 'does not exist', op: 'ne_exists', symbol: 'does not exist', wordBoundary: true },
  { phrase: 'is not present', op: 'ne_exists', symbol: 'is not present', wordBoundary: true },
  { phrase: 'not present', op: 'ne_exists', symbol: 'not present', wordBoundary: true },
  { phrase: 'equals', op: 'eq', symbol: '=', wordBoundary: true },
  { phrase: 'contains', op: 'contains', symbol: 'contains', wordBoundary: true },
  { phrase: 'is present', op: 'exists', symbol: 'exists', wordBoundary: true },
  { phrase: 'exists', op: 'exists', symbol: 'exists', wordBoundary: true },
  { phrase: 'is', op: 'eq', symbol: '=', wordBoundary: true },
  { phrase: 'not', op: 'ne', symbol: '!=', wordBoundary: true },
  { phrase: '>=', op: 'gte', symbol: '>=', wordBoundary: false },
  { phrase: '<=', op: 'lte', symbol: '<=', wordBoundary: false },
  { phrase: '!=', op: 'ne', symbol: '!=', wordBoundary: false },
  { phrase: '>', op: 'gt', symbol: '>', wordBoundary: false },
  { phrase: '<', op: 'lt', symbol: '<', wordBoundary: false },
  { phrase: '=', op: 'eq', symbol: '=', wordBoundary: false },
];

const CRITICAL_ACTIONS = new Set<string>(['DENY', 'TERMINATE', 'QUARANTINE']);
const HIGH_ACTIONS = new Set<string>(['REQUIRE_APPROVAL', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN']);
const MEDIUM_ACTIONS = new Set<string>(['MASK', 'REDACT', 'WARN']);

// ---------- action vocabulary ----------

const ENFORCEMENT_ACTIONS: EnforcementAction[] = [
  'ALLOW', 'ALLOW_WITH_MONITORING', 'WARN', 'REDACT', 'MASK', 'CHALLENGE',
  'STEP_UP_AUTH', 'REQUIRE_APPROVAL', 'HANDOFF_TO_HUMAN', 'QUARANTINE', 'DENY', 'TERMINATE',
];
const ACTION_SET = new Set<string>(ENFORCEMENT_ACTIONS);

/** Friendly phrases → EnforcementAction. Bare enum names also match after
 *  case + underscore/hyphen normalization. CHALLENGE has no friendly form. */
const FRIENDLY_ACTIONS: Record<string, EnforcementAction> = {
  'require human approval': 'REQUIRE_APPROVAL',
  'require approval': 'REQUIRE_APPROVAL',
  'block': 'DENY',
  'step up authentication': 'STEP_UP_AUTH',
  'force mfa': 'STEP_UP_AUTH',
  'transfer to human': 'HANDOFF_TO_HUMAN',
  'handoff': 'HANDOFF_TO_HUMAN',
  'mask': 'MASK',
  'redact': 'REDACT',
  'warn': 'WARN',
  'allow with monitoring': 'ALLOW_WITH_MONITORING',
  'allow': 'ALLOW',
  'disable external tools': 'QUARANTINE',
  'quarantine': 'QUARANTINE',
  'terminate': 'TERMINATE',
};

// ---------- small string utilities (no eval anywhere) ----------

function normalizeWords(s: string): string {
  return s.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

/** Levenshtein edit distance (two-row DP). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

class ParseError extends Error {
  line: number | null;
  constructor(message: string) {
    super(message);
    this.line = null;
  }
}

/** Alias-start regex for in-list disambiguation (see splitTopLevel). */
const ALIAS_START_RE = new RegExp(
  '^(' + SORTED_ALIASES.map(a =>
    a.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+'),
  ).join('|') + ')(?![A-Za-z0-9])',
  'i',
);

/**
 * Split text on whole-word ` and ` / ` or ` (case-insensitive) and any
 * comma, never inside quoted spans or parentheses. Returns
 * { segments, delimiters } — delimiters[i] sits between segments[i] and
 * segments[i+1].
 *
 * List state: within a segment whose text already contains `is one of`,
 * AND/OR are treated as list separators (kept inside the segment) UNLESS the
 * text right after the delimiter starts with a known field alias — then the
 * author clearly meant a new condition. Use parentheses for lists that would
 * otherwise be ambiguous.
 */
function splitTopLevel(
  text: string,
  opts: { comma: boolean; and: boolean; or: boolean },
): { segments: string[]; delimiters: string[] } {
  const segs: string[] = [];
  const delims: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && depth > 0) depth--;
    if (depth === 0) {
      const beforeIsBoundary = buf.length === 0 || /\s/.test(buf[buf.length - 1]);
      if (opts.comma && ch === ',') {
        delims.push(',');
        segs.push(buf);
        buf = '';
        continue;
      }
      if ((opts.and || opts.or) && beforeIsBoundary) {
        const rest = text.slice(i);
        const andM = opts.and ? /^and(?![A-Za-z0-9])/i.exec(rest) : null;
        const orM = opts.or ? /^or(?![A-Za-z0-9])/i.exec(rest) : null;
        const m = andM ?? orM;
        if (m) {
          const inList = /\bis one of\b/i.test(matchSurface(buf));
          const startsNewCond = ALIAS_START_RE.test(rest.slice(m[0].length).trimStart());
          if (!inList || startsNewCond) {
            delims.push(m[0].toUpperCase());
            segs.push(buf);
            buf = '';
            i += m[0].length - 1; // for-loop re-increments
            continue;
          }
        }
      }
    }
    buf += ch;
  }
  segs.push(buf);
  return { segments: segs, delimiters: delims };
}

/** Blank out quoted spans (keeping length/indices) so operator/keyword
 *  scanning never matches inside string literals. */
function maskQuoted(s: string): string {
  let out = '';
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      out += ' ';
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------- condition parsing ----------

interface ParsedCondition {
  cond: PolicyCondition;
  display: string; // human-readable fragment using the dot-path
}

function parseValue(raw: string, fieldPath: string): unknown {
  const t = raw.trim();
  const unq = stripQuotes(t);
  if (unq !== t) return unq; // quoted string kept verbatim
  const lower = unq.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'detected') return fieldPath === 'promptInjectionDetected' ? true : unq;
  let n = unq.replace(/,/g, '');
  let numeric = false;
  if (/^\$[\d,]+(\.\d+)?(\s+dollars?)?$/i.test(unq)) { n = unq.slice(1).replace(/,/g, '').replace(/\s+dollars?$/i, ''); numeric = true; }
  else if (/^[\d,]+(\.\d+)?\s+dollars?$/i.test(unq)) { n = unq.replace(/,/g, '').replace(/\s+dollars?$/i, ''); numeric = true; }
  if (/^-?\d+(\.\d+)?$/.test(n)) numeric = true;
  if (numeric) {
    const v = Number(n);
    if (!Number.isFinite(v)) throw new ParseError(`invalid numeric value '${t}'`);
    return v;
  }
  return unq; // bare identifier kept as-is (uppercase action-ish names)
}

/** Length-preserving match surface: separators folded to spaces, quotes
 *  blanked, lowercased — indices stay aligned with the original text so the
 *  value can always be sliced out verbatim from the ORIGINAL string. */
function matchSurface(s: string): string {
  return maskQuoted(s).replace(/[_-]/g, ' ').toLowerCase();
}

/** Longest-alias-first match at the start of the match surface. */
function findField(cleaned: string, scan: string): { alias: string; path: string; end: number } {
  if (cleaned.trim().length === 0) throw new ParseError('missing field name');
  for (const m of ALIAS_MATCHERS) {
    const hit = m.re.exec(scan);
    if (hit) return { alias: m.alias, path: m.path, end: hit[0].length };
  }
  // nearest-alias suggestions within edit distance 2 (full segment head,
  // first head token vs alias or alias's first word)
  const norm = normalizeWords(cleaned);
  const head = norm.split(' ')[0] ?? norm;
  const scored = SORTED_ALIASES
    .map(a => ({
      a,
      d: Math.min(
        editDistance(norm, a),
        editDistance(head, a),
        editDistance(head, a.split(' ')[0]),
      ),
    }))
    .filter(x => x.d <= 2)
    .sort((x, y) => x.d - y.d || x.a.length - y.a.length);
  const seen = new Set<string>();
  const uniq = scored.filter(x => (seen.has(x.a) ? false : (seen.add(x.a), true))).slice(0, 3);
  const hint = uniq.length
    ? ` — did you mean ${uniq.map(x => `'${x.a}'`).join(', ')}?`
    : ` — known aliases: ${SORTED_ALIASES.join(', ')}`;
  throw new ParseError(`unknown field '${norm.split(' ').slice(0, 3).join(' ')}'${hint}`);
}

/** Earliest operator occurrence on the match surface (longer phrase on ties). */
function findOperator(scan: string, from: number): { spec: OpSpec; pos: number } | null {
  let best: { spec: OpSpec; pos: number } | null = null;
  for (const spec of OPERATORS) {
    const pos = scan.indexOf(spec.phrase, from);
    if (pos < 0) continue;
    if (spec.wordBoundary) {
      const after = scan[pos + spec.phrase.length];
      if (after !== undefined && after !== ' ') continue; // 'is' inside 'issue' etc.
      if (pos > from && scan[pos - 1] !== ' ') continue; // whole-word on the left
    }
    if (!best || pos < best.pos || (pos === best.pos && spec.phrase.length > best.spec.phrase.length)) {
      best = { spec, pos };
    }
  }
  return best;
}

function displayValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(x)).join(', ')}]`;
  return JSON.stringify(v);
}

function parseCondition(seg: string): ParsedCondition {
  const cleaned = seg.trim().replace(/[;]+$/g, '').replace(/(?<=\S)\.+(?=\s*$)/g, '');
  const scan = matchSurface(cleaned);
  const field = findField(cleaned, scan);
  const op = findOperator(scan, field.end);
  if (!op) {
    throw new ParseError(`unparseable condition '${cleaned}' — no recognized operator after '${field.alias}'`);
  }
  const left = scan.slice(field.end, op.pos).trim();
  const right = cleaned.slice(op.pos + op.spec.phrase.length).trim();
  if (left.length > 0) {
    throw new ParseError(`unexpected text '${cleaned.slice(field.end, op.pos).trim()}' between '${field.alias}' and '${op.spec.phrase}'`);
  }
  const { spec } = op;

  if (spec.op === 'exists') {
    if (right.length > 0) throw new ParseError(`'${spec.phrase}' takes no value (got '${right}')`);
    return {
      cond: { field: field.path, op: 'exists', value: true },
      display: `${field.path} exists`,
    };
  }
  if (spec.op === 'ne_exists') {
    if (right.length > 0) throw new ParseError(`'${spec.phrase}' takes no value (got '${right}')`);
    throw new ParseError(
      `'${spec.phrase}' cannot be expressed — the engine has no negated exists; use 'is not <value>' against a known value instead`,
    );
  }
  if (right.length === 0) {
    throw new ParseError(`missing value after '${spec.phrase}' in condition '${seg.trim()}'`);
  }

  let value: unknown;
  let display: string;
  if (spec.op === 'in') {
    if (spec.symbol === 'not in') {
      throw new ParseError(`negated list ('${spec.phrase}') is not supported in this grammar — split into AND-joined 'is different from' style rules`);
    }
    const listText = /^\(([\s\S]*)\)$/.test(right) ? right.slice(1, -1) : right;
    const { segments } = splitTopLevel(listText, { comma: true, and: true, or: true });
    const tokens = segments.map(s => s.trim()).filter(s => s.length > 0);
    if (tokens.length === 0) throw new ParseError(`'${spec.phrase}' requires a list of values`);
    value = tokens.map(tok => parseValue(tok, field.path));
    display = `${field.path} is one of ${displayValue(value)}`;
    return { cond: { field: field.path, op: 'in', value }, display };
  }
  value = parseValue(right, field.path);
  display = `${field.path} ${spec.symbol} ${displayValue(value)}`;
  return { cond: { field: field.path, op: spec.op, value }, display };
}

// ---------- action parsing ----------

function parseAction(raw: string): EnforcementAction {
  const phrase = normalizeWords(stripQuotes(raw)).replace(/[.!]+$/g, '').trim();
  if (phrase.length === 0) throw new ParseError(`empty action '${raw.trim()}'`);
  const enumKey = phrase.replace(/ /g, '_').toUpperCase();
  if (ACTION_SET.has(enumKey)) return enumKey as EnforcementAction;
  const friendly = FRIENDLY_ACTIONS[phrase];
  if (friendly) return friendly;
  throw new ParseError(
    `unknown action '${raw.trim()}' — allowed actions: ${[...ENFORCEMENT_ACTIONS].sort().join(', ')}; ` +
    `friendly forms: ${Object.keys(FRIENDLY_ACTIONS).map(a => `'${a}'`).join(', ')}`,
  );
}

function inferSeverity(actions: EnforcementAction[]): PolicyRule['severity'] {
  if (actions.some(a => CRITICAL_ACTIONS.has(a))) return 'CRITICAL';
  if (actions.some(a => HIGH_ACTIONS.has(a))) return 'HIGH';
  if (actions.some(a => MEDIUM_ACTIONS.has(a))) return 'MEDIUM';
  return 'LOW';
}

// ---------- rule UI rendering ----------

/** Human restatement of a compiled rule: IF/THEN text using dot-paths.
 *  Exported for UI rendering. */
export function describeRule(rule: PolicyRule): string {
  const joiner = rule.match === 'ALL' ? ' AND ' : ' OR ';
  const conds = rule.conditions.map(c => {
    if (c.op === 'exists') return `${c.field} exists`;
    if (c.op === 'in') return `${c.field} is one of ${displayValue(c.value)}`;
    if (c.op === 'contains') return `${c.field} contains ${displayValue(c.value)}`;
    return `${c.field} ${symbolForOp(c.op)} ${displayValue(c.value)}`;
  }).join(joiner);
  return `IF ${conds} THEN ${rule.actions.join(' AND ')}`;
}

function symbolForOp(op: PolicyCondition['op']): string {
  switch (op) {
    case 'eq': return '=';
    case 'ne': return '!=';
    case 'gt': return '>';
    case 'lt': return '<';
    case 'gte': return '>=';
    case 'lte': return '<=';
    default: return op;
  }
}

// ---------- rule block parsing ----------

function parseRuleBlock(lines: Array<{ text: string; line: number }>, warnings: string[], index: number): PolicyRule {
  const id = `NL_${index + 1}`;
  const joined = lines.map(l => l.text.trim()).join(' ');
  const firstLine = lines[0].line;
  const at = (msg: string): ParseError => {
    const e = new ParseError(`${id} (line ${firstLine}): ${msg}`);
    e.line = firstLine;
    return e;
  };

  const m = /^(if|when)\b([\s\S]*?)(\bthen\b|->)(.*)$/i.exec(joined);
  if (!m) {
    throw at(`unparseable rule — expected "IF <conditions> THEN <actions>" (WHEN and -> also accepted), got: '${joined}'`);
  }
  const condSection = m[2].trim();
  const actionsSection = m[4].trim().replace(/[.]+$/g, '');
  if (condSection.length === 0) throw at('no conditions between IF and THEN');
  if (actionsSection.length === 0) throw at('no actions after THEN');

  // find which line a segment fragment lives on (for precise error lines)
  const locate = (needle: string): number => {
    const n = needle.toLowerCase();
    for (const l of lines) if (l.text.toLowerCase().replace(/\s+/g, ' ').includes(n)) return l.line;
    return firstLine;
  };

  const { segments: condSegs, delimiters: joins } = splitTopLevel(condSection, { comma: false, and: true, or: true });
  const joinKinds = new Set(joins);
  if (joinKinds.size > 1) {
    throw at('rule mixes AND and OR at the same level — split it into separate rules, one match mode each');
  }
  const match: PolicyRule['match'] = joinKinds.has('OR') ? 'ANY' : 'ALL';

  const conditions: PolicyCondition[] = [];
  const seen = new Set<string>();
  condSegs.forEach((seg, idx) => {
    const trimmed = seg.trim();
    if (trimmed.length === 0) {
      throw at(`empty condition between ${joins[idx - 1] ?? 'IF'} and ${joins[idx] ?? 'THEN'}`);
    }
    let pc: ParsedCondition;
    try {
      pc = parseCondition(trimmed);
    } catch (e) {
      if (e instanceof ParseError) {
        const line = locate(trimmed.slice(0, 24));
        e.line = line;
        e.message = `${id} (line ${line}): ${e.message}`;
      }
      throw e;
    }
    const key = `${pc.cond.field}|${pc.cond.op}|${JSON.stringify(pc.cond.value)}`;
    if (seen.has(key)) {
      warnings.push(`${id}: duplicate condition (${pc.display}) — engine evaluates conditions as a set, one was dropped`);
    } else {
      seen.add(key);
      conditions.push(pc.cond);
    }
  });

  const { segments: actionSegs } = splitTopLevel(actionsSection, { comma: true, and: true, or: false });
  const actions: EnforcementAction[] = [];
  for (const seg of actionSegs) {
    const trimmed = seg.trim();
    if (trimmed.length === 0) continue;
    let act: EnforcementAction;
    try {
      act = parseAction(trimmed);
    } catch (e) {
      if (e instanceof ParseError) {
        const line = locate(trimmed.slice(0, 24));
        e.line = line;
        e.message = `${id} (line ${line}): ${e.message}`;
      }
      throw e;
    }
    if (!actions.includes(act)) actions.push(act);
  }
  if (actions.length === 0) throw at(`no valid actions after THEN: '${actionsSection}'`);

  const severity = inferSeverity(actions);
  const hasDenyLike = actions.some(a => CRITICAL_ACTIONS.has(a));
  const hasAllowLike = actions.some(a => a === 'ALLOW' || a === 'ALLOW_WITH_MONITORING');
  if (hasDenyLike && hasAllowLike) {
    warnings.push(`${id}: rule mixes DENY-like and ALLOW-like actions — engine reports not-allowed (only ALLOW / ALLOW_WITH_MONITORING / WARN permit)`);
  }
  if (actions.every(a => a === 'ALLOW')) {
    warnings.push(`${id}: rule only allows — it changes nothing unless it shadows a stricter earlier rule`);
  }

  const rule: PolicyRule = {
    id,
    description: '',
    conditions,
    match,
    actions,
    severity,
  };
  rule.description = describeRule(rule);
  return rule;
}

// ---------- public API ----------

/**
 * Compile restricted plain-English policy text into a core `Policy`.
 * Pure, deterministic, authoring-time only. ALL errors across the text are
 * collected before failing (not just the first). On success returns the
 * policy plus non-fatal warnings.
 */
export function compilePolicyText(text: string, opts?: CompileOptions): CompileResult {
  const warnings: string[] = [];

  // 1. split into rule blocks: blank lines and comment lines separate rules;
  //    a line that reopens IF/WHEN starts a new rule even without a blank line.
  const rawLines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<Array<{ text: string; line: number }>> = [];
  let current: Array<{ text: string; line: number }> = [];
  const flush = () => { if (current.length > 0) { blocks.push(current); current = []; } };
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      flush();
      continue;
    }
    if (current.length > 0 && /^(if|when)\b/i.test(trimmed)) flush();
    current.push({ text: trimmed, line: i + 1 });
  }
  flush();

  if (blocks.length === 0) {
    return {
      ok: false,
      errors: [{ line: 1, message: 'policy text is empty — expected at least one rule: IF <conditions> THEN <actions>' }],
    };
  }

  // 2. parse every rule, collecting all errors
  const errors: CompileError[] = [];
  const rules: PolicyRule[] = [];
  for (const block of blocks) {
    try {
      rules.push(parseRuleBlock(block, warnings, rules.length));
    } catch (e) {
      if (e instanceof ParseError) {
        errors.push({ line: e.line ?? block[0].line, message: e.message });
      } else {
        errors.push({ line: block[0].line, message: `internal parse failure: ${(e as Error).message}` });
      }
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.line - b.line);
    return { ok: false, errors };
  }

  const policy: Policy = {
    policyId: opts?.policyId ?? 'nl-policy',
    name: opts?.name ?? 'Natural Language Policy',
    version: opts?.version ?? 1,
    failMode: opts?.failMode ?? 'RESTRICTED',
    rules,
  };
  return { ok: true, policy, warnings };
}

/** Field alias table, exported for authoring UIs (autocomplete, docs). */
export const POLICY_FIELD_ALIASES = FIELD_ALIASES;

/** Allowed enforcement actions, exported for authoring UIs. */
export const POLICY_ACTIONS: EnforcementAction[] = ENFORCEMENT_ACTIONS;
