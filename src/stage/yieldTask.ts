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
