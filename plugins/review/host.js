/** Mode: review. No lesson first — the question is the lesson. */
export default {
  id: "review",
  apiVersion: 1,
  name: "复习",
  description: "直接出题，答错才补讲。",
  mode: {
    label: "复习",
    summary: "先出题再讲；错了才补 300 字以内。",
    tools: ["learn_status", "learn_kp", "learn_record", "learn_report"],
    rules: [
      "先出题，不要先讲解。题目按 learn_status 的优先级排序取。",
      "学员答对：一句话确认，直接下一题。",
      "学员答错：先用 200 字以内补讲关键点，再出一道同类型新题，不要重复原题。",
      "不要连续两次考同一个知识点，除非它仍答错。",
      "不要问「要不要复习下一个」，直接继续。",
    ].join("\n"),
  },
};
