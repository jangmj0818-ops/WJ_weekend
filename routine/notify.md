# 주말 비서 · 카카오톡 알림 (매주 목요일 20:00)

이번 주말 추천 요약을 카카오톡 나와의 채팅으로 보낸다.

1. 프로젝트 폴더 `C:\Users\jangm\OneDrive\바탕 화면\MJ\#AI\03.우진주말비서앱`의 `.env`에서 `WEBAPP_URL`, `ROUTINE_SECRET`을 읽는다. 값은 출력하지 않는다.
2. 요약 문구를 받는다. 본문은 스크래치 폴더에 JSON 파일로 쓴다.
   ```bash
   curl -sL -H "Content-Type: application/json" --data @body.json "$WEBAPP_URL"
   ```
   본문: `{"secret": ROUTINE_SECRET, "action": "summary"}` → 응답 `{"ok": true, "text": "..."}`
3. `ok`가 true면 `text`를 고치지 말고 그대로 카카오톡 나에게 보내기 도구로 보낸다. 서버가 200자 안으로 맞춰 준다.
4. 실패하면 이렇게 보낸다: `[주말 비서] 이번 주 추천을 불러오지 못했어요. (사유를 짧게)`
5. 기록: `{"secret": ..., "action": "log", "clock": "notify", "result": "ok"|"error", "detail": "보낸 글자 수 또는 사유"}`

지키는 것: 비밀값을 출력하거나 메시지에 넣지 않는다. 메시지는 한 번만 보낸다. 저장소 파일은 고치지 않는다.
