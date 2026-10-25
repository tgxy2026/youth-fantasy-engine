import type { TabDef, TableRow, Project, Volume, Chapter } from '../../../src/lib/types'
import type { AtlasSchemaConfig } from '../../../src/lib/atlas/types'
import type { AtlasColumn } from '../../../src/lib/atlas/columns'
export const FIXTURE_NAMES: readonly string[]
export const FIXTURE_VERSION: number
export function hash(value: unknown): string
export interface TableFixture {
  version: number; name: string; seed: number; tab: { id: string; name: string; group: string }
  columns: { key: string; type: string; label: string }[]
  stores: { projects: Project[]; tableRows: TableRow[]; settingsKV: { key: string; value: AtlasSchemaConfig }[]; volumes: Volume[]; chapters: Chapter[]; revisionPayloads: { id: string; bytes: number; report: unknown }[]; meta: { key: string; value: string }[] }
  expected: { order: string[]; parents: Record<string, string | null>; filter: { key: string; query: string; ids: string[] }; recordsHash: string; chapterChars: number }
  manifest: { rows: number; rowsPerProject: number; columns: number; customFields: number; projects: number; chapters: number; payloads: number; bytes: number; sha256: string }
}
export function generateTableFixture(schema: { tab: TabDef; columnsOf: (tab: TabDef, config: AtlasSchemaConfig) => AtlasColumn[] }, name: string, seed?: number): TableFixture
