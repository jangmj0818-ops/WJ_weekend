/**
 * 주말 비서: Apps Script 서버
 * 시트 구조·추천 규칙·화면은 CLAUDE.md 4~7장을 따른다. 규칙이 바뀌면 CLAUDE.md부터 고친다.
 *
 * 처음 한 번: setup 실행 → 웹 앱으로 배포 → showLinks 실행 (README.md)
 */

const TZ = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 5;

const HEADERS = {
  settings: ['key', 'value'],
  places: ['place_id', 'name', 'category', 'io', 'lat', 'lng', 'address', 'age_min_months', 'age_max_months',
    'booking_required', 'booking_rule', 'booking_url', 'kakao_url', 'naver_url', 'source_primary', 'active'],
  place_facts: ['place_id', 'field', 'value', 'status', 'sources', 'checked_at', 'expires_at'],
  events: ['event_id', 'name', 'venue', 'place_id', 'start', 'end', 'age_note', 'sources', 'status',
    'io', 'address', 'lat', 'lng', 'fee', 'url'],
  weekly_candidates: ['week_start', 'day', 'io', 'rank', 'ref_type', 'ref_id', 'reason', 'badges'],
  bookings: ['place_id', 'visit_date', 'open_at', 'notify_at', 'status', 'done_by'],
  plans: ['week_start', 'day', 'ref_id', 'added_by', 'added_at'],
  feedback: ['at', 'ref_id', 'member', 'type', 'note'],
  run_log: ['at', 'clock', 'result', 'detail'],
};

const DEFAULT_SETTINGS = [
  ['child_birthdate', ''],
  ['base_label', '동작구청'],
  ['base_address', '서울 동작구 장승배기로 70'],
  ['base_lat', '37.5042165'],
  ['base_lng', '126.9402200'],
  ['radius_km', '20'],
  ['max_drive_min', '40'],
  ['notify_weekday', '4'],
  ['notify_time', '20:00'],
  ['notify_channel', 'kakao_memo'],
  ['members', 'MJ,아내'],
  ['exclude_categories', ''],
  ['kid_interests', ''],
];

const CATEGORIES = {
  park: '공원', playground: '놀이터', kids_cafe_public: '공공 키즈카페', kids_cafe_private: '키즈카페',
  library: '도서관', museum: '박물관·미술관', indoor_zoo: '실내 동물원', indoor_mall: '실내 쇼핑몰',
  experience: '체험', event_venue: '행사장', view_spot: '구경거리',
};
const FACT_FIELDS = ['hours_sat', 'hours_sun', 'closed_days', 'fee', 'parking', 'parking_fee',
  'nursing_room', 'stroller', 'transit', 'related_place', 'booking_rule', 'kids_allowed', 'highlight'];
const FACT_STATUS = ['verified', 'needs_check', 'conflict', 'expired', 'field_verified', 'review_based'];
const USABLE_STATUS = ['verified', 'conflict', 'field_verified', 'review_based'];
// 정보 유효기간 (CLAUDE.md 5장). 여기 없는 항목은 180일.
const TTL_DAYS = { booking_rule: 30, hours_sat: 90, hours_sun: 90, closed_days: 90, fee: 90, kids_allowed: 90 };
const FEEDBACK_TYPES = ['visited', 'good', 'bad', 'info_wrong', 'refresh'];
const EDITABLE_SETTINGS = ['child_birthdate', 'base_label', 'base_address', 'base_lat', 'base_lng',
  'radius_km', 'max_drive_min', 'exclude_categories', 'kid_interests'];
const SPOT_BADGE = '구경거리';
const NEW_BADGE = '처음 추천';
const REST_DAYS = 28; // 다녀온 곳은 4주 쉰다 (6장 12번)
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

// ───────────────────────── 진입점 ─────────────────────────

