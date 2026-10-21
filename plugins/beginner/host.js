/**
 * Mode: learn from zero.
 *
 * A mode is policy, not code paths: the kernel keeps the tools and the data
 * format, the pack decides how the lesson runs. `rules` is handed to the model
 * verbatim by `learn_status`, so it must be short and imperative.
 */
export default {
  id: "beginner",
  apiVersion: 1,
  name: "从零学",
  description: "一次一个知识点，讲解后立即探测。",
  mode: {
    label: "从零学",
    summary: "讲 200–300 字，立刻出题；答错换个讲法重来一次。",
    tools: ["learn_status", "learn_kp", "learn_record", "learn_report"],
    rules: [
      "每个知识点讲解不超过 300 字，必须带「坏例子 / 好例子」两段代码。",
      "讲完立刻出一道探测题，不要问「懂了吗」。",
      "按 rubric 逐条判分，命中才给分；判卷必须引用学员原话。",
      "答错时换一种讲法重讲一次，再出一道同类题；两次都不行就标记薄弱并前进。",
      "答对后直接进入下一个知识点，不要问「还要继续吗」。",
    ].join("\n"),
  },
};
