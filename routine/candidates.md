# 주말 비서 · 후보 만들기 (매주 월요일 21:00, 목요일 18:00)

이번 주말(토·일)에 아이와 갈 곳 후보를 만들어 주말 비서 시트에 넣는다.
월요일 실행은 미리 채우기, 목요일 실행은 최신 행사·정보로 다시 채우기다. 같은 주에 다시 보내면 그 주 후보가 통째로 바뀐다.
CLAUDE.md의 절대 원칙(2장), 시트 구조(4장), 유효기간(5장), 추천 규칙(6장)을 따른다.

## 준비

1. 프로젝트 폴더: `C:\Users\jangm\OneDrive\바탕 화면\MJ\#AI\03.우진주말비서앱`
2. `.env`에서 `WEBAPP_URL`, `ROUTINE_SECRET`을 읽는다. 값은 출력하거나 다른 파일·메시지에 쓰지 않는다.
   `.env`가 없으면 아래 '실패할 때'로 간다.
3. CLAUDE.md 2·4·5·6장을 읽는다.

## 서버 부르는 법

요청 본문을 스크래치 폴더의 JSON 파일로 쓰고 POST한다. 응답은 JSON이다.

```bash
curl -sL -H "Content-Type: application/json" --data @body.json "$WEBAPP_URL"
```

모든 본문에 `"secret": ROUTINE_SECRET`을 넣는다. `ok:false`면 `error`를 읽고 고친다.

## 순서

1. **읽기**: `{"action":"state"}`
   - `weekend`(sat, sun), `child_months`, `settings`(기준 위치·반경·자차 시간·제외 유형·`kid_interests` 아이 취향), `weather`, `places`, `place_facts`, `events`, `bookings`, `feedback`, `excluded_ref_ids`(별로였어요), `info_wrong`(제보), `recheck`(다시 확인할 항목), `current_candidates`.
   - 반복 방지용: `recent_top`(최근 3주 섹션 상위 5곳), `seen_ref_ids`(지금까지 후보에 나온 곳), `resting_ref_ids`(다녀온 지 4주가 안 된 곳).
   - `child_months`가 null이면 월령 조건 없이 진행하고, 마지막 기록에 "생년월일 미입력"을 남긴다.

2. **정보 확인 (③)**: 최대 20건.
   - 순서: 이번 주 후보로 쓸 곳의 `needs_check`·`expired` → `info_wrong` 제보가 있는 곳 → 나머지.
   - 출처 신뢰 순서: 공식 홈페이지 > 지자체·공공기관 > 육아 플랫폼 > 블로그.
   - 출처 2곳이 같으면 `verified`. 엇갈리면 `conflict`로 하고 보수적인 값(더 이른 마감, 더 비싼 요금)을 쓴다. 못 찾으면 `needs_check` 그대로 둔다.

3. **행사 모으기**: 이번 토·일과 앞으로 4주 안에 열리는 아이 동반 행사.
   - 범위: 기준 위치에서 자차 편도 `max_drive_min`분 안, 직선 `radius_km` 안.
   - 찾을 곳: 기준 위치 주변 구청(동작·관악·영등포·서초·용산·마포·구로·금천·강남·양천·강서·중구·종로)과 경기 과천·광명·안양·성남 공지, 서울시·문화포털, 국립 박물관·미술관 공지, 뉴스.
   - 날짜·장소·대상 연령·요금은 출처 URL이 있는 것만 넣는다. 일정이 확인 안 된 행사는 넣지 않는다.
   - 이번 주말 행사만 후보(`weekly_candidates`)에 넣는다. 다음 주 이후 행사는 `events`에만 넣는다. 앱의 '다가오는 행사'에 나오고, 그 주가 되면 후보로 올린다.
   - 이미 `state.events`에 있는 행사는 일정이 바뀌었는지만 확인한다.

