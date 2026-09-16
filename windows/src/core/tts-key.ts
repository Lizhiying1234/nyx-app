/**
 * 朗读实际会读的那一段文字 · D-466
 *
 * ★ 这个文件原来是**缓存文件名的判据**（拿什么去哈希、哈希出来叫什么）。
 *   D-466 把云端与永久缓存两半一起撤了 —— 没有云端就没有东西能填进缓存，
 *   于是「缓存名」这件事整个没有了对象：`ttsKeyMaterial` / `ttsFileName` /
 *   `LEGACY_CACHE_PROVIDER` 都删了。剩下的只有这一条判据，两端仍然共用：
 *   **一次朗读最多读多少字符**。
 *
 * ★ 文件名**故意留在原地**（主控 2026-09-07 裁）：Android 的 `core-link.ts`
 *   对着 `core/tts-key.ts` 这个路径转出 `ttsText`。两仓对着同一个路径，
 *   比换一个更贴切的名字值 —— 改名得两仓同一次提交才不断，而收益只是好听。
 *
 * ★ 同步引擎里 `nyx/audio` 那条通道不动（协议锁 · ARCHITECTURE LOCKED ③），
 *   落盘名字的白名单仍在 `core/audio-name.ts` —— 它只是从此同步 0 个文件。
 */

/** 一次朗读最多读这么多字符，超出的部分不读 */
export const TTS_TEXT_MAX = 500

/** 朗读实际会读的那段话 */
export function ttsText(text: string): string {
  return text.trim().slice(0, TTS_TEXT_MAX)
}
