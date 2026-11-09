// @cxtrust/policycraft — natural-language policy authoring (compile-time only).
// The engine never imports this package; it runs the compiled Policy artifacts.

export {
  compilePolicyText,
  describeRule,
  POLICY_FIELD_ALIASES,
  POLICY_ACTIONS,
} from './compiler.ts';
export type { CompileError, CompileResult, CompileOptions } from './compiler.ts';
