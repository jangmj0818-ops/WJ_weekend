# 주말 비서

부부 둘이 쓰는 개인용 웹앱. 아이와 이번 주말에 갈 곳을 추천하고, 예약이 필요한 곳을 미리 알려준다.
기획·규칙은 [CLAUDE.md](CLAUDE.md)에 있다.

```
apps-script/   구글 시트에 붙는 Apps Script (서버 Code.gs, 화면 Index.html, 설정 appsscript.json)
routine/       Claude 예약 작업 지시서 (월 21:00·목 18:00 후보 만들기, 목 20:00 카카오톡 알림)
.env.example   예약 작업이 읽는 값의 형식
```

## 처음 설치 (10분)

1. **시트 만들기**: [sheets.new](https://sheets.new)에서 새 스프레드시트를 만들고 이름을 `주말 비서`로 바꾼다.
2. **스크립트 붙여넣기**: 메뉴 `확장 프로그램 → Apps Script`.
   - `Code.gs`의 내용을 지우고 [apps-script/Code.gs](apps-script/Code.gs)를 붙여넣는다.
   - 파일 옆 `+` → `HTML` → 이름 `Index` → [apps-script/Index.html](apps-script/Index.html)을 붙여넣는다.
     (HTML 파일은 링크로 열면 화면으로 보여서 코드가 안 보인다. 메모장으로 열거나 Claude에게 "Index.html 복사해 줘"라고 하면 클립보드에 넣어 준다.)
   - 왼쪽 `프로젝트 설정(톱니바퀴)` → `"appsscript.json" 매니페스트 파일 표시` 체크 → 편집기로 돌아와 `appsscript.json`에 [apps-script/appsscript.json](apps-script/appsscript.json)을 붙여넣는다.
   - 저장(Ctrl+S).
3. **준비 실행**: 위쪽 함수 목록에서 `setup` → `실행`. 권한 요청이 뜨면 본인 계정으로 허용한다.
   ("Google에서 확인하지 않은 앱" 화면이 나오면 `고급 → 주말 비서(으)로 이동`.)
   시트에 탭 9개가 생기면 성공.
4. **웹 앱 배포**: 오른쪽 위 `배포 → 새 배포` → 유형 `웹 앱` → 실행 사용자 `나`, 액세스 권한 `모든 사용자` → `배포`.
5. **링크 받기**: 함수 목록에서 `showLinks` → `실행`. 아래 실행 로그에 나온다.
   - `MJ 링크`, `아내 링크`: 각자 휴대폰에서 열고 `홈 화면에 추가`. 링크에 열쇠가 들어 있으니 남에게 보내지 않는다.
   - `WEBAPP_URL`, `ROUTINE_SECRET`: 프로젝트 폴더에 `.env` 파일을 만들어 넣는다 ([.env.example](.env.example) 형식).
6. **아이 생년월일**: 앱 오른쪽 위 설정 버튼에서 입력한다.

## 코드를 고친 뒤

Apps Script 편집기에 고친 파일을 붙여넣고 `배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포`.
이렇게 하면 웹 앱 주소가 그대로 유지된다. (`새 배포`를 다시 만들면 주소가 바뀐다.)

## 자동으로 도는 것

| 언제 | 무엇 | 어디서 |
|---|---|---|
| 매일 7시 | 날씨로 실내·실외 순서 다시 정렬, 기한 지난 정보 표시 | Apps Script 트리거 (`setup`이 만든다) |
| 월 21:00 | 다가오는 주말 후보 미리 만들기 | Claude 예약 작업 → [routine/candidates.md](routine/candidates.md) |
| 목 18:00 | 최신 행사·정보로 후보 다시 만들기 | Claude 예약 작업 → [routine/candidates.md](routine/candidates.md) |
| 목 20:00 | 카카오톡 나와의 채팅으로 요약 알림 | Claude 예약 작업 → [routine/notify.md](routine/notify.md) |

Claude 예약 작업은 이 PC에서 Claude 앱이 켜져 있을 때 돈다. 그 시각에 꺼져 있었으면 다음에 켤 때 돈다.
