// 명령줄 (원 설계: make-bio-database 의 dbtool). 코어를 부르고 서기에게 쓰기를 맡길 뿐 판단하지 않는다.
//
//   node src/node/cli.ts status
//   node src/node/cli.ts validate <patch.json>              병합·관문만 확인 (쓰지 않음)
//   node src/node/cli.ts merge <patch.json> [--dry] [--allow-warnings]
//   node src/node/cli.ts chains [규칙 번호]                  자동으로 이어진 규칙 사슬
//   node src/node/cli.ts appendix [--write | --check]
//   node src/node/cli.ts web [--write | --check]
//   node src/node/cli.ts day [시나리오]                      하루(들)를 돌려 단계마다 한 줄씩 보인다 (기본: 뼈대 시나리오)
//   node src/node/cli.ts golden [--write | --check]          뼈대 하루의 골든 트레이스
//   node src/node/cli.ts receipt [시나리오] [--write | --check] 하루 영수증 (보기 · receipts/에 쓰기 · 쓴 것을 검증하고 다시 돌려 맞춰 보기)
//   node src/node/cli.ts audit [시나리오]                    기록이 정의(규칙·행동·진행·감각)와 맞는지 다시 계산해 본다
//   node src/node/cli.ts gaps [--write | --check]            영수증의 원인 빈칸 → docs/원인-빈칸.md, docs/한계-등록부.md
//   옵션: --root <폴더>  (기본: 현재 폴더)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdges, chainRoots, chainsFrom, collectRules, ruleNodes } from '../core/chains.ts';
import { generatedRules } from '../core/generated.ts';
import { patchReportMarkdown } from '../core/report.ts';
import { compileSources } from '../core/compile.ts';
import { parseScript } from '../core/script.ts';
import { appendix, auditEvents, auditScenario, commitPatch, gaps, golden, loadDb, readReceipts, readRecordReport, receiptNames, receiptsFor, replay, scenarioRun, sha256, SKELETON_SCENARIO, syncWeb, writeReceipts } from './clerk.ts';
import { verifyReceipts } from '../core/receipt.ts';
import { auditSummary } from '../core/audit.ts';
import { viaKindsLookup } from '../core/via.ts';
import { receiptText } from '../core/receipt-text.ts';
import { changesSince, guardCheck } from './guard.ts';
import { loadVocabDir } from './vocab-files.ts';

const HERE = fileURLToPath(new URL('../..', import.meta.url));

