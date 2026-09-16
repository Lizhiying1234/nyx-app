/**
 * 图片当模块 import 时的类型 —— Vite 会把它打成一个 URL 字符串。
 *
 * 只有一处在用：启动页「没图版」那只兔子（`Splash.svelte`）。
 * 它**必须打进包里**：那一版存在的理由就是「`resources/` 里那张图不在也要有东西可画」，
 * 再让它去依赖另一个外部文件就等于没有兜底。
 */
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.webp' {
  const src: string
  export default src
}
