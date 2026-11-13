const { execFile } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);

async function convertHeicPreview(inputPath) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'proof-preview-'));
  try {
    const output = path.join(temp, 'preview.jpg');
    await exec('vips', ['thumbnail', inputPath, output + '[Q=92,strip]', '2400', '--height', '2400', '--size', 'down'], {
      timeout: 15000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      env: { ...process.env, VIPS_CONCURRENCY: '1' }
    });
    return await readFile(output);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

module.exports = { convertHeicPreview };
