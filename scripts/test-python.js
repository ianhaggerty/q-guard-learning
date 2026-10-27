// `npm run test:python`: the Python test suites (model store, trainer, agent service), with
// the repository's .venv if there is one (PYTHON overrides). Tests that need Postgres run
// when TEST_DATABASE_URL points at a server they may create throwaway databases on, e.g.
//   TEST_DATABASE_URL=postgres://pml:pml-dev@127.0.0.1:5433/pml npm run test:python

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const python = process.env.PYTHON || (existsSync(repo('.venv/bin/python')) ? repo('.venv/bin/python') : 'python3');
const path = ['artifacts', 'services/model-store', 'services/model-store/tests', 'services/trainer', 'services/trainer/tests',
  'services/agent-inference'].map(repo).join(':');

let failed = false;
for (const suite of ['services/model-store/tests', 'services/trainer/tests', 'services/agent-inference/tests']) {
  if (!existsSync(repo(suite))) continue;
  console.log(`\n${suite}`);
  const result = spawnSync(python, ['-W', 'ignore::DeprecationWarning', '-m', 'unittest', 'discover', '-s', repo(suite)], {
    stdio: 'inherit', env: { ...process.env, PYTHONPATH: path },
  });
  failed ||= result.status !== 0;
}
process.exitCode = failed ? 1 : 0;
