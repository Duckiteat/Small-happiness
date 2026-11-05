# 에이전트 점검표

이 프로젝트는 AI와 함께 만든다. 아래는 AI가 **얕은 수를 쓰지 않도록** 하는 규칙이고, 대부분 시험과 CI가 강제한다. 이유와 한계는 `docs/꼼수-방지.md`.

## 시작할 때
1. `docs/결정-기록.md`(확정/기본안/미정), `docs/구현-계획.md`(작업 목록과 끝나는 조건), 관련 명세를 읽는다.
2. 큰 파일(`data/db.json`, `data/patches/`)은 통째로 읽지 말고 명령(`status`, `chains`)이나 `grep`을 쓴다.

## 데이터
- **`data/db.json`을 직접 고치지 않는다.** 패치(`examples/patches/` 형식)를 만들어 `node src/node/cli.ts validate <패치>` → `merge <패치>`로만 바꾼다. 손으로 고치면 `npm run verify`와 시험이 잡는다.
- 패치에는 `why`가 필수다. 새 항목은 임시 번호(`OBJ+1`)를 쓴다.
- 사전에 없는 단어를 쓰지 않는다. 필요하면 `data/vocab/`에 먼저 넣는다.
- 모르는 값은 지어내지 않는다. 임시 수치는 `tuned:false`로 표시한다.
- `--allow-warnings`는 사용자가 허락했을 때만 쓴다.

## 코드
- 코어(`src/core`)는 입출력이 없는 순수 모듈이다. 파일·프로세스·현재 시각·난수를 직접 쓰지 않는다 (시각과 난수는 인자로 받는다). 파일 쓰기는 `src/node/clerk.ts`만 한다.
- **변화 규칙은 난수를 쓰지 않는다.** 난수는 이벤트와 행동 판정에만 쓴다.
- 코드에 오브젝트·장소 이름(신발, 냉장고 …)을 박지 않는다. 사실은 데이터와 사전에 둔다.
- 결과를 직접 정하지 않고 효과 요청(규칙)을 거친다.

## 금지 (시험이 검사한다)
- `@ts-ignore`·`@ts-expect-error`·`as any`, 코어/어댑터의 `as never`·`as unknown as`
- `test.skip`·`test.todo`·`test.only`, 빈 `catch {}`, `eslint-disable`
- 항상 참인 단언 (`assert.ok(true)`)
- 시험을 지우거나 줄이기, 거부 말뭉치(`test/fixtures/rejections/`)를 줄이기
- **통과시키려고 관문·사전·시험의 규칙을 느슨하게 하기.** 규칙은 사용자가 요청했을 때만 바꾸고, 바꾸면 같은 커밋에서 `docs/결정-기록.md`에 이유를 남긴다 (`npm run guard`가 확인한다).
- 실패를 숨기기: 실패한 시험은 고치거나 사용자에게 그대로 보고한다. "통과했다"는 말이 아니라 실행한 명령의 출력으로 말한다.

## 끝내기 전에
```sh
npm run typecheck && npm test && npm run appendix:check && npm run verify
npm run guard          # 직전 커밋과 비교
```
- 코드·형식·어휘·문서 구조를 바꾸면 `CHANGES.md` 맨 위에 **한 행**(Scope · Why · Impact · Verification)을 같은 커밋에서 더한다 (행은 고치지 않는다). 새 문서는 `docs/보고서-목록.md`에 올린다 (시험이 확인).
- 새 규칙에는 **거부 시험**(말뭉치 파일 + `EXPECT.json`)을 더하고 `test/fixtures/FLOOR.json`의 바닥값을 올린다 (내리지 않는다).
- 설계가 바뀌면 관련 명세와 `결정-기록.md`를 같은 커밋에서 고친다. 자동 생성 부록이 낡으면 `npm run appendix`.
- 보고할 때는 확인한 것과 **확인하지 못한 것**을 구분한다.
