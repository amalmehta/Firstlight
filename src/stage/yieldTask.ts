/**
 * Let the browser handle input and paint before continuing. Uses scheduler.yield() where it
 * exists, else a MessageChannel message: unlike setTimeout, neither is subject to timer
 * throttling in hidden tabs (which can stretch chained timeouts to once a minute).
 */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const queue: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => queue.shift()?.();

export function yieldTask(): Promise<void> {
  const sched = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    queue.push(resolve);
    channel.port2.postMessage(0);
  });
}

/**
 * Resolve once the GPU has finished everything queued so far (a fence), yielding meanwhile.
 * Used to pace heavy one-off GPU work (noise generation) so it never builds a backlog that
 * a later synchronous WebGL call would have to wait behind.
 */
export async function gpuIdle(gl: WebGL2RenderingContext, maxPolls = 2000): Promise<void> {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  try {
    for (let i = 0; i < maxPolls; i++) {
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) return;
      await yieldTask();
    }
  } finally {
    gl.deleteSync(sync);
  }
}
