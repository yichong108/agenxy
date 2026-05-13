import path from 'node:path';

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

/** Repo-root–relative paths, always with `/`. */
function normalizeRepoRelative(f) {
  return toPosix(path.normalize(f));
}

/** Staged paths under `apps/<pkg>/` → paths relative to that package (POSIX). */
function relativeToPackage(stagedPaths, packageDirPosix) {
  const prefix = `${packageDirPosix}/`;
  return stagedPaths
    .map((f) => normalizeRepoRelative(f))
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

function shellQuoteArg(p) {
  if (!/\s|["'\\]/.test(p)) return p;
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export default {
  '**/*.{json,md}': 'prettier --write',

  'apps/desktop/**/*.{ts,tsx}': (files) => {
    const rel = relativeToPackage(files, 'apps/desktop');
    if (!rel.length) return [];
    const prettierTargets = files.map((f) => shellQuoteArg(f)).join(' ');
    const eslintTargets = rel.map((f) => shellQuoteArg(f)).join(' ');
    return [
      `prettier --write ${prettierTargets}`,
      `pnpm --filter @agenxy/desktop exec eslint --fix ${eslintTargets}`,
    ];
  },

  'apps/landing/**/*.{ts,tsx}': (files) => {
    const rel = relativeToPackage(files, 'apps/landing');
    if (!rel.length) return [];
    const prettierTargets = files.map((f) => shellQuoteArg(f)).join(' ');
    const eslintTargets = rel.map((f) => shellQuoteArg(f)).join(' ');
    return [
      `prettier --write ${prettierTargets}`,
      `pnpm --filter @agenxy/landing exec eslint --fix ${eslintTargets}`,
    ];
  },

  '**/*.{ts,tsx}': (files) => {
    const other = files.filter((f) => {
      const p = normalizeRepoRelative(f);
      return (
        !p.startsWith('apps/desktop/') &&
        !p.startsWith('apps/landing/')
      );
    });
    if (!other.length) return [];
    return `prettier --write ${other.map((f) => shellQuoteArg(f)).join(' ')}`;
  },
};
