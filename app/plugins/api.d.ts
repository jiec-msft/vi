export type Hook = 'preview.transform' | 'final.transform' | 'output.guard';
export interface Manifest {
  id: string;
  version: string;
  apiVersion: 1;
  entry: string;
  hooks: Hook[];
  privacy?: { suppressUnprocessed: boolean };
  description?: string;
}
export interface Input {
  runId: string;
  requestId: string;
  revision: number;
  hook: Hook;
  inputText: string;
  config: unknown;
  context: { profile: 'general' | 'developer'; locale?: string };
  signal: AbortSignal;
}
export type TransformResult = { outcome: 'keep'; count?: number } |
  { outcome: 'replace'; text: string; count?: number };
export type FinalResult = TransformResult | { outcome: 'suppress' | 'block' };
export type GuardResult = { outcome: 'allow' | 'block' };
export interface Plugin {
  validateConfig?: (config: unknown) => { valid: boolean } | Promise<{ valid: boolean }>;
  hooks: {
    'preview.transform'?: (input: Input) => TransformResult | Promise<TransformResult>;
    'final.transform'?: (input: Input) => FinalResult | Promise<FinalResult>;
    'output.guard'?: (input: Input) => GuardResult | Promise<GuardResult>;
  };
  dispose?: () => void | Promise<void>;
}
