import { contextBridge, ipcRenderer } from 'electron'
import type { AnalyzeStage, NyxApi } from '@shared/api.ts'

/**
 * 把界面传来的值变成「干净的」再过 IPC。
 *
 * **为什么必须有这一层**：Svelte 5 的 `$state` 是 Proxy，而 Electron 的 IPC 走
 * 结构化克隆 —— **Proxy 克隆不了**，会抛 `An object could not be cloned.`。
 * 症状很坑：类型检查全过、界面看着正常，一点按钮就整块报错。
 *
 * 放在这里而不是各个调用点，是因为「记得手动 snapshot」是守不住的 ——
 * 只要有一处忘了就复发，而且下次复发时又要从头查一遍。
 */
/**
 * 去掉响应式包装再过 IPC。
 *
 * **注意它管不到什么**：contextBridge 在参数**进入这里之前**就已经克隆过一次了，
 * 所以渲染层直接把 Svelte 的 `$state` Proxy 传进来，报错在桥上就发生了 ——
 * 「An object could not be cloned」，和这个函数无关。
 * 真正的防线在**调用点**：渲染层传数组/对象时要 `[...arr]` 或展开一层。
 * 这里留着是为了 preload 自己拼出来的对象，以及将来 electron 放宽克隆规则时的一道保险。
 */
function plain<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/**
 * 界面层拿不到 node、拿不到数据库、拿不到 AI —— 只能调下面这几个口子（D-258）。
 * 出问题时能立刻分清是哪一层。
 */
