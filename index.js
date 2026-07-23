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

// 비공개 방 입장코드 검증용. 코드는 LiveKit "방 메타데이터"에 저장 → 별도 DB 불필요.
const HTTP_URL = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const roomSvc = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET);

const server = http.createServer(async (req, res) => {
  // 웹(Flutter web)에서 fetch 가능하도록 CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, serverUrl: LIVEKIT_URL }));
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
      let meta = {};
      try { meta = JSON.parse(existing.metadata || '{}'); } catch (_) {}
      if (meta.private && (!pin || pin !== meta.pin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ error: '입장 코드가 올바르지 않습니다.' }));
      }
    } else {
      if (isCreate) {
        // 만들기: 공개/비공개 모두 즉시 생성(참여자가 곧바로 찾을 수 있게)
        await roomSvc.createRoom({
          name: room,
          emptyTimeout: 600, // 비면 10분 뒤 삭제(그때까지 유지)
          metadata: pin ? JSON.stringify({ private: true, pin }) : '',
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[prism-token-server] listening on :${PORT}`);
  console.log(`  LIVEKIT_URL = ${LIVEKIT_URL}`);
  console.log(`  API key set = ${API_KEY ? 'yes' : 'NO (토큰 발급 불가)'}`);
  console.log(`  엔드포인트  = GET /token?room=<방>&name=<이름>`);
});
