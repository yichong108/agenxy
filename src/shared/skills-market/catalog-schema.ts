import { z } from 'zod'

/** 远端 catalog JSON 本体（不含本地缓存字段） */
export const skillsMarketCatalogPayloadSchema = z.object({
  version: z.number().int().positive(),
  items: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/),
        name: z.string().min(1).max(200),
        description: z.string().max(8000),
        version: z.string().min(1).max(64),
        packageUrl: z
          .string()
          .url()
          .refine((u) => u.startsWith('https:'), 'packageUrl 必须为 https')
      })
    )
    .max(20_000)
})

export type SkillsMarketCatalogPayload = z.infer<typeof skillsMarketCatalogPayloadSchema>

/** ClawHub `GET /api/v1/skills` 分页中的一页 */
export const clawhubSkillListItemSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string(),
  summary: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
  latestVersion: z
    .object({ version: z.string().min(1) })
    .nullable()
    .optional()
})

export const clawhubSkillsPageSchema = z.object({
  items: z.array(clawhubSkillListItemSchema),
  nextCursor: z.string().optional()
})

export type ClawhubSkillListItem = z.infer<typeof clawhubSkillListItemSchema>
export type ClawhubSkillsPage = z.infer<typeof clawhubSkillsPageSchema>
