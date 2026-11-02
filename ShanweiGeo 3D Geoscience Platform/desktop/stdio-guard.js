'use strict';

// A desktop app can outlive the terminal that launched it. Only disconnected
// diagnostic output is optional; Python task pipes retain their own handlers.
function guardDiagnosticStream(stream) {
  if (!stream) return;
  let disconnected = false;
  const isDisconnected = error => error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';
  stream.on('error', error => {
    if (isDisconnected(error)) disconnected = true;
    else throw error;
  });
  const write = stream.write;
  stream.write = function (...args) {
    if (disconnected) {
      const callback = args.findLast(arg => typeof arg === 'function');
      if (callback) process.nextTick(callback);
      return true;
    }
    try { return write.apply(this, args); }
    catch (error) {
      if (!isDisconnected(error)) throw error;
      disconnected = true;
      return true;
    }
  };
}

module.exports = { guardDiagnosticStream };
