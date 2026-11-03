// 명령줄 (원 설계: make-bio-database 의 dbtool). 코어를 부르고 서기에게 쓰기를 맡길 뿐 판단하지 않는다.
//
//   node src/node/cli.ts status
//   node src/node/cli.ts validate <patch.json>              병합·관문만 확인 (쓰지 않음)
//   node src/node/cli.ts merge <patch.json> [--dry] [--allow-warnings]
//   node src/node/cli.ts chains [규칙 번호]                  자동으로 이어진 규칙 사슬
//   node src/node/cli.ts appendix [--write | --check]
//   옵션: --root <폴더>  (기본: 현재 폴더)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdges, chainRoots, chainsFrom, collectRules } from '../core/chains.ts';
import { patchReportMarkdown } from '../core/report.ts';
import { appendix, commitPatch, loadDb } from './clerk.ts';
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
      const edges = buildEdges(rules);
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
    default:
      die('명령: status | validate <패치> | merge <패치> [--dry] [--allow-warnings] | chains [규칙] | appendix [--write|--check]  (옵션 --root <폴더>, 기본 ' + HERE + ')');
  }
}

main();
