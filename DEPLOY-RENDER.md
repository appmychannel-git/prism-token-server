# Render 무료 배포 가이드 (토큰 서버)

목표: 토큰 서버를 Render 무료 티어에 올려 **고정 HTTPS 주소**를 얻고,
UptimeRobot 무료 핑거로 **항상 켜진 상태**로 유지. (데스크탑 무관, 카드 불필요)

---

## 1) GitHub에 token-server 올리기 (한 번만)

Render는 GitHub 저장소를 연결해 배포합니다. 이 `token-server` 폴더를 저장소로 올립니다.
(로컬 git 준비는 이미 되어 있음 — 아래는 새 원격 저장소 연결만)

1. https://github.com 에서 새 저장소 생성 (예: `prism-token-server`, Private 가능)
2. 안내되는 명령 중 "push an existing repository" 부분을 이 폴더에서 실행:
   ```powershell
   cd D:\claude\project\prism\prism_meeting\token-server
   git remote add origin https://github.com/<your-id>/prism-token-server.git
   git branch -M main
   git push -u origin main
   ```

## 2) Render에서 배포

1. https://render.com 가입 (GitHub 계정으로 로그인 가능, **카드 불필요**)
2. **New → Web Service** → 방금 만든 GitHub 저장소 선택
3. 설정 (대부분 자동 인식):
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node index.js`
   - Instance Type: **Free**
4. **Environment** 에 3개 추가 (LiveKit Cloud 값):
   - `LIVEKIT_URL` = `wss://<프로젝트>.livekit.cloud`
   - `LIVEKIT_API_KEY` = `<API Key>`
   - `LIVEKIT_API_SECRET` = `<API Secret>`
5. **Create Web Service** → 빌드·배포 완료되면 주소가 나옵니다:
   `https://prism-token-server-xxxx.onrender.com`

## 3) 동작 확인

```powershell
curl "https://prism-token-server-xxxx.onrender.com/health"
# -> {"ok":true,"serverUrl":"wss://..."}
```

## 4) UptimeRobot 핑거로 항상 켜두기 (콜드스타트 방지)

Render 무료는 15분 미사용 시 잠듭니다. 5분마다 찔러서 깨어있게 유지:

1. https://uptimerobot.com 무료 가입
2. **Add New Monitor**
   - Type: **HTTP(s)**
   - URL: `https://prism-token-server-xxxx.onrender.com/health`
   - Interval: **5 minutes**
3. 저장 → 이제 서버가 잠들지 않습니다.

## 5) 앱을 이 주소로 빌드

발급된 Render 주소로 APK를 다시 빌드하면 데스크탑·터널과 무관하게 동작:
```powershell
flutter build apk --release --dart-define=LK_TOKEN_URL=https://prism-token-server-xxxx.onrender.com/token
```

---

> ⚠️ API Secret은 절대 깃에 커밋하지 마세요. Render 대시보드의 Environment에만 입력합니다.
> (이 폴더의 .gitignore 가 node_modules/.env 를 제외합니다.)
