# iOS VoIP 푸시(CallKit) 서버 설정 — Render 환경변수

iOS는 데이터 전용 FCM으로 **꺼진 앱을 못 깨운다.** 그래서 `/call`은 상대가 iOS(voipToken 보유)면
**APNs VoIP 푸시**를 직접 보내 PushKit이 앱을 깨우고 CallKit(네이티브 전화 UI)을 띄운다.

이걸 켜려면 Render 대시보드 → `prism-token-server` → **Environment** 에 아래 4개를 추가한다.

| Key | 값 | 비고 |
|-----|-----|------|
| `APNS_KEY_P8` | `.p8` 파일 **내용 전체** (BEGIN/END 포함) | **Firebase에 올린 그 APNs 키와 동일 파일** 재사용 |
| `APNS_KEY_ID` | 그 키의 Key ID (10자) | Apple Developer → Keys 에서 확인 |
| `APNS_TEAM_ID` | `N7653V74T8` | Apple 팀 ID |
| `APNS_BUNDLE_ID` | `kr.co.mychannel.meeting.prism` | prism 번들 ID(기본값이라 생략 가능) |

## `.p8` 내용 넣는 법
`.p8` 파일을 텍스트 에디터로 열어 전체를 복사해 `APNS_KEY_P8` 값에 붙여넣는다. 형태:
```
-----BEGIN PRIVATE KEY-----
MIGTAgEA...
...여러 줄...
-----END PRIVATE KEY-----
```
- Render는 여러 줄 값을 지원한다. 만약 한 줄로 붙게 되면 줄바꿈을 `\n` 으로 넣어도 된다(서버가 `\n`→줄바꿈 변환함).

## 저장 후
- 자동 재배포됨. 로그에 다음이 뜨면 정상:
  ```
  VoIP(iOS)   = yes (topic kr.co.mychannel.meeting.prism.voip)
  ```
- `NO (...)` 로 뜨면 위 3개(P8/KEY_ID/TEAM_ID) 중 빠진 게 있는 것.

## 동작
- 상대가 **iOS** → VoIP 푸시(`via: voip`). 앱 종료/잠금/절전에서도 CallKit 수신.
  - production APNs 먼저 시도 → `BadDeviceToken` 이면 sandbox 재시도(개발서명 빌드 대응).
    TestFlight/AppStore 빌드는 production으로 자동 처리됨.
- 상대가 **Android** → 기존 FCM 데이터 메시지(`via: fcm`). 변경 없음.

## 주의
- VoIP 토픽은 반드시 `<bundleId>.voip` 여야 한다(코드에서 자동 구성).
- 브랜드가 늘면(gbled 등) 브랜드별 번들 ID로 `APNS_BUNDLE_ID` 를 맞추거나, 서버를 다중 번들 대응으로 확장해야 한다(현재는 prism 기준).