function doGet(e) {
  const key = (e && e.parameter && e.parameter.k) || '';
  if (!memberKeys_()[key]) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px;line-height:1.6">링크가 올바르지 않아요.<br>받은 링크로 다시 열어 주세요.</p>')
      .setTitle('주말 비서');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('주말 비서')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** Claude 정기 작업 전용. 본문: { secret, action, ... } */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '본문이 JSON이 아니에요' });
  }
  if (!body.secret || body.secret !== PropertiesService.getScriptProperties().getProperty('ROUTINE_SECRET')) {
    return json_({ ok: false, error: '비밀값이 맞지 않아요' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (body.action) {
      case 'state': return json_(Object.assign({ ok: true }, state_()));
      case 'ingest': return json_(ingest_(body));
      case 'summary': return json_({ ok: true, text: summary_() });
      case 'stage': return json_(stage_(body));
      case 'staged': return json_(staged_(body));
      case 'log':
        log_(String(body.clock || 'routine'), String(body.result || ''), String(body.detail || '').slice(0, 1000));
        return json_({ ok: true });
      default: return json_({ ok: false, error: '알 수 없는 action: ' + body.action });
    }
  } catch (err) {
    log_('post', 'error', String(err));
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── 처음 설정 ─────────────────────────

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const head = HEADERS[name];
    // 날짜 문자열이 시트에서 날짜로 바뀌지 않도록 모든 칸을 텍스트로 둔다
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  ss.getSheets().forEach(sh => {
    if (!HEADERS[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  const cur = getSettings_();
  const add = {};
  DEFAULT_SETTINGS.forEach(([k, v]) => { if (!(k in cur)) add[k] = v; });
  if (Object.keys(add).length) setSettings_(add);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ROUTINE_SECRET')) props.setProperty('ROUTINE_SECRET', newKey_());
  if (!props.getProperty('MEMBER_KEYS')) {
    const keys = {};
    splitList_(getSettings_().members).forEach(m => { keys[newKey_()] = m; });
    props.setProperty('MEMBER_KEYS', JSON.stringify(keys));
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRefresh')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRefresh').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();

  log_('setup', 'ok', '시트·설정·비밀값·매일 아침 트리거 준비');
  Logger.log('준비 끝. 웹 앱으로 배포한 다음 showLinks를 실행하세요.');
}

/** 배포 후 실행: 멤버별 링크와 정기 작업용 값을 로그에 보여준다. */
function showLinks() {
  const url = ScriptApp.getService().getUrl() || '[배포 화면의 웹 앱 URL]';
  const keys = memberKeys_();
  Object.keys(keys).forEach(k => Logger.log(keys[k] + ' 링크: ' + url + '?k=' + k));
  Logger.log('WEBAPP_URL=' + url);
  Logger.log('ROUTINE_SECRET=' + PropertiesService.getScriptProperties().getProperty('ROUTINE_SECRET'));
  Logger.log('주소가 /dev로 끝나면 배포 화면에 있는 /exec 주소로 바꿔 쓰세요.');
}

// ───────────────────────── ④ 매일 아침 재판단 ─────────────────────────

function dailyRefresh() {
  const s = getSettings_();
  weather_(s, true);
  const now = new Date();
  const nowStr = nowIso_();
  const today = today_();

  const facts = table_('place_facts');
  let expired = 0;
  facts.rows.forEach(r => {
    if (r.status !== 'expired' && r.status !== 'needs_check' && r.expires_at && r.expires_at < nowStr) {
      r.status = 'expired';
      expired++;
    }
  });
  if (expired) save_(facts);

  const events = table_('events');
  let ended = 0;
  events.rows.forEach(r => {
    const end = String(r.end || r.start).slice(0, 10);
    if (r.status !== 'ended' && end && end < today) {
      r.status = 'ended';
      ended++;
    }
  });
  if (ended) save_(events);

  log_('daily', 'ok', '날씨 갱신 · 기한 지난 정보 ' + expired + '건 · 끝난 행사 ' + ended + '건 (' + fmt_(now, 'HH:mm') + ')');
}

// ───────────────────────── 화면용 API (google.script.run) ─────────────────────────

function getHome(key) {
  return homeData_(auth_(key));
}

function getPlace(key, refType, refId, day) {
  const member = auth_(key);
  const s = getSettings_();
  const now = new Date();
  const wk = weekendOf_(now);
  const facts = factsByPlace_(table_('place_facts').rows);
  const cands = candidatesFor_(wk.sat).rows.filter(c => c.ref_id === refId);
  const cand = cands.find(c => c.day === day) || cands[0];
  const plans = table_('plans').rows.filter(p => p.week_start === wk.sat && p.ref_id === refId);
  const mine = table_('feedback').rows.filter(f => f.ref_id === refId && f.member === member);
  const visited = mine.some(f => f.type === 'visited' && f.at >= addDays_(wk.sat, -5));
  const rated = mine.filter(f => f.type === 'good' || f.type === 'bad').pop();

  const planBy = {};
  ['sat', 'sun'].forEach(d => {
    const who = plans.filter(p => p.day === d).map(p => p.added_by);
    planBy[d] = { me: who.indexOf(member) >= 0, others: who.filter(m => m !== member) };
  });

  const base = {
    ref_type: refType, id: refId, reason: cand ? cand.reason : '', plan: planBy,
    visited, rating: rated ? rated.type : '', weekend: wk,
  };

  if (refType === 'event') {
    const ev = table_('events').rows.find(r => r.event_id === refId);
    if (!ev) throw new Error('행사 정보를 찾지 못했어요.');
    const place = ev.place_id ? table_('places').rows.find(r => r.place_id === ev.place_id) : null;
    const lat = ev.lat || (place && place.lat);
    const lng = ev.lng || (place && place.lng);
    const tags = [{ text: '행사', tone: 'top' }];
    if (ev.io) tags.push({ text: ev.io === 'indoor' ? '실내' : '실외', tone: 'alt' });
    if (ev.fee) tags.push({ text: ev.fee, tone: 'alt' });
    return Object.assign(base, {
      name: ev.name,
      // 다음 주 이후 행사는 이번 주말 계획에 담을 수 없다
      onWeekend: String(ev.start).slice(0, 10) <= wk.sun && String(ev.end || ev.start).slice(0, 10) >= wk.sat,
      tags,
      address: [ev.venue, ev.address || (place && place.address)].filter(Boolean).join(' · '),
      distance: distanceLabel_(s, lat, lng),
      kid: [
        { label: '대상 연령', value: ev.age_note || '확인 필요', warn: !ev.age_note },
        { label: '요금', value: ev.fee || '확인 필요', warn: !ev.fee },
      ],
      schedule: { title: '일정', rows: [{ label: '기간', value: eventWhen_(ev, today_()) }], note: ev.venue || '' },
      related: '',
      transit: '',
      maps: mapLinks_(ev.name, lat, lng, '', ''),
      booking: ev.url ? { rule: '', url: ev.url, label: '행사 페이지' } : null,
      sources: sourceList_([ev.sources]),
      checkedAt: '',
    });
  }

  const p = table_('places').rows.find(r => r.place_id === refId);
  if (!p) throw new Error('장소 정보를 찾지 못했어요.');
  const f = facts[refId] || {};
  const tags = [{ text: p.io === 'indoor' ? '실내' : '실외', tone: 'top' }];
  if (f.fee && usable_(f.fee)) tags.push({ text: shortFee_(f.fee.value), tone: 'alt' });
  tags.push(p.booking_required === 'Y' ? { text: '예약 필요', tone: 'warn' } : { text: '예약 불필요', tone: 'alt' });

  const sat = toDate_(wk.sat);
  const sun = toDate_(wk.sun);
  const checked = Object.keys(f).map(k => f[k].checked_at).filter(Boolean).sort().pop() || '';
  const rule = f.booking_rule && usable_(f.booking_rule) ? f.booking_rule.value : p.booking_rule;

  return Object.assign(base, {
    name: p.name,
    onWeekend: true,
    tags,
    address: p.address,
    distance: distanceLabel_(s, p.lat, p.lng),
    category: CATEGORIES[p.category] || p.category,
    highlight: usable_(f.highlight) ? f.highlight.value + (f.highlight.status === 'review_based' ? ' (후기 기준)' : '') : '',
    kid: [
      { label: '적합 월령', value: ageRange_(p) || '확인 필요', warn: !ageRange_(p) },
      factCell_('수유실', f.nursing_room),
      factCell_('유모차', f.stroller),
      factCell_('주차', f.parking, f.parking_fee, '요금 확인 필요'),
    ].concat(p.category === 'view_spot' || f.kids_allowed ? [factCell_('아이 동반', f.kids_allowed)] : []),
    schedule: {
      title: '이번 주말 운영',
      rows: [
        factRow_('토 ' + fmt_(sat, 'M/d'), f.hours_sat),
        factRow_('일 ' + fmt_(sun, 'M/d'), f.hours_sun),
      ],
      note: f.closed_days && usable_(f.closed_days) ? '휴무: ' + f.closed_days.value : '',
      warn: [f.hours_sat, f.hours_sun].some(x => x && x.status === 'conflict')
        ? '출처마다 운영시간이 달라 더 짧은 쪽으로 표시했어요' : '',
    },
    related: f.related_place && usable_(f.related_place) ? f.related_place.value : '',
    transit: f.transit && usable_(f.transit) ? f.transit.value : '',
    maps: mapLinks_(p.name, p.lat, p.lng, p.kakao_url, p.naver_url),
    booking: p.booking_required === 'Y'
      ? { rule: rule || '예약 규칙 확인 필요', url: p.booking_url, label: '예약 페이지' } : null,
    sources: sourceList_([p.source_primary].concat(Object.keys(f).map(k => f[k].sources))),
    checkedAt: checked ? md_(toDate_(checked)) : '',
  });
}

/** 원탭 반응: plan(토글), booked, visited, good, bad, info_wrong, refresh */
function act(key, a) {
  const member = auth_(key);
  a = a || {};
  const wk = weekendOf_(new Date());
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (a.type === 'plan') {
      if (a.day !== 'sat' && a.day !== 'sun') throw new Error('요일이 필요해요.');
      const t = table_('plans');
      const i = t.rows.findIndex(r => r.week_start === wk.sat && r.day === a.day && r.ref_id === a.ref_id && r.added_by === member);
      if (i >= 0) t.rows.splice(i, 1);
      else t.rows.push({ week_start: wk.sat, day: a.day, ref_id: a.ref_id, added_by: member, added_at: nowIso_() });
      save_(t);
      return { planned: i < 0 };
    }
    if (a.type === 'booked') {
      const parts = String(a.key || '').split('|');
      const t = table_('bookings');
      const r = t.rows.find(x => x.place_id === parts[0] && x.visit_date === parts[1]);
      if (!r) throw new Error('예약 항목을 찾지 못했어요.');
      r.status = 'booked';
      r.done_by = member;
      save_(t);
      return { ok: true };
    }
    if (FEEDBACK_TYPES.indexOf(a.type) >= 0) {
      append_('feedback', [{ at: nowIso_(), ref_id: String(a.ref_id || ''), member, type: a.type, note: String(a.note || '').slice(0, 300) }]);
      return { ok: true };
    }
    throw new Error('알 수 없는 동작이에요.');
  } finally {
    lock.releaseLock();
  }
}

/** 기록 탭: 또 갈래요, 다녀온 곳, 지난 추천(최근 8주) */
function getRecords(key) {
  auth_(key);
  const places = index_(table_('places').rows, 'place_id');
  const events = index_(table_('events').rows, 'event_id');
  const info = id => {
    if (places[id]) return { ref_type: 'place', name: places[id].name, category: places[id].category };
    if (events[id]) return { ref_type: 'event', name: events[id].name, category: 'event' };
    return null;
  };
  const feedback = table_('feedback').rows; // 시간순으로 쌓인다

  const latestRating = {};
  feedback.filter(f => f.type === 'good' || f.type === 'bad').forEach(f => { latestRating[f.ref_id] = f; });
  const favorites = Object.keys(latestRating)
    .filter(id => latestRating[id].type === 'good' && info(id))
    .map(id => Object.assign({ ref_id: id, date: md_(toDate_(latestRating[id].at)), member: latestRating[id].member }, info(id)))
    .reverse();

  const visits = feedback.filter(f => f.type === 'visited' && info(f.ref_id)).reverse().slice(0, 40).map(f => {
    const after = feedback.filter(x => x.ref_id === f.ref_id && (x.type === 'good' || x.type === 'bad') && x.at >= f.at);
    return Object.assign({ ref_id: f.ref_id, date: md_(toDate_(f.at)), member: f.member, rating: after.length ? after[after.length - 1].type : '' }, info(f.ref_id));
  });

  const wk = weekendOf_(new Date());
  const cands = table_('weekly_candidates').rows.filter(c => c.week_start < wk.sat);
  const weekStarts = cands.map(c => c.week_start).filter((w, i, a) => a.indexOf(w) === i).sort().reverse().slice(0, 8);
  const weeks = weekStarts.map(ws => {
    const days = ['sat', 'sun'].map(day => {
      const rows = cands.filter(c => c.week_start === ws && c.day === day &&
        (Number(c.rank) <= PAGE_SIZE || splitList_(c.badges).indexOf(SPOT_BADGE) >= 0));
      rows.sort((a, b) => (a.io === b.io ? Number(a.rank) - Number(b.rank) : a.io < b.io ? -1 : 1));
      const items = rows.filter(c => info(c.ref_id)).map(c => Object.assign({ ref_id: c.ref_id, io: c.io, spot: splitList_(c.badges).indexOf(SPOT_BADGE) >= 0 }, info(c.ref_id)));
      return { day, label: day === 'sat' ? '토' : '일', items };
    });
    return { week_start: ws, label: fmt_(toDate_(ws), 'M/d') + '~' + fmt_(toDate_(addDays_(ws, 1)), 'M/d'), days };
  });

  return { favorites, visits, weeks };
}

function getSettingsView(key) {
  const member = auth_(key);
  const s = getSettings_();
  const values = {};
  EDITABLE_SETTINGS.forEach(k => { values[k] = s[k] || ''; });
  return {
    member,
    values,
    notify: notifyLabel_(s),
    members: splitList_(s.members),
    categories: CATEGORIES,
  };
}

function saveSettings(key, obj) {
  auth_(key);
  obj = obj || {};
  const clean = {};
  const s = getSettings_();
  if ('child_birthdate' in obj) {
    const b = String(obj.child_birthdate || '').trim();
    if (b && !/^\d{4}-\d{2}-\d{2}$/.test(b)) throw new Error('생년월일은 2024-05-01 형식으로 적어 주세요.');
    clean.child_birthdate = b;
  }
  ['base_label', 'base_address'].forEach(k => { if (k in obj) clean[k] = String(obj[k] || '').trim().slice(0, 80); });
  if ('kid_interests' in obj) clean.kid_interests = splitList_(String(obj.kid_interests || '').replace(/[·、]/g, ',')).join(', ').slice(0, 100);
  [['base_lat', 33, 39], ['base_lng', 124, 132], ['radius_km', 1, 50], ['max_drive_min', 10, 120]].forEach(([k, lo, hi]) => {
    if (!(k in obj)) return;
    const n = Number(obj[k]);
    if (!isFinite(n) || n < lo || n > hi) throw new Error(k + ' 값을 확인해 주세요.');
    clean[k] = String(n);
  });
  if ('exclude_categories' in obj) {
    clean.exclude_categories = splitList_(obj.exclude_categories).filter(c => CATEGORIES[c]).join(',');
  }
  setSettings_(clean);
  if (clean.base_lat !== undefined && (clean.base_lat !== s.base_lat || clean.base_lng !== s.base_lng)) {
    PropertiesService.getScriptProperties().deleteProperty('WEATHER');
  }
  return getSettingsView(key);
}

// ───────────────────────── 홈 데이터 ─────────────────────────

function homeData_(member) {
  const s = getSettings_();
  const now = new Date();
  const wk = weekendOf_(now);
  const months = monthAge_(s.child_birthdate, wk.sat);
  const feedback = table_('feedback').rows;
  const allCands = table_('weekly_candidates').rows;
  const pick = candidatesFor_(wk.sat, allCands);
  const cands = pick.rows;
  const earlier = allCands.filter(c => c.week_start < pick.week_start);
  const ctx = {
    s, months, member,
    places: index_(table_('places').rows, 'place_id'),
    events: index_(table_('events').rows, 'event_id'),
    facts: factsByPlace_(table_('place_facts').rows),
    bad: new Set(feedback.filter(f => f.type === 'bad').map(f => f.ref_id)),
    resting: restingIds_(feedback, wk.sat),
    seen: new Set(earlier.map(c => c.ref_id)),
    hasHistory: earlier.length > 0,
    exclude: new Set(splitList_(s.exclude_categories)),
    plans: table_('plans').rows.filter(p => p.week_start === wk.sat),
  };
  const weather = weather_(s, false);
  const fallbackNote = pick.fallback
    ? '지난주(' + fmt_(toDate_(pick.week_start), 'M/d') + ') 추천 기준이에요. 이번 주 목록이 나오면 바뀌어요. ' : '';

  const days = ['sat', 'sun'].map(day => {
    const date = wk[day];
    const w = judgeDay_(weather.days ? weather.days[date] : null);
    const order = w.indoorFirst ? ['indoor', 'outdoor'] : ['outdoor', 'indoor'];
    const byRank = (a, b) => Number(a.rank) - Number(b.rank);
    const isSpot = c => splitList_(c.badges).indexOf(SPOT_BADGE) >= 0;
    // 구경거리는 섹션과 따로 '이번 주 구경거리' 칸에 모은다 (6장 13번)
    const spots = cands.filter(c => c.day === day && isSpot(c)).sort(byRank)
      .map(c => card_(c, day, date, ctx)).filter(Boolean);
    const sections = order.map((io, i) => {
      const rows = cands.filter(c => c.day === day && c.io === io && !isSpot(c)).sort(byRank);
      let items = rows.map(c => card_(c, day, date, ctx)).filter(Boolean);
      items = planFirst_(diversify_(demoteUnchecked_(items)));
      return {
        io, title: io === 'indoor' ? '실내' : '실외', tone: i === 0 ? 'top' : 'alt',
        tag: i === 0 ? firstTag_(w) : (w.rain ? '비 안 오면' : '대안'),
        items,
      };
    });
    return { day, date, label: (day === 'sat' ? '토 ' : '일 ') + fmt_(toDate_(date), 'M/d'), weather: w, lead: fallbackNote + lead_(w), spots, sections };
  });

  const shown = new Set(cands.map(c => c.ref_id));
  const bookings = bookingCards_(ctx.places, ctx.facts, now);
  return {
    member,
    base: { label: s.base_label, reach: '자차 편도 ' + reachLabel_(s.max_drive_min) + ' · 반경 ' + s.radius_km + 'km' },
    child: { months },
    weekend: wk,
    days,
    bookings: bookings.filter(b => b.group !== 'booked'),
    booked: bookings.filter(b => b.group === 'booked'),
    events: upcomingEvents_(ctx.events, shown, now),
    hasCandidates: cands.length > 0,
    fallbackWeek: pick.fallback ? pick.week_start : '',
    updatedAt: lastRun_('candidates'),
    nextNotify: nextNotify_(s, now),
    notifyLabel: notifyLabel_(s),
  };
}

/**
 * 이번 주 후보가 아직 없으면(예: 월요일 작업 전) 가장 최근 주의 후보를 대신 쓴다.
 * 이번 주말에 안 열리는 행사는 card_에서 날짜로 걸러진다.
 */
function candidatesFor_(weekStart, rows) {
  const all = rows || table_('weekly_candidates').rows;
  const own = all.filter(c => c.week_start === weekStart);
  if (own.length) return { rows: own, week_start: weekStart, fallback: false };
  const prev = all.map(c => c.week_start).filter(w => w < weekStart).sort().pop();
  if (!prev) return { rows: [], week_start: weekStart, fallback: false };
  return { rows: all.filter(c => c.week_start === prev), week_start: prev, fallback: true };
}

/** 다녀온 지 4주가 안 된 곳. 이번 주(월요일부터)에 다녀온 곳은 화면에 그대로 둔다. */
function restingIds_(feedback, sat) {
  const monday = addDays_(sat, -5);
  const since = addDays_(sat, -REST_DAYS);
  return new Set(feedback.filter(f => f.type === 'visited' && f.at >= since && f.at < monday).map(f => f.ref_id));
}

function card_(c, day, date, ctx) {
  const id = c.ref_id;
  if (ctx.bad.has(id) || ctx.resting.has(id)) return null;
  const badges = splitList_(c.badges);
  const meta = [];
  let name, category, lat, lng;
  let needsCheck = false;
  let highlight = '';

  if (c.ref_type === 'event') {
    const ev = ctx.events[id];
    if (!ev || ev.status === 'ended') return null;
    const start = String(ev.start).slice(0, 10);
    const end = String(ev.end || ev.start).slice(0, 10);
    if (start > date || end < date) return null;
    const place = ev.place_id ? ctx.places[ev.place_id] : null;
    name = ev.name;
    category = 'event';
    lat = ev.lat || (place && place.lat);
    lng = ev.lng || (place && place.lng);
    meta.push(distanceShort_(ctx.s, lat, lng), '행사', ev.fee, ev.venue);
  } else {
    const p = ctx.places[id];
    if (!p || p.active === 'N' || ctx.exclude.has(p.category) || !ageFits_(p, ctx.months)) return null;
    const f = ctx.facts[id] || {};
    // 노키즈존은 빼고, 구경거리 장소는 아이 동반이 확인된 곳만 (6장 13번)
    if (usable_(f.kids_allowed) && /노키즈/.test(f.kids_allowed.value)) return null;
    if (p.category === 'view_spot' && !usable_(f.kids_allowed)) return null;
    const hours = f['hours_' + day];
    name = p.name;
    category = p.category;
    lat = p.lat;
    lng = p.lng;
    if (usable_(f.highlight)) highlight = f.highlight.value;
    meta.push(distanceShort_(ctx.s, lat, lng));
    if (f.fee && usable_(f.fee)) meta.push(shortFee_(f.fee.value));
    if (hours && usable_(hours)) {
      meta.push(hours.value);
    } else {
      meta.push('운영시간 확인 필요');
      needsCheck = true;
    }
    if (p.booking_required === 'Y' && badges.indexOf('예약 필요') < 0) badges.push('예약 필요');
  }

  // 이전 주 기록이 있을 때, 한 번도 후보에 없던 곳 (6장 12번)
  if (ctx.hasHistory && !ctx.seen.has(id) && badges.indexOf(NEW_BADGE) < 0) badges.push(NEW_BADGE);

  const who = ctx.plans.filter(x => x.day === day && x.ref_id === id).map(x => x.added_by);
  const uniq = who.filter((m, i) => who.indexOf(m) === i);
  return {
    ref_type: c.ref_type === 'event' ? 'event' : 'place',
    ref_id: id, name, category, badges, highlight,
    meta: meta.filter(Boolean).join(' · '),
    reason: c.reason,
    needsCheck,
    plannedMe: uniq.indexOf(ctx.member) >= 0,
    plannedOthers: uniq.filter(m => m !== ctx.member),
    plannedBoth: uniq.length >= 2,
  };
}

/** 운영시간이 확인 안 된 곳은 뒤로 (6장 8번) */
function demoteUnchecked_(items) {
  return items.filter(i => !i.needsCheck).concat(items.filter(i => i.needsCheck));
}

/** 5곳 한 묶음에 같은 유형은 최대 2곳 (6장 6번) */
function diversify_(items) {
  const rest = items.slice();
  const out = [];
  while (rest.length) {
    const page = [];
    const count = {};
    for (let i = 0; i < rest.length && page.length < PAGE_SIZE;) {
      const c = rest[i].category;
      if ((count[c] || 0) < 2) {
        count[c] = (count[c] || 0) + 1;
        page.push(rest.splice(i, 1)[0]);
      } else {
        i++;
      }
    }
    while (page.length < PAGE_SIZE && rest.length) page.push(rest.shift());
    Array.prototype.push.apply(out, page);
  }
  return out;
}

/** 둘 다 담은 곳은 맨 위 (7장 부부 공유 표시) */
function planFirst_(items) {
  return items.filter(i => i.plannedBoth).concat(items.filter(i => !i.plannedBoth));
}

/**
 * '예약할 것' 탭 카드. group: soon(오픈 7일 안·이미 열림) | later | unknown(오픈 시각 모름) | booked(예약 완료)
 */
function bookingCards_(places, facts, now) {
  const today = fmt_(now, 'yyyy-MM-dd');
  const soon = now.getTime() + 7 * DAY_MS;
  return table_('bookings').rows
    .filter(b => (b.status === 'pending' || b.status === 'booked') && b.visit_date >= today && places[b.place_id])
    .map(b => {
      const p = places[b.place_id];
      const open = toDate_(b.open_at);
      const visit = toDate_(b.visit_date);
      const booked = b.status === 'booked';
      let badge = '확인 필요';
      let tone = 'check';
      let group = 'unknown';
      if (booked) {
        badge = '예약 완료';
        tone = 'top';
        group = 'booked';
      } else if (open) {
        const dd = Math.round((toDate_(fmt_(open, 'yyyy-MM-dd')) - toDate_(today)) / DAY_MS);
        badge = open <= now ? '오픈됨' : dd === 0 ? '오늘' : 'D-' + dd;
        group = open.getTime() <= soon ? 'soon' : 'later';
        tone = group === 'soon' ? 'urgent' : 'check';
      }
      const rf = facts[b.place_id] && facts[b.place_id].booking_rule;
      const rule = rf && usable_(rf) ? rf.value : (p.booking_rule || '예약 규칙 확인 필요');
      return {
        key: b.place_id + '|' + b.visit_date,
        place_id: b.place_id,
        name: p.name,
        badge, tone, group, rule,
        when: booked
          ? md_(visit) + ' 방문' + (b.done_by ? ' · ' + b.done_by + ' 예약' : '')
          : (open ? md_(open) + ' ' + hm_(open) + ' 오픈 · ' : '') + md_(visit) + ' 방문분',
        url: p.booking_url,
        sort: booked ? visit.getTime() : open ? open.getTime() : 9e15,
      };
    })
    .sort((a, b) => a.sort - b.sort)
    .slice(0, 30)
    .map(x => { delete x.sort; return x; });
}

function upcomingEvents_(events, shown, now) {
  const today = fmt_(now, 'yyyy-MM-dd');
  return Object.keys(events).map(k => events[k])
    .filter(e => e.status !== 'ended' && String(e.end || e.start).slice(0, 10) >= today && !shown.has(e.event_id))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, 6)
    .map(e => ({ event_id: e.event_id, name: e.name, when: eventWhen_(e, today), venue: e.venue }));
}

// ───────────────────────── 날씨 (Open-Meteo, 키 없음) ─────────────────────────

function weather_(s, force) {
  const props = PropertiesService.getScriptProperties();
  let cached = null;
  try { cached = JSON.parse(props.getProperty('WEATHER') || 'null'); } catch (err) { cached = null; }
  if (!force && cached && Date.now() - cached.at < 3 * 3600 * 1000) return cached;
  try {
    const q = 'latitude=' + s.base_lat + '&longitude=' + s.base_lng + '&timezone=Asia%2FSeoul';
    const f = JSON.parse(UrlFetchApp.fetch('https://api.open-meteo.com/v1/forecast?' + q +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=10').getContentText());
    const a = JSON.parse(UrlFetchApp.fetch('https://air-quality-api.open-meteo.com/v1/air-quality?' + q +
      '&hourly=pm10,pm2_5&forecast_days=5').getContentText());
    const days = {};
    f.daily.time.forEach((d, i) => {
      days[d] = {
        code: f.daily.weather_code[i],
        tmax: f.daily.temperature_2m_max[i],
        tmin: f.daily.temperature_2m_min[i],
        pop: f.daily.precipitation_probability_max[i],
      };
    });
    // 미세먼지는 낮(9~18시) 최댓값으로 본다. 보수적으로 판단하기 위해서다.
    a.hourly.time.forEach((t, i) => {
      const x = days[t.slice(0, 10)];
      const h = Number(t.slice(11, 13));
      if (!x || h < 9 || h > 18) return;
      if (a.hourly.pm10[i] != null) x.pm10 = Math.max(x.pm10 || 0, a.hourly.pm10[i]);
      if (a.hourly.pm2_5[i] != null) x.pm25 = Math.max(x.pm25 || 0, a.hourly.pm2_5[i]);
    });
    const out = { at: Date.now(), days, source: 'Open-Meteo' };
    props.setProperty('WEATHER', JSON.stringify(out));
    return out;
  } catch (err) {
    log_('weather', 'error', String(err).slice(0, 300));
    return cached || { at: 0, days: {} };
  }
}

/** 강수확률 60% 이상 또는 미세먼지 나쁨 이상이면 실내 먼저 (6장 1번) */
function judgeDay_(w) {
  if (!w || w.tmax == null) {
    return { known: false, indoorFirst: false, label: '예보 전', short: '예보 전', pop: null, dust: '' };
  }
  const sky = sky_(w.code);
  const dust = dustLevel_(w.pm10, w.pm25);
  const rain = w.pop != null && w.pop >= 60;
  const badAir = dust === '나쁨' || dust === '매우나쁨';
  const temp = Math.round(w.tmin) + '~' + Math.round(w.tmax) + '°';
  return {
    known: true,
    indoorFirst: rain || badAir,
    rain, badAir, dust, pop: w.pop, sky,
    label: (rain ? '비 ' + w.pop + '%' : badAir ? '미세먼지 ' + dust : sky) + ' · ' + temp,
    short: rain ? '비 ' + w.pop + '%' : badAir ? '미세먼지 ' + dust : sky + ' ' + Math.round(w.tmax) + '°',
  };
}

function lead_(w) {
  if (!w.known) return '아직 날씨 예보 전이에요. 실외를 먼저, 실내는 대안으로 보여드려요.';
  if (w.rain) return '비 소식이 있어요(강수확률 ' + w.pop + '%). 실내를 먼저, 실외는 비가 안 올 때의 대안으로 추천해요.';
  if (w.badAir) return '미세먼지 예보가 \'' + w.dust + '\'이에요. 실내를 먼저, 실외는 대안으로 추천해요.';
  return w.sky + ' 날씨예요. 실외를 먼저, 실내는 대안으로 추천해요.';
}

function firstTag_(w) {
  if (!w.known) return '기본 순서';
  if (w.rain) return '비 대비 추천';
  if (w.badAir) return '미세먼지 대비';
  return '날씨에 추천';
}

function sky_(code) {
  if (code === 0) return '맑음';
  if (code === 1 || code === 2) return '구름 조금';
  if (code === 3) return '흐림';
  if (code === 45 || code === 48) return '안개';
  if (code >= 51 && code <= 57) return '이슬비';
  if (code >= 61 && code <= 67) return '비';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '눈';
  if (code >= 80 && code <= 82) return '소나기';
  if (code >= 95) return '뇌우';
  return '날씨 확인';
}

/** 환경부 예보 등급: PM10 30/80/150, PM2.5 15/35/75 */
function dustLevel_(pm10, pm25) {
  const grade = (v, cuts) => v == null ? -1 : v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3;
  const g = Math.max(grade(pm10, [30, 80, 150]), grade(pm25, [15, 35, 75]));
  return ['좋음', '보통', '나쁨', '매우나쁨'][g] || '';
}

// ───────────────────────── 정기 작업용 ─────────────────────────

function state_() {
  const s = getSettings_();
  const now = new Date();
  const wk = weekendOf_(now);
  const weather = weather_(s, false);
  const nowStr = nowIso_();
  const facts = table_('place_facts').rows;
  const allCands = table_('weekly_candidates').rows;
  const since = addDays_(today_(), -120);
  const feedback = table_('feedback').rows.filter(f => f.at >= since);
  return {
    now: nowStr,
    weekend: wk,
    child_months: monthAge_(s.child_birthdate, wk.sat),
    settings: s,
    weather: { sat: judgeDay_(weather.days[wk.sat]), sun: judgeDay_(weather.days[wk.sun]) },
    categories: Object.keys(CATEGORIES),
    fact_fields: FACT_FIELDS,
    places: table_('places').rows,
    place_facts: facts,
    events: table_('events').rows.filter(e => e.status !== 'ended'),
    bookings: table_('bookings').rows.filter(b => b.visit_date >= today_()),
    feedback,
    excluded_ref_ids: feedback.filter(f => f.type === 'bad').map(f => f.ref_id),
    info_wrong: feedback.filter(f => f.type === 'info_wrong'),
    recheck: facts.filter(f => f.status === 'needs_check' || f.status === 'expired' || (f.expires_at && f.expires_at < nowStr)),
    current_candidates: allCands.filter(c => c.week_start === wk.sat),
    // 새 장소 우선 (6장 12번): 최근 3주 상위 5곳, 지금까지 후보에 나온 곳, 4주 쉬는 곳
    recent_top: allCands.filter(c => c.week_start < wk.sat && c.week_start >= addDays_(wk.sat, -21) && Number(c.rank) <= PAGE_SIZE)
      .map(c => ({ week_start: c.week_start, day: c.day, io: c.io, rank: c.rank, ref_id: c.ref_id })),
    seen_ref_ids: allCands.filter(c => c.week_start < wk.sat).map(c => c.ref_id).filter((id, i, a) => a.indexOf(id) === i),
    resting_ref_ids: Array.from(restingIds_(table_('feedback').rows, wk.sat)),
  };
}

function ingest_(body) {
  const d = body.data || {};
  const warnings = [];
  const counts = {};
  const now = nowIso_();

  if (Array.isArray(d.places)) {
    const ok = d.places.filter(p => {
      const bad = !p.place_id ? 'place_id 없음' : !p.name ? '이름 없음' : !CATEGORIES[p.category] ? 'category 값 오류'
        : (p.io !== 'indoor' && p.io !== 'outdoor') ? 'io 값 오류' : (!isFinite(Number(p.lat)) || !isFinite(Number(p.lng)) || p.lat === '' || p.lng === '') ? '좌표 없음' : '';
      if (bad) warnings.push('place ' + (p.place_id || p.name) + ': ' + bad);
      return !bad;
    });
    counts.places = upsert_('places', ['place_id'], ok);
  }

  const placeIds = new Set(table_('places').rows.map(p => p.place_id));

  if (Array.isArray(d.place_facts)) {
    const ok = d.place_facts.filter(f => {
      const bad = !placeIds.has(f.place_id) ? '없는 place_id' : FACT_FIELDS.indexOf(f.field) < 0 ? 'field 값 오류'
        : FACT_STATUS.indexOf(f.status) < 0 ? 'status 값 오류'
          : (USABLE_STATUS.indexOf(f.status) >= 0 && !f.sources) ? '출처 없음' : '';
      if (bad) warnings.push('fact ' + f.place_id + '/' + f.field + ': ' + bad);
      return !bad;
    }).map(f => {
      const checked = f.checked_at || now;
      return Object.assign({}, f, {
        checked_at: checked,
        expires_at: f.expires_at || addDays_(checked.slice(0, 10), TTL_DAYS[f.field] || 180) + checked.slice(10),
      });
    });
    // 부부가 현장에서 확인한 값은 기한 전까지 덮어쓰지 않는다
    counts.place_facts = upsert_('place_facts', ['place_id', 'field'], ok,
      (old, neu) => old.status === 'field_verified' && neu.status !== 'field_verified' && old.expires_at > now);
  }

  if (Array.isArray(d.events)) {
    const ok = d.events.filter(e => {
      const bad = !e.event_id ? 'event_id 없음' : !e.name ? '이름 없음' : !/^\d{4}-\d{2}-\d{2}/.test(e.start || '') ? 'start 형식 오류' : '';
      if (bad) warnings.push('event ' + (e.event_id || e.name) + ': ' + bad);
      return !bad;
    });
    counts.events = upsert_('events', ['event_id'], ok);
  }

  const eventIds = new Set(table_('events').rows.map(e => e.event_id));

  if (Array.isArray(d.weekly_candidates)) {
    const ws = String(body.week_start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) throw new Error('week_start(그 주 토요일, yyyy-MM-dd)가 필요해요');
    const ok = d.weekly_candidates.filter(c => {
      const exists = c.ref_type === 'event' ? eventIds.has(c.ref_id) : placeIds.has(c.ref_id);
      const rank = Number(c.rank);
      const bad = (c.day !== 'sat' && c.day !== 'sun') ? 'day 값 오류' : (c.io !== 'indoor' && c.io !== 'outdoor') ? 'io 값 오류'
        : !(rank >= 1 && rank <= 20) ? 'rank는 1~20' : !exists ? '없는 ref_id' : '';
      if (bad) warnings.push('candidate ' + c.ref_id + ': ' + bad);
      return !bad;
    }).map(c => ({
      week_start: ws, day: c.day, io: c.io, rank: String(c.rank), ref_type: c.ref_type === 'event' ? 'event' : 'place',
      ref_id: c.ref_id, reason: c.reason || '', badges: Array.isArray(c.badges) ? c.badges.join(',') : (c.badges || ''),
    }));
    const t = table_('weekly_candidates');
    const keepFrom = addDays_(ws, -56);
    t.rows = t.rows.filter(r => r.week_start !== ws && r.week_start >= keepFrom).concat(ok);
    save_(t);
    counts.weekly_candidates = ok.length;
  }

  if (Array.isArray(d.bookings)) {
    const ok = d.bookings.filter(b => {
      const bad = !placeIds.has(b.place_id) ? '없는 place_id' : !/^\d{4}-\d{2}-\d{2}$/.test(b.visit_date || '') ? 'visit_date 형식 오류' : '';
      if (bad) warnings.push('booking ' + b.place_id + ': ' + bad);
      return !bad;
    }).map(b => {
      const open = toDate_(b.open_at);
      return {
        place_id: b.place_id, visit_date: b.visit_date, open_at: b.open_at || '',
        notify_at: b.notify_at || (open ? fmt_(new Date(open.getTime() - 30 * 60 * 1000), "yyyy-MM-dd'T'HH:mm") : ''),
        status: 'pending', done_by: '',
      };
    });
    // 이미 예약 완료·건너뜀 처리한 항목은 그대로 둔다
    counts.bookings = upsert_('bookings', ['place_id', 'visit_date'], ok, old => old.status !== 'pending');
  }

  log_('ingest', warnings.length ? 'warn' : 'ok', JSON.stringify(counts) + (warnings.length ? ' 경고 ' + warnings.length + '건' : ''));
  return { ok: true, counts, warnings };
}

/** 카카오톡 나에게 보내기는 200자까지라서 짧게 만든다. */
function summary_() {
  const h = homeData_('');
  const wk = h.weekend;
  const lines = ['[주말 비서] 🍯 ' + fmt_(toDate_(wk.sat), 'M/d') + '~' + fmt_(toDate_(wk.sun), 'M/d') + (h.fallbackWeek ? ' (지난주 목록)' : '')];
  if (!h.hasCandidates) {
    lines.push('이번 주 추천이 아직 없어요. 후보 만들기 작업 기록을 확인해 주세요.');
    return fit_(lines, 200);
  }
  h.days.forEach(d => {
    const sec = d.sections[0];
    const names = sec.items.slice(0, 2).map(i => short_(i.name, 12));
    lines.push(weatherEmoji_(d.weather) + ' ' + d.label.slice(0, 1) + ' ' + d.weather.short + ' → ' +
      (sec.io === 'indoor' ? '🏠 ' : '🌳 ') + sec.title + ' ' + (names.join(', ') || '후보 없음'));
  });
  const spotNames = [];
  h.days.forEach(d => d.spots.forEach(i => { if (spotNames.indexOf(i.name) < 0) spotNames.push(i.name); }));
  if (spotNames.length) lines.push('🔭 구경거리: ' + spotNames.slice(0, 2).map(n => short_(n, 14)).join(', '));
  const b = h.bookings.filter(x => x.tone === 'urgent')[0] || h.bookings[0];
  if (b) lines.push('🎟️ 예약: ' + short_(b.name, 14) + ' ' + b.badge);
  lines.push('📱 나머지 추천은 앱에서 볼 수 있어요');
  return fit_(lines, 200);
}

/** 화면(Index.html weatherEmoji)과 같은 기준의 날씨 이모지 */
function weatherEmoji_(w) {
  if (!w || !w.known) return '🗓️';
  if (w.rain) return '🌧️';
  if (w.badAir) return '😷';
  const map = { '맑음': '☀️', '구름 조금': '⛅', '흐림': '☁️', '안개': '🌫️', '이슬비': '🌦️', '비': '🌧️', '눈': '❄️', '소나기': '🌦️', '뇌우': '⛈️' };
  return map[w.sky] || '🌤️';
}

// ───────────────────────── 배포 도우미 ─────────────────────────

/** 고친 코드를 잠깐(6시간) 맡겨 둔다. Apps Script 편집기에서 staged로 꺼내 붙인다. */
function stage_(body) {
  const name = String(body.name || '');
  const parts = Number(body.parts);
  const part = Number(body.part);
  if (!/^[A-Za-z]+\.(gs|html|json)$/.test(name)) throw new Error('파일 이름 오류');
  if (!(parts >= 1 && parts <= 20 && part >= 0 && part < parts)) throw new Error('part 오류');
  const cache = CacheService.getScriptCache();
  cache.put('stage:' + name + ':' + part, String(body.content || ''), 21600);
  cache.put('stage:' + name + ':parts', String(parts), 21600);
  return { ok: true, name, part, parts };
}

function staged_(body) {
  const name = String(body.name || '');
  const cache = CacheService.getScriptCache();
  const parts = Number(cache.get('stage:' + name + ':parts'));
  if (!parts) return { ok: false, error: '맡겨 둔 파일이 없어요' };
  let content = '';
  for (let i = 0; i < parts; i++) {
    const c = cache.get('stage:' + name + ':' + i);
    if (c === null) return { ok: false, error: '일부가 없어요: ' + i };
    content += c;
  }
  return { ok: true, name, content };
}

// ───────────────────────── 시트 도우미 ─────────────────────────

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('시트가 없어요: ' + name + ' (setup을 먼저 실행하세요)');
  return sh;
}

function table_(name) {
  const sh = sheet_(name);
  const head = HEADERS[name];
  const last = sh.getLastRow();
  const values = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getValues() : [];
  const rows = values.filter(r => r.some(v => v !== '')).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = cell_(r[i]); });
    return o;
  });
  return { sh, head, rows };
}

function save_(t) {
  const last = t.sh.getLastRow();
  if (last > 1) t.sh.getRange(2, 1, last - 1, t.head.length).clearContent();
  if (t.rows.length) {
    t.sh.getRange(2, 1, t.rows.length, t.head.length).setNumberFormat('@')
      .setValues(t.rows.map(o => t.head.map(h => o[h] == null ? '' : String(o[h]))));
  }
}

function append_(name, objs) {
  const sh = sheet_(name);
  const head = HEADERS[name];
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, head.length).setNumberFormat('@')
    .setValues(objs.map(o => head.map(h => o[h] == null ? '' : String(o[h]))));
}