4. **장소 채우기 (①)**: 실내·실외 후보가 각각 20곳이 안 되거나, 처음 추천할 곳(`seen_ref_ids`에 없는 곳)이 섹션마다 2곳이 안 되면 새 장소를 더한다 (한 번에 최대 15곳, 구경거리 장소는 따로 최대 5곳).
   - 필수: 이름, 주소, 좌표(지도 서비스나 공식 주소로 확인한 값), `category`, `io`, `source_primary`.
   - 월령 범위(`age_min_months`, `age_max_months`)는 근거가 있을 때만 넣는다.
   - 운영시간(토·일), 휴무, 요금, 주차, 수유실, 유모차, 예약 규칙은 `place_facts`로 출처와 함께 넣는다.
   - `excluded_ref_ids`, 설정의 `exclude_categories`에 있는 것은 넣지 않는다.

5. **구경거리 찾기 (6장 13번)**: 토·일 각각 1곳 이상, 좋은 곳이 있으면 2~3곳.
   - 이번 주 테마를 하나 고른다. `kid_interests`를 먼저 보고, 지난 몇 주와 겹치지 않게 돌린다. 지난 테마는 `recent_top`과 `seen_ref_ids`의 구경거리 장소로 짐작한다.
     - 예: 🚂 기차·지하철이 보이는 곳 · ✈️ 비행기가 보이는 곳 · 🚌 버스·트램 · 🐟 물고기·동물 · 🚜 공사장 차 구경 · 🚢 배가 보이는 강변
   - 아이 시설이 아니어도 된다. 예: 기찻길 앞 카페, 비행기가 낮게 지나가는 공원, 버스 차고지가 보이는 공원. 카페·전망 장소는 `category`를 `view_spot`으로 넣는다.
   - **아이 동반 가능(`kids_allowed`)을 반드시 확인한다.** 노키즈존이거나 확인하지 못한 곳은 넣지 않는다.
   - `highlight`에 무엇을 언제 볼 수 있는지 적는다. 예: "창가 자리에서 경의중앙선 기차가 10분마다 지나가요".
   - 공식 출처가 없고 방문 후기만 있으면 최근 1년 안 후기 2곳 이상이 같은 내용일 때 `review_based`로 넣는다. 후기 1곳뿐이면 넣지 않는다.
   - 후보에는 `구경거리` 배지를 달고, `io`는 실제 장소에 맞게(카페는 indoor) 넣는다. 앱이 '🔭 이번 주 구경거리' 칸에 따로 모아 보여준다.

6. **순위 매기기 (6장)**: 토·일 × 실내·실외마다 최대 20곳, rank 1부터.
   - **새 장소 우선 (6장 12번)**:
     - `resting_ref_ids`(다녀온 지 4주가 안 된 곳)는 넣지 않는다. `또 갈래요`를 받은 곳은 4주가 지나면 다시 넣어도 된다.
     - `recent_top`에 있는 곳(최근 3주 상위 5곳)은 6위 아래로 내린다.
     - 섹션마다 1~5위 중 2곳 이상은 `seen_ref_ids`에 없는 처음 추천하는 곳으로 채운다. `처음 추천` 배지는 서버가 붙이니 따로 달지 않는다.
   - 그날 휴무인 곳, 월령·연령이 안 맞는 곳은 뺀다.
   - 이번 주말에만 있는 행사는 위로 올리고 `이번 주만` 배지.
   - 가까울수록 가점. 5곳 묶음마다 같은 `category`는 최대 2곳.
   - 운영시간이 `needs_check`인 곳은 뒤로.
   - **예약이 이미 열려 지나간 곳은 맨 뒤로**: 예약이 필요한 곳인데 이번 주말 회차의 예약 오픈 시각이 이미 지났으면(예: 14일 전 오픈), 남은 자리를 확인하지 못한 한 그 섹션 맨 뒤에 두고 `예약 마감 가능` 배지를 붙인다. 현장 접수나 남은 자리가 확인된 곳은 예외다.
   - `feedback`의 `refresh`가 많았던 섹션 유형은 낮추고, `good` 받은 곳은 4주가 지나면 가끔 다시 넣는다.
   - `kid_interests`와 맞는 곳(예: 기차를 좋아하면 기차 박물관, 철도 공원)은 조금 올린다.
   - `reason`: 이 아이(개월수)에게 왜 좋은지 한 줄. 확인된 사실로만 쓴다. 무료 여부, 확인이 필요한 점도 여기에 짧게 쓴다.
   - **배지는 아래 것만 쓴다.** 앱에서 주황색으로 눈에 띄게 보여서, 행동이 필요한 정보만 배지로 단다.
     - `이번 주만`, `토요일만`, `일요일만`
     - `N개월 이상`, `N세 이상` (근거가 있을 때)
     - `예약 필요`, `예약 마감 가능`
     - `구경거리` (5번 단계의 장소)
   - `무료`, `출처 엇갈림`, `운영시간 확인 필요`, `휴관 확인 필요` 같은 정보는 배지로 달지 않는다. 사실은 `place_facts`에, 설명은 `reason`에 둔다.

