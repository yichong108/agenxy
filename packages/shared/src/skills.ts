export type SkillInstallKind = 'builtin_code' | 'builtin_packaged' | 'market' | 'legacy'

export type SkillUiEntry = {
  key: string
  kind: SkillInstallKind
  toolName: string
  title: string
  description: string
  sourceLabel: string
  marketFolderId?: string
  legacyFolderRelative?: string
}

export type SkillsRuntimeState = {
  builtinCode: SkillUiEntry[]
  builtinPackaged: SkillUiEntry[]
  installedMarket: SkillUiEntry[]
  legacyUser: SkillUiEntry[]
}

export type SkillsUninstallResult = { ok: true } | { ok: false; error: string }

export type SkillsUninstallPayload =
  | { kind: 'market'; folderId: string }
  | { kind: 'legacy'; legacyFolderRelative: string }
