export const SKILL_NAMES = [] as const;
export type SkillName = string;

export function isSkillName(_value: string): _value is SkillName {
	return false;
}

export async function fetchSkill(_name: SkillName): Promise<string | null> {
	return null;
}
