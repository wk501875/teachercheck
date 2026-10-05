# CLAUDE.md

## 프로젝트 배경
- 교회 교사 체크리스트 웹앱(출석·성경읽기 기록).
- 구성: `index.html` 단일 파일 + `functions/supabase.js`(Cloudflare Pages Function, 주소는 `/supabase`).
- `main` 브랜치에 머지되면 Cloudflare Pages(teachercheck.pages.dev)로 자동 배포됨. 빌드 과정 없음.
- 데이터는 Supabase의 `checklist_data` 테이블에 부서별 한 행으로 저장.
  - id가 `junior` / `senior` 인 행: 2026 회기 운영 데이터. 다른 사이트가 실제 사용 중. 이 사이트에서는 "2026 회기" 조회 화면에서 **읽기만** 함(`season: 2026` GET 요청).
  - id가 `junior_2027` / `senior_2027` 인 행: 이 저장소가 쓰는 새 회기의 **명단·PIN·마감 설정**(`functions/supabase.js`의 `ROW_SUFFIX`). 이 행의 `state` 칸은 예전 통째 저장분으로, 새 구조로 옮겨지기 전 기록을 보여줄 때만 읽음.
- 2027 회기 **선생님별 기록**은 `teacher_records` 테이블에 선생님 한 명당 한 행(`season`, `dept`, `teacher_id`, `state`, `version`).
  - 선생님은 이름이 아닌 고유 ID(`id`)로 구분. 예전 명단(id 없음)은 순서대로 `t_1`, `t_2` ...
  - 저장은 `version`이 맞을 때만 성공(오래된 화면이 덮어쓰지 못함). 충돌하면 화면에서 바뀐 칸만 최신 기록 위에 병합 후 다시 저장.
  - 명단 행 저장도 `updated_at`이 맞을 때만 성공. 부서 전체를 통째로 저장하는 방식(`PUT`)은 쓰지 않음.
- 사용자는 개발자가 아니고 태블릿으로 작업함. 설명은 한국어로 쉽게.

## 반드시 지킬 규칙
- `ROW_SUFFIX` 값을 바꾸지 말 것.
- `junior` / `senior` 행은 **읽기만 허용, 쓰기는 금지**. 이 행에 쓰기(PUT/PATCH/INSERT/DELETE)하는 코드를 만들지 말고, `functions/supabase.js`에서 2026 회기 PUT을 거부하는 안전장치를 없애지 말 것.
- 2026 회기 데이터는 화면 표시용으로 메모리에만 두고, localStorage나 2027 행(`junior_2027` / `senior_2027`)에 섞이지 않게 할 것.
- 요청한 부분만 수정하고 기존 디자인과 기능은 그대로 유지할 것.
- 빌드 도구나 프레임워크를 도입하지 말고 단일 `index.html` 구조 유지.
- DB 구조 변경이 필요하면 직접 하지 말고, 사용자가 Supabase에서 실행할 SQL을 PR 설명에 적을 것.
