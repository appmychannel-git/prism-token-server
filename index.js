// Prism Meeting - LiveKit 접속 토큰 발급 서버 (경량, 의존성 1개)
//
// 실행:
//   LIVEKIT_URL=wss://<프로젝트>.livekit.cloud \
//   LIVEKIT_API_KEY=<API Key> \
//   LIVEKIT_API_SECRET=<API Secret> \
//   node index.js
//
// (Windows PowerShell 예시는 token-server/README.md 참고)
//
// 앱은 GET /token?room=<방>&name=<이름> 을 호출하고,
// 서버는 { serverUrl, participantToken } 을 반환합니다.

const http = require('http');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://YOUR-PROJECT.livekit.cloud';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const PORT = Number(process.env.PORT || 3000);
// ---- 방 정책값 (env로 조절 가능) ----
// 비회원(게스트) 방 최대 유지 시간(초). 데모: 생성 1시간 뒤 자동 종료. 0이면 무제한.
const ROOM_MAX_SEC = Number(process.env.ROOM_MAX_SEC || 3600);
// 회원(로그인) 방 최대 유지 시간(초). 기본 6시간. 0이면 무제한.
// ⚠️ 무제한(0)은 유휴 참가자가 남은 방이 안 닫혀 비용이 샐 수 있어 비권장.
const ROOM_MAX_SEC_MEMBER = Number(process.env.ROOM_MAX_SEC_MEMBER || 21600);
// 방 생성 후 아무도 안 들어오면 종료(초). 기본 10분.
const EMPTY_SEC = Number(process.env.EMPTY_SEC || 600);
// 방 종료 후 이 시간 동안은 "원래 방장"만 같은 이름으로 재생성 가능(초). 기본 3분.
const RESERVE_SEC = Number(process.env.RESERVE_SEC || 180);
// sweeper 주기(초). 기본 3분.
const SWEEP_SEC = Number(process.env.SWEEP_SEC || 180);

// ---- 채팅 번역(Google Cloud Translation v2 Basic, API 키 방식) ----
// Google Cloud 프로젝트에서 "Cloud Translation API" 사용 설정 후 만든 API 키를
// Render 환경변수 GOOGLE_TRANSLATE_API_KEY 로 넣는다. (서비스계정 JSON 불필요)
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
// 한 번에 번역할 최대 글자 수(남용/비용 방지). 채팅 한 줄엔 충분.
const TRANSLATE_MAX_CHARS = Number(process.env.TRANSLATE_MAX_CHARS || 2000);
// 번역 결과 메모리 캐시(같은 문장 재요청 시 Google 재호출/과금 방지).
const _trCache = new Map(); // key: `${source}|${target}|${text}` -> {translatedText, detectedSourceLanguage}
const TRANSLATE_CACHE_MAX = 5000;
function _trCacheSet(key, val) {
  _trCache.set(key, val);
  if (_trCache.size > TRANSLATE_CACHE_MAX) {
    // 가장 오래된 항목부터 제거(Map은 삽입순 보존)
    _trCache.delete(_trCache.keys().next().value);
  }
}
// POST 본문(JSON) 읽기 헬퍼.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100000) req.destroy(); // 과대 본문 차단
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 최근 종료된 방 예약: roomName -> { host, endedAt }.
// 종료 후 RESERVE_SEC 동안 원래 방장(host identity)만 같은 이름 재생성 가능.
// (메모리 보관 → 서버 재시작 시 초기화됨. 짧은 창이라 영향 미미.)
const recentlyEnded = new Map();
function markEnded(room, host) {
  if (room) {
    recentlyEnded.set(room, { host: host || '', endedAt: Math.floor(Date.now() / 1000) });
  }
}

// 비공개 방 입장코드 검증용. 코드는 LiveKit "방 메타데이터"에 저장 → 별도 DB 불필요.
const HTTP_URL = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const roomSvc = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET);

