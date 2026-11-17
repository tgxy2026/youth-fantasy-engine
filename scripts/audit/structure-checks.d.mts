// 与 registry-check.d.mts 同例：给单测提供 .mjs 的类型声明，避免 TS7016 / 隐式 any。
export interface StructureFinding {
  rule: 'arch.reverse-import' | 'arch.facade-undeclared'
  confidence: 'review'
  file: string
  line: number
  message: string
}

export interface StructureStats {
  files: number
  reverseImports: number
  undeclaredFacades: number
}

export interface DeclaredFacade {
  file: string
  reason: string
}

export declare const DECLARED_FACADES: DeclaredFacade[]
export declare const NON_UI_DIRS: string[]

export declare function scanStructure(
  root: string,
  opts?: { files?: string[]; readFile?: (file: string) => string },
): { findings: StructureFinding[]; stats: StructureStats }

export declare function validateFacadeRegistry(
  facades: DeclaredFacade[],
  exists: (file: string) => boolean,
): { ok: boolean; issues: string[] }
