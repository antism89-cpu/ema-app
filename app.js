import * as DB from './db.js';
import { HEALTH_TYPES, parseHealthXML, parseHealthCSV, parseChatExport } from './importers.js';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmtDay = k => { const d = parseDay(k); return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]})`; };
const fmtDT = ms => { const d = new Date(ms); return `${fmtDay(dayKey(d))} ${hm(d)}`; };
const iso = ms => (ms == null ? '' : new Date(ms).toISOString());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const DELETE_GRACE_MS = 24 * 3600 * 1000;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toCSV(rows, cols) {
  const q = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\r\n');
}

/* ---------- study model ---------- */
let study = null;

function bounds(s = study) {
  const start = parseDay(s.startDate);
  return { start, end: addDays(start, s.days), startKey: s.startDate, endKeyExcl: dayKey(addDays(start, s.days)) };
}

function phase(s = study, now = new Date()) {
  if (!s) return 'none';
  const { start, end } = bounds(s);
  if (now < start) return 'pending';
  if (now >= end) return 'ended';
  return 'active';
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Stratified random schedule: the wake window is split into N blocks, one prompt per block,
// placed so consecutive prompts are always at least minGap minutes apart.
function generatePrompts(s) {
  const out = [];
  const { start } = bounds(s);
  const ws = toMin(s.window.start), we = toMin(s.window.end);
  const n = s.promptsPerDay;
  const block = (we - ws) / n;
  const slack = Math.max(0, block - s.minGapMin);
  for (let d = 0; d < s.days; d++) {
    const day = addDays(start, d);
    const key = dayKey(day);
    const rnd = mulberry32(hashStr(s.id + key));
    for (let i = 0; i < n; i++) {
      const m = Math.round(ws + i * block + rnd() * slack);
      const t = new Date(day); t.setHours(0, m, 0, 0);
      // Prompts that fell before the study was created are not scheduled (they would count as missed).
      if (t.getTime() > s.createdAt) out.push({ id: `${key}-${i}`, date: key, idx: i, at: t.getTime() });
    }
  }
  return out;
}

function promptStatus(p, answered, now = Date.now()) {
  if (answered.has(p.id)) return 'answered';
  if (now < p.at) return 'upcoming';
  if (now < p.at + study.expiryMin * 60000) return 'open';
  return 'missed';
}

async function answeredSet() {
  const rs = await DB.all('responses');
  return new Set(rs.map(r => r.promptId).filter(Boolean));
}

// What is kept from imported AI chats. Older studies stored a boolean (chatIncludeContent).
const CHAT_MODES = {
  none: '시각·발화자·글자 수만 (본문·제목 제외)',
  user: '내가 보낸 메시지의 본문 + 모든 메시지의 시각·글자 수 (AI 답변 본문·제목 제외)',
  all: '모든 본문·제목·시각·글자 수',
};
function chatMode(s = study) { return s.chatContent || (s.chatIncludeContent ? 'all' : 'none'); }

async function saveStudy() { await DB.put('meta', study, 'study'); }

/* ---------- auto delete ---------- */
async function destroyAll(reason) {
  await DB.destroy();
  try { localStorage.removeItem('ema-notified'); } catch {}
  study = null;
  location.hash = '';
  render();
  toast(reason || '모든 데이터를 삭제했습니다.');
}

async function maybeAutoDelete() {
  if (study && phase() === 'ended' && study.exportedAt && study.autoDelete !== false
      && Date.now() >= study.exportedAt + DELETE_GRACE_MS) {
    await destroyAll('연구가 끝나고 내보내기 후 24시간이 지나 기기 내 데이터를 자동 삭제했습니다.');
    return true;
  }
  return false;
}

/* ---------- notifications (only while the study is active) ---------- */
function getNotified() { try { return new Set(JSON.parse(localStorage.getItem('ema-notified') || '[]')); } catch { return new Set(); } }
function setNotified(set) { try { localStorage.setItem('ema-notified', JSON.stringify([...set].slice(-500))); } catch {} }

async function notifyDuePrompts() {
  if (!study?.modules.prompts || phase() !== 'active') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const answered = await answeredSet();
  const notified = getNotified();
  const due = (await DB.all('prompts')).filter(p => promptStatus(p, answered, now) === 'open' && !notified.has(p.id));
  if (!due.length) return;
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const p of due) {
    const opts = { body: `${study.expiryMin}분 안에 지금의 상태를 기록해 주세요.`, tag: p.id, data: { url: './#survey' } };
    try { reg ? await reg.showNotification('EMA 응답 시간', opts) : new Notification('EMA 응답 시간', opts); } catch {}
    notified.add(p.id);
  }
  setNotified(notified);
}

function buildICS(prompts) {
  const f = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.origin + location.pathname + '#survey';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EMA Local//KO', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:EMA 응답 알림'];
  for (const p of prompts) {
    lines.push('BEGIN:VEVENT', `UID:${p.id}-${study.id}@ema.local`, `DTSTAMP:${stamp}`,
      `DTSTART:${f(new Date(p.at))}`, `DTEND:${f(new Date(p.at + study.expiryMin * 60000))}`,
      'SUMMARY:EMA 응답 시간', `URL:${url}`, 'DESCRIPTION:앱을 열어 지금의 상태를 기록하세요.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:EMA 응답 시간', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* ---------- shell ---------- */
const TABS = [
  ['home', '홈', '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ['survey', '응답', '<path d="M5 4h14v16H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>'],
  ['data', '연동', '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>'],
  ['export', '내보내기', '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>'],
];

function currentView() {
  const v = location.hash.slice(1);
  return TABS.some(t => t[0] === v) ? v : 'home';
}

function renderTop() {
  const ph = phase();
  const label = { none: '설정 전', pending: '시작 전', active: '기록 중', ended: '종료됨' }[ph];
  let sub = '';
  if (study) {
    const { end } = bounds();
    sub = `${fmtDay(study.startDate)} – ${fmtDay(dayKey(addDays(end, -1)))} · ${study.days}일`;
  }
  $('#top').innerHTML = `
    <div class="brand"><img src="icon.svg" alt="" width="28" height="28"><div><b>EMA 기록</b><small>${esc(sub || '로컬 전용 · 기간 한정')}</small></div></div>
    <span class="pill ${ph}">${label}</span>`;
}

function renderTabs() {
  const v = currentView();
  $('#tabs').innerHTML = study ? TABS.map(([id, name, icon]) =>
    `<a href="#${id}" class="${v === id ? 'on' : ''}" aria-current="${v === id ? 'page' : 'false'}">
       <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${name}</span></a>`).join('') : '';
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  renderTop();
  renderTabs();
  if (!study) return renderSetup();
  const html = await ({ home: viewHome, survey: viewSurvey, data: viewData, export: viewExport })[currentView()]();
  if (seq !== renderSeq) return;
  $('#app').innerHTML = html;
  bindView(currentView());
}

/* ---------- setup ---------- */
function renderSetup() {
  const today = dayKey(new Date());
  $('#app').innerHTML = `
  <section class="card hero">
    <h1>새 EMA 연구 설정</h1>
    <p>고른 항목만, 정해진 기간 동안만 기록합니다. 다른 앱과의 연동은 계속 연결해 두는 방식이 아니라 <b>내가 고른 파일을 한 번 읽어 기간 안의 데이터만 남기는</b> 방식입니다. 모든 데이터는 이 기기 안에만 저장됩니다.</p>
  </section>
  <form id="setup" novalidate>
    <section class="card">
      <h2><span class="num">1</span>기록할 항목</h2>
      <label class="opt"><input type="checkbox" checked disabled><div><b>자기보고 설문</b><small>기분 · 스트레스 · 피로 · 하는 일 · 함께 있는 사람 · 메모. 권한 필요 없음 (필수)</small></div></label>
      <label class="opt"><input type="checkbox" name="prompts" checked><div><b>랜덤 알림 프롬프트</b><small>하루 몇 번 무작위 시간에 응답을 요청합니다. <em>알림 권한</em>을 이 항목을 켰을 때만 요청합니다.</small></div></label>
      <label class="opt"><input type="checkbox" name="health"><div><b>건강 데이터</b><small>iPhone 건강 앱 또는 Android(Google Fit · 삼성 헬스)의 '내보내기' 파일에서 연구 기간 안의 <em>일별 요약</em>만 추출합니다. 원본 파일은 저장하지 않습니다.</small></div></label>
      <div class="sub" data-when="health">
        ${Object.entries(HEALTH_TYPES).map(([k, t]) => `<label class="chk"><input type="checkbox" name="ht_${k}" ${k !== 'heart' ? 'checked' : ''}> ${t.label}</label>`).join('')}
      </div>
      <label class="opt"><input type="checkbox" name="chat"><div><b>지정한 AI 채팅 사용기록</b><small>ChatGPT · Claude 데이터 내보내기 파일에서 <em>내가 고른 대화</em>의 기간 내 메시지만 남깁니다.</small></div></label>
      <div class="sub" data-when="chat">
        <label class="opt"><input type="radio" name="chatContent" value="none" checked><div><b>본문 저장 안 함</b><small>시각 · 발화자(나/AI) · 글자 수만 저장합니다.</small></div></label>
        <label class="opt"><input type="radio" name="chatContent" value="user"><div><b>내가 보낸 메시지 본문만 저장</b><small>AI의 답변은 본문 없이 시각 · 글자 수만 저장합니다. 대화 제목은 저장하지 않습니다.</small></div></label>
        <label class="opt"><input type="radio" name="chatContent" value="all"><div><b>모든 본문과 대화 제목 저장</b><small>내 메시지와 AI 답변의 본문, 대화 제목까지 저장합니다.</small></div></label>
      </div>
    </section>

    <section class="card">
      <h2><span class="num">2</span>기간과 일정</h2>
      <div class="grid">
        <label>시작일<input type="date" name="startDate" value="${today}" min="${today}"></label>
        <label>기간 (일)<input type="number" name="days" value="14" min="1" max="90" inputmode="numeric"></label>
        <label>참가자 코드 (선택)<input type="text" name="pid" maxlength="24" placeholder="예: P01" autocomplete="off" autocapitalize="characters"></label>
        <label data-when="prompts">응답 시간대 시작<input type="time" name="ws" value="09:00"></label>
        <label data-when="prompts">응답 시간대 끝<input type="time" name="we" value="21:00"></label>
        <label data-when="prompts">하루 프롬프트 수<input type="number" name="n" value="5" min="1" max="12" inputmode="numeric"></label>
        <label data-when="prompts">최소 간격 (분)<input type="number" name="gap" value="60" min="0" max="240" inputmode="numeric"></label>
        <label data-when="prompts">응답 유효 시간 (분)<input type="number" name="expiry" value="30" min="5" max="120" inputmode="numeric"></label>
      </div>
      <p class="err" id="setupErr" hidden></p>
    </section>

    <section class="card">
      <h2><span class="num">3</span>확인과 동의</h2>
      <div id="summary" class="summary"></div>
      <label class="opt"><input type="checkbox" name="consent"><div><b>위 내용을 확인했고 동의합니다</b></div></label>
      <button class="btn primary block" type="submit">연구 시작</button>
    </section>
  </form>`;

  const f = $('#setup');
  const read = () => {
    const v = n => f.elements[n];
    return {
      prompts: v('prompts').checked, health: v('health').checked, chat: v('chat').checked,
      chatContent: v('chatContent').value,
      healthTypes: Object.keys(HEALTH_TYPES).filter(k => v('ht_' + k).checked),
      startDate: v('startDate').value, days: parseInt(v('days').value, 10),
      pid: v('pid').value.trim().replace(/[^\p{L}\p{N}_-]/gu, ''),
      ws: v('ws').value, we: v('we').value, n: parseInt(v('n').value, 10),
      gap: parseInt(v('gap').value, 10), expiry: parseInt(v('expiry').value, 10),
    };
  };
  const validate = o => {
    if (!o.startDate) return '시작일을 정해 주세요.';
    if (!(o.days >= 1 && o.days <= 90)) return '기간은 1–90일 사이로 정해 주세요.';
    if (o.health && !o.healthTypes.length) return '건강 데이터 항목을 하나 이상 고르세요.';
    if (o.prompts) {
      if (!o.ws || !o.we || toMin(o.we) <= toMin(o.ws)) return '응답 시간대의 끝이 시작보다 늦어야 합니다.';
      if (!(o.n >= 1 && o.n <= 12)) return '하루 프롬프트 수는 1–12 사이로 정해 주세요.';
      if (!(o.expiry >= 5)) return '응답 유효 시간은 5분 이상이어야 합니다.';
      if ((toMin(o.we) - toMin(o.ws)) / o.n <= o.gap) return '시간대가 짧거나 프롬프트가 많아 최소 간격을 지킬 수 없습니다. 간격이나 횟수를 줄이세요.';
      if (o.gap < o.expiry) return '최소 간격은 응답 유효 시간 이상이어야 합니다.';
    }
    return '';
  };
  const update = () => {
    const o = read();
    $$('[data-when]', f).forEach(el => { el.hidden = !o[el.dataset.when]; });
    const end = o.startDate && o.days ? dayKey(addDays(parseDay(o.startDate), o.days - 1)) : '';
    const collect = ['자기보고 설문 응답과 응답 시각'];
    const perms = [];
    if (o.prompts) { collect.push(`무작위 프롬프트 일정 (하루 ${o.n || '?'}회, ${o.ws}–${o.we})`); perms.push('알림 (프롬프트 시각을 알리기 위해)'); }
    if (o.health) collect.push(`건강 일별 요약: ${o.healthTypes.map(k => HEALTH_TYPES[k].label).join(', ') || '없음'} — 직접 고른 내보내기 파일에서 1회 추출`);
    if (o.chat) collect.push(`고른 AI 대화의 메시지 ${CHAT_MODES[o.chatContent]} — 직접 고른 내보내기 파일에서 1회 추출`);
    $('#summary').innerHTML = `
      <dl>
        <dt>기간</dt><dd>${o.startDate ? `${esc(fmtDay(o.startDate))} – ${esc(fmtDay(end))} (${o.days}일). 이 기간 밖의 데이터는 기록하거나 가져오지 않습니다.` : '—'}</dd>
        <dt>기록 항목</dt><dd><ul>${collect.map(c => `<li>${esc(c)}</li>`).join('')}</ul></dd>
        <dt>요청 권한</dt><dd>${perms.length ? perms.map(esc).join(', ') : '없음'}</dd>
        <dt>저장 위치</dt><dd>이 기기의 브라우저 저장소에만. 서버로 전송하지 않습니다.</dd>
        <dt>전달</dt><dd>자동 전송 없음. 내보내기 화면에서 내가 직접 파일을 보낼 때만 전달됩니다${o.pid ? ` (파일에 참가자 코드 ${esc(o.pid)} 표시)` : ''}.</dd>
        <dt>종료 후</dt><dd>기록 · 알림 중단 → 내보내기 → 24시간 뒤 기기 안 데이터 자동 삭제</dd>
      </dl>`;
    const err = validate(o);
    const e = $('#setupErr'); e.hidden = !err; e.textContent = err;
  };
  f.addEventListener('input', update);
  f.addEventListener('change', update);
  update();

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const o = read();
    const err = validate(o);
    if (err) { toast(err); return; }
    if (!f.elements.consent.checked) { toast('동의에 체크해 주세요.'); return; }
    // Ask for notification permission only now, only if prompts were chosen (needs the click gesture).
    let notif = 'not-requested';
    if (o.prompts && 'Notification' in window) {
      try { notif = await Notification.requestPermission(); } catch { notif = 'unsupported'; }
    }
    study = {
      id: uid(), createdAt: Date.now(), consentAt: Date.now(), participantId: o.pid || '',
      startDate: o.startDate, days: o.days,
      window: { start: o.ws, end: o.we }, promptsPerDay: o.n, minGapMin: o.gap, expiryMin: o.expiry,
      modules: { survey: true, prompts: o.prompts, health: o.health, chat: o.chat },
      healthTypes: o.health ? o.healthTypes : [], chatContent: o.chat ? o.chatContent : 'none',
      exportedAt: null, autoDelete: true,
    };
    await saveStudy();
    if (o.prompts) await DB.putMany('prompts', generatePrompts(study));
    location.hash = 'home';
    render();
    toast(o.prompts && notif !== 'granted' ? '연구를 만들었습니다. 알림이 꺼져 있어 홈에서 다시 켜거나 캘린더 알림을 쓸 수 있습니다.' : '연구를 만들었습니다.');
  });
}

/* ---------- home ---------- */
async function viewHome() {
  const ph = phase();
  const now = Date.now();
  const { start } = bounds();
  const [prompts, responses] = await Promise.all([study.modules.prompts ? DB.all('prompts') : [], DB.all('responses')]);
  const answered = new Set(responses.map(r => r.promptId).filter(Boolean));
  const st = p => promptStatus(p, answered, now);
  const open = prompts.find(p => st(p) === 'open');
  const past = prompts.filter(p => ['answered', 'missed'].includes(st(p)));
  const done = past.filter(p => st(p) === 'answered').length;
  const todayK = dayKey(new Date());
  const todays = prompts.filter(p => p.date === todayK).sort((a, b) => a.at - b.at);
  const next = prompts.filter(p => p.at > now).sort((a, b) => a.at - b.at)[0];
  const dayN = Math.round((parseDay(todayK) - start) / 864e5) + 1;

  let status = '';
  if (ph === 'pending') status = `<p class="big">${fmtDay(study.startDate)}에 시작합니다</p><p class="muted">시작 전에는 아무것도 기록하지 않습니다.</p>`;
  else if (ph === 'active') status = `<p class="big">${dayN}일째 <span class="muted">/ ${study.days}일</span></p>
      <div class="bar"><i style="width:${Math.min(100, (dayN / study.days) * 100)}%"></i></div>`;
  else status = `<p class="big">연구가 끝났습니다</p><p class="muted">기록과 알림이 멈췄습니다. 데이터를 내보낸 뒤 기기에서 삭제하세요.</p>
      <a class="btn primary" href="#export">내보내기로 이동</a>`;

  const notifState = 'Notification' in window ? Notification.permission : 'unsupported';
  const promptsCard = study.modules.prompts && ph !== 'ended' ? `
    <section class="card">
      <h2>오늘의 프롬프트</h2>
      ${todays.length ? `<ul class="timeline">${todays.map(p => {
        const s = st(p);
        return `<li class="${s}"><time>${hm(new Date(p.at))}</time><span class="chip ${s}">${{ answered: '응답함', open: '응답 가능', missed: '놓침', upcoming: '예정' }[s]}</span></li>`;
      }).join('')}</ul>` : `<p class="muted">오늘은 예정된 프롬프트가 없습니다.${next ? ` 다음: ${fmtDT(next.at)}` : ''}</p>`}
      <div class="row wrap">
        ${notifState === 'granted' ? '<span class="chip ok">알림 켜짐 · 앱이 열려 있거나 백그라운드일 때</span>'
          : notifState === 'unsupported' ? '<span class="chip">이 브라우저는 알림을 지원하지 않음</span>'
          : notifState === 'denied' ? '<span class="chip warn">알림이 차단됨 · 브라우저 설정에서 허용 가능</span>'
          : '<button class="btn" data-act="notif">알림 켜기</button>'}
        <button class="btn" data-act="ics">캘린더 알림 받기 (.ics)</button>
      </div>
      <p class="hint">웹앱은 닫혀 있을 때 알림을 보장하지 못합니다. 캘린더 파일을 추가하면 남은 프롬프트 시각마다 기기 캘린더가 알려 줍니다 (연구가 끝나면 캘린더에서 'EMA 응답 알림'을 지우세요).</p>
    </section>` : '';

  // mood chart across study days
  const byDay = {};
  for (const r of responses) (byDay[dayKey(new Date(r.ts))] ??= []).push(r.mood);
  const days = Array.from({ length: study.days }, (_, i) => dayKey(addDays(start, i)));
  const W = 320, H = 90, bw = W / days.length;
  const bars = days.map((k, i) => {
    const v = byDay[k]; if (!v) return '';
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    const h = Math.max(3, ((avg - 1) / 6) * (H - 6));
    return `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${fmtDay(k)} 평균 기분 ${avg.toFixed(1)}</title></rect>`;
  }).join('');

  return `
    ${open && ph === 'active' ? `<section class="card alert"><div><b>지금 응답할 수 있어요</b><small>${hm(new Date(open.at))} 프롬프트 · ${hm(new Date(open.at + study.expiryMin * 60000))}까지</small></div><a class="btn primary" href="#survey">응답하기</a></section>` : ''}
    <section class="card">${status}</section>
    <section class="stats">
      <div class="stat"><b>${responses.length}</b><small>총 응답</small></div>
      ${study.modules.prompts ? `<div class="stat"><b>${past.length ? Math.round((done / past.length) * 100) + '%' : '—'}</b><small>응답률 (${done}/${past.length})</small></div>` : ''}
      <div class="stat"><b>${next && ph !== 'ended' ? hm(new Date(next.at)) : '—'}</b><small>다음 프롬프트${next && dayKey(new Date(next.at)) !== todayK && ph !== 'ended' ? ` (${fmtDay(next.date)})` : ''}</small></div>
    </section>
    ${promptsCard}
    <section class="card">
      <h2>일별 평균 기분</h2>
      ${responses.length ? `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="일별 평균 기분">${bars}</svg>
        <div class="axis"><span>${fmtDay(days[0])}</span><span>${fmtDay(days[days.length - 1])}</span></div>` : '<p class="muted">아직 응답이 없습니다.</p>'}
    </section>
    ${ph === 'active' ? '<a class="btn block" href="#survey">지금 직접 기록하기</a>' : ''}`;
}

/* ---------- survey ---------- */
const ACTIVITIES = ['업무/공부', '휴식', '이동', '식사', '대화/사교', 'AI 도구 사용', '운동', '기타'];
const SOCIAL = ['혼자', '가족', '친구', '동료', '기타'];

async function viewSurvey() {
  const ph = phase();
  if (ph !== 'active') {
    return `<section class="card"><h2>지금은 기록할 수 없습니다</h2><p class="muted">${ph === 'pending' ? `연구는 ${fmtDay(study.startDate)}에 시작합니다.` : '연구 기간이 끝나 더 이상 기록하지 않습니다.'}</p></section>`;
  }
  const answered = await answeredSet();
  const open = study.modules.prompts ? (await DB.all('prompts')).find(p => promptStatus(p, answered) === 'open') : null;
  const scale = (name, label, min, max, lo, hi, val) => `
    <fieldset class="scale"><legend>${label} <output data-for="${name}">${val}</output></legend>
      <input type="range" name="${name}" min="${min}" max="${max}" value="${val}" step="1">
      <div class="ends"><span>${lo}</span><span>${hi}</span></div></fieldset>`;
  const chips = (name, list) => `<div class="chips">${list.map(x => `<label><input type="radio" name="${name}" value="${esc(x)}"><span>${esc(x)}</span></label>`).join('')}</div>`;
  return `
    <form id="survey" class="card" data-prompt="${open ? open.id : ''}" data-prompt-at="${open ? open.at : ''}">
      <h2>${open ? `${hm(new Date(open.at))} 프롬프트 응답` : '직접 기록'}</h2>
      <p class="muted">지금 이 순간을 기준으로 답해 주세요.</p>
      ${scale('mood', '기분', 1, 7, '매우 나쁨', '매우 좋음', 4)}
      ${scale('stress', '스트레스', 0, 10, '전혀 없음', '매우 높음', 5)}
      ${scale('fatigue', '피로', 0, 10, '전혀 없음', '매우 높음', 5)}
      <fieldset><legend>지금 하는 일</legend>${chips('activity', ACTIVITIES)}</fieldset>
      <fieldset><legend>함께 있는 사람</legend>${chips('social', SOCIAL)}</fieldset>
      <label class="field">메모 (선택)<textarea name="note" rows="2" maxlength="500" placeholder="떠오르는 것이 있으면 적어 주세요"></textarea></label>
      <button class="btn primary block" type="submit">저장</button>
    </form>`;
}

/* ---------- data / imports ---------- */
async function viewData() {
  const ph = phase();
  const { startKey, endKeyExcl } = bounds();
  const range = `${fmtDay(startKey)} – ${fmtDay(dayKey(addDays(parseDay(endKeyExcl), -1)))}`;
  const blocks = [];
  if (!study.modules.health && !study.modules.chat) {
    return `<section class="card"><h2>연동 항목 없음</h2><p class="muted">이 연구는 자기보고 설문만 기록합니다. 다른 앱과 연동하지 않습니다.</p></section>`;
  }
  const locked = ph === 'pending';

  if (study.modules.health) {
    const rows = (await DB.all('health')).sort((a, b) => a.date.localeCompare(b.date));
    const t = study.healthTypes;
    blocks.push(`
      <section class="card">
        <h2>건강 데이터</h2>
        <p class="muted">가져오는 범위: <b>${range}</b> · 항목: <b>${t.map(k => HEALTH_TYPES[k].label).join(', ')}</b></p>
        <details><summary>iPhone에서 파일 만드는 법</summary>
          <ol class="steps"><li>건강 앱 → 오른쪽 위 프로필 → <b>모든 건강 데이터 내보내기</b></li>
          <li>만들어진 <code>내보내기.zip</code>을 파일 앱에 저장하고 탭해서 압축 해제</li>
          <li>아래에서 폴더 안의 <code>export.xml</code>(또는 <code>내보내기.xml</code>)을 고르세요</li></ol>
        </details>
        <details><summary>Android에서 파일 만드는 법</summary>
          <ul class="steps"><li><b>Google Fit</b>: <code>takeout.google.com</code>에서 'Fit'만 선택해 내보내기 → 받은 zip을 풀고 <b>일일 활동 측정항목</b>(Daily activity metrics) 폴더의 <code>.csv</code> 파일을 고르세요</li>
          <li><b>삼성 헬스</b>: 설정 → 개인 데이터 다운로드 → 받은 폴더에서 이름에 <code>pedometer_day_summary</code>가 들어간 <code>.csv</code> (걸음 수)</li>
          <li>그 밖의 앱: 날짜 열과 걸음 · 심박 · 수면 열이 있는 일별 CSV면 읽을 수 있습니다. 안 되면 아래 '직접 입력'을 쓰세요.</li></ul>
        </details>
        <details><summary>파일은 어떻게 처리되나요</summary>
          <p class="hint">파일 전체를 읽지만 기간 밖 기록과 고르지 않은 항목은 즉시 버리고, 하루 단위 요약만 저장합니다. 건강 앱과의 지속 연결은 없습니다.</p>
        </details>
        ${locked ? '<p class="chip">연구 시작 후 가져올 수 있습니다</p>' : `
        <label class="file">건강 내보내기 파일 선택 (.xml · .csv)<input type="file" accept=".xml,.csv,text/xml,application/xml,text/csv" data-act="health-file"></label>
        <progress id="healthProg" max="1" value="0" hidden></progress>`}
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>날짜</th>${t.includes('steps') ? '<th>걸음</th>' : ''}${t.includes('sleep') ? '<th>수면</th>' : ''}${t.includes('heart') ? '<th>심박 평균 (최저–최고)</th>' : ''}<th></th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${fmtDay(r.date)}</td>${t.includes('steps') ? `<td>${r.steps?.toLocaleString() ?? '—'}</td>` : ''}${t.includes('sleep') ? `<td>${r.sleepMin != null ? `${Math.floor(r.sleepMin / 60)}h ${r.sleepMin % 60}m` : '—'}</td>` : ''}${t.includes('heart') ? `<td>${r.hrAvg != null ? `${r.hrAvg}${r.hrMin != null && r.hrMax != null ? ` (${r.hrMin}–${r.hrMax})` : ''}` : '—'}</td>` : ''}<td class="src">${r.manual ? '직접' : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">아직 가져온 건강 데이터가 없습니다.</p>'}
        ${locked ? '' : `<details><summary>파일 없이 직접 입력</summary>
          <form id="manualHealth" class="grid">
            <label>날짜<input type="date" name="date" min="${startKey}" max="${dayKey(addDays(parseDay(endKeyExcl), -1))}" value="${ph === 'active' ? dayKey(new Date()) : startKey}" required></label>
            ${t.includes('steps') ? '<label>걸음 수<input type="number" name="steps" min="0" inputmode="numeric"></label>' : ''}
            ${t.includes('sleep') ? '<label>수면 (시간)<input type="number" name="sleepH" min="0" max="24" step="0.25" inputmode="decimal"></label>' : ''}
            ${t.includes('heart') ? '<label>평균 심박<input type="number" name="hrAvg" min="20" max="250" inputmode="numeric"></label>' : ''}
            <button class="btn" type="submit">저장</button>
          </form></details>`}
      </section>`);
  }

  if (study.modules.chat) {
    const events = await DB.all('chat');
    const convs = {};
    for (const e of events) {
      const c = (convs[e.convKey] ??= { key: e.convKey, label: e.convLabel, source: e.source, n: 0, user: 0, first: e.ts, last: e.ts });
      c.n++; if (e.role === 'user') c.user++;
      c.first = Math.min(c.first, e.ts); c.last = Math.max(c.last, e.ts);
    }
    const list = Object.values(convs);
    blocks.push(`
      <section class="card">
        <h2>AI 채팅 사용기록</h2>
        <p class="muted">가져오는 범위: <b>${range}</b> · 저장 내용: <b>${CHAT_MODES[chatMode()]}</b></p>
        <details><summary>내보내기 파일 받는 법</summary>
          <ul class="steps"><li><b>ChatGPT</b>: 설정 → 데이터 제어 → 데이터 내보내기 → 메일로 받은 zip 안의 <code>conversations.json</code></li>
          <li><b>Claude</b>: 설정 → 개인정보 → 데이터 내보내기 → 받은 zip 안의 <code>conversations.json</code></li></ul>
          <p class="hint">파일을 열면 연구 기간 안에 메시지가 있는 대화 목록만 보여 줍니다. 체크한 대화만 저장하고 나머지는 메모리에서 바로 버립니다.</p>
        </details>
        ${locked ? '<p class="chip">연구 시작 후 가져올 수 있습니다</p>' : '<label class="file">conversations.json 선택<input type="file" accept=".json,application/json" data-act="chat-file"></label>'}
        <div id="chatPick"></div>
        ${list.length ? `<ul class="convs">${list.map(c => `<li><div><b>${esc(c.label)}</b><small>${c.source === 'claude' ? 'Claude' : 'ChatGPT'} · 메시지 ${c.n}개 (내가 보낸 것 ${c.user}) · ${fmtDT(c.first)} – ${fmtDT(c.last)}</small></div><button class="btn small ghost" data-act="chat-remove" data-key="${esc(c.key)}">삭제</button></li>`).join('')}</ul>` : '<p class="muted">아직 저장한 대화가 없습니다.</p>'}
      </section>`);
  }
  return blocks.join('');
}

let pendingChat = null;
async function handleChatFile(file) {
  const { start, end } = bounds();
  let convs;
  try { convs = await parseChatExport(file); } catch (e) { toast('파일을 읽지 못했습니다. ChatGPT/Claude의 conversations.json인지 확인하세요.'); return; }
  const inWin = convs.map(c => ({ ...c, messages: c.messages.filter(m => m.ts >= start.getTime() && m.ts < end.getTime()) }))
    .filter(c => c.messages.length)
    .sort((a, b) => b.messages[b.messages.length - 1].ts - a.messages[a.messages.length - 1].ts);
  pendingChat = inWin;
  const box = $('#chatPick');
  if (!inWin.length) { box.innerHTML = `<p class="chip warn">파일의 대화 ${convs.length}개 중 연구 기간 안에 메시지가 있는 대화가 없습니다.</p>`; return; }
  box.innerHTML = `
    <form id="chatForm" class="pick">
      <p><b>저장할 대화를 고르세요</b> <span class="muted">(기간 안 대화 ${inWin.length}개 / 전체 ${convs.length}개)</span></p>
      <ul>${inWin.map((c, i) => `<li><label><input type="checkbox" name="c" value="${i}"><div><b>${esc(c.title)}</b><small>${c.source === 'claude' ? 'Claude' : 'ChatGPT'} · 기간 내 메시지 ${c.messages.length}개 · 마지막 ${fmtDT(c.messages[c.messages.length - 1].ts)}</small></div></label></li>`).join('')}</ul>
      <p class="hint">제목은 고르는 데만 보여 주며, ${chatMode() === 'all' ? '모든 본문 저장이 켜져 있어 제목도 함께 저장합니다.' : '저장하지 않습니다 ("대화 1"처럼 번호로 저장).'}</p>
      <div class="row"><button class="btn primary" type="submit">선택한 대화 저장</button><button class="btn ghost" type="button" data-act="chat-cancel">취소</button></div>
    </form>`;
  $('#chatForm').addEventListener('submit', async e => {
    e.preventDefault();
    const picked = $$('input[name=c]:checked', e.target).map(x => pendingChat[+x.value]);
    if (!picked.length) { toast('대화를 하나 이상 고르세요.'); return; }
    const mode = chatMode();
    const existing = await DB.all('chat');
    const labels = new Map(existing.map(x => [x.convKey, x.convLabel]));
    let n = new Set(existing.map(x => x.convKey)).size;
    const rows = [];
    for (const c of picked) {
      const key = `${c.source}:${c.id}`;
      if (!labels.has(key)) labels.set(key, mode === 'all' ? c.title : `대화 ${++n}`);
      for (const m of c.messages) {
        const row = {
          id: `${key}:${m.ts}:${m.role}`, source: c.source, convKey: key, convLabel: labels.get(key),
          ts: m.ts, role: m.role, chars: m.text.length, words: m.text.trim().split(/\s+/).filter(Boolean).length,
        };
        if (mode === 'all' || (mode === 'user' && m.role === 'user')) row.text = m.text;
        rows.push(row);
      }
    }
    await DB.putMany('chat', rows);
    pendingChat = null;
    toast(`대화 ${picked.length}개, 메시지 ${rows.length}개를 저장했습니다.`);
    render();
  });
}

/* ---------- export ---------- */
async function viewExport() {
  const ph = phase();
  const [responses, prompts, health, chat] = await Promise.all(['responses', 'prompts', 'health', 'chat'].map(s => DB.all(s)));
  const delAt = study.exportedAt ? study.exportedAt + DELETE_GRACE_MS : null;
  return `
    ${ph === 'ended' ? `<section class="card ${study.exportedAt ? '' : 'alert'}">
      <div><b>${study.exportedAt ? '내보내기 완료' : '연구가 끝났습니다 — 데이터를 내보내세요'}</b>
      <small>${study.exportedAt
        ? (study.autoDelete ? `${fmtDT(delAt)}에 기기 안 데이터를 자동 삭제합니다 (앱을 열 때 실행).` : '자동 삭제가 꺼져 있습니다.')
        : '내보내기를 하면 24시간 뒤 기기 안 데이터를 자동 삭제합니다. 그 사이 파일이 잘 받아졌는지 확인하세요.'}</small></div>
      ${study.exportedAt ? `<button class="btn small ghost" data-act="toggle-auto">${study.autoDelete ? '자동 삭제 취소' : '자동 삭제 다시 켜기'}</button>` : ''}
    </section>` : ''}
    <section class="card">
      <h2>저장된 데이터</h2>
      <ul class="counts">
        <li><b>${responses.length}</b>설문 응답</li>
        ${study.modules.prompts ? `<li><b>${prompts.length}</b>프롬프트 일정</li>` : ''}
        ${study.modules.health ? `<li><b>${health.length}</b>건강 일별 요약</li>` : ''}
        ${study.modules.chat ? `<li><b>${chat.length}</b>AI 채팅 메시지</li>` : ''}
      </ul>
      <div class="row wrap">
        <button class="btn primary" data-act="export-share">연구자에게 보내기</button>
        <button class="btn" data-act="export-json">전체 JSON 저장</button>
        <button class="btn" data-act="export-csv">CSV 파일로 저장</button>
      </div>
      <p class="hint">'연구자에게 보내기'는 기기의 공유 창(메일 · AirDrop · 메신저 등)을 열어 파일을 첨부합니다. 받는 사람은 직접 고르며, 앱이 자동으로 보내는 곳은 없습니다.${study.participantId ? ` 파일에 참가자 코드 <b>${esc(study.participantId)}</b>가 표시됩니다.` : ''}</p>
      <p class="hint">${ph === 'ended' ? '' : '연구 중 내보내기는 백업용이며, 자동 삭제는 연구가 끝난 뒤 내보내기를 했을 때만 예약됩니다.'}</p>
    </section>
    <section class="card">
      <h2>권한과 삭제</h2>
      <dl class="perm">
        <dt>알림</dt><dd>${!study.modules.prompts ? '요청하지 않음' : ('Notification' in window ? { granted: '허용됨', denied: '차단됨', default: '아직 묻지 않음' }[Notification.permission] : '지원 안 됨')}${study.modules.prompts ? ' · 연구가 끝나면 앱이 알림을 보내지 않습니다. 권한 자체는 브라우저 설정(사이트 설정 → 알림)이나 iPhone 설정 → 알림에서 끌 수 있습니다.' : ''}</dd>
        <dt>건강 데이터</dt><dd>${study.modules.health ? '지속 권한 없음 — 고른 파일을 한 번 읽기만 합니다.' : '사용 안 함'}</dd>
        <dt>AI 채팅</dt><dd>${study.modules.chat ? '계정 연결 없음 — 고른 파일을 한 번 읽기만 합니다.' : '사용 안 함'}</dd>
      </dl>
      <button class="btn danger block" data-act="delete-now">지금 모든 데이터 삭제</button>
    </section>`;
}

async function exportData(kind) {
  const [responses, prompts, health, chat] = await Promise.all(['responses', 'prompts', 'health', 'chat'].map(s => DB.all(s)));
  const stamp = dayKey(new Date());
  const answered = new Set(responses.map(r => r.promptId).filter(Boolean));
  const promptRows = prompts.sort((a, b) => a.at - b.at).map(p => ({ id: p.id, date: p.date, at: iso(p.at), status: promptStatus(p, answered) }));
  const respRows = responses.sort((a, b) => a.ts - b.ts).map(r => ({ ...r, ts: iso(r.ts), promptAt: iso(r.promptAt) }));
  const chatRows = chat.sort((a, b) => a.ts - b.ts).map(c => ({ ...c, ts: iso(c.ts) }));
  const pid = study.participantId || '';
  const base = `ema-${pid ? pid + '-' : ''}`;
  const withPid = rows => (pid ? rows.map(r => ({ participant: pid, ...r })) : rows);
  const cols = list => (pid ? ['participant', ...list] : list);
  const { id, createdAt, consentAt, ...cfg } = study;
  const jsonFile = {
    name: `${base}${stamp}.json`, type: 'application/json',
    text: JSON.stringify({
      exportedAt: new Date().toISOString(),
      study: { id, createdAt: iso(createdAt), consentAt: iso(consentAt), ...cfg },
      responses: respRows, prompts: promptRows, health: health.sort((a, b) => a.date.localeCompare(b.date)), chat: chatRows,
    }, null, 2),
  };
  const csvFiles = [{ name: `${base}responses-${stamp}.csv`, type: 'text/csv', text: toCSV(withPid(respRows), cols(['id', 'ts', 'promptId', 'promptAt', 'latencySec', 'mood', 'stress', 'fatigue', 'activity', 'social', 'note'])) }];
  if (study.modules.prompts) csvFiles.push({ name: `${base}prompts-${stamp}.csv`, type: 'text/csv', text: toCSV(withPid(promptRows), cols(['id', 'date', 'at', 'status'])) });
  if (study.modules.health) csvFiles.push({ name: `${base}health-${stamp}.csv`, type: 'text/csv', text: toCSV(withPid(health), cols(['date', 'steps', 'sleepMin', 'hrAvg', 'hrMin', 'hrMax', 'manual'])) });
  if (study.modules.chat) csvFiles.push({ name: `${base}chat-${stamp}.csv`, type: 'text/csv', text: toCSV(withPid(chatRows), cols(['ts', 'source', 'convLabel', 'role', 'chars', 'words', ...(chatMode() !== 'none' ? ['text'] : [])])) });

  let msg = '내보내기 파일을 만들었습니다.';
  if (kind === 'share') {
    // Opens the device share sheet; the person picks the recipient. Nothing is sent automatically.
    const asFiles = list => list.map(f => new File([f.text], f.name, { type: f.type }));
    const sets = [asFiles([...csvFiles, jsonFile]), asFiles(csvFiles)];
    const files = navigator.canShare ? sets.find(s => navigator.canShare({ files: s })) : null;
    if (!files) {
      [...csvFiles, jsonFile].forEach(f => download(f.name, f.text, f.type));
      msg = '이 브라우저는 공유 창을 지원하지 않아 파일로 저장했습니다. 저장된 파일을 직접 보내 주세요.';
    } else {
      try {
        await navigator.share({ files, title: `EMA 데이터${pid ? ' ' + pid : ''}`, text: `EMA 데이터${pid ? ` (참가자 ${pid})` : ''} · ${study.startDate}부터 ${study.days}일` });
        msg = '공유 창으로 파일을 넘겼습니다.';
      } catch (err) {
        if (err.name === 'AbortError') return toast('보내기를 취소했습니다.');
        [...csvFiles, jsonFile].forEach(f => download(f.name, f.text, f.type));
        msg = '공유 창을 열지 못해 파일로 저장했습니다. 저장된 파일을 직접 보내 주세요.';
      }
    }
  } else if (kind === 'json') {
    download(jsonFile.name, jsonFile.text, jsonFile.type);
  } else {
    csvFiles.forEach(f => download(f.name, f.text, f.type));
  }
  if (phase() === 'ended' && !study.exportedAt) {
    study.exportedAt = Date.now();
    await saveStudy();
    render();
  }
  toast(msg);
}

/* ---------- event binding ---------- */
function bindView(v) {
  const app = $('#app');
  app.onclick = async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'INPUT') return;
    const act = btn.dataset.act;
    if (act === 'notif') {
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? '알림을 켰습니다.' : '알림이 허용되지 않았습니다.');
      render();
    } else if (act === 'ics') {
      const future = (await DB.all('prompts')).filter(p => p.at > Date.now()).sort((a, b) => a.at - b.at);
      if (!future.length) return toast('남은 프롬프트가 없습니다.');
      download('ema-prompts.ics', buildICS(future), 'text/calendar');
    } else if (act === 'chat-remove') {
      const key = btn.dataset.key;
      if (!confirm('이 대화의 저장된 기록을 삭제할까요?')) return;
      await DB.delMany('chat', (await DB.all('chat')).filter(x => x.convKey === key).map(x => x.id));
      render();
    } else if (act === 'chat-cancel') {
      pendingChat = null; $('#chatPick').innerHTML = '';
    } else if (act === 'export-share') exportData('share');
    else if (act === 'export-json') exportData('json');
    else if (act === 'export-csv') exportData('csv');
    else if (act === 'toggle-auto') { study.autoDelete = !study.autoDelete; await saveStudy(); render(); }
    else if (act === 'delete-now') {
      if (confirm('설문 응답, 일정, 가져온 건강·AI 채팅 기록과 연구 설정이 이 기기에서 모두 삭제되며 되돌릴 수 없습니다. 삭제할까요?')) destroyAll();
    }
  };
  app.onchange = async e => {
    const input = e.target;
    if (input.dataset?.act === 'health-file' && input.files[0]) {
      const prog = $('#healthProg'); prog.hidden = false;
      const { startKey, endKeyExcl } = bounds();
      try {
        const file = input.files[0];
        const opts = { fromKey: startKey, toKeyExcl: endKeyExcl, types: study.healthTypes, onProgress: p => { prog.value = p; } };
        const { rows } = /\.csv$/i.test(file.name) || file.type === 'text/csv' ? await parseHealthCSV(file, opts) : await parseHealthXML(file, opts);
        const old = new Map((await DB.all('health')).map(r => [r.id, r]));
        await DB.putMany('health', rows.map(r => ({ ...(old.get(r.id) || {}), ...r, manual: false })));
        toast(rows.length ? `${rows.length}일치 요약을 저장했습니다.` : '연구 기간 안의 해당 기록이 파일에 없습니다.');
      } catch (err) {
        toast(err.message === 'no-columns' ? '이 CSV에서 날짜 열이나 걸음·심박·수면 열을 찾지 못했습니다. 직접 입력을 써 주세요.'
          : '파일을 읽지 못했습니다. 건강 앱의 내보내기 파일(.xml 또는 .csv)인지 확인하세요.');
      }
      render();
    } else if (input.dataset?.act === 'chat-file' && input.files[0]) {
      handleChatFile(input.files[0]);
      input.value = '';
    }
  };

  if (v === 'survey') {
    const f = $('#survey');
    if (!f) return;
    f.addEventListener('input', e => {
      if (e.target.type === 'range') $(`output[data-for="${e.target.name}"]`, f).textContent = e.target.value;
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (phase() !== 'active') { toast('연구 기간이 아닙니다.'); return render(); }
      const fd = new FormData(f);
      const now = Date.now();
      let promptId = f.dataset.prompt || null;
      let promptAt = f.dataset.promptAt ? Number(f.dataset.promptAt) : null;
      if (promptId && now >= promptAt + study.expiryMin * 60000) { promptId = null; promptAt = null; } // expired while filling
      await DB.put('responses', {
        id: uid(), ts: now, promptId, promptAt, latencySec: promptAt ? Math.round((now - promptAt) / 1000) : null,
        mood: +fd.get('mood'), stress: +fd.get('stress'), fatigue: +fd.get('fatigue'),
        activity: fd.get('activity') || '', social: fd.get('social') || '', note: (fd.get('note') || '').trim(),
      });
      toast('저장했습니다.');
      location.hash = 'home';
    });
  }

  if (v === 'data') {
    const mf = $('#manualHealth');
    mf?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(mf);
      const date = fd.get('date');
      const { startKey, endKeyExcl } = bounds();
      if (!date || date < startKey || date >= endKeyExcl) return toast('연구 기간 안의 날짜만 입력할 수 있습니다.');
      const row = { ...((await DB.get('health', date)) || {}), id: date, date, manual: true };
      if (fd.get('steps')) row.steps = Math.round(+fd.get('steps'));
      if (fd.get('sleepH')) row.sleepMin = Math.round(+fd.get('sleepH') * 60);
      if (fd.get('hrAvg')) row.hrAvg = Math.round(+fd.get('hrAvg'));
      await DB.put('health', row);
      toast('저장했습니다.');
      render();
    });
  }
}

/* ---------- boot ---------- */
let lastPhase = null;
async function tick() {
  if (!study) return;
  if (await maybeAutoDelete()) return;
  const ph = phase();
  await notifyDuePrompts();
  if (ph !== lastPhase || currentView() === 'home') { lastPhase = ph; render(); }
}

window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  study = (await DB.get('meta', 'study')) || null;
  if (await maybeAutoDelete()) return;
  lastPhase = phase();
  render();
  notifyDuePrompts();
  setInterval(tick, 30000);
})();
