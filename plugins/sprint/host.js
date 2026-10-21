/** Mode: quick pass. Breadth over depth; no grading, just a "seen" mark. */
export default {
  id: "sprint",
  apiVersion: 1,
  name: "快速过",
  description: "只讲一句话和常见误解，不判分。",
  mode: {
    label: "快速过",
    summary: "每个知识点一句话 + 常见误解，标记看过就前进。",
    tools: ["learn_status", "learn_kp", "learn_record", "learn_report"],
    rules: [
      "每个知识点只输出三行：一句话结论、最容易错的地方、和上一个知识点的关系。",
      "不要出题、不要判分。",
      "讲完调用 learn_record，score 记 0.6、kind 记 recall、note 写「快速过」。",
      "一次连续过 5 个知识点后再停，让学员决定是否继续。",
    ].join("\n"),
  },
};
