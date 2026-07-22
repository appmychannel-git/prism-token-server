# Prism 토큰 서버

LiveKit 접속 토큰을 발급하는 경량 Node 서버. (의존성: `livekit-server-sdk` 하나)

앱은 `GET /token?room=<방>&name=<이름>` 을 호출하고,
서버는 `{ "serverUrl": "...", "participantToken": "..." }` 를 반환합니다.

## 1) LiveKit Cloud에서 값 3개 확보
- **LIVEKIT_URL**: 프로젝트의 `wss://...livekit.cloud` 주소 (Settings/General)
- **API Key / API Secret**: 좌측 **"API keys"** 탭에서 발급

## 2) 설치
```bash
cd token-server
npm install
```

## 3) 실행

**Windows PowerShell**
```powershell
$env:LIVEKIT_URL="wss://<프로젝트>.livekit.cloud"
$env:LIVEKIT_API_KEY="<API Key>"
$env:LIVEKIT_API_SECRET="<API Secret>"
node index.js
```

**macOS / Linux / Git Bash**
```bash
LIVEKIT_URL="wss://<프로젝트>.livekit.cloud" \
LIVEKIT_API_KEY="<API Key>" \
LIVEKIT_API_SECRET="<API Secret>" \
node index.js
```

정상 실행되면 `listening on :3000` 이 출력됩니다.

## 4) 확인
```bash
curl "http://localhost:3000/token?room=test&name=alice"
# -> {"serverUrl":"wss://...","participantToken":"eyJ..."}
```

## 5) 앱과 연결
- **같은 PC의 웹**:   `--dart-define=LK_TOKEN_URL=http://localhost:3000/token`
- **폰/TV 등 다른 기기**: PC의 LAN IP 사용
  `--dart-define=LK_TOKEN_URL=http://192.168.10.20:3000/token`
  (IP 확인: Windows `ipconfig`, 같은 Wi-Fi/공유기여야 함. 방화벽에서 3000 포트 허용)

> ⚠️ 이 서버는 프로토타입용이라 인증이 없습니다(누구나 토큰 발급 가능).
> 실서비스에서는 로그인/검증을 붙이고, HTTPS 뒤에 두세요.
