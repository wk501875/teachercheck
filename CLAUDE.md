# CLAUDE.md

## 프로젝트 배경
- 교회 교사 체크리스트 웹앱(출석·성경읽기 기록).
- 구성: `index.html` 단일 파일 + `functions/supabase.js`(Cloudflare Pages Function, 주소는 `/supabase`).
- `main` 브랜치에 머지되면 Cloudflare Pages(teachercheck.pages.dev)로 자동 배포됨. 빌드 과정 없음.
- 데이터는 Supabase의 `checklist_data` 테이블에 부서별 한 행으로 저장.
  - id가 `junior` / `senior` 인 행: 2026 회기 운영 데이터. 다른 사이트가 실제 사용 중.
  - id가 `junior_2027` / `senior_2027` 인 행: 이 저장소가 쓰는 새 회기 데이터(`functions/supabase.js`의 `ROW_SUFFIX`).
- 사용자는 개발자가 아니고 태블릿으로 작업함. 설명은 한국어로 쉽게.

## 반드시 지킬 규칙
- `ROW_SUFFIX` 값을 바꾸거나, `junior` / `senior` 행에 쓰기(수정)하는 코드를 만들지 말 것.
- 요청한 부분만 수정하고 기존 디자인과 기능은 그대로 유지할 것.
- 빌드 도구나 프레임워크를 도입하지 말고 단일 `index.html` 구조 유지.
- DB 구조 변경이 필요하면 직접 하지 말고, 사용자가 Supabase에서 실행할 SQL을 PR 설명에 적을 것.
