/**
 * Safe, deterministic arithmetic expression evaluator for the Billing Calculator.
 * Does NOT use eval() or Function().
 * Enforces a 128-character limit and recursion depth limits.
 */

export type CalculatorEvaluationResult =
  | { success: true; result: number; formatted: string }
  | { success: false; error: string };

type TokenType =
  | "NUMBER"
  | "PLUS"
  | "MINUS"
  | "MULTIPLY"
  | "DIVIDE"
  | "LPAREN"
  | "RPAREN";

interface Token {
  type: TokenType;
  value?: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const char = input[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === "+" || char === "＋") {
      tokens.push({ type: "PLUS" });
      i++;
    } else if (char === "-" || char === "−" || char === "–") {
      tokens.push({ type: "MINUS" });
      i++;
    } else if (char === "*" || char === "×" || char === "x" || char === "X") {
      tokens.push({ type: "MULTIPLY" });
      i++;
    } else if (char === "/" || char === "÷") {
      tokens.push({ type: "DIVIDE" });
      i++;
    } else if (char === "(") {
      tokens.push({ type: "LPAREN" });
      i++;
    } else if (char === ")") {
      tokens.push({ type: "RPAREN" });
      i++;
    } else if (/[0-9.]/.test(char)) {
      let numStr = "";
      let hasDot = false;
      while (i < len && /[0-9.]/.test(input[i])) {
        if (input[i] === ".") {
          if (hasDot) {
            throw new Error("Invalid number with multiple decimal points.");
          }
          hasDot = true;
        }
        numStr += input[i];
        i++;
      }
      const num = Number(numStr);
      if (!Number.isFinite(num)) {
        throw new Error("Invalid number.");
      }
      tokens.push({ type: "NUMBER", value: num });
    } else {
      throw new Error(`Unexpected character: '${char}'`);
    }
  }

  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private depth = 0;
  private static readonly MAX_DEPTH = 32;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(expectedType?: TokenType): Token {
    const current = this.peek();
    if (!current) {
      throw new Error("Unexpected end of expression.");
    }
    if (expectedType && current.type !== expectedType) {
      throw new Error(`Expected token ${expectedType} but got ${current.type}.`);
    }
    this.pos++;
    return current;
  }

  public parse(): number {
    if (this.tokens.length === 0) {
      throw new Error("Expression is empty.");
    }
    const result = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error("Unexpected tokens after expression.");
    }
    if (!Number.isFinite(result)) {
      throw new Error("Calculation resulted in non-finite value.");
    }
    return result;
  }

  private parseExpression(): number {
    this.depth++;
    if (this.depth > Parser.MAX_DEPTH) {
      throw new Error("Expression nesting is too deep.");
    }
    try {
      let left = this.parseTerm();

      while (this.peek() && (this.peek()!.type === "PLUS" || this.peek()!.type === "MINUS")) {
        const op = this.consume().type;
        const right = this.parseTerm();
        if (op === "PLUS") {
          left = left + right;
        } else {
          left = left - right;
        }
      }

      return left;
    } finally {
      this.depth--;
    }
  }

  private parseTerm(): number {
    this.depth++;
    if (this.depth > Parser.MAX_DEPTH) {
      throw new Error("Expression nesting is too deep.");
    }
    try {
      let left = this.parseFactor();

      while (this.peek() && (this.peek()!.type === "MULTIPLY" || this.peek()!.type === "DIVIDE")) {
        const op = this.consume().type;
        const right = this.parseFactor();
        if (op === "MULTIPLY") {
          left = left * right;
        } else {
          if (right === 0 || Math.abs(right) < Number.EPSILON) {
            throw new Error("Cannot divide by zero.");
          }
          left = left / right;
        }
      }

      return left;
    } finally {
      this.depth--;
    }
  }

  private parseFactor(): number {
    const next = this.peek();
    if (!next) {
      throw new Error("Unexpected end of expression.");
    }

    // Unary plus or minus
    if (next.type === "PLUS") {
      this.consume();
      return this.parseFactor();
    }
    if (next.type === "MINUS") {
      this.consume();
      return -this.parseFactor();
    }

    if (next.type === "NUMBER") {
      this.consume();
      return next.value ?? 0;
    }

    if (next.type === "LPAREN") {
      this.consume("LPAREN");
      const expr = this.parseExpression();
      this.consume("RPAREN");
      return expr;
    }

    throw new Error(`Unexpected token '${next.type}'`);
  }
}

export function formatCalculatorResult(value: number): string {
  if (!Number.isFinite(value)) return "Error";
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isInteger(rounded)
    ? rounded.toString()
    : rounded.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function evaluateCalculatorExpression(input: string): CalculatorEvaluationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { success: false, error: "Enter an expression to calculate." };
  }

  if (trimmed.length > 128) {
    return { success: false, error: "Expression cannot exceed 128 characters." };
  }

  try {
    const tokens = tokenize(trimmed);
    const parser = new Parser(tokens);
    const result = parser.parse();
    return {
      success: true,
      result,
      formatted: formatCalculatorResult(result),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || "Invalid arithmetic expression.",
    };
  }
}
