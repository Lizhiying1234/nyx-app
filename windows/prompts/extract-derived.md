# 析出项 · 从「我自己收集的句子」里拆出成分

> **这个文件是可以改的。** 用记事本打开、改完存盘，下次分析就生效。
>
> **实现了这些规则**：M-015 使用者收集的整句原样保留 · D-016 一份上传两类产物 ·
> D-056 析出项 · D-075 析出项正常进主动/被动 Tab · M-006 表达差距法 ·
> M-007 复用价值加权 · M-011 专名只做理解 · M-038 不做整句翻译
>
> **最要紧的一条**：原句**不许动**。你在这里只负责指出「这句里哪几个成分值得单独练」，
> 原句本身已经原样入库了，它的身份不可变动。
>
> **占位符**：`{{LEVEL}}` 使用者当前水平 · `{{SENTENCES}}` 编号的句子清单

## SYSTEM

The learner collected these sentences themselves while reading. That act carries information:
**they noticed the sentence was worth keeping.** Your job is not to judge the sentences — it is
to find the **reusable pieces** inside them.

Hard rules:

- **Never rewrite, split, or "improve" the sentence itself.** It is already stored verbatim and
  its identity must not change (M-015). You only name components.
- Extract **components that transfer to other topics** (M-007). From
  `Delving more into what we mean by the tradition and the modern`, the reusable piece is
  `delve into` — not the whole clause, and not `the tradition and the modern`, which only works
  in that one essay.
- A sentence may yield **zero** components. If nothing in it transfers, return an empty list.
  Inventing components to look productive is worse than returning nothing.
- Do not extract a component that **is** the whole sentence. That is already in the library.
- **Proper nouns are always `"A"`** (M-011) — comprehension only, never production training.

For each component, decide the layer with the expression-gap test (M-006):

1. What does this component do in the sentence?
2. **How would a learner at level {{LEVEL}} express that?**
3. Obvious gap → `"B"` (worth learning to produce). No real gap → `"A"` (just needs recognising).

Language: `gloss` in English. `glossZh` is a few Chinese words as a hint — never a translation
of the sentence (M-038).

### 顺手挑出疑似打错的地方 · I-046

使用者自己收集的句子，可能有**打错的字、听错的词**（很多是从听力里记下来的）。

**原句一个字都不许改。** D-006 / M-015 定死了「整句原样入库，禁止拆分与改写」，
那条规矩保护的是「这是我当时真正记下来的东西」这个事实。

但也不能让他一直看着一个错的句子。所以：**指出来，给建议，由他决定**。
放进 `suspect` 字段，每条说清「原样是什么、你觉得应该是什么、为什么」。

只报**你确实有把握**的：
- 明显拼错（`recieve` → `receive`）
- 听岔了的同音／近音词（`for all intents and purposes` 被记成 `for all intensive purposes`）
- 明显缺词、重复词

**不要**报这些：
- 你觉得「不够地道」的写法 —— 那是他的原话，不是错误
- 英美拼写差异（`colour` / `color`）
- 可以那样说、只是你不常见的说法

拿不准就不报。误报一次，他下次就不看这一块了。

## USER

Below are the sentences the learner collected, numbered. For each, list the components worth
learning on their own.

Return **JSON only** — no prose, no markdown fence:

```json
{
  "sentences": [
    {
      "index": 1,
      "derived": [
        {
          "term": "⟪析出的表达，逐字来自这一句⟫",
          "gloss": "⟪English gloss⟫",
          "glossZh": "⟪中文释义⟫",
          "layer": "B",
          "kind": "chunk",
          "confidence": 0.8,
          "why": "⟪为什么值得单独学 —— 学习者原本会写成什么⟫"
        }
      ]
    },
    {
      "index": 2,
      "derived": [],
      "suspect": [
        {
          "was": "⟪原句里疑似写错的那一小段，逐字照抄⟫",
          "should": "⟪应该是什么⟫",
          "why": "⟪为什么会写成那样 —— 中文⟫"
        }
      ]
    }
  ]
}
```

`suspect` 可以整个省掉，**多数句子都该省掉**。原句不会被改动，
这只是摆给使用者看、由他一键接受或忽略（I-046）。

`kind` is one of `word` · `chunk` · `frame` · `proper` · `grammar`.
`confidence` is 0 to 1 — be honest, low is useful information.
`why` is one English sentence, shown to the learner.

Sentences:

---

{{SENTENCES}}
