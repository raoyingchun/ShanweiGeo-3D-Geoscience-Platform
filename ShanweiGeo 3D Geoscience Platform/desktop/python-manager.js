'use strict';
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const METHODS = new Set(['health.check', 'diagnostic.progress', 'diagnostic.error', 'coord.native.convert', 'coord.native.batch', 'model.parse', 'block.parse', 'terrain.parse']);
class PythonManager {
  constructor({ root, packaged = false, pythonPath, coordDir, timeoutMs = 30000 }) {
    this.root = root;
    this.pythonPath = pythonPath || path.join(root, 'runtime', 'python', 'python.exe');
    if (!pythonPath && !fs.existsSync(this.pythonPath) && !packaged) this.pythonPath = process.env.SHANWEI_PYTHON || 'python';
    // 原版 COORD 位于 userData/tools/COORD（可写目录），不在 resources 内。
    this.coordDir = coordDir || path.join(root, 'tools', 'COORD');
    this.timeoutMs = timeoutMs;
    this.tasks = new Map();
    this.stopping = false;
  }
  start(request, ownerId, emit) {
    if (this.stopping) throw new Error('Backend is shutting down');
    if (!request || !METHODS.has(request.method)) throw new Error('Unsupported Python Operation');
    const params = request.params || {};
    if (typeof params !== 'object' || Array.isArray(params)) throw new Error('Parameters must be an object');
    if (request.method === 'diagnostic.progress' && params.steps !== undefined &&
        (!Number.isInteger(params.steps) || params.steps < 1 || params.steps > 100)) throw new Error('steps must be 1 to 100 integer');
    if (this.tasks.size) throw new Error('Another computation is already running');
    const payload = JSON.stringify({ method: request.method, params }) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > 1024 * 1024) throw new Error('Request parameters are too large');
    const taskId = randomUUID();
    const coordDir = process.env.SHANWEI_COORD_DIR || this.coordDir;
    const child = spawn(this.pythonPath, ['-u', '-X', 'utf8', path.join(this.root, 'backend', 'worker.py')], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', SHANWEI_COORD_DIR: coordDir }
    });
    let complete;
    const task = { child, ownerId, done: false, buffer: '', stderr: '', terminal: null, nativeDirs: new Set(), closed: new Promise(resolve => { complete = resolve; }) };
    this.tasks.set(taskId, task);
    const send = message => { try { emit({ ...message, taskId }); } catch (_) {} };
    const finish = async message => {
      if (task.done) return;
      task.done = true; clearTimeout(task.timer);
      try { await this.cleanupNative(task.nativeDirs); }
      catch (error) { message = { type: 'error', error: { code: 'CLEANUP_FAILED', message: 'Temporary COORD Cleanup failed:  ' + error.message } }; }
      this.tasks.delete(taskId); send(message); complete();
    };
    task.stop = (code, message) => {
      if (task.done) return;
      task.terminal = { type: 'error', error: { code, message } }; child.kill();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { task.stderr = (task.stderr + chunk).slice(-8192); });
    child.stdout.on('data', chunk => {
      task.buffer += chunk;
      if (task.buffer.length > 1024 * 1024) return task.stop('PROTOCOL_ERROR', 'Backend message is too large');
      let newline;
      while ((newline = task.buffer.indexOf('\n')) >= 0) {
        const line = task.buffer.slice(0, newline).trim(); task.buffer = task.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (!['progress', 'result', 'error'].includes(message.type)) throw new Error('Unknown message type');
          if (message.type === 'progress') {
            if (typeof message.nativeWorkDir === 'string') {
              const directory = path.resolve(message.nativeWorkDir);
              if (path.dirname(directory).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && path.basename(directory).startsWith('shanwei-coord-')) task.nativeDirs.add(directory);
            }
            if (!task.terminal) send(message);
          }
          else if (!task.terminal) task.terminal = message;
        } catch (_) { task.stop('PROTOCOL_ERROR', 'The backend returned an invalid protocol message'); }
      }
    });
    child.on('error', error => finish({ type: 'error', error: { code: 'START_FAILED', message: 'Python Startup failed:  ' + error.message } }));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (task.terminal && task.terminal.type === 'error') return finish(task.terminal);
      if (code !== 0 || !task.terminal || task.buffer.trim()) return finish({ type: 'error', error: { code: 'PROCESS_FAILED', message: task.stderr.trim() || 'Python exited unexpectedly or returned an incomplete result' } });
      finish(task.terminal);
    });
    task.timer = setTimeout(() => task.stop('TIMEOUT', 'Python Task timed out'), ['coord.native.batch','model.parse','block.parse','terrain.parse'].includes(request.method) ? 120000 : this.timeoutMs);
    child.stdin.end(payload);
    return { taskId };
  }
  cancel(taskId, ownerId) {
    const task = this.tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) return false;
    task.stop('CANCELLED', 'Task canceled'); return true;
  }
  cancelOwner(ownerId) {
    for (const [id, task] of this.tasks) if (task.ownerId === ownerId) this.cancel(id, ownerId);
  }
  cleanupNative(directories) {
    if (!directories.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const helper = spawn(this.pythonPath, ['-u', '-X', 'utf8', path.join(this.root, 'backend', 'worker.py'), '--cleanup-coord', ...directories], { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { helper.kill(); reject(new Error('Cleanup timed out')); }, 8000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Cleanup process exit code ' + code)); });
    });
  }
  async shutdown() {
    this.stopping = true;
    await Promise.all([...this.tasks.values()].map(task => { task.stop('APP_EXIT', 'Application exit, Task stopped'); return task.closed; }));
  }
}
module.exports = { PythonManager };