function parseArgs(argv: readonly string[]): { positional: string[]; flags: Set<string>; root: string } {
  const positional: string[] = [];
  const flags = new Set<string>();
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--root') root = resolve(argv[++i] ?? root);
    else if (a.startsWith('--')) flags.add(a);
    else positional.push(a);
  }
  return { positional, flags, root };
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const { positional, flags, root } = parseArgs(process.argv.slice(2));
  const [command, arg] = positional;
  const vocab = loadVocabDir(join(root, 'data', 'vocab'));

  switch (command) {
    case 'status': {
      const db = loadDb(root);
      const byKind = new Map<string, number>();
      for (const id of Object.keys(db.defs)) byKind.set(id.slice(0, 3), (byKind.get(id.slice(0, 3)) ?? 0) + 1);
      console.log(`정의 ${Object.keys(db.defs).length}개`, [...byKind].map(([k, n]) => `${k} ${n}`).join(' · '));
      console.log('다음 번호:', Object.entries(db.meta.next).map(([k, n]) => `${k}=${n}`).join(' '));
      console.log('사전:', vocab.categories().map((c) => `${c} ${vocab.keys(c).length}`).join(' · '));
      return;
    }
    case 'validate':
    case 'merge': {
      if (arg === undefined) die('패치 파일을 지정하세요');
      const raw: unknown = JSON.parse(readFileSync(resolve(arg), 'utf8'));
      const dry = command === 'validate' || flags.has('--dry');
      const result = commitPatch(root, raw, vocab, { dry, allowWarnings: flags.has('--allow-warnings') });
      if (result.status === 'invalid-patch') {
        console.error('패치 형식 오류:');
        for (const i of result.patchIssues ?? []) console.error(`  - ${i.where}: ${i.msg}`);
        process.exit(1);
      }
      if (result.report !== undefined && result.db !== undefined) console.log(patchReportMarkdown(result.report, result.db));
      for (const i of [...(result.gate?.mergeErrors ?? []), ...(result.gate?.newErrors ?? []), ...(result.gate?.newWarnings ?? [])]) {
        console.log(`  ${i.level === 'error' ? '오류' : '경고'} ${i.where}: ${i.msg}`);
      }
      console.log(`결과: ${result.status}`, result.files.length > 0 ? `(${result.files.join(', ')})` : '');
      if (result.status === 'rejected') process.exit(1);
      return;
    }
    case 'chains': {
      const db = loadDb(root);
      const rules = [...collectRules(db), ...ruleNodes(generatedRules(db, vocab))]; // 손 규칙 + 데이터에서 만든 규칙(번짐·냄새 종류)
      const edges = buildEdges(rules, vocab, db);
      if (arg !== undefined && !rules.some((r) => r.ref === arg)) die(`없는 규칙: ${arg} (형식: 정의 번호/rule/키, 예: ${rules[0]?.ref ?? 'PLC000002/rule/bugs'})`);
      const starts = arg !== undefined ? [arg] : chainRoots(rules, edges);
      for (const s of starts) {
        console.log(s);
        for (const p of chainsFrom(edges, s)) console.log('  ' + p.join(' → '));
      }
      return;
    }
    case 'appendix': {
      const mode = flags.has('--write') ? 'write' : flags.has('--check') ? 'check' : 'print';
      const r = appendix(root, vocab, mode);
      if (mode === 'print') console.log(r.content);
      else if (mode === 'check' && !r.ok) die('자동 생성 부록이 현재 코드·데이터와 다름 — node src/node/cli.ts appendix --write');
      else console.log(mode === 'write' ? '저장: docs/자동생성-부록.md' : '부록이 최신이다');
      return;
    }
    case 'web': {
      const mode = flags.has('--check') ? 'check' : 'write';
      const r = syncWeb(root, mode);
      if (!r.ok) die('시제품 HTML의 장면 JSON이 examples/view와 다름 — npm run web');
      console.log(mode === 'write' ? `저장: web/prototype/index.html (장면 ${r.count}개)` : '시제품이 최신이다');
      return;
    }
    case 'day': {
      for (const step of scenarioRun(root, vocab, arg ?? SKELETON_SCENARIO).steps) for (const line of step.lines) console.log(line);
      return;
    }
    case 'receipt': {
      const file = arg ?? SKELETON_SCENARIO;
      if (flags.has('--check')) {
        // 쓴 영수증을 영수증만으로 검증하고(사슬·집계·마감·봉인), 다시 돌려 찍은 것과 봉인이 같은지 본다 (결정론·손 편집)
        const stored = readReceipts(root, file);
        const v = verifyReceipts(stored, sha256, viaKindsLookup(vocab));
        if (!v.ok) die(`영수증 검증 실패 ${v.errors.length}건\n` + v.errors.map((e) => `  ✗ ${e}`).join('\n'));
        const audit = auditEvents(root, vocab, file, stored.flatMap((r) => r.items));
        if (audit.findings.length > 0) die(`영수증 감사 위반 ${audit.findings.length}건\n` + audit.findings.slice(0, 20).map((f) => `  ✗ ${f.seq} [${f.check}] ${f.message}`).join('\n'));
        const fresh = receiptsFor(root, vocab, file);
        const diff = fresh.filter((r, i) => stored[i]?.seal !== r.seal).map((r) => r.day);
        if (stored.length !== fresh.length || diff.length > 0) die(`다시 찍은 영수증과 다르다 (날 ${diff.join(', ') || '수'}) — 엔진·데이터·시나리오가 바뀌었으면 receipt ${file} --write`);
        console.log(`영수증 ${v.days}장 · 사건 ${v.events}건 · 사슬 정상 · 감사 통과 · 다시 찍어도 같다 (마지막 봉인 ${String(v.head).slice(0, 12)})`);
        return;
      }
      const receipts = receiptsFor(root, vocab, file);
      if (flags.has('--write')) {
        const dir = writeReceipts(root, vocab, file, receipts);
        console.log(`저장: ${dir} (영수증 ${receipts.length}장)`);
        return;
      }
      const names = receiptNames(root, file, vocab);
      for (const r of receipts) console.log(receiptText(r, names));
      return;
    }
    case 'audit': {
      const r = auditScenario(root, vocab, arg ?? SKELETON_SCENARIO);
      for (const f of r.findings.slice(0, 30)) console.error(`  ✗ ${f.seq} [${f.check}] ${f.message}`);
      if (r.findings.length > 30) console.error(`  … 외 ${r.findings.length - 30}건`);
      console.log(auditSummary(r));
      if (r.findings.length > 0) process.exit(1);
      return;
    }
    case 'gaps': {
      const mode = flags.has('--write') ? 'write' : 'check';
      const r = gaps(root, vocab, mode);
      if (r.unregistered > 0) die(`등록 안 된 원인 빈칸 ${r.unregistered}건 — data/limitations.json에 항목을 더한다 (docs/원인-빈칸.md "등록 안 됨")`);
      if (r.stale.length > 0) die(`낡은 문서: ${r.stale.join(', ')} — node src/node/cli.ts gaps --write`);
      console.log(mode === 'write' ? '저장: docs/원인-빈칸.md, docs/한계-등록부.md' : '원인 빈칸·한계 등록부가 최신이다');
      return;
    }
    case 'golden': {
      const mode = flags.has('--write') ? 'write' : 'check';
      const r = golden(root, vocab, mode);
      if (!r.ok) die('골든 트레이스가 바뀌었다 — 의도한 변화면 결정 기록에 이유를 적고 node src/node/cli.ts golden --write');
      console.log(mode === 'write' ? '저장: test/fixtures/golden/skeleton-day.json' : '골든 트레이스가 같다');
      return;
    }
    case 'verify': {
      const r = replay(root, vocab);
      console.log(`기록된 패치 ${r.patches}건을 다시 적용했다`);
      for (const p of r.problems) console.error('  - ' + p);
      if (!r.ok) process.exit(1);
      console.log('data/db.json이 기록과 일치한다');
      return;
    }
    case 'guard': {
      const base = arg ?? 'HEAD~1';
      const changes = changesSince(base, root);
      if (changes === null) {
        console.log(`비교할 커밋(${base})이 없어 건너뛴다`);
        return;
      }
      const g = guardCheck(changes);
      for (const p of g.problems) console.error('  - ' + p);
      if (!g.ok) process.exit(1);
      console.log(`가드 통과 (변경 ${changes.length}건)`);
      return;
    }
    case 'report': {
      // 저장된 패치 기록의 보고서를 다시 본다 (읽기만). 이름은 지금 저장소 기준으로 보인다.
      if (arg === undefined) die('패치 기록(파일 이름 또는 번호)을 지정하세요');
      const { file, report } = readRecordReport(root, arg);
      console.log(`# ${file}\n`);
      console.log(patchReportMarkdown(report, loadDb(root)));
      return;
    }
    case 'compile': {
      // 원본 파일들 → 패치 JSON (표준 출력). 형식·사전·펼치기 검사 후 기존 패치 형식으로 낸다. 파일은 쓰지 않는다.
      const files = positional.slice(1);
      if (files.length === 0) die('원본 파일을 하나 이상 지정하세요');
      // 줄글 스크립트(.ev)는 이벤트 원본으로 먼저 읽는다 (script.ts, 줄 번호가 있는 오류)
      const sources = files.map((f) => {
        const text = readFileSync(resolve(f), 'utf8');
        if (!f.endsWith('.ev')) return JSON.parse(text) as unknown;
        const r = parseScript(text, loadVocabDir(join(root, 'data', 'vocab')));
        if (r.source === null) {
          for (const i of r.issues) console.error(`  오류 ${f}:${i.line}: ${i.msg}`);
          process.exit(1);
        }
        return r.source;
      });
      const r = compileSources(sources);
      if (r.patch === null) {
        for (const i of r.issues) console.error(`  오류 ${i.where}: ${i.msg}`);
        process.exit(1);
      }
      console.log(JSON.stringify(r.patch, null, 2));
      return;
    }
    default:
      die('명령: status | compile <원본...> | report <기록> | validate <패치> | merge <패치> [--dry] [--allow-warnings] | chains [규칙] | appendix [--write|--check] | web [--write|--check] | day [시나리오] | golden [--write|--check] | receipt [시나리오] [--write|--check] | audit [시나리오] | gaps [--write|--check] | verify | guard [기준 커밋]  (옵션 --root <폴더>, 기본 ' + HERE + ')');
  }
}

try {
  main();
} catch (err) {
  // 파일이 없거나 형식이 틀린 입력: 내부 덤프 대신 이유 한 줄 (자세한 위치는 DEBUG=1)
  console.error(`오류: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env['DEBUG'] === '1' && err instanceof Error) console.error(err.stack);
  process.exit(1);
}
