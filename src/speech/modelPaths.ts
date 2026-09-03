/**
 * modelPaths.ts — whisper model file placement policy (todo36).
 *
 * Models are large user downloads, never shipped: the accepted homes are
 *   ① <modelsDir>/**        (the registry root the user can already switch)
 *   ② <userData>/whisper-models/**
 * Outside those two subtrees the path is refused (path-outside-allowed) even
 * when the file exists — the renderer cannot steer whisper-server at arbitrary
 * disk locations. Extensions: whisper.cpp ggml (.bin) and gguf (.gguf).
 */

export const WHISPER_MODEL_EXTENSIONS = ['bin', 'gguf'] as const

export type ModelPathCheck = {
  path: string
  modelsDir: string
  userDataDir: string
  existsSync: (p: string) => boolean
}

export type ModelPathRejection = 'not-absolute' | 'bad-extension' | 'file-not-found' | 'path-outside-allowed'

/** resolve + lowercase Windows-safe containment (mirrors src/agent path fences). */
export function isInsideDir(candidate: string, dir: string): boolean {
  const normalize = (p: string): string => {
    const trimmed = p.replace(/[/\\]+$/, '')
    return `${trimmed.replace(/\\/g, '/')}/`.toLowerCase()
  }
  return normalize(candidate).startsWith(normalize(dir))
}

/** undefined = accepted; otherwise the first violated rule. */
export function checkWhisperModelPath(check: ModelPathCheck): ModelPathRejection | undefined {
  const { path, modelsDir, userDataDir, existsSync } = check
  if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('/')) return 'not-absolute'
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (!(WHISPER_MODEL_EXTENSIONS as readonly string[]).includes(ext)) return 'bad-extension'
  const homes = [modelsDir, userDataDir]
  const insideHome = homes.some((home) => isInsideDir(path, home))
  if (!insideHome) return 'path-outside-allowed'
  if (!existsSync(path)) return 'file-not-found'
  return undefined
}

/** Convenience predicate used by the handlers (allowed = no rejection). */
export function modelPathIsAllowed(
  path: string,
  dirs: { modelsDir: string; userDataDir: string; existsSync: (p: string) => boolean },
): boolean {
  return checkWhisperModelPath({ path, ...dirs }) === undefined
}
