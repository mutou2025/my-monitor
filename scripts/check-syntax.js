#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = ['src', 'scripts']
  .map((target) => path.join(root, target))
  .filter((target) => fs.existsSync(target));

function collectJsFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, output);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      output.push(fullPath);
    }
  }
  return output;
}

const files = targets.flatMap((target) => collectJsFiles(target)).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} JavaScript files.`);
