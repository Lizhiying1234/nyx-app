import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { DictionaryIO, FileHandle } from '@core/dict/contract.ts'

/**
 * Node 这边的 `DictionaryIO` · D2（2026-08-19）
 *
 * 契约里的 I/O 是**注入**的，不是 adapter 自己去 `import 'node:fs'` ——
 * 判据是 D-238：将来 Android 端要照搬同一套 adapter 逻辑，
 * 换掉的只应该是这一个文件。
 *
 * 同步的理由见 `contract.ts`：读的是头部那几百字节，
 * 而昂贵的那条路（取一条 mp3）走 `OpenDictionary.resource()`，那条是异步的。
 */

interface NodeHandle extends FileHandle {
  readonly fd: number
}

export const nodeIO: DictionaryIO = {
  open(path: string): FileHandle {
    const fd = openSync(path, 'r')
    const h: NodeHandle = { path, size: statSync(path).size, fd }
    return h
  },
  read(h: FileHandle, at: number, len: number): Uint8Array {
    const buf = Buffer.alloc(len)
    // ★ 读到文件尾就返回短的，**不抛** —— 契约里写死的
    const n = readSync((h as NodeHandle).fd, buf, 0, len, at)
    return buf.subarray(0, n)
  },
  close(h: FileHandle): void {
    closeSync((h as NodeHandle).fd)
  }
}
