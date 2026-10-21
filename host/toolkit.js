/**
 * Minimal local equivalent of `defineTool` from `@deepseek-ai/dsh-tools`.
 *
 * The bundle is installed by linking a directory, so Node resolves imports from
 * `D:\dsh-plugin\host\...` and cannot see the packages that ship inside the DSH
 * installation. Rather than depend on resolution that only works for registry
 * installs, this plugin builds the compiled tool definition itself. The shape is
 * what `ctx.tools.register()` validates:
 *   { name, description, parameters: <JSON Schema>,
 *     output: { schema: <JSON Schema>, render(args, value) }, execute(args, exec) }
 */

/** Collect `required: true` markers into the JSON Schema `required` array. */
function toSchema(node) {
  if (Array.isArray(node)) return node.map(toSchema);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  let required;
  for (const [key, value] of Object.entries(node)) {
    if (key === "required") {
      if (value === true) continue; // collected from the sibling properties
      required = value;
      continue;
    }
    if (key === "properties") {
      out.properties = toProperties(value);
      continue;
    }
    out[key] = toSchema(value);
  }
  const fromProperties = Object.entries(node.properties ?? {})
    .filter(([, spec]) => spec && spec.required === true)
    .map(([key]) => key);
  if (fromProperties.length > 0) out.required = fromProperties;
  else if (Array.isArray(required) && required.length > 0) out.required = required;
  return out;
}

function toProperties(map) {
  const out = {};
  for (const [key, spec] of Object.entries(map ?? {})) {
    const { required: _required, ...rest } = spec ?? {};
    out[key] = toSchema(rest);
  }
  return out;
}

/** Build the definition object `ctx.tools.register()` accepts. */
export function defineTool(options) {
  const parameters = {
    type: "object",
    properties: toProperties(options.parameters),
    ...(() => {
      const required = Object.entries(options.parameters ?? {})
        .filter(([, spec]) => spec && spec.required === true)
        .map(([key]) => key);
      return required.length > 0 ? { required } : {};
    })(),
    additionalProperties: false,
  };
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: toSchema(options.output.schema),
      render: (args, value) => options.output.render(args, value),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      return options.execute(args, exec);
    },
  };
}