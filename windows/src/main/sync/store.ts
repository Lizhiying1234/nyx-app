/**
 * ★★ 2026-08-29 · 阶段 3（Android 同步接线）：传输层整体搬进
 * `core/sync/store.ts`（它本来就只用 fetch，两端必须同一份）。
 * 这里只剩转发，免得 main 里的旧 import 路径全要跟着改。
 */
export {
  makeStore,
  SupabaseStore,
  WebDavStore,
  type RemoteStore,
  type SyncConfig
} from '@core/sync/store.ts'
