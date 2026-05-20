export interface SessionState {
  cwd: string;
  turnCount: number;
  totalCost: number;
  opusCost: number;
  sonnetCost: number;
  excludedCount: number;
  inputTokens: number;
  contextWindow: number;
  model: string;
}
