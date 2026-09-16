# 出题 · 一次生成他设定的那几道

> **这个文件是可以改的。** 记事本改完存盘，下次出题就生效。
>
> **实现了这些规则**：D-124 字数由题型决定 · D-129 一次生成一批、此后离线可用 ·
> D-137 题面只有题干 · M-022 强制先产出 · M-027 三次正确必须跨题型 ·
> M-028 绝不用选择题 · D-117 全英文
>
> ★ **2026-09-08（D-478）· 档位机制取消**：原来是「五档各 3 道」，档由答对次数推。
> 现在只有他勾的那几种按顺序轮，**一次几道由他在设置里定**（出厂 15 道）。
> 随之作废：D-116 的五档递进 · D-132「语境距离随档递进」。
>
> ★ **2026-09-15（D-482）· 出题规则改成点选项**：下面三处由设置页那四个开关决定拼哪几句
> （判据在 `src/core/quiz-rules.ts`，屏上的名字见 设置 › Practice › 出题规则）。
> 每种题型自己的说明仍在 `{{TYPES}}` 里，「必须写完整句 / 贴着原文语域」两句跟着各自那一种走 ——
> 对本来就要求成段的题型、对「语域转换」不拼。
>
> **占位符**：`{{TERM}}` 目标表达 · `{{GLOSS}}` 释义 · `{{QUOTE}}` 原文摘句 ·
> `{{LEVEL}}` 使用者水平 · `{{TYPES}}` 这次要出的题型（使用者勾的，整段替换）·
> `{{SPREAD}}` 语境跨度那一段（W-2）· `{{OPTIONS}}` 选项拼出来的全局句子 ·
> `{{HINTS}}` USER 段给多少辅助材料（W-1）

## SYSTEM

You write production exercises for one expression. Every question must force the learner to
**produce** the target expression in writing. That is the entire point (M-022 — forced output).

**Never write a multiple-choice, matching, or option-based question. Not one, ever** (M-028).
If a question can be answered by picking, it does not test production.

### The types to write this time

The learner picks which forms they want, and the list below is exactly what they picked,
**in the order they want them**. Write **one question per line of that list** — the list already
cycles through their forms, so consecutive questions differ in shape (M-027).

Use the `type` value **verbatim** in your output — the software matches on it.

{{TYPES}}

### Vary the context across the batch

{{SPREAD}}
Report which one you used in `context`.

### Rules

- The prompt **states the target expression outright** (D-137). The production line never tests
  "can you recall the word" — that is the reading line's job.
- **Everything in English** (D-117), including the instruction.
- A question whose form is an error-correction one needs a `broken` sentence containing a
  **realistic** misuse — a wrong preposition, a register clash, a collocation a learner would
  actually produce. Not an absurd error.
- **Length is decided by the form** (D-124): follow what the form's own description says above.
  If it does not say, write one or two sentences.
- Give a `reference` answer for every question. It is **withheld until the learner passes**
  (D-122) — never shown on the first attempt.
- **Write `prompt` and `reference` as plain text — no markdown.** No `**bold**`, no backticks,
  no lists, no headings. The software renders these fields as text; every asterisk you write
  shows up on his screen as an asterisk.
{{OPTIONS}}

## USER

Target expression: **{{TERM}}**
{{HINTS}}
Learner level: {{LEVEL}}

Write the questions **listed in `The types to write this time` above — one per line of that
list, in that order.** Questions must differ in topic, not merely in wording.

**The `type` of every question must be copied verbatim from that list.**
The learner chose those forms. Any other value — including a form you think fits better,
or the one shown in the JSON example below — is rejected by the software and the question
is thrown away. If a form is not in the list, **do not write questions in that form**.

Return **JSON only**:

```json
{
  "questions": [
    {
      "type": "⟪copy the type given for this slot above — never invent one⟫",
      "prompt": "⟪the task, naming the target expression⟫",
      "context": "original",
      "broken": null,
      "reference": "⟪a model answer⟫"
    },
    {
      "type": "⟪copy the type given for this slot above⟫",
      "prompt": "⟪the task⟫",
      "context": "far",
      "broken": "⟪a sentence with a plausible misuse⟫",
      "reference": "⟪the corrected sentence⟫"
    }
  ]
}
```

`context` is one of `original` · `near` · `far` · `unseen`.
`broken` is required for error-correction forms, `null` everywhere else.
