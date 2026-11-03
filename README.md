# Small-happiness

**당신의 하루가 소박한 행복이 되기를.** — 시스템에서 태어나는 생활 이야기

일하는 직장인의 하루를 곁에서 지켜보는 스토리텔링 기반 생활 시뮬레이션. 콘텐츠는 시스템에서 나오고, 작가는 그 순간의 문장을 쓴다.

## 개발

```sh
npm install
npm test          # 테스트
npm run typecheck # 타입 검사
```

Node 22.18 이상이 필요하다. TypeScript를 빌드 없이 바로 실행한다.

## 명령줄

```sh
node src/node/cli.ts status                                   # 정의 수, 다음 번호, 사전 규모
node src/node/cli.ts validate examples/patches/fridge-chain.json   # 병합·관문만 확인 (쓰지 않음)
node src/node/cli.ts merge <패치.json> [--dry] [--allow-warnings] # 관문 통과 시 저장소와 기록에 씀
node src/node/cli.ts chains [규칙 번호]                       # 자동으로 이어진 규칙 사슬
node src/node/cli.ts appendix [--write | --check]              # 자동 생성 부록
```

데이터(`data/db.json`)는 직접 고치지 않고 **패치**로만 바꾼다. 패치는 관문을 통과해야 들어가며, 거부되면 아무것도 쓰지 않는다.

## 구성

| 경로 | 내용 |
|---|---|
| `src/core/` | 시뮬레이션 코어 (번호, 상태 키, 사건, 기록, 사전, 정의 저장소, 패치, 관문, 사슬, 보고서). 입출력 없음 |
| `src/node/` | 파일을 읽고 쓰는 어댑터 (서기, 명령줄) |
| `data/vocab/` | 사전 (게임이 쓰는 모든 단어) |
| `data/db.json` | 정의 저장소 (패치로만 변경) |
| `examples/patches/` | 예시 패치 |
| `test/` | 테스트 |
| `docs/` | 기획과 설계 문서 |

## 문서

- `docs/기획보고서-v2.md` — 기획 보고서
- `docs/구현-계획.md` — 작업 목록 (빌더 플랜)
- `docs/결정-기록.md` — 결정 현황
- `docs/시스템-명세.md` — 시스템 분리와 계약
- `docs/기반층-명세.md` — 번호, 상태 키, 사건, 기록, 난수, 시계, 저장
- `docs/인물-명세.md` — 내면, 밖의 하루, 자율 행동
- `docs/번짐-명세.md` — 오염이 퍼지는 방식
- `docs/사전-명세.md` — 사전(통제 어휘)
- `docs/DB-개념-이식.md` — 별도 프로젝트에서 가져온 설계 개념과 도구
