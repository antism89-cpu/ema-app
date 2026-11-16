// One-shot file importers. Each reads a user-chosen export file, keeps only what falls
// inside the study window (and only the selected types / conversations), and discards the rest.
// No persistent connection to any other app or account is ever made.

export const HEALTH_TYPES = {
  steps: { id: 'HKQuantityTypeIdentifierStepCount', label: '걸음 수' },
  heart: { id: 'HKQuantityTypeIdentifierHeartRate', label: '심박수' },
  sleep: { id: 'HKCategoryTypeIdentifierSleepAnalysis', label: '수면 시간' },
};

const RE_RECORD = /<Record\b([^>]*)>/g;
const RE_TYPE = /\btype="([^"]*)"/;
const RE_START = /\bstartDate="([^"]*)"/;
const RE_END = /\bendDate="([^"]*)"/;
const RE_VALUE = /\bvalue="([^"]*)"/;
const RE_SOURCE = /\bsourceName="([^"]*)"/;

// "2026-11-01 08:00:00 +0900" -> epoch ms
function healthTime(s) {
  return Date.parse(`${s.slice(0, 10)}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`);
}

function mergedMinutes(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [s, e] of intervals) {
    if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; }
    else if (e > ce) ce = e;
  }
  if (ce > cs) total += ce - cs;
  return Math.round(total / 60000);
}

/**
 * Streams Apple Health export.xml and returns per-day summaries for [fromKey, toKeyExcl).
 * Steps: the largest single-source daily total (avoids iPhone + Watch double counting).
 * Sleep: union of "Asleep*" intervals, assigned to the day the sleep ended.
 */
export async function parseHealthXML(file, { fromKey, toKeyExcl, types, onProgress }) {
  const want = new Map(types.map(k => [HEALTH_TYPES[k].id, k]));
  const steps = {};   // day -> source -> sum
  const heart = {};   // day -> {sum, n, min, max}
  const sleep = {};   // day -> [[s, e]]
  let kept = 0;

  const handle = (chunk) => {
    RE_RECORD.lastIndex = 0;
    let m;
    while ((m = RE_RECORD.exec(chunk))) {
      const a = m[1];
      const type = RE_TYPE.exec(a)?.[1];
      const kind = want.get(type);
      if (!kind) continue;
      const sd = RE_START.exec(a)?.[1];
      const ed = RE_END.exec(a)?.[1];
      if (!sd || !ed) continue;
      const day = (kind === 'sleep' ? ed : sd).slice(0, 10);
      if (day < fromKey || day >= toKeyExcl) continue;
      const value = RE_VALUE.exec(a)?.[1];
      if (kind === 'steps') {
        const src = RE_SOURCE.exec(a)?.[1] || '?';
        steps[day] ??= {};
        steps[day][src] = (steps[day][src] || 0) + Number(value || 0);
      } else if (kind === 'heart') {
        const v = Number(value);
        if (!Number.isFinite(v)) continue;
        const h = (heart[day] ??= { sum: 0, n: 0, min: Infinity, max: -Infinity });
        h.sum += v; h.n++; h.min = Math.min(h.min, v); h.max = Math.max(h.max, v);
      } else if (kind === 'sleep') {
        if (!value || !value.includes('Asleep')) continue;
        const s = healthTime(sd), e = healthTime(ed);
        if (!(e > s)) continue;
        (sleep[day] ??= []).push([s, e]);
      }
      kept++;
    }
  };

  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    bytes += value.length;
    const cut = buf.lastIndexOf('<');
    if (cut > 0) { handle(buf.slice(0, cut)); buf = buf.slice(cut); }
    onProgress?.(Math.min(1, bytes / file.size));
  }
  handle(buf);
  onProgress?.(1);

  const days = new Set([...Object.keys(steps), ...Object.keys(heart), ...Object.keys(sleep)]);
  const rows = [...days].sort().map(day => {
    const row = { id: day, date: day };
    if (steps[day]) row.steps = Math.round(Math.max(...Object.values(steps[day])));
    if (heart[day]) {
      const h = heart[day];
      row.hrAvg = Math.round(h.sum / h.n); row.hrMin = Math.round(h.min); row.hrMax = Math.round(h.max);
    }
    if (sleep[day]) row.sleepMin = mergedMinutes(sleep[day]);
    return row;
  });
  return { rows, kept };
}

/** Reads a ChatGPT or Claude data-export conversations.json into a common shape. */
export async function parseChatExport(file) {
  let data = JSON.parse(await file.text());
  if (!Array.isArray(data)) data = data.conversations || [data];
  return data.map(normalizeConversation).filter(c => c && c.messages.length);
}