/** keys가 같은 행은 들어온 값으로 고치고, 없으면 추가한다. skipFn(old, new)가 true면 그 행은 건드리지 않는다. */
function upsert_(name, keys, objs, skipFn) {
  const t = table_(name);
  const keyOf = o => keys.map(k => String(o[k])).join('|');
  const byKey = {};
  t.rows.forEach(r => { byKey[keyOf(r)] = r; });
  let n = 0;
  objs.forEach(o => {
    const old = byKey[keyOf(o)];
    if (old) {
      if (skipFn && skipFn(old, o)) return;
      t.head.forEach(h => { if (o[h] !== undefined && o[h] !== null) old[h] = String(o[h]); });
    } else {
      const r = {};
      t.head.forEach(h => { r[h] = o[h] == null ? '' : String(o[h]); });
      t.rows.push(r);
      byKey[keyOf(r)] = r;
    }
    n++;
  });
  save_(t);
  return n;
}

function cell_(v) {
  if (v instanceof Date) return fmt_(v, "yyyy-MM-dd'T'HH:mm").replace('T00:00', '');
  return String(v).trim();
}

function getSettings_() {
  const o = {};
  table_('settings').rows.forEach(r => { o[r.key] = r.value; });
  return o;
}

function setSettings_(obj) {
  const t = table_('settings');
  Object.keys(obj).forEach(k => {
    const r = t.rows.find(x => x.key === k);
    if (r) r.value = String(obj[k]);
    else t.rows.push({ key: k, value: String(obj[k]) });
  });
  save_(t);
}

