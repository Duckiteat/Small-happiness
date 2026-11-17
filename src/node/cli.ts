// 명령줄 (원 설계: make-bio-database 의 dbtool). 코어를 부르고 서기에게 쓰기를 맡길 뿐 판단하지 않는다.
//
//   node src/node/cli.ts status
//   node src/node/cli.ts validate <patch.json>              병합·관문만 확인 (쓰지 않음)
//   node src/node/cli.ts merge <patch.json> [--dry] [--allow-warnings]
//   node src/node/cli.ts simulate <일수> [패치] [효과 패턴...]  세계를 며칠 돌려 본다 (저장하지 않음)
//   node src/node/cli.ts trace <조각 파일> <인물 기록>      조각과 인물 기록의 대조 (읽기만)
//   node src/node/cli.ts chains [규칙 번호]                  자동으로 이어진 규칙 사슬
//   node src/node/cli.ts appendix [--write | --check]
//   node src/node/cli.ts web [--write | --check]
//   옵션: --root <폴더>  (기본: 현재 폴더)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdges, chainRoots, chainsFrom, collectRules } from '../core/chains.ts';
import { patchReportMarkdown } from '../core/report.ts';
import { compileSources } from '../core/compile.ts';
import { checkSlotFile, slotReportText } from '../core/slots.ts';
import { tracePerson, traceReportText } from '../core/pieces.ts';
import { advance, applyEffect, buildWorld, readLevels } from '../core/world.ts';
import type { NewEvent } from '../core/events.ts';
import { appendix, commitPatch, loadDb, readRecordReport, replay, syncWeb } from './clerk.ts';
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
      const rules = collectRules(loadDb(root));
      const edges = buildEdges(rules, vocab);
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
    case 'slots': {
      // 문장 자리 파일 검사 (읽기만). --strict: 비어 있는 필수 기본 문장도 오류로 본다.
      const files = positional.slice(1);
      if (files.length === 0) die('자리 파일을 하나 이상 지정하세요');
      let failed = false;
      for (const f of files) {
        const raw: unknown = JSON.parse(readFileSync(resolve(f), 'utf8'));
        const r = checkSlotFile(raw, vocab, { strict: flags.has('--strict') });
        console.log(`# ${f}`);
        for (const i of r.issues) console.log(`  ${i.level === 'error' ? '오류' : '경고'} ${i.where}: ${i.msg}`);
        console.log(slotReportText(r.report));
        if (r.issues.some((i) => i.level === 'error')) failed = true;
      }
      if (failed) process.exit(1);
      return;
    }
    case 'simulate': {
      // 세계를 며칠 돌려 본다 (읽기만, 저장하지 않음). 패치 파일을 주면 저장소에 병합한 것으로 치고 돌린다.
      // 나머지 인자는 시작할 때 적용할 효과 패턴(`정의|부위:특징@조건`)이다.
      const days = Number(arg);
      if (!Number.isInteger(days) || days <= 0) die('일수를 지정하세요 (예: simulate 7 examples/patches/fridge-week.json)');
      const rest = positional.slice(2);
      const patchFile = rest.find((f) => f.endsWith('.json'));
      let db = loadDb(root);
      if (patchFile !== undefined) {
        const result = commitPatch(root, JSON.parse(readFileSync(resolve(patchFile), 'utf8')) as unknown, vocab, { dry: true });
        if (result.db === undefined || result.status === 'rejected' || result.status === 'invalid-patch') die(`패치가 관문을 통과하지 못했다 (${result.status})`);
        db = result.db;
      }
      const built = buildWorld(db, vocab);
      for (const i of built.issues) console.error(`  오류 ${i.where}: ${i.msg}`);
      if (built.issues.length > 0) process.exit(1);
      const name = (key: string): string => `${db.defs[key.slice(0, 9)]?.names.ko ?? '?'} ${key.slice(key.indexOf('|') + 1)}`;
      const events: NewEvent[] = [];
      let state = built.state;
      for (const pattern of rest.filter((f) => !f.endsWith('.json'))) {
        const r = applyEffect(state, built.spec, pattern, 'setup');
        state = r.state;
        events.push(...r.events);
      }
      const run = advance(state, built.spec, days * 86400);
      events.push(...run.events);
      for (const e of events) {
        const s = Number(e.data?.['t_s'] ?? 0);
        const at = `${Math.floor(s / 86400) + 1}일째 ${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
        if (e.type === 'stage_advanced') console.log(`${at}  ${name(String(e.data?.['key']))}: ${String(e.data?.['from'])} → ${String(e.data?.['to'])}  (${String(e.data?.['cause'])})`);
        else if (flags.has('--all')) console.log(`${at}  예약 ${String(e.data?.['phase'])}: ${String(e.data?.['rule'])}`);
      }
      console.log(`\n${days}일 뒤의 상태:`);
      for (const [key, level] of Object.entries(readLevels(run.state, built.spec))) console.log(`  ${name(key)} = ${level}`);
      return;
    }
    case 'trace': {
      // 인물 조각 파일과 인물 기록을 대조한다 (읽기만). --used: 조각마다 쓰인 항목을 함께 보인다.
      const [piecesFile, sheetFile] = positional.slice(1);
      if (piecesFile === undefined || sheetFile === undefined) die('조각 파일과 인물 기록 파일을 지정하세요');
      const read = (f: string): unknown => JSON.parse(readFileSync(resolve(f), 'utf8'));
      const r = tracePerson(read(piecesFile), read(sheetFile), vocab);
      for (const i of r.issues) console.log(`  ${i.level === 'error' ? '오류' : '경고'} ${i.where}: ${i.msg}`);
      if (r.report !== null) {
        console.log(traceReportText(r.report, vocab));
        if (flags.has('--used')) for (const [h, list] of Object.entries(r.report.usedBy)) console.log(`  ${h} → ${list.join(', ')}`);
      }
      if (r.issues.some((i) => i.level === 'error')) process.exit(1);
      return;
    }
    case 'compile': {
      // 원본 파일들 → 패치 JSON (표준 출력). 형식·사전·펼치기 검사 후 기존 패치 형식으로 낸다. 파일은 쓰지 않는다.
      const files = positional.slice(1);
      if (files.length === 0) die('원본 파일을 하나 이상 지정하세요');
      const sources = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as unknown);
      const r = compileSources(sources);
      if (r.patch === null) {
        for (const i of r.issues) console.error(`  오류 ${i.where}: ${i.msg}`);
        process.exit(1);
      }
      console.log(JSON.stringify(r.patch, null, 2));
      return;
    }
    default:
      die('명령: status | simulate <일수> [패치] [효과 패턴...] [--all] | compile <원본...> | slots <자리 파일...> [--strict] | trace <조각 파일> <인물 기록> [--used] | report <기록> | validate <패치> | merge <패치> [--dry] [--allow-warnings] | chains [규칙] | appendix [--write|--check] | web [--write|--check] | verify | guard [기준 커밋]  (옵션 --root <폴더>, 기본 ' + HERE + ')');
  }
}

main();
