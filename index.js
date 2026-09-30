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
const { AccessToken, RoomServiceClient, WebhookReceiver } = require('livekit-server-sdk');

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
// Azure Translator(품질 비교/대안용). provider=azure 로 호출 시 사용.
const AZURE_TRANSLATE_KEY = process.env.AZURE_TRANSLATE_KEY || '';
const AZURE_TRANSLATE_REGION = process.env.AZURE_TRANSLATE_REGION || '';
const AZURE_TRANSLATE_ENDPOINT = (process.env.AZURE_TRANSLATE_ENDPOINT ||
  'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
// DeepL(품질 비교용). provider=deepl 로 호출 시 사용.
// 무료 키(끝이 ':fx')는 api-free, 유료 키는 api.deepl.com 을 자동 선택.
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const DEEPL_ENDPOINT = (process.env.DEEPL_ENDPOINT ||
  (DEEPL_API_KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')
  ).replace(/\/+$/, '');
// 앱의 2글자 코드 → DeepL 언어코드(대문자, 일부 특수).
function _deeplLang(code, isTarget) {
  const c = (code || '').toUpperCase();
  if (!c) return '';
  if (c === 'EN') return isTarget ? 'EN-US' : 'EN';
  if (c === 'PT') return isTarget ? 'PT-BR' : 'PT';
  if (c === 'ZH') return 'ZH';
  return c; // KO, RU, KK, JA, FR, ES, DE, AR ... 는 그대로 대문자
}
// 이 배포의 기본 번역 엔진: 'google'(기본) | 'azure'.
// 거래처별 토큰서버를 따로 띄울 때 이 값만 바꾸면 앱 수정 없이 엔진이 갈린다.
// (예: 카자흐스탄 서버 TRANSLATE_PROVIDER=azure, 르완다 서버=google)
const TRANSLATE_PROVIDER = (process.env.TRANSLATE_PROVIDER || 'google').toLowerCase();
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

// 비밀번호(pin) 무차별 대입 방지: 방+IP 기준으로 실패 누적 시 일시 잠금.
const PIN_MAX_FAILS = Number(process.env.PIN_MAX_FAILS || 5);
const PIN_LOCK_SEC = Number(process.env.PIN_LOCK_SEC || 300); // 5분
const pinAttempts = new Map(); // `${room}|${ip}` -> { fails, lockUntil(초) }
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  return xff.split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
}

function markEnded(room, host) {
  if (room) {
    recentlyEnded.set(room, { host: host || '', endedAt: Math.floor(Date.now() / 1000) });
  }
}

// 비공개 방 입장코드 검증용. 코드는 LiveKit "방 메타데이터"에 저장 → 별도 DB 불필요.
const HTTP_URL = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
const roomSvc = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET);

// ---- Firebase Admin (통화 수신벨 FCM 전송용) ----
// Render 환경변수 FIREBASE_SERVICE_ACCOUNT 에 서비스계정 JSON 전체를 넣는다.
// 값이 없으면 /call 만 비활성 — 기존 /token, /translate 는 영향 없음.
let fbMessaging = null;
let fbFirestore = null;
let fbAuth = null;
try {
  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (rawSa) {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(rawSa)) });
    fbMessaging = admin.messaging();
    fbFirestore = admin.firestore();
    fbAuth = admin.auth();
  }
} catch (e) {
  console.log('firebase-admin init failed:', e && e.message ? e.message : e);
}

