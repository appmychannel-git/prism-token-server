# 거래처별 토큰서버 분리 운영 (A안)

**한 코드베이스 → 거래처마다 별도 배포**. 코드는 같고, **환경변수와 앱 빌드 URL만** 다르다.
이렇게 하면 ① 거래처별 최적 번역엔진 ② 거래처별 사용량 분리 ③ 격리(장애·브랜딩)를 한 번에 얻는다.

실측 근거: 키냐르완다는 Azure가 ~1/3 영어로 반환(실패) → **르완다=Google**. 카자흐·러시아는
Azure가 정상+절반값 → **카자흐스탄=Azure**.

## 거래처별 구성 예시

| 거래처 | 토큰서버(Render) | 기본 엔진 | 번역 키 | 앱 빌드 `LK_TOKEN_URL` |
|---|---|---|---|---|
| 기본/국내·르완다 | `prism-token-server` | google | `GOOGLE_TRANSLATE_API_KEY` | `https://prism-token-server.onrender.com/token` |
| 카자흐스탄 | `prism-token-kz`(신규) | azure | `AZURE_TRANSLATE_*` | `https://prism-token-kz.onrender.com/token` |

## 새 거래처 서버 띄우기 (체크리스트)

1. **Render에 새 Web Service 생성** — 같은 저장소(`prism-token-server`) 연결, 이름 예 `prism-token-kz`.
   (Build: 없음 / Start: `node index.js` / Instance: Free)
2. **환경변수 설정**:
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
     - 거래처별 사용량/격리를 원하면 **LiveKit 프로젝트도 거래처별로** 발급(선택). 공유해도 동작.
   - `TRANSLATE_PROVIDER` = `azure` (카자흐스탄) 또는 `google` (르완다/기본)
   - 엔진에 맞는 키:
     - google: `GOOGLE_TRANSLATE_API_KEY`
     - azure: `AZURE_TRANSLATE_KEY`, `AZURE_TRANSLATE_REGION`, `AZURE_TRANSLATE_ENDPOINT`
   - (선택) 방 정책 env: `ROOM_MAX_SEC`, `EMPTY_SEC` 등
3. **UptimeRobot**로 `/health` 5분 핑 → 무료 티어 슬립 방지.
4. **거래처 앱 빌드**를 그 서버로:
   ```
   flutter build apk --release --dart-define=LK_TOKEN_URL=https://prism-token-kz.onrender.com/token
   ```
   - 번역 주소(`/translate`)는 앱이 `LK_TOKEN_URL`의 `/token`을 `/translate`로 자동 치환 → **따로 지정 불필요**.
   - 이 서버의 `TRANSLATE_PROVIDER`가 엔진을 결정하므로 **앱은 provider를 몰라도 됨**.

## 사용량(비용) 추적

- **거래처별로 다른 번역 키/리소스**를 쓰면, 각 클라우드 콘솔에서 **거래처별 사용량·청구**가 분리돼 보인다.
  - Google: 거래처별 **프로젝트(또는 키)** → Google Cloud 콘솔 사용량
  - Azure: 거래처별 **Translator 리소스** → Azure 메트릭
- 같은 엔진을 여러 거래처가 써도, **키만 분리**하면 사용량이 나뉜다.

## 참고

- 엔진을 일시적으로 강제하려면 요청 body에 `provider: 'azure'|'google'`을 넣으면 배포 기본값보다 우선.
  (품질 비교·디버깅용. 평상시엔 서버의 `TRANSLATE_PROVIDER`에 맡긴다.)
- 절대 절감액은 작다(번역비 자체가 소액). A안의 주 가치는 **엔진 최적화 + 사용량 가시성 + 격리**.
- 거래처가 2~3곳 이상 확정될 때 본격 적용 권장. 소수/데모 단계는 단일 서버로 충분.