function normalizeConversation(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.mapping) {
    const messages = Object.values(c.mapping)
      .map(n => n && n.message)
      .filter(m => m && m.create_time && m.author && (m.author.role === 'user' || m.author.role === 'assistant'))
      .map(m => ({
        ts: Math.round(m.create_time * 1000),
        role: m.author.role,
        text: (m.content?.parts || []).filter(p => typeof p === 'string').join('\n'),
      }))
      .filter(m => m.text.trim())
      .sort((a, b) => a.ts - b.ts);
    return { source: 'chatgpt', id: String(c.id || c.conversation_id || c.create_time), title: c.title || '(제목 없음)', messages };
  }
  if (Array.isArray(c.chat_messages)) {
    const messages = c.chat_messages
      .map(m => ({
        ts: Date.parse(m.created_at),
        role: m.sender === 'human' ? 'user' : 'assistant',
        text: m.text || (m.content || []).filter(x => x && x.type === 'text').map(x => x.text).join('\n'),
      }))
      .filter(m => Number.isFinite(m.ts) && (m.text || '').trim())
      .sort((a, b) => a.ts - b.ts);
    return { source: 'claude', id: String(c.uuid || c.created_at), title: c.name || '(제목 없음)', messages };
  }
  return null;
}

/* ---------- Android / generic daily CSV (Google Fit Takeout, Samsung Health, others) ---------- */
function parseCSVText(text) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const isDateCol = n => /^(date|day|날짜|일자)$/.test(n) || /(^|[._])day_time$/.test(n);

function csvDayKey(v) {
  v = String(v).trim();
  if (/^\d{10,13}$/.test(v)) {                       // epoch (Samsung day_time = UTC midnight)
    const n = Number(v) * (v.length <= 10 ? 1000 : 1);
    return new Date(n).toISOString().slice(0, 10);
  }
  const m = v.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

/**
 * Reads a one-row-per-day CSV and keeps only days in [fromKey, toKeyExcl) and the selected types.
 * Columns are matched by header name, so it tolerates different apps and Korean/English exports.
 */
export async function parseHealthCSV(file, { fromKey, toKeyExcl, types, onProgress }) {
  const table = parseCSVText((await file.text()).replace(/^﻿/, ''));
  const norm = s => String(s).toLowerCase().trim();
  // Samsung Health files carry a one-line descriptor before the real header row.
  const hi = table.findIndex(r => r.some(c => isDateCol(norm(c))));
  if (hi < 0) throw new Error('no-columns');
  const head = table[hi].map(norm);
  const col = re => head.findIndex(n => re.test(n));
  const cDate = head.findIndex(isDateCol);
  const cols = {
    steps: types.includes('steps') ? col(/step.?count|^steps$|걸음/) : -1,
    hrAvg: types.includes('heart') ? col(/(average|avg|mean).*heart.?rate|heart.?rate.*(average|avg|mean)|평균.*심박/) : -1,
    hrMax: types.includes('heart') ? col(/\bmax(imum)?\b.*heart.?rate|heart.?rate.*\bmax(imum)?\b|최대.*심박|최고.*심박/) : -1,
    hrMin: types.includes('heart') ? col(/\bmin(imum)?\b.*heart.?rate|heart.?rate.*\bmin(imum)?\b|최소.*심박|최저.*심박/) : -1,
    sleep: types.includes('sleep') ? col(/^sleep duration|total.*sleep|sleep.*(duration|minutes|time)|^수면 ?시간|총 ?수면/) : -1,
  };
  if (Object.values(cols).every(i => i < 0)) throw new Error('no-columns');
  const sleepHead = cols.sleep >= 0 ? head[cols.sleep] : '';
  const sleepToMin = v => (/\(ms\)|밀리초/.test(sleepHead) ? v / 60000 : /hour|시간\)/.test(sleepHead) ? v * 60 : /sec|초\)/.test(sleepHead) ? v / 60 : v);
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

  const days = {};
  let kept = 0;
  for (const r of table.slice(hi + 1)) {
    const day = csvDayKey(r[cDate] ?? '');
    if (!day || day < fromKey || day >= toKeyExcl) continue;
    const d = (days[day] ??= { id: day, date: day });
    const take = (key, v, pick) => { if (v != null) d[key] = d[key] == null ? v : pick(d[key], v); };
    if (cols.steps >= 0) take('steps', num(r[cols.steps]) == null ? null : Math.round(num(r[cols.steps])), Math.max);
    if (cols.hrAvg >= 0) take('hrAvg', num(r[cols.hrAvg]) == null ? null : Math.round(num(r[cols.hrAvg])), (a, b) => b);
    if (cols.hrMax >= 0) take('hrMax', num(r[cols.hrMax]) == null ? null : Math.round(num(r[cols.hrMax])), Math.max);
    if (cols.hrMin >= 0) take('hrMin', num(r[cols.hrMin]) == null ? null : Math.round(num(r[cols.hrMin])), Math.min);
    if (cols.sleep >= 0) take('sleepMin', num(r[cols.sleep]) == null ? null : Math.round(sleepToMin(num(r[cols.sleep]))), Math.max);
    kept++;
  }
  onProgress?.(1);
  const rows = Object.values(days).filter(d => Object.keys(d).length > 2).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, kept };
}