const api: NyxApi = {
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close')
  },
  res: {
    listSplash: () => ipcRenderer.invoke('res:listSplash'),
    shippedSplash: () => ipcRenderer.invoke('res:shippedSplash'),
    readSplash: (name: string) => ipcRenderer.invoke('res:readSplash', name),
    activeSplash: () => ipcRenderer.invoke('res:activeSplash'),
    setActiveSplash: (c: unknown) => ipcRenderer.invoke('res:setActiveSplash', c),
    pickSplash: () => ipcRenderer.invoke('res:pickSplash'),
    removeSplash: (name: string) => ipcRenderer.invoke('res:removeSplash', name),
    splashLabels: () => ipcRenderer.invoke('res:splashLabels'),
    renameSplash: (name: string, label: string) =>
      ipcRenderer.invoke('res:renameSplash', name, label),
    openSplashFolder: () => ipcRenderer.invoke('res:openSplashFolder'),
    colorModes: () => ipcRenderer.invoke('res:colorModes'),
    /** ★ 传字符串而不是对象：Svelte 5 的 $state 代理结构化克隆会炸
     *  （2026-09-09「An object could not be cloned.」那次就是这么来的）*/
    saveColorModes: (json: string) => ipcRenderer.invoke('res:saveColorModes', json),
    applyColors: (id: string) => ipcRenderer.invoke('res:applyColors', id)
  },
  app: {
    selfTest: () => ipcRenderer.invoke('app:selfTest'),
    // H-4a · 错误页要显示构建号，而它不能依赖数据库
    buildInfo: () => ipcRenderer.invoke('app:buildInfo'),
    // B8 · 启动页那张图（读不出来给 null，界面画没图版）
    splashArt: () => ipcRenderer.invoke('app:splashArt'),
  },
  data: {
    tree: () => ipcRenderer.invoke('data:tree'),
    ensurePath: (p, u, l) => ipcRenderer.invoke('data:ensurePath', p, u, l),
    lecture: (id) => ipcRenderer.invoke('data:lecture', id),
    deleteMaterial: (id) => ipcRenderer.invoke('data:deleteMaterial', id),
    addOriginal: (lectureId, title, content) =>
      ipcRenderer.invoke('data:addOriginal', lectureId, title, content),
    createProject: (name) => ipcRenderer.invoke('data:createProject', name),
    createUnit: (projectId, name) => ipcRenderer.invoke('data:createUnit', projectId, name),
    createLecture: (unitId, name) => ipcRenderer.invoke('data:createLecture', unitId, name),
    rename: (kind, id, name) => ipcRenderer.invoke('data:rename', kind, id, name),
    softDelete: (kind, id) => ipcRenderer.invoke('data:softDelete', kind, id),
    silenceLecture: (id, on) => ipcRenderer.invoke('data:silenceLecture', id, on),
    setPinned: (id, on) => ipcRenderer.invoke('data:setPinned', id, on),
    setSilent: (kind, id, on) => ipcRenderer.invoke('data:setSilent', kind, id, on),
    silentTree: () => ipcRenderer.invoke('data:silentTree'),
    reorder: (kind, parentId, ids) => ipcRenderer.invoke('data:reorder', kind, parentId, ids),
    markUnread: (id) => ipcRenderer.invoke('data:markUnread', id),
    move: (kind, id, p2) => ipcRenderer.invoke('data:move', kind, id, p2),
    forkLecture: (id) => ipcRenderer.invoke('data:forkLecture', id),
    lecturesUnder: (kind, id) => ipcRenderer.invoke('data:lecturesUnder', kind, id),
    exportNotes: (kind, id, name) => ipcRenderer.invoke('data:exportNotes', kind, id, name),
    matchQuotes: (lectureId: number) => ipcRenderer.invoke('data:matchQuotes', lectureId),
    addItem: (lectureId, term, gloss, layer, quote) =>
      ipcRenderer.invoke('data:addItem', lectureId, term, gloss, layer, quote),
    addChunks: (lectureId, title, content) =>
      ipcRenderer.invoke('data:addChunks', lectureId, title, content)
  },
  ai: {
    explain: (text: string) => ipcRenderer.invoke('ai:explain', text),
    brief: (text: string) => ipcRenderer.invoke('ai:brief', text),
    settings: () => ipcRenderer.invoke('ai:settings'),
    save: (input) => ipcRenderer.invoke('ai:save', plain(input)),
    providers: () => ipcRenderer.invoke('ai:providers'),
    isConfigured: () => ipcRenderer.invoke('ai:isConfigured'),
    testConnection: (slot) => ipcRenderer.invoke('ai:test', slot),
    analyze: (lectureId, extra, presetName, materialIds) =>
      // plain() 是必须的：Svelte 的 $state 会把数组包成 Proxy，
      // Proxy 过不了 contextBridge —— 报的是「An object could not be cloned」，
      // 看上去和参数内容毫无关系，查起来很费劲（I-082 就栽在这里一次）
      ipcRenderer.invoke('ai:analyze', lectureId, extra, presetName, plain(materialIds)),
    cancelAnalyze: (lectureId) => ipcRenderer.invoke('ai:cancelAnalyze', lectureId),
    onStage: (cb) => {
      const h = (_e: unknown, s: AnalyzeStage): void => cb(s)
      ipcRenderer.on('ai:stage', h)
      return () => ipcRenderer.off('ai:stage', h)
    }
  },
  prompts: {
    presets: () => ipcRenderer.invoke('prompts:presets'),
    savePreset: (p) => ipcRenderer.invoke('prompts:savePreset', plain(p)),
    deletePreset: (id) => ipcRenderer.invoke('prompts:deletePreset', id),
    lecturePreset: (id) => ipcRenderer.invoke('prompts:lecturePreset', id),
    setLecturePreset: (l, p) => ipcRenderer.invoke('prompts:setLecturePreset', l, p),
    assembled: (name, extra) => ipcRenderer.invoke('prompts:assembled', name, extra),
    readingFaces: () => ipcRenderer.invoke('reading:faces'),
    saveReadingFaces: (list) => ipcRenderer.invoke('reading:saveFaces', plain(list)),
    saveCustomFace: (face) => ipcRenderer.invoke('reading:saveCustomFace', plain(face)),
    deleteCustomFace: (id) => ipcRenderer.invoke('reading:deleteCustomFace', id),
    saveReadingOptions: (patch) => ipcRenderer.invoke('reading:saveOptions', plain(patch)),
    saveReadingQType: (v) => ipcRenderer.invoke('reading:saveQType', v),
    syncReport: () => ipcRenderer.invoke('prompts:syncReport'),
    openFolder: () => ipcRenderer.invoke('prompts:openFolder')
  },
  params: {
    list: () => ipcRenderer.invoke('params:list'),
    set: (key, value) => ipcRenderer.invoke('params:set', key, value),
    reset: (key) => ipcRenderer.invoke('params:reset', key)
  },
  bubble: {
    /** 主进程推过来的真状态（开着 / 没开）*/
    onState: (fn: (on: boolean) => void) => {
      const h = (_e: unknown, on: boolean): void => fn(on)
      ipcRenderer.on('bubble:state', h)
      return () => ipcRenderer.removeListener('bubble:state', h)
    },
    /** 点一下 = 开 / 关**当前那一档**（不切模式）*/
    toggle: () => ipcRenderer.send('bubble:toggle'),
    /** 拖动中：搬一段 */
    moveBy: (dx: number, dy: number, first: boolean) =>
      ipcRenderer.send('bubble:moveBy', dx, dy, first),
    /** 拖完了：把位置记下来（★ 不是每一步都写库）*/
    rest: () => ipcRenderer.send('bubble:rest')
  },
  marker: {
    /**
     * 选区高亮那一层订阅「现在该画哪几个方块」。
     * ★ 单向、只读：这一层从不往回说话，也不吃鼠标。
     */
    onRects: (fn: (rects: { x: number; y: number; w: number; h: number }[]) => void) => {
      const h = (
        _e: unknown,
        rects: { x: number; y: number; w: number; h: number }[]
      ): void => fn(rects)
      ipcRenderer.on('marker:rects', h)
      return () => ipcRenderer.removeListener('marker:rects', h)
    }
  },
  overlay: {
    /**
     * @param ocr   认出来的（不是问系统要来的）—— 卡上标「可能有误」（D-395）
     * @param empty 这一下什么都没读到 —— 卡照样出来，说一句实话（I-177）
     */
    onLookup: (
      fn: (text: string, ocr: boolean, empty: boolean, note: string, hint: string) => void
    ) => {
      const h = (
        _e: unknown,
        text: string,
        ocr: boolean,
        empty: boolean,
        note: string,
        hint: string
      ): void => fn(text, ocr === true, empty === true, note ?? '', hint ?? '')
      ipcRenderer.on('overlay:lookup', h)
      return () => ipcRenderer.off('overlay:lookup', h)
    },
    moveBy: (dx: number, dy: number, first: boolean) =>
      ipcRenderer.send('overlay:moveBy', dx, dy, first),
    close: () => ipcRenderer.send('overlay:close')
  },
  glance: {
    get: () => ipcRenderer.invoke('glance:get'),
    /** 托盘那边改了模式 —— 设置页要跟着变，否则屏上那一档是旧的 */
    onChanged: (fn: () => void) => {
      const h = (): void => fn()
      ipcRenderer.on('assist:changed', h)
      return () => ipcRenderer.off('assist:changed', h)
    },
    set: (mode: string, blocked: string) => ipcRenderer.invoke('glance:set', mode, blocked),
    setLecture: (id: number | null) => ipcRenderer.invoke('glance:setLecture', id),
    setBubble: (on) => ipcRenderer.invoke('glance:setBubble', on),
    onHit: (fn: (text: string) => void) => {
      const h = (_e: unknown, text: string): void => fn(text)
      ipcRenderer.on('glance:hit', h)
      return () => ipcRenderer.off('glance:hit', h)
    },
    onDead: (fn: (why: string) => void) => {
      const h = (_e: unknown, why: string): void => fn(why)
      ipcRenderer.on('glance:dead', h)
      return () => ipcRenderer.off('glance:dead', h)
    }
  },
  ui: {
    get: (k: string) => ipcRenderer.invoke('ui:get', k),
    set: (k: string, v: string) => ipcRenderer.invoke('ui:set', k, v)
  },
  store: {
    info: () => ipcRenderer.invoke('store:info'),
    backupNow: () => ipcRenderer.invoke('store:backupNow'),
    openFolder: (which: 'data' | 'logs' | 'backups') => ipcRenderer.invoke('store:openFolder', which)
  },
  tts: {
    settings: () => ipcRenderer.invoke('tts:settings'),
    save: (s) => ipcRenderer.invoke('tts:save', plain(s)),
    speak: (text) => ipcRenderer.invoke('tts:speak', text),
    lastTrace: () => ipcRenderer.invoke('tts:lastTrace')
  },
  onDataChanged: (fn) => {
    const h = (_e: unknown, info: { from: string; rows: number }): void => fn(info)
    ipcRenderer.on('data:changed', h)
    return () => ipcRenderer.off('data:changed', h)
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    save: (c) => ipcRenderer.invoke('sync:save', plain(c)),
    test: () => ipcRenderer.invoke('sync:test'),
    setAuto: (on) => ipcRenderer.invoke('sync:setAuto', on),
    run: (resolve) => ipcRenderer.invoke('sync:run', resolve)
  },
  dict: {
    list: () => ipcRenderer.invoke('dict:list'),
    rescan: () => ipcRenderer.invoke('dict:rescan'),
    setEnabled: (id, on) => ipcRenderer.invoke('dict:setEnabled', id, on),
    reorder: (ids) => ipcRenderer.invoke('dict:reorder', plain(ids)),
    lookupCard: (word, bookId) => ipcRenderer.invoke('dict:lookupCard', word, bookId),
    setDefaultBook: (id) => ipcRenderer.invoke('dict:setDefaultBook', id),
    openFolder: () => ipcRenderer.invoke('dict:openFolder'),
    // ── 富词条 · D4 ──
    rich: (word, bookId) => ipcRenderer.invoke('dict:rich', word, bookId),
    resource: (ref) => ipcRenderer.invoke('dict:resource', ref),
    style: (bookId, key) => ipcRenderer.invoke('dict:style', bookId, key)
  },
  ingest: {
    pickFile: () => ipcRenderer.invoke('ingest:pickFile')
  },
  exp: {
    backup: () => ipcRenderer.invoke('exp:backup'),
    notes: () => ipcRenderer.invoke('exp:notes'),
    restore: () => ipcRenderer.invoke('exp:restore'),
    notesForItems: (ids, name) => ipcRenderer.invoke('exp:notesForItems', plain(ids), name),
    factoryReset: (word, alsoRemote) =>
      ipcRenderer.invoke('exp:factoryReset', word, alsoRemote ?? false),
    relaunch: () => ipcRenderer.invoke('exp:relaunch'),
    dictsInfo: () => ipcRenderer.invoke('exp:dictsInfo'),
    wipe: (alsoRemote, alsoSettings) => ipcRenderer.invoke('exp:wipe', alsoRemote, alsoSettings)
  },
  report: {
    build: (days) => ipcRenderer.invoke('report:build', days),
    evidence: (days) => ipcRenderer.invoke('report:evidence', days)
  },
  health: {
    audit: () => ipcRenderer.invoke('app:audit'),
    repair: () => ipcRenderer.invoke('app:repair')
  },
  ledger: {
    list: () => ipcRenderer.invoke('ledger:list'),
    drop: (id) => ipcRenderer.invoke('ledger:drop', id),
    ops: () => ipcRenderer.invoke('ledger:ops'),
    restore: (id) => ipcRenderer.invoke('ledger:restore', id),
    // T-4.14 · 查词记账（一行 ops_log），以及「后来收下了」的回填
    lookup: (term, face) => ipcRenderer.invoke('ledger:lookup', term, face),
    lookupSaved: (opId, itemId) => ipcRenderer.invoke('ledger:lookupSaved', opId, itemId)
  },
  /** T-2.11 / T-4.8 · 讲次内一键去重。`pick` 是纯对象，过桥前 `plain` 一层 */
  dedup: {
    scan: (lectureId) => ipcRenderer.invoke('dedup:scan', lectureId),
    merge: (lectureId, pick) => ipcRenderer.invoke('dedup:merge', lectureId, plain(pick))
  },
  browse: {
    search: (q) => ipcRenderer.invoke('browse:search', q),
    trash: () => ipcRenderer.invoke('browse:trash'),
    restore: (kind, id) => ipcRenderer.invoke('browse:restore', kind, id),
    restoreMany: (picks) => ipcRenderer.invoke('browse:restoreMany', picks),
    purgeMany: (picks) => ipcRenderer.invoke('browse:purgeMany', picks),
    renameLecture: (id, name) => ipcRenderer.invoke('browse:renameLecture', id, name),
    deleteLecture: (id) => ipcRenderer.invoke('browse:deleteLecture', id)
  },
  files: {
    list: () => ipcRenderer.invoke('files:list'),
    add: (title, content, lectureId) => ipcRenderer.invoke('files:add', title, content, lectureId),
    detail: (id) => ipcRenderer.invoke('files:detail', id),
    setPath: (id, lectureId) => ipcRenderer.invoke('files:setPath', id, lectureId),
    remove: (id) => ipcRenderer.invoke('files:remove', id),
    setStatus: (id, s) => ipcRenderer.invoke('files:setStatus', id, s),
    chat: (id, text, tutorId, mode, genreUid, questNext) =>
      ipcRenderer.invoke('files:chat', id, text, tutorId, mode, genreUid, questNext ?? false),
    analyse: (id) => ipcRenderer.invoke('files:analyse', id),
    tutors: () => ipcRenderer.invoke('files:tutors'),
    saveTutor: (t) => ipcRenderer.invoke('files:saveTutor', plain(t)),
    genres: () => ipcRenderer.invoke('files:genres'),
    saveGenre: (g) => ipcRenderer.invoke('files:saveGenre', plain(g)),
    deleteGenre: (id) => ipcRenderer.invoke('files:deleteGenre', id),
    deleteTutor: (id) => ipcRenderer.invoke('files:deleteTutor', id),
    setDefaultTutor: (id) => ipcRenderer.invoke('files:setDefaultTutor', id)
  },
  study: {
    startLearning: (id) => ipcRenderer.invoke('study:startLearning', id),
    deleteItem: (id) => ipcRenderer.invoke('study:deleteItem', id),
    setLayer: (id, layer) => ipcRenderer.invoke('study:setLayer', id, layer),
    dueCards: (id, limit) => ipcRenderer.invoke('study:dueCards', id, limit),
    readingFace: (itemId) => ipcRenderer.invoke('study:readingFace', itemId),
    testCards: (ids, shuffle) => ipcRenderer.invoke('study:testCards', plain(ids), shuffle),
    testQueue: (ids, shuffle) => ipcRenderer.invoke('study:testQueue', plain(ids), shuffle),
    gradeCard: (id, grade, ms) => ipcRenderer.invoke('study:gradeCard', id, grade, ms),
    productionQueueMany: (ids) => ipcRenderer.invoke('study:productionQueueMany', plain(ids)),
    hardQueue: () => ipcRenderer.invoke('study:hardQueue'),
    hardQuestion: (id) => ipcRenderer.invoke('study:hardQuestion', id),
    diagnose: (s) => ipcRenderer.invoke('study:diagnose', s),
    queueByIds: (ids) => ipcRenderer.invoke('study:queueByIds', plain(ids)),
    hardList: () => ipcRenderer.invoke('study:hardList'),
    todayPlan: (target) => ipcRenderer.invoke('study:todayPlan', target),
    dailyTarget: () => ipcRenderer.invoke('study:dailyTarget'),
    setDailyTarget: (n) => ipcRenderer.invoke('study:setDailyTarget', n),
    settleLectures: (ids, s) => ipcRenderer.invoke('study:settleLectures', plain(ids), s),
    ensureQuestions: (id) => ipcRenderer.invoke('study:ensureQuestions', id),
    qtypes: () => ipcRenderer.invoke('study:qtypes'),
    setQtypes: (ids) => ipcRenderer.invoke('study:setQtypes', [...ids]),
    saveQtype: (q) => ipcRenderer.invoke('study:saveQtype', plain(q)),
    deleteQtype: (id) => ipcRenderer.invoke('study:deleteQtype', id),
    setQtypeEnabled: (id, on) => ipcRenderer.invoke('study:setQtypeEnabled', id, on),
    restoreQtypes: () => ipcRenderer.invoke('study:restoreQtypes'),
    savePracticeRules: (patch) => ipcRenderer.invoke('study:savePracticeRules', plain(patch)),
    savePracticeFace: (v) => ipcRenderer.invoke('study:savePracticeFace', v),
    clearQtypePrompt: (uid) => ipcRenderer.invoke('study:clearQtypePrompt', uid),
    order: () => ipcRenderer.invoke('study:order'),
    setOrder: (o) => ipcRenderer.invoke('study:setOrder', plain(o)),
    nextQuestion: (id) => ipcRenderer.invoke('study:nextQuestion', id),
    submitAnswer: (s, i, q, text, first, hinted, durationMs) =>
      ipcRenderer.invoke('study:submitAnswer', s, i, q, text, first, hinted, durationMs),
    usedHint: (id) => ipcRenderer.invoke('study:usedHint', id),
    matrix: () => ipcRenderer.invoke('study:matrix'),
    libraryItems: (f) => ipcRenderer.invoke('study:libraryItems', plain(f)),
    bulkDelete: (ids) => ipcRenderer.invoke('study:bulkDelete', plain(ids)),
    bulkSetLayer: (ids, layer) => ipcRenderer.invoke('study:bulkSetLayer', plain(ids), layer),
    silentStats: () => ipcRenderer.invoke('study:silentStats'),
    itemDetail: (id) => ipcRenderer.invoke('study:itemDetail', id),
    ensureAnalysis: (id, force) => ipcRenderer.invoke('study:ensureAnalysis', id, force),
    editItem: (id, input) => ipcRenderer.invoke('study:editItem', id, plain(input)),
    acceptSuspect: (id, i) => ipcRenderer.invoke('study:acceptSuspect', id, i),
    dismissSuspects: (id) => ipcRenderer.invoke('study:dismissSuspects', id),
    silenceItem: (id) => ipcRenderer.invoke('study:silenceItem', id),
    restoreItem: (id) => ipcRenderer.invoke('study:restoreItem', id),
    derivedOf: (id) => ipcRenderer.invoke('study:derivedOf', id),
    bulkSilence: (ids, on) => ipcRenderer.invoke('study:bulkSilence', plain(ids), on),
    termsOf: (ids) => ipcRenderer.invoke('study:termsOf', plain(ids)),
    analysisCounts: (lectureId) => ipcRenderer.invoke('study:analysisCounts', lectureId),
    analyseScope: (lectureId, scope) => ipcRenderer.invoke('study:analyseScope', lectureId, scope),
    testCardsByIds: (ids, sh) => ipcRenderer.invoke('study:testCardsByIds', plain(ids), sh),
    startSession: (kind, scope, target) =>
      ipcRenderer.invoke('study:startSession', kind, scope, target),
    settle: (l, s) => ipcRenderer.invoke('study:settle', l, s),
    overview: () => ipcRenderer.invoke('study:overview')
  }
}

contextBridge.exposeInMainWorld('nyx', api)
