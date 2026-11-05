# CHANGES — 코드·형식 변경 기록

> 맨 위가 최신이다. **행을 고치거나 지우지 않는다.** 코드·형식·어휘·문서 구조를 바꾸면 **같은 커밋에서** 한 행을 맨 위에 더한다. 데이터 패치의 보고서는 패치 기록(`data/patches/*.json`)의 `report`에 저장되고 `report <기록>`으로 본다. 결정은 `docs/결정-기록.md`에, 여기에는 **무엇을 바꿨는지**만 적는다.
> 칸: Scope(파일·함수·정의) · Why · Impact(하류 규칙·명령·데이터) · Verification(시험 수·검사).

| 날짜 · 주제 | Scope | Why | Impact | Verification |
|---|---|---|---|---|
| 2026-11-05 · 격자 경계 상태 정의 (보고서 + 파이썬 검증 코드) | `docs/격자-경계-상태-정의.md`(신설), `examples/grid-boundary/grid_boundary.py`(신설), `docs/보고서-목록.md` | 작가가 제안한 감정·재질 격자와 경계 추출 개념을 이 프로젝트에 맞게 정리하고 검증 | 코어 코드 변경 없음, 결정 없음(제안). 4칸 사다리에서는 내부가 거의 안 생긴다는 점을 발견 | `python3 grid_boundary.py` 자체 검증 4항목 통과 · 시험 163 · guard |
| 2026-11-05 · 보고서 형식·목록 정리, `report` 명령, 이 파일 | `docs/보고서-형식.md`·`보고서-목록.md`, `test/docs-index.test.ts`·`report-cmd.test.ts`, `src/node/cli.ts`(report)·`clerk.ts`(findRecord·readRecordReport)·`core/report.ts`(isPatchReport), `CHANGES.md`·`CLAUDE.md` 점검표 | 문서 종류·상태가 섞였고, 저장된 패치 보고서를 다시 볼 길이 없었다 | 새 문서는 목록에 올려야 한다(시험). 병목 보고서는 `층-비교.md` 8장으로 흡수하고 보관, 캔바 파일 삭제. 시스템·인물 명세와 구현 계획에 정정 안내 | 시험 163 · typecheck · verify · appendix:check · guard |
| 2026-11-05 · 두 라인 구조, 품질판 명세 | `docs/품질판-명세.md`(신설)·`축과-층위.md` 3장·`축-구현-순서.md`·`층-비교.md`·`결정-기록.md` | 외부계·내면·지각의 관계와 층 사이의 약속이 비어 있었다 | 구현 순서가 라인 A → 라인 B → 5 지각. 4a 외부계는 내면에만 영향 | 문서만 · guard |
| 2026-11-05 · 기반층 완성 (난수·시계·저장) | `src/core/rng.ts`·`clock.ts`·`save.ts`, `src/node/clerk.ts`(writeSave·readSave·contentHash)·`real-clock.ts`, 시험 4건, `.gitignore`(saves/) | 층 0의 남은 세 조각 | 이후 층은 시각과 난수를 인자로만 받는다. 저장은 정규 JSON | 시험 158 · typecheck · verify · guard |
| 2026-11-05 · 원본 → 패치 변환 (`compile`) | `src/core/compile.ts`, `src/node/cli.ts`, `examples/src/`, `test/compile.test.ts` | 작가가 쓰는 원본과 관문 형식을 잇는다 | 명세 단계 필드는 "아직 받지 않는 필드"로 거부 | 시험 126 · guard |
| 2026-11-03~05 · 단계 사다리, 조건 단계 키, 종결·내구 사전 | `src/core/statekey.ts`·`gate.ts`·`vocab.ts`·`chains.ts`·`meaning.ts`, `data/vocab/00-core.json`, 거부 말뭉치 | 조건이 번호에 묶여 단계 수가 바뀌면 뜻이 어긋났다 | 번호 조건 거부, 잠긴 칸 거부, 종결 단계는 `=`만. 단계는 0~5 | 시험 119 · guard |
