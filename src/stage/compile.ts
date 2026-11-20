import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import { yieldTask } from './yieldTask';

/**
 * renderer.compileAsync with a deadline. Some programs (seen with the heavy cloud shaders on
 * Chrome/ANGLE-Metal) never report KHR_parallel_shader_compile's COMPLETION_STATUS as done,
 * so compileAsync would wait forever; yet one synchronous LINK_STATUS query finishes them in
 * well under 100 ms. After `deadlineMs`, finish whatever is left that way, one program per
 * task so no single task carries several.
 */
export async function compileWithDeadline(
  renderer: WebGLRenderer,
  root: Object3D,
  camera: Camera,
  target: Scene | null = null,
  deadlineMs = 1500,
): Promise<void> {
  let timer = 0;
  const done = renderer.compileAsync(root, camera, target).then(() => true);
  const late = new Promise<boolean>((res) => {
    timer = window.setTimeout(() => res(false), deadlineMs);
  });
  const ok = await Promise.race([done, late]);
  clearTimeout(timer);
  if (ok) return;
  const gl = renderer.getContext();
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const programs = (renderer.info.programs ?? []) as unknown as { program: WebGLProgram }[];
  for (const p of programs) {
    if (ext && gl.getProgramParameter(p.program, ext.COMPLETION_STATUS_KHR)) continue;
    gl.getProgramParameter(p.program, gl.LINK_STATUS); // blocks until this one is linked
    await yieldTask();
  }
  await done;
}