// ---- APNs VoIP (iOS 통화 수신용 PushKit/CallKit) ----
// iOS 는 데이터 전용 FCM 으로 꺼진 앱을 못 깨우므로, VoIP 푸시로 앱을 깨워 CallKit 을 띄운다.
//
// ⚠️ APNs 인증 키(.p8)는 "환경 전용"일 수 있다(Apple 이 개발/프로덕션 키를 따로 발급).
//   - 프로덕션 키 → production 엔드포인트(TestFlight/AppStore 빌드)
//   - 개발 키     → sandbox 엔드포인트(flutter run 개발서명 빌드)
//   프로덕션 키를 sandbox 로 쓰면 BadEnvironmentKeyInToken, 반대는 BadDeviceToken 이 난다.
//   그래서 두 키를 모두 받아 각 엔드포인트에 맞는 키로 보낸다.
//
// Render 환경변수:
//   APNS_TEAM_ID, APNS_BUNDLE_ID
//   APNS_KEY_P8      / APNS_KEY_ID      → 프로덕션 키(production 엔드포인트)
//   APNS_KEY_P8_DEV  / APNS_KEY_ID_DEV  → 개발 키(sandbox 엔드포인트)
//   (개발 키가 없으면 프로덕션 키로 sandbox 도 시도 — 환경전용 키면 실패할 수 있음)
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'kr.co.mychannel.meeting.prism';
let apnProviders = null; // { prod, sandbox } (각각 null 가능)
try {
  const teamId = process.env.APNS_TEAM_ID || '';
  const prodP8 = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n');
  const prodKeyId = process.env.APNS_KEY_ID || '';
  // 개발 키 미지정 시 프로덕션 키로 폴백(환경전용 키면 sandbox 에서 실패할 수 있음).
  const devP8 = (process.env.APNS_KEY_P8_DEV || '').replace(/\\n/g, '\n') || prodP8;
  const devKeyId = process.env.APNS_KEY_ID_DEV || prodKeyId;
  if (teamId) {
    const apn = require('@parse/node-apn');
    const mk = (key, keyId, production) =>
      key && keyId ? new apn.Provider({ token: { key, keyId, teamId }, production }) : null;
    const prod = mk(prodP8, prodKeyId, true);
    const sandbox = mk(devP8, devKeyId, false);
    if (prod || sandbox) apnProviders = { prod, sandbox };
  }
} catch (e) {
  console.log('APNs(VoIP) init failed:', e && e.message ? e.message : e);
}

// iOS VoIP 푸시 전송. data = {id, nameCaller, handle, isVideo, room, fromUuid, callId}
// bundleId: 받는 기기의 번들 ID(브랜드별로 다름). VoIP 토픽은 <그 기기 bundleId>.voip 여야 함.
async function sendVoipPush(voipToken, data, bundleId) {
  if (!apnProviders) throw new Error('APNs 미설정(APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID).');
  const apn = require('@parse/node-apn');
  const note = new apn.Notification();
  note.topic = (bundleId || APNS_BUNDLE_ID) + '.voip'; // VoIP 는 반드시 <bundleId>.voip 토픽
  note.pushType = 'voip';
  note.priority = 10;
  note.expiry = Math.floor(Date.now() / 1000) + 30; // 30초 내 미수신 시 폐기
  note.payload = data;
  // production(프로덕션 키) 먼저 시도, 실패하면 sandbox(개발 키)로 재시도. 둘 중 하나만
  // 성공하면 OK. 각 엔드포인트는 그 환경의 키로 보내야 한다(환경전용 키 대응).
  const reason = (res) =>
    res.failed && res.failed.length
      ? (res.failed[0].response ? JSON.stringify(res.failed[0].response) : String(res.failed[0].error))
      : null;
  const attempts = [];
  let prodReason = 'skip(no prod key)';
  let sbReason = 'skip(no dev key)';

  if (apnProviders.prod) {
    const rp = await apnProviders.prod.send(note, voipToken);
    prodReason = reason(rp);
    if (!prodReason) { console.log('[voip] sent via prod'); return; }
    attempts.push(`prod=${prodReason}`);
  }
  if (apnProviders.sandbox) {
    const rs = await apnProviders.sandbox.send(note, voipToken);
    sbReason = reason(rs);
    if (!sbReason) { console.log('[voip] sent via sandbox'); return; }
    attempts.push(`sandbox=${sbReason}`);
  }
  throw new Error('VoIP 전송 실패 (' + (attempts.join(', ') || 'no provider') + ')');
}