7. **예약 (⑤)**: 후보 중 예약이 필요한 곳은 `bookings`에 넣는다.
   - 이번 주말과 다음 4주 주말 중 방문할 만한 날짜(`visit_date`)를 고르고, 확인한 예약 오픈 규칙으로 `open_at`을 계산한다.
   - 규칙을 확인하지 못했으면 `open_at`을 비운다 (화면에 '확인 필요'로 나온다).

8. **쓰기**: `{"action":"ingest","week_start": weekend.sat, "data": {places, place_facts, events, weekly_candidates, bookings}}`
   - 응답의 `warnings`를 확인하고, 고칠 수 있는 것은 고쳐서 한 번 더 보낸다.

9. **기록**: `{"action":"log","clock":"candidates","result":"ok"|"warn","detail":"후보 n곳 · 처음 추천 n · 구경거리 n(테마) · 새 장소 n · 확인 n건 · 경고 n건"}`

## 데이터 형식

- 시각은 모두 한국 시간. 날짜 `yyyy-MM-dd`, 시각 `yyyy-MM-ddTHH:mm`.
- `places`: `place_id`(영문 소문자·숫자·하이픈, 예: `boramae-park`), `name`, `category`(park | playground | kids_cafe_public | kids_cafe_private | library | museum | indoor_zoo | indoor_mall | experience | event_venue | view_spot), `io`(indoor | outdoor), `lat`, `lng`, `address`, `age_min_months`, `age_max_months`, `booking_required`(Y/N), `booking_rule`, `booking_url`, `kakao_url`, `naver_url`, `source_primary`
- `place_facts`: `place_id`, `field`(hours_sat | hours_sun | closed_days | fee | parking | parking_fee | nursing_room | stroller | transit | related_place | booking_rule | kids_allowed | highlight), `value`, `status`(verified | needs_check | conflict | review_based), `sources`(URL 쉼표 구분, verified·conflict·review_based는 필수), `checked_at`(생략하면 지금). `expires_at`은 서버가 채운다.
- `events`: `event_id`, `name`, `venue`, `place_id`(있으면), `start`, `end`, `age_note`, `sources`, `io`, `address`, `lat`, `lng`, `fee`, `url`
- `weekly_candidates`: `day`(sat | sun), `io`, `rank`(1~20), `ref_type`(place | event), `ref_id`, `reason`, `badges`(배열)
- `bookings`: `place_id`, `visit_date`, `open_at`(비워도 됨)

## 지키는 것

- 정보를 지어내지 않는다. 출처 URL이 없는 사실은 `verified`로 넣지 않는다.
- 예약은 하지 않는다. 예약 링크까지만 넣는다.
- 비밀값을 출력하거나 커밋하지 않는다. 임시 파일은 스크래치 폴더에 둔다.
- 저장소 파일은 고치지 않는다.
- 성공했을 때는 카카오톡을 보내지 않는다. 알림은 20시 작업이 보낸다.

## 실패할 때

- 서버에 쓰지 못했으면 카카오톡 나에게 보내기로 한 줄 알린다: `[주말 비서] 후보 만들기 실패: (사유를 짧게)`
- 가능하면 `{"action":"log","clock":"candidates","result":"error","detail":"사유"}`도 남긴다.