const server = http.createServer(async (req, res) => {
  // 웹(Flutter web)에서 fetch 가능하도록 CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, serverUrl: LIVEKIT_URL }));
  }

  // 채팅 번역: POST /translate  body={text, target, source?} → {translatedText, detectedSourceLanguage}
  // 각 클라이언트가 수신 메시지를 자기 선호 언어로 "탭 번역"할 때 호출.
  if (url.pathname === '/translate') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST 로 호출하세요.' }));
    }
    if (!GOOGLE_TRANSLATE_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'GOOGLE_TRANSLATE_API_KEY 가 설정되지 않았습니다.',
      }));
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '잘못된 요청 본문(JSON) 입니다.' }));
    }
    const text = (body.text || '').toString();
    const target = (body.target || '').toString();
    const source = (body.source || '').toString();
    if (!text || !target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'text, target 는 필수입니다.' }));
    }
    if (text.length > TRANSLATE_MAX_CHARS) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '번역 가능한 길이를 초과했습니다.' }));
    }
    const cacheKey = `${source}|${target}|${text}`;
    if (_trCache.has(cacheKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(_trCache.get(cacheKey)));
    }
    try {
      const gRes = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: text,
            target,
            source: source || undefined, // 없으면 Google 이 자동 감지
            format: 'text',
          }),
        },
      );
      const gJson = await gRes.json();
      if (!gRes.ok) {
        const msg = gJson && gJson.error && gJson.error.message
          ? gJson.error.message : `Google 오류 (${gRes.status})`;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: msg }));
      }
      const tr = gJson.data.translations[0];
      const out = {
        translatedText: tr.translatedText,
        detectedSourceLanguage: tr.detectedSourceLanguage || source || '',
      };
      _trCacheSet(cacheKey, out);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '번역 서버 호출 실패: ' + String(e) }));
    }
  }

  // 방장이 회의 종료 → 방 삭제(전원 퇴장). 방장 identity 검증.
  if (url.pathname === '/end') {
    const room = url.searchParams.get('room') || '';
    const identity = url.searchParams.get('identity') || '';
    try {
      const found = await roomSvc.listRooms([room]);
      const existing = found && found[0];
      if (!existing) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, note: 'already ended' }));
      }
      let meta = {};
      try { meta = JSON.parse(existing.metadata || '{}'); } catch (_) {}
      if (meta.host && meta.host !== identity) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '방장만 종료할 수 있습니다.' }));
      }
      await roomSvc.deleteRoom(room);
      markEnded(room, meta.host || identity); // 종료 후 RESERVE_SEC 동안 방장만 재생성 허용
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  if (url.pathname !== '/token') {
    res.writeHead(404);
    return res.end('not found');
  }

  if (!API_KEY || !API_SECRET) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'LIVEKIT_API_KEY / LIVEKIT_API_SECRET 가 설정되지 않았습니다.',
    }));
  }

  const room = url.searchParams.get('room') || 'prism-demo';
  const name = url.searchParams.get('name') || `guest-${Date.now() % 1000}`;
  // identity(고정 식별값)와 name(표시 이름)을 분리.
  // 같은 identity로 재접속하면 서버가 이전 세션을 즉시 교체 → 유령 참가자 방지.
  const identity = url.searchParams.get('identity') || name;
  const pin = (url.searchParams.get('pin') || '').trim();
  const isCreate = url.searchParams.get('create') === 'true'; // 방 만들기 여부

  // ---- 방 존재 확인 + 비공개(입장코드) 검증 ----
  // 코드는 LiveKit 방 메타데이터에 저장(별도 DB 불필요).
  //  - 방 있음 + 비공개 → pin 일치해야 입장
  //  - 방 없음 + 만들기(create) → (비공개면 메타데이터와 함께) 생성
  //  - 방 없음 + 참여하기 → 거부(없는 방 입장/자동생성 방지)
  try {
    const found = await roomSvc.listRooms([room]);
    const existing = found && found[0];

    if (existing) {
      // 만들기(create)인데 같은 이름의 방이 이미 있으면 → 이름 중복 거부.
      // (두 번째 생성자가 기존 방에 흡수 입장되지 않고, 다른 이름을 쓰도록 안내)
      if (isCreate) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: '이미 사용 중인 방 이름입니다. 다른 이름을 사용하세요.',
        }));
      }
      let meta = {};
      try { meta = JSON.parse(existing.metadata || '{}'); } catch (_) {}
      if (meta.private && (!pin || pin !== meta.pin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ error: '입장 코드가 올바르지 않습니다.' }));
      }
    } else {
      if (isCreate) {
        const now = Math.floor(Date.now() / 1000);
        // 방 종료 후 예약창: RESERVE_SEC 동안은 원래 방장만 같은 이름 재생성 가능.
        // 다른 사람이 그 이름으로 만들려 하면 잠시 막는다.
        const rec = recentlyEnded.get(room);
        if (rec && (now - rec.endedAt) < RESERVE_SEC && rec.host !== identity) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: '최근까지 사용된 방 이름입니다. 잠시 후 다시 시도하세요.',
          }));
        }
        recentlyEnded.delete(room); // 재생성되면 예약 해제

        // 회원/비회원 차등 유지시간.
        // TODO(로그인): 로그인·회원 검증 붙으면 여기서 isMember 를 판정한다
        //   (예: 검증된 세션/토큰 확인). 지금은 인증 체계가 없어 전원 게스트 취급.
        const isMember = false;
        const maxSec = isMember ? ROOM_MAX_SEC_MEMBER : ROOM_MAX_SEC;

        // 만들기: 공개/비공개 모두 즉시 생성. 방장(host)=생성자 identity 저장.
        // createdAt + maxDurationSec: 최대 유지시간 초과 시 sweeper가 자동 종료.
        const meta = { host: identity, createdAt: now };
        if (maxSec > 0) meta.maxDurationSec = maxSec;
        if (pin) { meta.private = true; meta.pin = pin; }
        await roomSvc.createRoom({
          name: room,
          emptyTimeout: EMPTY_SEC, // 아무도 안 들어오면 이 시간 뒤 삭제
          metadata: JSON.stringify(meta),
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: '존재하지 않는 방이거나 아직 시작되지 않았습니다.',
        }));
      }
    }
  } catch (e) {
    // 방 조회 실패 시 토큰 발급은 진행(안정성 우선)
    console.log('room check error:', e && e.message ? e.message : e);
  }

  try {
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: identity,
      name: name,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });
    const token = await at.toJwt();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ serverUrl: LIVEKIT_URL, participantToken: token }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