function log_(clock, result, detail) {
  try {
    append_('run_log', [{ at: nowIso_(), clock, result, detail }]);
  } catch (err) {
    Logger.log(clock + ' ' + result + ' ' + detail);
  }
}

function lastRun_(clock) {
  const r = table_('run_log').rows.filter(x => x.clock === clock && x.result !== 'error').pop()
    || table_('run_log').rows.filter(x => x.clock === 'ingest' && x.result !== 'error').pop();
  if (!r) return '';
  const d = toDate_(r.at);
  return d ? md_(d) + ' ' + fmt_(d, 'HH:mm') : '';
}

// ───────────────────────── 작은 도우미 ─────────────────────────

function memberKeys_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('MEMBER_KEYS') || '{}');
  } catch (err) {
    return {};
  }
}

function auth_(key) {
  const m = memberKeys_()[key];
  if (!m) throw new Error('링크가 올바르지 않아요. 받은 링크로 다시 열어 주세요.');
  return m;
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function index_(rows, key) {
  const o = {};
  rows.forEach(r => { o[r[key]] = r; });
  return o;
}

function factsByPlace_(rows) {
  const o = {};
  rows.forEach(r => {
    o[r.place_id] = o[r.place_id] || {};
    o[r.place_id][r.field] = r;
  });
  return o;
}

function usable_(fact) {
  return fact && USABLE_STATUS.indexOf(fact.status) >= 0 && fact.value !== '';
}

/** subMissing: 보조 정보(예: 주차 요금)가 확인 안 됐을 때 보여줄 문구 */
function factCell_(label, fact, subFact, subMissing) {
  if (!usable_(fact)) return { label, value: '확인 필요', warn: true };
  const sub = [];
  if (usable_(subFact)) sub.push(subFact.value);
  else if (subMissing) sub.push(subMissing);
  if (fact.status === 'conflict') sub.push('출처 엇갈림');
  if (fact.status === 'field_verified') sub.push('현장 확인');
  if (fact.status === 'review_based') sub.push('후기 기준');
  return { label, value: fact.value, sub: sub.join(' · '), warnSub: sub.some(x => x.indexOf('확인 필요') >= 0 || x === '출처 엇갈림') };
}

function factRow_(label, fact) {
  if (!usable_(fact)) return { label, value: '확인 필요', warn: true };
  const note = fact.status === 'conflict' ? '출처 엇갈림' : fact.status === 'review_based' ? '후기 기준' : '';
  return { label, value: fact.value, warn: false, note };
}

function ageFits_(p, months) {
  if (months == null) return true;
  if (p.age_min_months !== '' && months < Number(p.age_min_months)) return false;
  if (p.age_max_months !== '' && months > Number(p.age_max_months)) return false;
  return true;
}

function ageRange_(p) {
  const lo = p.age_min_months;
  const hi = p.age_max_months;
  if (lo === '' && hi === '') return '';
  if (hi === '') return lo + '개월부터';
  if (lo === '') return hi + '개월까지';
  return lo + '~' + hi + '개월';
}

function monthAge_(birth, onDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth || '')) return null;
  const b = birth.split('-').map(Number);
  const t = onDate.split('-').map(Number);
  let m = (t[0] - b[0]) * 12 + (t[1] - b[1]);
  if (t[2] < b[2]) m--;
  return m < 0 ? null : m;
}