// ---- LiveKit 사용량 집계(브랜드별 참가자-분) + 임계치 알림 ----
// LiveKit Cloud 프로젝트 설정 → Webhooks 에 이 서버의 /livekit-webhook 를 등록해야
// participant_left 이벤트가 들어온다. 참가자 접속 시간을 appId(브랜드)별로 Firestore 에 누적.
//   - 저장 위치: 컬렉션 lkUsage / 문서 YYYY-MM(UTC) / { total, brands:{...}, alerted80/100 }
//   - 조회: GET /usage[?month=YYYY-MM]   (ADMIN_KEY 설정 시 key 필요)
const lkWebhook = (API_KEY && API_SECRET) ? new WebhookReceiver(API_KEY, API_SECRET) : null;
// 이번 달 총 참가자-분이 이 값의 80%/100% 도달 시 1회씩 알림(0이면 알림 끔). 예: Ship=150000.
const USAGE_ALERT_MINUTES = Number(process.env.USAGE_ALERT_MINUTES || 0);
// 알림 전송 대상(POST JSON {text}). Slack Incoming Webhook 또는 Zapier/Make(→메일) 훅 URL.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
// /usage 조회 보호(설정 시 x-admin-key 헤더 또는 ?key= 가 일치해야 조회 가능).
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function usageMonthKey(d) {
  d = d || new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// Firestore 필드명엔 '.' 등을 못 쓰므로 브랜드(패키지명)의 특수문자를 '_'로.
function fsKey(s) { return (s || 'unknown').replace(/[.#$/[\]]/g, '_'); }
// Firestore Timestamp/유닉스초 → 초.
function tsSec(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  return ts.seconds != null ? Number(ts.seconds)
    : (ts._seconds != null ? Number(ts._seconds) : null);
}
// appId(패키지명)·방이름 → { appId, brand(한글명), type(미팅/CCTV/통화) }.
const BRAND_NAMES = {
  gbled: '글로벌', viewplus: '뷰플러스', freedom: 'Freedom', prism: '프리즘',
  mychannel: '마이채널', ecoglow: 'ECO GLOW',
};
function brandInfo(appId, roomName) {
  const app = appId || '';
  let type = '미팅';
  if (app.includes('.cctv.')) type = 'CCTV';
  else if (app.includes('.meeting.')) type = '미팅';
  else if ((roomName || '').startsWith('cctv-')) type = 'CCTV';
  else if ((roomName || '').startsWith('dm-')) type = '통화';
  const key = app ? app.split('.').pop() : '';
  return { appId: app || null, brand: BRAND_NAMES[key] || key || null, type };
}
// 유닉스초 → 'YYYY-MM-DD HH:MM:SS' (KST, UTC+9).
function fmtKst(sec) {
  sec = tsSec(sec);
  if (!sec) return null;
  const k = new Date(sec * 1000 + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} `
    + `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}

async function sendUsageAlert(subject, text) {
  console.log('[USAGE ALERT]', subject, '-', text);
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `⚠️ ${subject}\n${text}` }),
    });
  } catch (e) { console.log('alert send failed:', e && e.message ? e.message : e); }
}

