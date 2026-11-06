# CHANGES — 코드·형식 변경 기록

> 맨 위가 최신이다. **행을 고치거나 지우지 않는다.** 코드·형식·어휘·문서 구조를 바꾸면 **같은 커밋에서** 한 행을 맨 위에 더한다. 데이터 패치의 보고서는 패치 기록(`data/patches/*.json`)의 `report`에 저장되고 `report <기록>`으로 본다. 결정은 `docs/결정-기록.md`에, 여기에는 **무엇을 바꿨는지**만 적는다.
> 칸: Scope(파일·함수·정의) · Why · Impact(하류 규칙·명령·데이터) · Verification(시험 수·검사).

| 날짜 · 주제 | Scope | Why | Impact | Verification |
|---|---|---|---|---|
| 2026-11-06 · 기획서 (한 문서) | `docs/기획서.md`(신설), `docs/images/기획서-*.png`(그림 3개), `docs/보고서-목록.md`(행·집계·읽는 순서), `README.md` 문서 목록 | 처음 보는 사람이 게임과 엔진 전체를 한 문서로 이해하게 한다. Claude Docs 공유본의 사본 | 문서 구조만. 코드·데이터 영향 없음 | 시험 184/184 (문서 목록 시험 포함) · typecheck 0 |
| 2026-11-06 · 시험 바닥값 바로잡음 | `test/fixtures/FLOOR.json`(tests 184→165), `docs/결정-기록.md` | 직전 행에서 바닥값을 실행된 시험 수(184)로 올렸으나 래칫은 소스의 `test(` 줄 수(165)를 센다. 직전 커밋은 래칫 시험 1건이 실패한 채 푸시됐다 | 바닥값 144 → 165 (내리지 않음) | 아래 명령 출력 |
| 2026-11-06 · 세계 상태 (9번) | `src/core/world.ts`(신설), `test/world.test.ts`(신설), `data/vocab/10-events.json`(`instance_created`), `docs/자동생성-부록.md`, `test/fixtures/FLOOR.json`(tests 144→184), `docs/결정-기록.md`·`구현-계획.md`, `README.md` | 한 사슬이 끌고 가는 엔진의 첫 층. 상태 변경을 사건으로만 하고 기록에서 같은 상태를 다시 만든다 | 10번 규칙 실행기가 `World.set`으로 쓰고 `level()`로 읽는다. 양 저장은 아직 없음 | typecheck 0 · 시험 184/184 · appendix:check · verify · web:check · guard |
| 2026-11-05 · 논의 메모와 미정 목록 정리 | `docs/논의-메모.md`(신설), `docs/결정-기록.md` 미정 절(11행), `docs/보고서-목록.md` | 대화로만 있던 논의(방향 문서 초안, 거리 구간, 구역과 유효 재질, 겹침, 자동 연결, 일정)와 대기 질문을 잃지 않게 기록 | 결정 변경 없음. 미정 절이 단일 대기 목록이 됨 | 시험 163 · guard |
| 2026-11-05 · 감정 모델 초안 (보고서) | `docs/감정-모델-초안.md`(신설), `docs/보고서-목록.md` | 감정 논의(쾌·불쾌·안정, 익숙해짐, 활동 쌓기, 재평가 루프)를 잃지 않게 기록 | 코드·결정 변경 없음(제안). 새 축·층·결합 종류 없이 기존 구조에 들어간다는 매핑을 남김 | 시험 163 · guard |
| 2026-11-05 · 격자 경계 상태 정의 (보고서 + 파이썬 검증 코드) | `docs/격자-경계-상태-정의.md`(신설), `examples/grid-boundary/grid_boundary.py`(신설), `docs/보고서-목록.md` | 작가가 제안한 감정·재질 격자와 경계 추출 개념을 이 프로젝트에 맞게 정리하고 검증 | 코어 코드 변경 없음, 결정 없음(제안). 4칸 사다리에서는 내부가 거의 안 생긴다는 점을 발견 | `python3 grid_boundary.py` 자체 검증 4항목 통과 · 시험 163 · guard |
| 2026-11-05 · 보고서 형식·목록 정리, `report` 명령, 이 파일 | `docs/보고서-형식.md`·`보고서-목록.md`, `test/docs-index.test.ts`·`report-cmd.test.ts`, `src/node/cli.ts`(report)·`clerk.ts`(findRecord·readRecordReport)·`core/report.ts`(isPatchReport), `CHANGES.md`·`CLAUDE.md` 점검표 | 문서 종류·상태가 섞였고, 저장된 패치 보고서를 다시 볼 길이 없었다 | 새 문서는 목록에 올려야 한다(시험). 병목 보고서는 `층-비교.md` 8장으로 흡수하고 보관, 캔바 파일 삭제. 시스템·인물 명세와 구현 계획에 정정 안내 | 시험 163 · typecheck · verify · appendix:check · guard |
| 2026-11-05 · 두 라인 구조, 품질판 명세 | `docs/품질판-명세.md`(신설)·`축과-층위.md` 3장·`축-구현-순서.md`·`층-비교.md`·`결정-기록.md` | 외부계·내면·지각의 관계와 층 사이의 약속이 비어 있었다 | 구현 순서가 라인 A → 라인 B → 5 지각. 4a 외부계는 내면에만 영향 | 문서만 · guard |
| 2026-11-05 · 기반층 완성 (난수·시계·저장) | `src/core/rng.ts`·`clock.ts`·`save.ts`, `src/node/clerk.ts`(writeSave·readSave·contentHash)·`real-clock.ts`, 시험 4건, `.gitignore`(saves/) | 층 0의 남은 세 조각 | 이후 층은 시각과 난수를 인자로만 받는다. 저장은 정규 JSON | 시험 158 · typecheck · verify · guard |
| 2026-11-05 · 원본 → 패치 변환 (`compile`) | `src/core/compile.ts`, `src/node/cli.ts`, `examples/src/`, `test/compile.test.ts` | 작가가 쓰는 원본과 관문 형식을 잇는다 | 명세 단계 필드는 "아직 받지 않는 필드"로 거부 | 시험 126 · guard |
| 2026-11-03~05 · 단계 사다리, 조건 단계 키, 종결·내구 사전 | `src/core/statekey.ts`·`gate.ts`·`vocab.ts`·`chains.ts`·`meaning.ts`, `data/vocab/00-core.json`, 거부 말뭉치 | 조건이 번호에 묶여 단계 수가 바뀌면 뜻이 어긋났다 | 번호 조건 거부, 잠긴 칸 거부, 종결 단계는 `=`만. 단계는 0~5 | 시험 119 · guard |