function distanceKm_(lat1, lng1, lat2, lng2) {
  const a1 = Number(lat1), o1 = Number(lng1), a2 = Number(lat2), o2 = Number(lng2);
  if (![a1, o1, a2, o2].every(isFinite) || lat2 === '' || lng2 === '' || lat2 == null) return null;
  const r = Math.PI / 180;
  const x = Math.sin((a2 - a1) * r / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin((o2 - o1) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function distanceShort_(s, lat, lng) {
  const km = distanceKm_(s.base_lat, s.base_lng, lat, lng);
  return km == null ? '' : '약 ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + 'km';
}

function distanceLabel_(s, lat, lng) {
  const d = distanceShort_(s, lat, lng);
  return d ? s.base_label + '에서 직선 ' + d + ' · 차로 걸리는 시간은 길찾기에서 확인' : '위치 확인 필요';
}

function reachLabel_(min) {
  const n = Number(min) || 40;
  return (n - 10) + '~' + n + '분';
}

function mapLinks_(name, lat, lng, kakaoUrl, naverUrl) {
  const hasXY = lat !== '' && lng !== '' && lat != null && lng != null;
  return {
    kakao: kakaoUrl || (hasXY ? 'https://map.kakao.com/link/to/' + encodeURIComponent(name) + ',' + lat + ',' + lng
      : 'https://map.kakao.com/link/search/' + encodeURIComponent(name)),
    naver: naverUrl || 'https://map.naver.com/p/search/' + encodeURIComponent(name),
  };
}

/** 출처 URL 목록. 같은 사이트는 처음 나온 주소 하나만 보여준다. */
function sourceList_(list) {
  const out = [];
  const hosts = {};
  list.forEach(v => splitList_(v).forEach(u => {
    if (!/^https?:\/\//.test(u)) return;
    const host = u.replace(/^https?:\/\/(www\.|m\.)?/, '').split('/')[0];
    if (hosts[host]) return;
    hosts[host] = true;
    out.push({ url: u, host });
  }));
  return out.slice(0, 6);
}

function shortFee_(v) {
  return /^무료/.test(v) ? '무료' : v.length > 14 ? '유료' : v;
}

function eventWhen_(e, today) {
  const st = toDate_(e.start);
  const en = toDate_(e.end);
  if (!st) return '일정 확인 필요';
  const time = String(e.start).length > 10 ? ' ' + hm_(st) : '';
  if (!en || fmt_(en, 'yyyy-MM-dd') === fmt_(st, 'yyyy-MM-dd')) return md_(st) + time;
  if (fmt_(st, 'yyyy-MM-dd') <= today) return '~' + md_(en);
  return md_(st) + '~' + md_(en);
}

function nextNotify_(s, now) {
  const wd = Number(s.notify_weekday);
  const time = /^\d{2}:\d{2}$/.test(s.notify_time || '') ? s.notify_time : '20:00';
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * DAY_MS);
    if (kstDay_(d) !== wd) continue;
    const at = toDate_(fmt_(d, 'yyyy-MM-dd') + 'T' + time);
    if (at > now) return md_(at) + ' ' + time;
  }
  return '';
}

function notifyLabel_(s) {
  const wd = DOW_KO[Number(s.notify_weekday)] || '목';
  const ch = s.notify_channel === 'kakao_memo' ? '카카오톡 나와의 채팅' : s.notify_channel;
  return wd + '요일 ' + (s.notify_time || '20:00') + ' · ' + ch;
}

function fmt_(d, pattern) {
  return Utilities.formatDate(d, TZ, pattern);
}

function today_() {
  return fmt_(new Date(), 'yyyy-MM-dd');
}

function nowIso_() {
  return fmt_(new Date(), "yyyy-MM-dd'T'HH:mm");
}

/** 한국 시간 기준 요일 (0=일 ~ 6=토). 한국은 서머타임이 없어 9시간을 더하면 된다. */
function kstDay_(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).getUTCDay();
}

function md_(d) {
  return fmt_(d, 'M/d') + '(' + DOW_KO[kstDay_(d)] + ')';
}

function hm_(d) {
  const m = fmt_(d, 'mm');
  return m === '00' ? fmt_(d, 'H') + '시' : fmt_(d, 'H:mm');
}

/** 'yyyy-MM-dd', 'yyyy-MM-ddTHH:mm'을 한국 시간으로 읽는다. */
function toDate_(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+09:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += '+09:00';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function addDays_(dateStr, n) {
  return fmt_(new Date(toDate_(dateStr).getTime() + n * DAY_MS), 'yyyy-MM-dd');
}

/** 이번 주말: 월~금이면 다가오는 토·일, 토·일이면 그 주말. week_start는 토요일 날짜다. */
function weekendOf_(now) {
  const dow = kstDay_(now);
  const add = dow === 0 ? -1 : 6 - dow;
  const sat = new Date(now.getTime() + add * DAY_MS);
  return { sat: fmt_(sat, 'yyyy-MM-dd'), sun: fmt_(new Date(sat.getTime() + DAY_MS), 'yyyy-MM-dd') };
}

function splitList_(v) {
  return String(v || '').split(',').map(x => x.trim()).filter(Boolean);
}

function short_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** max 글자 안으로 자른다. 이모지가 반쪽으로 잘리지 않게 글자 단위로 줄인다. */
function fit_(lines, max) {
  const text = lines.join('\n');
  if (text.length <= max) return text;
  const chars = Array.from(text);
  while (chars.join('').length > max - 1) chars.pop();
  return chars.join('') + '…';
}
