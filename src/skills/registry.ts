/**
 * Skill registry — modular capability system for Virgil.
 *
 * Skills are discrete tools that Virgil can invoke directly or
 * offer to Claude as available capabilities. Each skill has a
 * name, description, parameter schema, and an execute function.
 */

// ── Types ───────────────────────────────────────────────────────

/** Schema for a single skill parameter */
export interface SkillParam {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
}

/** Input passed to a skill's execute function */
export interface SkillInput {
  /** Named parameters */
  params: Record<string, string | number | boolean>;
  /** Raw text input (for free-form invocation) */
  raw?: string;
}

/** Result returned from skill execution */
export interface SkillResult {
  /** Whether the skill executed successfully */
  success: boolean;
  /** Output text to return to the user */
  output: string;
  /** Optional structured data */
  data?: unknown;
}

/** A registered skill definition */
export interface Skill {
  /** Unique skill identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Parameter schema for the skill */
  params: SkillParam[];
  /** Execute the skill */
  execute: (input: SkillInput) => Promise<SkillResult>;
}

// ── Registry ────────────────────────────────────────────────────

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  /**
   * Registers a skill. Overwrites if a skill with the same name exists.
   */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * Gets a skill by name.
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Lists all registered skills.
   */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Executes a skill by name with the given input.
   *
   * @returns The skill result, or an error result if the skill is not found
   */
  async execute(name: string, input: SkillInput): Promise<SkillResult> {
    const skill = this.skills.get(name);
    if (!skill) {
      return {
        success: false,
        output: `Unknown skill: "${name}". Available: ${this.listNames().join(', ')}`,
      };
    }

    try {
      return await skill.execute(input);
    } catch (err) {
      return {
        success: false,
        output: `Skill "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Returns a summary of all skills, suitable for injection into a system prompt.
   */
  toPromptSummary(): string {
    const skills = this.list();
    if (skills.length === 0) return '';

    const lines = ['Available skills:'];
    for (const skill of skills) {
      const paramList = skill.params
        .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
        .join(', ');
      lines.push(`- ${skill.name}(${paramList}): ${skill.description}`);
    }
    return lines.join('\n');
  }

  /**
   * Returns just the skill names.
   */
  listNames(): string[] {
    return Array.from(this.skills.keys());
  }
}