async function addUsage(brand, minutes, roomName) {
  if (!fbFirestore || !(minutes > 0)) return;
  const admin = require('firebase-admin');
  const mk = usageMonthKey();
  const ref = fbFirestore.collection('lkUsage').doc(mk);
  const inc = admin.firestore.FieldValue.increment(minutes);
  await ref.set({
    month: mk,
    total: inc,
    brands: { [fsKey(brand)]: inc },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // 최근 사용 방 기록(방 이름별 누적 + 마지막 사용시각). /usage 에서 최근 5개 조회.
  if (roomName) {
    try {
      const rref = fbFirestore.collection('lkRooms').doc(roomName.replace(/[/#?[\]]/g, '_'));
      await rref.set({
        name: roomName,
        brand: brand || 'unknown',
        minutes: inc,
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) { console.log('room log failed:', e && e.message ? e.message : e); }
  }

  if (USAGE_ALERT_MINUTES > 0) {
    try {
      const d = (await ref.get()).data() || {};
      const total = Number(d.total || 0);
      const pct = total / USAGE_ALERT_MINUTES;
      if (pct >= 1 && !d.alerted100) {
        await ref.set({ alerted100: true }, { merge: true });
        await sendUsageAlert('LiveKit 사용량 100% 초과',
          `${mk} 누적 ${Math.round(total)}분 / 한도 ${USAGE_ALERT_MINUTES}분`);
      } else if (pct >= 0.8 && !d.alerted80) {
        await ref.set({ alerted80: true }, { merge: true });
        await sendUsageAlert('LiveKit 사용량 80% 도달',
          `${mk} 누적 ${Math.round(total)}분 / 한도 ${USAGE_ALERT_MINUTES}분 (${Math.round(pct * 100)}%)`);
      }
    } catch (e) { console.log('usage alert check failed:', e && e.message ? e.message : e); }
  }
}

async function handleLkWebhookEvent(event) {
  if (!event || event.event !== 'participant_left') return;
  const p = event.participant;
  if (!p || !p.identity) return;
  // 자막봇/녹화(egress)는 사용자 사용량이 아니므로 제외.
  if (p.identity === 'captions-bot' || p.identity.startsWith('EG_')) return;
  const joinedAt = Number(p.joinedAt || 0);                       // unix 초
  const leftAt = Number(event.createdAt || Math.floor(Date.now() / 1000));
  if (!(joinedAt > 0) || !(leftAt > joinedAt)) return;
  let minutes = (leftAt - joinedAt) / 60;
  if (minutes > 24 * 60) minutes = 24 * 60;                       // 이상치 상한
  minutes = Math.round(minutes * 100) / 100;
  let brand = '';
  try { brand = JSON.parse(p.metadata || '{}').appId || ''; } catch (_) {}
  const roomName = (event.room && event.room.name) || '';
  await addUsage(brand, minutes, roomName);
}

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

  // LiveKit 웹훅 수신: participant_left 시 브랜드별 사용량(참가자-분) 누적.
  // LiveKit Cloud 프로젝트 설정에 이 URL 을 등록해야 이벤트가 들어온다.
  if (url.pathname === '/livekit-webhook' && req.method === 'POST') {
    if (lkWebhook) {
      try {
        const raw = await readBody(req);
        const event = await lkWebhook.receive(raw, req.headers['authorization']);
        await handleLkWebhookEvent(event);
      } catch (e) {
        console.log('livekit-webhook error:', e && e.message ? e.message : e);
      }
    }
    res.writeHead(200); // 항상 200 — 실패해도 LiveKit 재전송 폭주 방지
    return res.end('ok');
  }

  // 사용량 조회: GET /usage[?month=YYYY-MM]
  //   { month, total, brands:{패키지명:분}, updatedAt(원본), updatedAtText(KST 문자열),
  //     recentRooms:[{name,brand,minutes,lastSeen}] (최근 5개) }
  if (url.pathname === '/usage') {
    if (ADMIN_KEY) {
      const k = (req.headers['x-admin-key'] ||
        url.searchParams.get('key') || '').toString();
      if (k !== ADMIN_KEY) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
    }
    const mk = (url.searchParams.get('month') || usageMonthKey()).toString();
    let data = {};
    let recentRooms = [];
    try {
      if (fbFirestore) {
        const snap = await fbFirestore.collection('lkUsage').doc(mk).get();
        data = snap.exists ? snap.data() : {};
        const rs = await fbFirestore.collection('lkRooms')
          .orderBy('lastSeenAt', 'desc').limit(5).get();
        recentRooms = rs.docs.map((doc) => {
          const r = doc.data();
          return {
            name: r.name,
            brand: r.brand,
            minutes: Math.round((Number(r.minutes) || 0) * 100) / 100,
            lastSeen: fmtKst(r.lastSeenAt),
          };
        });
      }
    } catch (e) { console.log('usage read error:', e && e.message ? e.message : e); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      month: mk,
      alertLimitMinutes: USAGE_ALERT_MINUTES || null,
      ...data,
      updatedAtText: fmtKst(data.updatedAt),
      recentRooms,
    }));
  }

  // 현재 활성 방(시작됐고 아직 종료 안 된 방) — LiveKit 실시간 조회.
  // GET /rooms            → { active, rooms:[{name, participants, publishers, createdAt}] }
  // GET /rooms?detail=1   → 각 방에 members:[{identity, name, publishing}] 포함
  //   publishing=true 면 영상/음성 송출 중(카메라·발표자), false 면 시청만(구독자).
  if (url.pathname === '/rooms') {
    if (ADMIN_KEY) {
      const k = (req.headers['x-admin-key'] ||
        url.searchParams.get('key') || '').toString();
      if (k !== ADMIN_KEY) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
    }
    const detail = url.searchParams.get('detail') === '1';
    try {
      const rooms = await roomSvc.listRooms();
      const list = [];
      for (const r of rooms) {
        // 참가자를 조회해 브랜드(appId)와 봇 외 실인원을 파악.
        let members = [], appId = '', realCount = 0;
        try {
          const parts = await roomSvc.listParticipants(r.name);
          for (const p of parts) {
            const publishing = (p.tracks && p.tracks.length > 0);
            members.push({ identity: p.identity, name: p.name || '', publishing });
            if (p.identity === 'captions-bot' || (p.identity || '').startsWith('EG_')) continue;
            realCount += 1;
            if (!appId) {
              try { const m = JSON.parse(p.metadata || '{}'); if (m.appId) appId = m.appId; } catch (_) {}
            }
          }
        } catch (_) {}
        const bi = brandInfo(appId, r.name);
        const item = {
          name: r.name,
          brand: bi.brand,
          type: bi.type,
          appId: bi.appId,
          participants: Number(r.numParticipants || 0),
          realParticipants: realCount,   // 봇/녹화 제외 실제 인원
          publishers: Number(r.numPublishers || 0),
          createdAt: fmtKst(r.creationTime),
        };
        if (detail) item.members = members;
        list.push(item);
      }
      list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ active: list.length, rooms: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  // 채팅 번역: POST /translate  body={text, target, source?} → {translatedText, detectedSourceLanguage}
  // 각 클라이언트가 수신 메시지를 자기 선호 언어로 "탭 번역"할 때 호출.
  if (url.pathname === '/translate') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST 로 호출하세요.' }));
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
    // provider: 요청 지정값 우선, 없으면 이 배포의 기본 엔진(TRANSLATE_PROVIDER).
    const provider = (body.provider || TRANSLATE_PROVIDER || 'google')
      .toString().toLowerCase();
    if (!text || !target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'text, target 는 필수입니다.' }));
    }
    if (text.length > TRANSLATE_MAX_CHARS) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '번역 가능한 길이를 초과했습니다.' }));
    }
    const cacheKey = `${provider}|${source}|${target}|${text}`;
    if (_trCache.has(cacheKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(_trCache.get(cacheKey)));
    }
    try {
      let out;
      if (provider === 'azure') {
        if (!AZURE_TRANSLATE_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'AZURE_TRANSLATE_KEY 가 설정되지 않았습니다.' }));
        }
        const qs = new URLSearchParams({ 'api-version': '3.0', to: target });
        if (source) qs.set('from', source);
        const aRes = await fetch(`${AZURE_TRANSLATE_ENDPOINT}/translate?${qs}`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_TRANSLATE_KEY,
            'Ocp-Apim-Subscription-Region': AZURE_TRANSLATE_REGION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ Text: text }]),
        });
        const aJson = await aRes.json();
        if (!aRes.ok) {
          const msg = aJson && aJson.error && aJson.error.message
            ? aJson.error.message : `Azure 오류 (${aRes.status})`;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: msg }));
        }
        const r0 = aJson[0];
        out = {
          translatedText: r0.translations[0].text,
          detectedSourceLanguage:
            (r0.detectedLanguage && r0.detectedLanguage.language) || source || '',
        };
      } else if (provider === 'deepl') {
        if (!DEEPL_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'DEEPL_API_KEY 가 설정되지 않았습니다.' }));
        }
        const dBody = { text: [text], target_lang: _deeplLang(target, true) };
        const ds = _deeplLang(source, false);
        if (ds) dBody.source_lang = ds;
        const dRes = await fetch(`${DEEPL_ENDPOINT}/v2/translate`, {
          method: 'POST',
          headers: {
            'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(dBody),
        });
        const dJson = await dRes.json();
        if (!dRes.ok) {
          const msg = dJson && dJson.message ? dJson.message : `DeepL 오류 (${dRes.status})`;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: msg }));
        }
        const d0 = dJson.translations[0];
        out = {
          translatedText: d0.text,
          detectedSourceLanguage:
            (d0.detected_source_language || source || '').toLowerCase(),
        };
      } else {
        if (!GOOGLE_TRANSLATE_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'GOOGLE_TRANSLATE_API_KEY 가 설정되지 않았습니다.' }));
        }
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
        out = {
          translatedText: tr.translatedText,
          detectedSourceLanguage: tr.detectedSourceLanguage || source || '',
        };
      }
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

  // Firebase 커스텀 토큰 발급: POST /authtoken body={uuid} → { token }
  // 앱이 이 토큰으로 signInWithCustomToken → request.auth.uid == uuid (보안 규칙용).
  if (url.pathname === '/authtoken') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST 로 호출하세요.' }));
    }
    if (!fbAuth) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT 미설정.' }));
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '잘못된 요청 본문(JSON) 입니다.' }));
    }
    const uuid = (body.uuid || '').toString();
    // uid 는 1~128자. 우리 uuid(a<ANDROID_ID>_<pkg> 또는 UUIDv4)는 이 범위.
    if (!uuid || uuid.length > 128) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'uuid 가 올바르지 않습니다.' }));
    }
    try {
      const token = await fbAuth.createCustomToken(uuid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '토큰 생성 실패: ' + String(e) }));
    }
  }

  // CCTV 대기모드 원격 켜기: POST /cctv-wake body={code}
  // cctvCameras/{code}.uuid → deviceTokens/{uuid}.fcmToken → FCM(cctv_wake) 전송.
  if (url.pathname === '/cctv-wake') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST 로 호출하세요.' }));
    }
    if (!fbMessaging || !fbFirestore) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'FCM 미설정.' }));
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '잘못된 요청 본문(JSON) 입니다.' }));
    }
    const code = (body.code || '').toString();
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'code 는 필수입니다.' }));
    }
    try {
      const cam = await fbFirestore.collection('cctvCameras').doc(code).get();
      const uuid = cam.exists ? cam.get('uuid') : null;
      if (!uuid) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: '등록된 CCTV 기기를 찾을 수 없습니다.',
        }));
      }
      const dt = await fbFirestore.collection('deviceTokens').doc(uuid).get();
      const token = dt.exists ? dt.get('fcmToken') : null;
      if (!token) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'CCTV 기기가 오프라인입니다(토큰 없음).',
        }));
      }
      await fbMessaging.send({
        token,
        data: { type: 'cctv_wake', code },
        android: { priority: 'high' },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'CCTV 깨우기 실패: ' + String(e) }));
    }
  }

  // 통화 벨: POST /call  body={callId, fromUuid, fromName, toUuid, room, video}
  // 상대(toUuid) 기기 FCM 토큰을 Firestore(devices/{uuid})에서 읽어 수신 푸시를 보낸다.
  if (url.pathname === '/call') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST 로 호출하세요.' }));
    }
    if (!fbMessaging || !fbFirestore) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'FCM 미설정(FIREBASE_SERVICE_ACCOUNT).',
      }));
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '잘못된 요청 본문(JSON) 입니다.' }));
    }
    const callId = (body.callId || '').toString();
    const toUuid = (body.toUuid || '').toString();
    const room = (body.room || '').toString();
    const fromName = (body.fromName || '').toString();
    const fromUuid = (body.fromUuid || '').toString();
    const video = body.video === true || body.video === 'true';
    if (!callId || !toUuid || !room) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'callId, toUuid, room 은 필수입니다.' }));
    }
    try {
      // 토큰은 클라이언트가 못 읽는 deviceTokens 에서 읽는다(구버전은 devices 폴백).
      let fcmToken = null;
      let voipToken = null;
      let bundleId = null;
      const dt = await fbFirestore.collection('deviceTokens').doc(toUuid).get();
      if (dt.exists) {
        fcmToken = dt.get('fcmToken');
        voipToken = dt.get('voipToken'); // iOS 만 존재
        bundleId = dt.get('bundleId'); // 브랜드별 번들 ID(iOS VoIP 토픽용)
      }
      if (!fcmToken) {
        const snap = await fbFirestore.collection('devices').doc(toUuid).get();
        fcmToken = snap.exists ? snap.get('fcmToken') : null;
      }

      console.log(`[/call] callId=${callId} toUuid=${toUuid} voipToken=${voipToken ? 'Y' : 'N'} fcmToken=${fcmToken ? 'Y' : 'N'} apns=${apnProviders ? 'Y' : 'N'} bundleId=${bundleId || '(default)'}`);

      // iOS(voipToken 있음) → VoIP 푸시로 CallKit 표시(꺼진 앱/잠금/절전에서도 수신).
      if (voipToken && apnProviders) {
        try {
          await sendVoipPush(voipToken, {
            id: callId,
            nameCaller: fromName || '전화',
            handle: fromName || '',
            isVideo: video,
            room,
            fromUuid,
            callId,
          }, bundleId);
          console.log(`[/call] → VoIP 전송 완료 callId=${callId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, via: 'voip' }));
        } catch (ve) {
          console.log(`[/call] !! VoIP 전송 실패 callId=${callId}: ${String(ve)}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'VoIP 전송 실패: ' + String(ve) }));
        }
      }
      if (voipToken && !apnProviders) {
        console.log('[/call] voipToken 있으나 APNs 미설정 → FCM 폴백(iOS 꺼진앱 수신 불가)');
      }

      if (!fcmToken) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: '상대 기기를 찾을 수 없습니다(오프라인/미등록).',
        }));
      }
      // Android: data-only(알림 페이로드 없음) 고우선순위 → 앱의 백그라운드 핸들러가
      // 항상 실행되어 풀스크린(CATEGORY_CALL) 통화 알림을 직접 띄운다.
      await fbMessaging.send({
        token: fcmToken,
        data: {
          type: 'incoming_call',
          callId,
          fromUuid,
          fromName,
          room,
          video: String(video),
        },
        android: { priority: 'high' },
      });
      console.log(`[/call] → FCM 전송 완료 callId=${callId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, via: 'fcm' }));
    } catch (e) {
      console.log(`[/call] !! 에러 callId=${callId}: ${String(e)}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '전송 실패: ' + String(e) }));
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
  // 비밀번호는 헤더로 받는다(URL 쿼리 로그 노출 방지). 구버전 앱 호환용 쿼리 폴백.
  const pin = (req.headers['x-room-pin'] ||
    url.searchParams.get('pin') || '').toString().trim();
  const isCreate = url.searchParams.get('create') === 'true'; // 방 만들기 여부
  // dm(1:1 통화)·cctv 방은 여러 당사자가 공유하는 방 → 중복 생성/예약 검사 제외.
  const isShareRoom = room.startsWith('dm-') || room.startsWith('cctv-');
  const isCctv = room.startsWith('cctv-');

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
      // 단, DM 통화방(dm-)은 두 당사자가 공유하는 방이라 중복 거부하지 않고 참여시킨다
      // (발신/수신이 동시에 create 로 들어오는 경쟁 조건 → "이미 사용 중" 오류 방지).
      if (isCreate && !isShareRoom) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: '이미 사용 중인 방 이름입니다. 다른 이름을 사용하세요.',
        }));
      }
      let meta = {};
      try { meta = JSON.parse(existing.metadata || '{}'); } catch (_) {}
      if (meta.private) {
        const now = Math.floor(Date.now() / 1000);
        const akey = `${room}|${clientIp(req)}`;
        const rec = pinAttempts.get(akey) || { fails: 0, lockUntil: 0 };
        // 잠금 중이면 거부.
        if (rec.lockUntil > now) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: '비밀번호 시도가 많습니다. 잠시 후 다시 시도하세요.',
          }));
        }
        if (!pin || pin !== meta.pin) {
          rec.fails += 1;
          if (rec.fails >= PIN_MAX_FAILS) {
            rec.lockUntil = now + PIN_LOCK_SEC;
            rec.fails = 0;
          }
          pinAttempts.set(akey, rec);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ error: '입장 코드가 올바르지 않습니다.' }));
        }
        pinAttempts.delete(akey); // 성공 시 실패 카운트 리셋
      }
    } else {
      if (isCreate) {
        const now = Math.floor(Date.now() / 1000);
        // 방 종료 후 예약창: RESERVE_SEC 동안은 원래 방장만 같은 이름 재생성 가능.
        // 다른 사람이 그 이름으로 만들려 하면 잠시 막는다.
        // 공유 방(dm/cctv)은 여러 당사자가 만들 수 있어야 하므로 예약창 검사 제외.
        const rec = recentlyEnded.get(room);
        if (!isShareRoom &&
            rec && (now - rec.endedAt) < RESERVE_SEC && rec.host !== identity) {
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
        // CCTV 방은 최대 유지시간 제한 없음(카메라가 앱을 끄면 빈 방이 되어 emptyTimeout으로 종료).
        const maxSec = isCctv ? 0 : (isMember ? ROOM_MAX_SEC_MEMBER : ROOM_MAX_SEC);

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
    // 브랜드 구분용 appId(패키지명)를 참가자 메타데이터에 심어, LiveKit 웹훅에서
    // 브랜드별 사용량을 집계할 수 있게 한다(앱은 이미 ?appId= 로 보냄).
    const appId = (url.searchParams.get('appId') || '').toString();
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: identity,
      name: name,
      ttl: '2h',
      metadata: JSON.stringify({ appId }),
    });
    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      // 앱이 회의 중 "말하는 언어"를 참가자 속성(setAttributes)으로 갱신할 수 있게 허용.
      canUpdateOwnMetadata: true,
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
    // 만료된 비밀번호 시도 기록 정리
    for (const [k, rec] of pinAttempts) {
      if ((rec.lockUntil || 0) < now && (rec.fails || 0) === 0) {
        pinAttempts.delete(k);
      } else if ((rec.lockUntil || 0) !== 0 && rec.lockUntil < now) {
        pinAttempts.delete(k);
      }
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
  console.log(`  Azure 번역 = ${AZURE_TRANSLATE_KEY ? `yes (${AZURE_TRANSLATE_REGION})` : 'NO (provider=azure 비활성)'}`);
  console.log(`  기본 엔진   = ${TRANSLATE_PROVIDER}`);
  console.log(`  FCM(통화)   = ${fbMessaging ? 'yes' : 'NO (/call 비활성 — FIREBASE_SERVICE_ACCOUNT 필요)'}`);
  console.log(`  VoIP(iOS)   = ${apnProviders ? `yes (topic ${APNS_BUNDLE_ID}.voip; prod키=${apnProviders.prod ? 'Y' : 'N'} dev키=${apnProviders.sandbox ? 'Y' : 'N'})` : 'NO (APNS_KEY_P8/KEY_ID/TEAM_ID 필요 — iOS 꺼진앱 수신 불가)'}`);
  console.log(`  사용량 집계 = ${fbFirestore ? 'yes (POST /livekit-webhook, GET /usage)' : 'NO (Firestore 없음)'}`);
  console.log(`  사용량 알림 = ${USAGE_ALERT_MINUTES ? `${USAGE_ALERT_MINUTES}분 기준 80/100%${ALERT_WEBHOOK_URL ? '' : ' (ALERT_WEBHOOK_URL 없음 → 로그만)'}` : 'off'}`);
  console.log(`  엔드포인트  = GET /token | POST /translate | POST /call | POST /livekit-webhook | GET /usage | GET /rooms`);
});