// 방 최대 유지시간 sweeper: SWEEP_SEC(기본 3분)마다 방을 훑어
// 생성 후 maxDurationSec 초과분을 삭제. 생성시각(메타 createdAt) 기준이라 재시작에도 안전.
setInterval(async () => {
  try {
    const rooms = await roomSvc.listRooms();
    const now = Math.floor(Date.now() / 1000);
    for (const r of rooms) {
      let meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch (_) {}
      if (meta.maxDurationSec && meta.createdAt &&
          (now - meta.createdAt) >= meta.maxDurationSec) {
        try {
          await roomSvc.deleteRoom(r.name);
          markEnded(r.name, meta.host); // 자동 종료도 예약 대상(방장만 재생성)
          console.log('auto-closed (time limit):', r.name);
        } catch (_) {}
      }
    }
    // 만료된 예약 정리
    for (const [nm, rec] of recentlyEnded) {
      if (now - rec.endedAt >= RESERVE_SEC) recentlyEnded.delete(nm);
    }
  } catch (e) {
    console.log('sweep error:', e && e.message ? e.message : e);
  }
}, SWEEP_SEC * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[prism-token-server] listening on :${PORT}`);
  console.log(`  LIVEKIT_URL = ${LIVEKIT_URL}`);
  console.log(`  API key set = ${API_KEY ? 'yes' : 'NO (토큰 발급 불가)'}`);
  console.log(`  번역 key set = ${GOOGLE_TRANSLATE_API_KEY ? 'yes' : 'NO (/translate 비활성)'}`);
  console.log(`  엔드포인트  = GET /token?room=<방>&name=<이름>  |  POST /translate {text,target}`);
});
