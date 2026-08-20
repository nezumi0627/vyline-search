export {};
const apkPath = 'E:/projects/Vyline-Search/data/apk/LINE-15.15.1.apk';
const outDir = 'E:/projects/Vyline-Search/data/apk-jadx/test';
const jadx = 'E:/projects/Vyline-Search/data/re-tools/jadx/bin/jadx.bat';

const args = [
  '-d', outDir,
  '-j', '4',
  '--output-format', 'java',
  '--deobf',
  apkPath,
];

console.log('Running jadx with -- separator...');

const proc = Bun.spawnSync({
  cmd: [jadx, ...args],
  cwd: 'E:/projects/Vyline-Search',
  stdio: ['pipe', 'pipe', 'pipe'],
});

console.log('exit code:', proc.exitCode);
console.log('stdout:', proc.stdout?.toString().slice(0, 2000));
console.log('stderr:', proc.stderr?.toString().slice(0, 2000));
